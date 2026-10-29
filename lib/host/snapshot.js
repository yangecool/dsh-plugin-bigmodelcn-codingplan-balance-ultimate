/**
 * Cached aggregations behind the plugin's Host routes.
 *
 * The Client never talks to BigModel or ZCode directly: it asks these methods
 * for a normalized snapshot and the snapshot module owns login state, the
 * memory TTLs, single-flight de-duplication, and stale-last-good fallback.
 *
 * Login state has exactly one source, `store.readAuth()`; an expired token is
 * treated as an expired login (the user name is kept for display and the
 * tokens are removed). Account details are cached for an hour and written back
 * into the auth document. Upstream failures never throw from `overview()`: the
 * payload reports `{ error }` and keeps the last good snapshot marked `stale`
 * instead, so one flaky upstream cannot blank an otherwise usable page.
 *
 * After a successful OAuth login the inference module is asked to write the
 * Coding Plan project token into the pi-ai provider credential, so model
 * inference keeps working; an overview rebuild (cache miss or `force`) also
 * pokes that module so a page refresh renews the credential before it expires.
 * Logout and login expiry go through `inference.releaseLogin()`, which owns the
 * order that makes the credential cleanup atomic: auth document first, then the
 * credential reference.
 */
import { HostError } from './http.js';
import { OVERVIEW_TTL_MS, RESET_TTL_MS, USAGE_RANGES, USAGE_TTL_MS } from './constants.js';
import { pickPrimaryLimit, remainingPercent } from './upstream.js';

/** Freshness of the cached customer/account document. */
const ACCOUNT_TTL_MS = 60 * 60_000;

/** Route reset types (Client contract) mapped to ZCode's wire enum. */
const RESET_TYPE_BY_ROUTE = Object.freeze({ five_hour: 'FIVE_HOUR', week: 'WEEK' });

/** Ordering accepted for direct callers that already use the wire enum. */
const RESET_TYPE_BY_WIRE = Object.freeze({ FIVE_HOUR: 'FIVE_HOUR', WEEK: 'WEEK' });

/** Shape of the inference status when the inference module has no data yet. */
const EMPTY_INFERENCE_STATUS = Object.freeze({
  enabled: false,
  available: false,
  ref: null,
  family: null,
  writtenAt: null,
  expiresAt: null,
  expiresInMs: null,
  error: 'inference_unavailable',
});

/** True for a non-null, non-array object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a finite number; null otherwise. */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read a non-empty trimmed string; null otherwise. */
function stringValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Whether a stored account document carries displayable customer data. */
function hasAccountInfo(account) {
  if (!isRecord(account)) return false;
  if (stringValue(account.customerNumber) !== null || stringValue(account.customerName) !== null) {
    return true;
  }
  return Array.isArray(account.organizations) && account.organizations.length > 0;
}

/** Typed login-expired failure. */
function loginExpiredError() {
  return new HostError('login_expired', 'The login has expired', { status: 401 });
}

/** Typed not-logged-in failure. */
function notLoggedInError() {
  return new HostError('not_logged_in', 'Not logged in', { status: 409 });
}

/** Typed invalid-request failure. */
function invalidRequestError(message) {
  return new HostError('invalid_request', message, { status: 400 });
}

/** Normalize an unknown thrown value into a string-coded failure. */
function asHostError(error) {
  return error instanceof HostError
    ? error
    : new HostError('internal_error', 'Unexpected plugin failure', { status: 500 });
}

/** Keep only the metadata fields of an inference status (never a token). */
function sanitizeInferenceStatus(status) {
  if (!isRecord(status)) return { ...EMPTY_INFERENCE_STATUS };
  return {
    enabled: status.enabled === true,
    available: status.available === true,
    ref: stringValue(status.ref),
    family: stringValue(status.family),
    writtenAt: finiteNumber(status.writtenAt),
    expiresAt: finiteNumber(status.expiresAt),
    expiresInMs: finiteNumber(status.expiresInMs),
    error: stringValue(status.error),
  };
}

/**
 * Build the snapshot module bound to one plugin instance.
 * @param options - store, oauth, account, upstream, optional inference and
 *   provider-provisioning modules, logger, and clock.
 * @returns cached snapshot methods used by the route table.
 */
export function createSnapshot(options = {}) {
  const { store, oauth, account, upstream, inference, provider, logger, now = () => Date.now() } = options;
  if (store === undefined || oauth === undefined || account === undefined || upstream === undefined) {
    throw new TypeError(
      'bigmodelcn-balance: createSnapshot requires store, oauth, account, and upstream',
    );
  }

  /** key -> { value, at } for TTL-cached successful results. */
  const cache = new Map();
  /** key -> in-flight promise; one upstream request per key at a time. */
  const inflight = new Map();
  /** key -> last successful payload, used for stale fallback. */
  const lastGood = new Map();
  /** 'account' -> { value, at, family } for the one-hour customer info cache. */
  const accountCache = new Map();
  /**
   * Bumped whenever the login identity changes (login ready, logout, expired
   * token). Requests started before the bump still resolve for their caller but
   * must not repopulate per-identity caches.
   */
  let generation = 0;
  /**
   * A login that failed with 401/403 has its tokens removed immediately, but the
   * page must keep explaining why it asks for a new login instead of silently
   * looking logged out. This flag survives the token removal until a new login
   * completes or the user logs out.
   */
  let expiredNotice = false;
  /** Last known user display name, kept so an expired login can still greet the user. */
  let rememberedUser = null;

  /** Drop every per-identity cache and ask the account module to forget probes. */
  function invalidateCaches() {
    generation += 1;
    cache.clear();
    inflight.clear();
    lastGood.clear();
    accountCache.clear();
    if (typeof account.clearCache === 'function') {
      try {
        account.clearCache();
      } catch (error) {
        logger?.warn?.(`bigmodelcn-balance: account probe cache could not be cleared (${error?.code ?? 'unknown'})`);
      }
    }
  }

  /** Read a non-forced TTL cache entry; undefined when stale or absent. */
  function readCacheEntry(key, ttl, force) {
    if (force) return undefined;
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    if (now() - entry.at >= ttl) return undefined;
    return entry.value;
  }

  /** Cache a result unless the login generation changed while it was loading. */
  function writeCacheEntry(key, value, startGeneration) {
    if (startGeneration !== generation) return;
    cache.set(key, { at: now(), value });
  }

  /** Join or start the single in-flight request of a cache key. */
  function singleFlight(key, task) {
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;
    let promise;
    promise = Promise.resolve()
      .then(task)
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  }

  /** Read the stored login without letting an unreadable file break a route. */
  function readStoredAuth() {
    try {
      return store.readAuth();
    } catch (error) {
      logger?.warn?.(`bigmodelcn-balance: auth document could not be read (${error?.code ?? 'unknown'})`);
      return null;
    }
  }

  /** Whether the stored access token is already past its expiry. */
  function isAuthExpired(auth) {
    const expiresAt = finiteNumber(auth?.expiresAt);
    return expiresAt !== null && expiresAt <= now();
  }

  /** Read the inference status; never throws. */
  async function readInferenceStatus() {
    if (inference === undefined || typeof inference.status !== 'function') {
      return { ...EMPTY_INFERENCE_STATUS };
    }
    try {
      return sanitizeInferenceStatus(await inference.status());
    } catch (error) {
      logger?.warn?.(`bigmodelcn-balance: inference status is unavailable (${error?.code ?? 'unknown'})`);
      return { ...EMPTY_INFERENCE_STATUS, error: 'inference_status_failed' };
    }
  }

  /** Kick off an inference renewal without ever awaiting or throwing. */
  function triggerInferenceSync(force) {
    if (inference === undefined || typeof inference.sync !== 'function') return;
    try {
      Promise.resolve(inference.sync({ force: force === true })).catch((error) => {
        logger?.warn?.(`bigmodelcn-balance: inference sync failed (${error?.code ?? 'unknown'})`);
      });
    } catch (error) {
      logger?.warn?.(`bigmodelcn-balance: inference sync failed (${error?.code ?? 'unknown'})`);
    }
  }

  /** Remove the inference credential through the module's non-logout path; never throws. */
  async function clearInferenceCredential() {
    if (inference === undefined || typeof inference.clear !== 'function') return;
    try {
      await inference.clear();
    } catch (error) {
      logger?.warn?.(`bigmodelcn-balance: inference credential could not be cleared (${error?.code ?? 'unknown'})`);
    }
  }

  /**
   * Release the credential the current login wrote, through the atomic logout
   * path (`releaseLogin`) that fences renewal attempts and deletes the auth
   * document before unsetting the reference. Falls back to `clear()` for an
   * inference module that predates `releaseLogin`, so the ordering here remains
   * explicit only for that fallback. Never throws.
   */
  async function releaseInferenceLogin() {
    if (inference === undefined) return;
    try {
      if (typeof inference.releaseLogin === 'function') {
        await inference.releaseLogin();
        return;
      }
      await clearInferenceCredential();
    } catch (error) {
      logger?.warn?.(`bigmodelcn-balance: inference credential could not be released (${error?.code ?? 'unknown'})`);
    }
  }

  /**
   * Clear the login identity: the inference credential (which needs the auth
   * document's bookkeeping), the stored tokens, and every per-identity cache.
   */
  async function clearLoginState() {
    expiredNotice = true;
    await releaseInferenceLogin();
    // releaseLogin() already deleted the auth document before unsetting the
    // reference; this second delete is a no-op on that path and keeps the
    // fallback (inference.clear() without releaseLogin) explicit.
    try {
      store.clearAuth();
    } catch (error) {
      logger?.warn?.(`bigmodelcn-balance: auth document could not be removed (${error?.code ?? 'unknown'})`);
    }
    invalidateCaches();
  }

  /**
   * Resolve the stored login, clearing an expired token.
   * @returns `{ auth, expired, user, family }`; `auth` is null when logged out.
   */
  async function resolveAuthState() {
    const auth = readStoredAuth();
    if (auth === null) return { auth: null, expired: false, user: null, family: null };
    rememberedUser = auth.user ?? rememberedUser;
    if (!isAuthExpired(auth)) return { auth, expired: false, user: auth.user ?? null, family: auth.family ?? null };
    const previous = { user: auth.user ?? null, family: auth.family ?? null };
    await clearLoginState();
    logger?.info?.('bigmodelcn-balance: stored login expired; cleared tokens');
    return { auth: null, expired: true, user: previous.user, family: previous.family };
  }

  /** Resolve the current login or throw the route-level auth error. */
  async function requireAuth() {
    const state = await resolveAuthState();
    if (state.auth !== null) return state.auth;
    throw state.expired || expiredNotice ? loginExpiredError() : notLoggedInError();
  }

  /** Build the overview auth block from the stored login and cached account. */
  function buildAuthBlock({ auth, expired, user, accountInfo, keyLocation }) {
    return {
      loggedIn: auth !== null,
      loginExpired: expired,
      user: auth?.user ?? user ?? null,
      account: accountInfo ?? (hasAccountInfo(auth?.account) ? auth.account : null),
      keyLocation: keyLocation ?? auth?.keyLocation ?? null,
    };
  }

  /**
   * Merge one resolved account fact (customer info or key location) into the
   * auth document. Re-reads the stored document first so concurrent inference
   * bookkeeping is never overwritten with an older copy. A removed login is
   * never recreated: a logout that commits while this request is in flight must
   * stay authoritative, or the deleted tokens would come back to life.
   */
  function persistAuthPatch(patch) {
    try {
      const latest = readStoredAuth();
      if (latest === null) return;
      store.writeAuth({ ...latest, ...patch });
    } catch (error) {
      logger?.warn?.(`bigmodelcn-balance: auth document could not be updated (${error?.code ?? 'unknown'})`);
    }
  }

  /** Persist the loaded customer info into the auth document. */
  function persistAccount(loaded) {
    persistAuthPatch({ account: loaded });
  }

  /** Load the customer info through the one-hour cache and write it back. */
  async function loadAccountCached(auth, force) {
    const key = 'account';
    if (!force) {
      const entry = accountCache.get(key);
      if (entry !== undefined && entry.family === auth.family && now() - entry.at < ACCOUNT_TTL_MS) {
        return entry.value;
      }
    }
    return singleFlight(key, async () => {
      const startGeneration = generation;
      const loaded = await account.loadAccount({
        family: auth.family,
        accessToken: auth.accessToken,
        force,
      });
      if (startGeneration === generation) {
        accountCache.set(key, { value: loaded, at: now(), family: auth.family });
        persistAccount(loaded);
      }
      return loaded;
    });
  }

  /** Keep exactly the subscription fields of the Client data model. */
  function pickSubscription(subscription) {
    if (subscription === null || subscription === undefined) return null;
    return {
      active: subscription.active === true,
      productId: subscription.productId ?? null,
      productName: subscription.productName ?? null,
      status: subscription.status ?? null,
      billingCycle: subscription.billingCycle ?? null,
      renewTime: finiteNumber(subscription.renewTime),
      expireAt: finiteNumber(subscription.expireAt),
      autoRenew: subscription.autoRenew === true,
    };
  }

  /** Keep exactly the quota fields of the Client data model (no envelope/status). */
  function pickQuota(quota) {
    if (quota === null || quota === undefined) return null;
    return {
      level: quota.level ?? null,
      limits: Array.isArray(quota.limits) ? quota.limits : [],
    };
  }

  /** Compute the compact remaining-quota block of the overview. */
  function computeRemaining(quota) {
    const primary = pickPrimaryLimit(quota?.limits ?? []);
    if (primary === null) return null;
    return {
      percentage: remainingPercent(primary),
      nextResetTime: finiteNumber(primary.nextResetTime),
    };
  }

  /** Report one upstream/reset failure as `{ code, message }`. */
  function reportFailure(error) {
    const mapped = asHostError(error);
    const message = typeof mapped.message === 'string' && mapped.message !== ''
      ? mapped.message
      : 'Unexpected plugin failure';
    return { code: mapped.code, message };
  }

  /** Build the login-expired overview payload, clearing stored tokens first. */
  async function loginExpiredOverview({ family, user }) {
    await clearLoginState();
    return {
      family,
      generatedAt: now(),
      auth: { loggedIn: false, loginExpired: true, user: user ?? null, account: null, keyLocation: null },
      subscription: null,
      quota: null,
      remaining: null,
      reset: null,
      inference: await readInferenceStatus(),
      stale: false,
      error: { code: 'login_expired', message: 'The login has expired' },
    };
  }

  /** Map a reset-side upstream failure to the route-level reset error. */
  async function mapResetError(error) {
    const mapped = asHostError(error);
    if (mapped.code === 'login_expired') {
      await clearLoginState();
      return mapped;
    }
    if (mapped.code === 'rate_limited') {
      return new HostError('reset_throttled', 'The reset request was throttled; retry later', {
        status: 429,
      });
    }
    return mapped;
  }

  /**
   * Fetch the reset block through the reset TTL cache/single-flight.
   * @param request - family, stored auth document, and force flag.
   * @returns normalized reset status.
   */
  async function fetchResetBlock({ family, auth, force }) {
    if (stringValue(auth?.zcodeJwtToken) === null) {
      throw new HostError('reset_unavailable', 'Coding Plan reset requires a ZCode login', {
        status: 409,
      });
    }
    const key = `reset:${family}`;
    const cachedValue = readCacheEntry(key, RESET_TTL_MS, force);
    if (cachedValue !== undefined) return cachedValue;
    return singleFlight(key, async () => {
      const startGeneration = generation;
      let block;
      try {
        block = await upstream.resetStatus({ family, auth, account });
      } catch (error) {
        throw await mapResetError(error);
      }
      writeCacheEntry(key, block, startGeneration);
      return block;
    });
  }

  /** Build one overview payload (the caller owns cache and stale handling). */
  async function buildOverview({ state, family, force, inference: inferenceStatus, startGeneration }) {
    const generatedAt = now();
    if (state.auth === null) {
      const expired = state.expired || expiredNotice;
      return {
        family,
        generatedAt,
        auth: buildAuthBlock({ auth: null, expired, user: state.user ?? rememberedUser }),
        subscription: null,
        quota: null,
        remaining: null,
        reset: null,
        inference: inferenceStatus,
        stale: false,
        error: null,
      };
    }
    const auth = state.auth;
    let accountInfo = null;
    try {
      accountInfo = await loadAccountCached(auth, force);
    } catch (error) {
      if (asHostError(error).code === 'login_expired') {
        return loginExpiredOverview({ family, user: auth.user });
      }
      logger?.warn?.(`bigmodelcn-balance: account info is unavailable (${error?.code ?? 'unknown'})`);
    }
    const settled = await Promise.allSettled([
      upstream.subscription({ family, auth, account }),
      upstream.quota({ family, auth, account }),
      fetchResetBlock({ family, auth, force }),
    ]);
    const subscriptionOutcome = settled[0];
    const quotaOutcome = settled[1];
    const resetOutcome = settled[2];
    const readOutcome = (result) => {
      if (result.status === 'fulfilled') return { value: result.value, error: null };
      const mapped = asHostError(result.reason);
      return {
        value: null,
        error: mapped,
        loginExpired: mapped.code === 'login_expired',
        noPlan: mapped.code === 'no_coding_plan',
      };
    };
    const subscriptionResult = readOutcome(subscriptionOutcome);
    const quotaResult = readOutcome(quotaOutcome);
    if (resetOutcome.status === 'rejected') {
      logger?.warn?.(`bigmodelcn-balance: reset status is unavailable (${resetOutcome.reason?.code ?? 'unknown'})`);
    }
    if (subscriptionResult.loginExpired === true || quotaResult.loginExpired === true) {
      return loginExpiredOverview({ family, user: auth.user });
    }
    const subscription = subscriptionResult.value;
    const quota = quotaResult.value;
    let noPlan = subscriptionResult.noPlan === true || quotaResult.noPlan === true;
    if (subscription !== null && subscription.active === false && subscription.productId === null) {
      noPlan = true;
    }
    const failures = [subscriptionResult.error, quotaResult.error].filter((error) => error !== null);
    const freshAuth = readStoredAuth();
    const authBlock = buildAuthBlock({
      auth,
      expired: false,
      user: null,
      accountInfo,
      keyLocation: freshAuth?.keyLocation ?? auth.keyLocation ?? null,
    });
    if (!noPlan && failures.length === 0 && authBlock.keyLocation === null && typeof account.ensureKeyLocation === 'function') {
      // The probe just accepted a credential, so the project location is already
      // in the account module's cache; persisting it lets a restart skip re-creation.
      try {
        const location = await account.ensureKeyLocation({
          family,
          accessToken: auth.accessToken,
          force: false,
        });
        // A logout or re-login that committed during the lookup owns the auth
        // document; an older identity must not write its location into it.
        if (isRecord(location) && startGeneration === generation) {
          persistAuthPatch({ keyLocation: location });
          authBlock.keyLocation = location;
        }
      } catch (error) {
        logger?.warn?.(`bigmodelcn-balance: key location could not be persisted (${error?.code ?? 'unknown'})`);
      }
    }
    const base = {
      family,
      generatedAt,
      auth: authBlock,
      subscription: pickSubscription(subscription),
      quota: pickQuota(quota),
      remaining: computeRemaining(quota),
      reset: resetOutcome.status === 'fulfilled' ? resetOutcome.value : null,
      inference: inferenceStatus,
      stale: false,
      error: null,
    };
    if (noPlan) {
      const error = {
        code: 'no_coding_plan',
        message: 'No Coding Plan is active for this account',
      };
      const last = lastGood.get('overview');
      if (last !== undefined) {
        return { ...last, auth: authBlock, inference: inferenceStatus, stale: true, error };
      }
      return { ...base, error };
    }
    if (failures.length > 0) {
      const error = reportFailure(failures[0]);
      const last = lastGood.get('overview');
      if (last !== undefined) {
        return { ...last, auth: authBlock, inference: inferenceStatus, stale: true, error };
      }
      return { ...base, error };
    }
    if (startGeneration === generation) lastGood.set('overview', base);
    return base;
  }

  return {
    /**
     * Report the persisted config, the login state, and the pending OAuth flow.
     * No upstream request is made; only a locally expired token is handled.
     * @returns status payload of the `GET /api/status` route.
     */
    async status() {
      const config = store.readConfig();
      const state = await resolveAuthState();
      const expired = state.expired || (state.auth === null && expiredNotice);
      const inferenceStatus = await readInferenceStatus();
      let login;
      const pending = typeof oauth.pending === 'function' ? oauth.pending() : null;
      if (isRecord(pending)) {
        login = {
          state: 'pending',
          authorizeUrl: stringValue(pending.authorizeUrl),
          expiresAt: finiteNumber(pending.expiresAt),
        };
      } else {
        login = { state: state.auth !== null ? 'ready' : 'idle' };
      }
      return {
        config,
        auth: {
          loggedIn: state.auth !== null,
          loginExpired: expired,
          user: state.auth?.user ?? (expired ? rememberedUser : null) ?? state.user ?? null,
          account: hasAccountInfo(state.auth?.account) ? state.auth.account : null,
          family: state.auth?.family ?? state.family ?? config.family,
        },
        login,
        inference: inferenceStatus,
      };
    },

    /**
     * Return the aggregated overview payload.
     *
     * Uses the 30s TTL cache unless `force` is set. Never throws for a missing
     * plan or an upstream failure: the payload reports an `error` and, when a
     * previous successful payload exists, returns it with `stale: true`.
     * @param request - optional force flag.
     * @returns overview payload of the `GET /api/overview` route.
     */
    async overview({ force = false } = {}) {
      const inferenceStatus = await readInferenceStatus();
      const config = store.readConfig();
      const state = await resolveAuthState();
      const family = state.auth?.family ?? state.family ?? config.family;
      const cacheKey = `overview:${family}`;
      const cachedValue = readCacheEntry(cacheKey, OVERVIEW_TTL_MS, force === true);
      if (cachedValue !== undefined) return { ...cachedValue, inference: inferenceStatus };
      return singleFlight(cacheKey, async () => {
        const startGeneration = generation;
        // Only a real rebuild renews the credential; a cached overview returns the
        // status read above without starting another attempt, and concurrent
        // rebuilds share this task.
        triggerInferenceSync(force === true);
        const result = await buildOverview({
          state,
          family,
          force: force === true,
          inference: inferenceStatus,
          startGeneration,
        });
        writeCacheEntry(cacheKey, result, startGeneration);
        return result;
      });
    },

    /**
     * Return the usage statistics of one range.
     *
     * Cached per range/time-zone for two minutes; upstream failures throw so the
     * Client can render an inline retry, while an expired login clears tokens.
     * @param request - range, optional IANA time zone, and force flag.
     * @returns usage payload of the `GET /api/usage` route.
     */
    async usage({ range = 'today', timeZone, force = false } = {}) {
      if (!USAGE_RANGES.includes(range)) {
        throw invalidRequestError(`Unknown usage range "${range}"`);
      }
      const auth = await requireAuth();
      const family = auth.family;
      const cacheKey = `usage:${family}:${range}:${timeZone ?? ''}`;
      const cachedValue = readCacheEntry(cacheKey, USAGE_TTL_MS, force === true);
      if (cachedValue !== undefined) return cachedValue;
      return singleFlight(cacheKey, async () => {
        const startGeneration = generation;
        let value;
        try {
          value = await upstream.usage({ family, auth, account, range, timeZone });
        } catch (error) {
          const mapped = asHostError(error);
          if (mapped.code === 'login_expired') await clearLoginState();
          throw mapped;
        }
        const result = {
          range,
          timeZone: value.timeZone ?? timeZone ?? null,
          generatedAt: now(),
          granularity: value.granularity,
          summary: value.summary,
          series: value.series,
          models: value.models,
          tools: value.tools,
        };
        writeCacheEntry(cacheKey, result, startGeneration);
        return result;
      });
    },

    /**
     * Return the Coding Plan reset status block.
     * @param request - optional force flag.
     * @returns reset block of the `GET /api/reset` route.
     */
    async reset({ force = false } = {}) {
      const auth = await requireAuth();
      return fetchResetBlock({ family: auth.family, auth, force: force === true });
    },

    /**
     * Consume one Coding Plan reset chance.
     * @param request - Client reset type (`five_hour`|`week`) and idempotency key.
     * @returns `{ used: true }`.
     */
    async useReset({ resetType, idempotencyKey } = {}) {
      const auth = await requireAuth();
      const useType =
        RESET_TYPE_BY_ROUTE[typeof resetType === 'string' ? resetType.trim() : ''] ??
        RESET_TYPE_BY_WIRE[typeof resetType === 'string' ? resetType.trim() : ''];
      if (useType === undefined) {
        throw invalidRequestError('resetType must be five_hour or week');
      }
      const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
      if (key === '' || key.length > 64) {
        throw invalidRequestError('idempotencyKey must be 1-64 characters');
      }
      if (stringValue(auth.zcodeJwtToken) === null) {
        throw new HostError('reset_unavailable', 'Coding Plan reset requires a ZCode login', {
          status: 409,
        });
      }
      try {
        await upstream.useReset({ family: auth.family, auth, account, resetType: useType, idempotencyKey: key });
      } catch (error) {
        throw await mapResetError(error);
      }
      const family = auth.family;
      cache.delete(`reset:${family}`);
      cache.delete(`overview:${family}`);
      return { used: true };
    },

    /**
     * Poll the pending OAuth flow; a completed login renews the inference
     * credential immediately and drops every cache of the previous identity.
     * @returns OAuth poll result.
     */
    async loginStatus() {
      const result = await oauth.poll();
      if (result?.state === 'ready') {
        expiredNotice = false;
        rememberedUser = null;
        if (inference !== undefined && typeof inference.sync === 'function') {
          try {
            await inference.sync({ force: true });
          } catch (error) {
            logger?.warn?.(`bigmodelcn-balance: inference sync after login failed (${error?.code ?? 'unknown'})`);
          }
        }
        // The Models provider row follows the fresh login family; the module
        // answers a typed skip for every absent or already-configured case.
        if (provider !== undefined && typeof provider.ensure === 'function') {
          void provider.ensure({ family: store.readAuth()?.family });
        }
        invalidateCaches();
      }
      return result;
    },

    /**
     * Remove the stored login, the inference credential it wrote, and every
     * cached snapshot.
     * @returns `{ ok: true }`.
     */
    async logout() {
      expiredNotice = false;
      rememberedUser = null;
      // Release the provisioned provider row before the login state goes: the
      // release reads its bookkeeping from the config document.
      if (provider !== undefined && typeof provider.release === 'function') {
        void provider.release();
      }
      // The inference module owns the atomic cleanup order for logout: it fences
      // renewal attempts, deletes the auth document, then unsets the reference.
      // The oauth/store deletes below are then no-ops for the credential path.
      await releaseInferenceLogin();
      try {
        await oauth.logout();
      } catch (error) {
        logger?.warn?.(`bigmodelcn-balance: OAuth logout failed (${error?.code ?? 'unknown'})`);
      }
      try {
        store.clearAuth();
      } catch (error) {
        logger?.warn?.(`bigmodelcn-balance: auth document could not be removed (${error?.code ?? 'unknown'})`);
      }
      invalidateCaches();
      return { ok: true };
    },
  };
}
