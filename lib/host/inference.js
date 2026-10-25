/**
 * Automatic model-inference sign-in for the pi-ai provider route.
 *
 * DSH's `llm-pi-ai` route `zai-coding-cn` resolves its key from the credential
 * reference `ZAI_CODING_CN_API_KEY` through the Host `credentials` seam on every
 * operation. After the BigModel OAuth login this module issues the Coding Plan
 * project token and stores it under that reference, so the configured provider
 * authenticates without a pasted key, and renews it before expiry.
 *
 * The token only ever exists in two places: the credential store, and the
 * account module's in-memory cache. This module's durable bookkeeping
 * (`auth.inference`) records which reference it wrote, when, and which source
 * the reference resolved from before that first write — never a value. Errors
 * and logs carry stable codes only, because upstream messages can echo tokens.
 */
import { INFERENCE_REFRESH_LEAD_MS, INFERENCE_SYNC_INTERVAL_MS } from './constants.js';
import { HostError } from './http.js';

/** Status code reported when the Host composes without the credentials seam. */
const CREDENTIALS_UNAVAILABLE = 'credentials_unavailable';

/** Status and rejection code for a login the upstream business APIs reject. */
const LOGIN_EXPIRED = 'login_expired';

/** Status code for a project-token reply without a usable token. */
const INVALID_MATERIAL = 'invalid_material';

/** Fallback status code for failures that carry no HostError code. */
const INTERNAL_ERROR = 'internal_error';

/**
 * Whether a failure means the stored OAuth login is no longer accepted.
 * @param error - failure raised by the account or credentials module.
 * @returns true for 401/403 and for an already typed login_expired failure.
 */
function isAuthorizationFailure(error) {
  if (error instanceof HostError && error.code === LOGIN_EXPIRED) return true;
  return error?.status === 401 || error?.status === 403;
}

/**
 * Map a failure to the stable code recorded in `status().error`.
 * @param error - failure raised by the account or credentials module.
 * @returns login_expired, the failure's HostError code, or internal_error.
 */
function failureCode(error) {
  if (isAuthorizationFailure(error)) return LOGIN_EXPIRED;
  return error instanceof HostError && typeof error.code === 'string' ? error.code : INTERNAL_ERROR;
}

/**
 * Build the automatic inference sign-in bound to one plugin instance.
 * @param options - account module, auth store, credentials-service getter, logger, and clock.
 * @param options.account - account module exposing `getProjectMaterial({ family, auth, force })`.
 * @param options.store - auth store; inference bookkeeping is persisted through `writeAuth`.
 * @param options.credentials - optional getter returning the Host `credentials` service, read per call.
 * @param options.logger - optional logger; messages never contain tokens or upstream messages.
 * @param options.now - clock injection used for expiry bookkeeping; defaults to `Date.now`.
 * @returns sync, clear, status, and start; the behavior is documented in notes/contracts.md.
 */
export function createInference({ account, store, credentials, logger, now = () => Date.now() }) {
  const getCredentials = typeof credentials === 'function' ? credentials : () => undefined;

  /** The shared promise of the current attempt, or null while idle. */
  let inFlight = null;
  /** Stable code of the last failed attempt; null after a successful write or clear. */
  let lastError = null;
  /** Last code written to the log, so a recurring failure does not log every timer tick. */
  let lastLoggedCode = null;
  /** Bumped by clear(): an attempt in flight when the user logs out must not commit. */
  let generation = 0;

  /** @returns the credentials provider, or undefined when this Host has no seam. */
  function credentialsService() {
    const service = getCredentials();
    return service === undefined || service === null ? undefined : service;
  }

  /**
   * Record one stable failure code; the log line is emitted only when the code changes.
   * @param code - stable error code safe to log.
   */
  function recordFailure(code) {
    lastError = code;
    if (code === lastLoggedCode) return;
    lastLoggedCode = code;
    logger?.warn?.(`inference credential sync failed (${code})`);
  }

  /** Record a successful write and clear the previous failure. */
  function recordSuccess() {
    lastError = null;
    lastLoggedCode = null;
  }

  /**
   * Remove one reference from the credential store, tolerating absence and a failing provider.
   * @param service - credentials provider.
   * @param ref - reference to release.
   * @param reason - stable log label.
   */
  async function unsetQuietly(service, ref, reason) {
    try {
      await service.unset(ref);
      logger?.info?.(`inference credential released (${ref}; ${reason})`);
    } catch (error) {
      recordFailure(failureCode(error));
    }
  }

  /**
   * Drop the recorded reference and its bookkeeping; used when the feature is disabled.
   * @param service - credentials provider.
   * @param reason - stable log label.
   */
  async function release(service, reason) {
    const auth = store.readAuth();
    const recorded = auth?.inference ?? null;
    if (auth === null || recorded === null) return;
    await unsetQuietly(service, recorded.ref, reason);
    try {
      store.writeAuth({ ...auth, inference: null });
    } catch (error) {
      recordFailure(failureCode(error));
    }
  }

  /**
   * Read which layer supplied a reference before this module overwrites it.
   * @param service - credentials provider.
   * @param ref - reference about to be written.
   * @returns the source layer id, or null when unconfigured or undescribable.
   */
  async function describeSource(service, ref) {
    try {
      const info = await service.describe(ref);
      return typeof info?.source === 'string' && info.source !== '' ? info.source : null;
    } catch {
      // Bookkeeping only: an undescribable reference must not block the write.
      return null;
    }
  }

  /**
   * Whether the attempt that started at one generation still owns the state it would write.
   * @param startedGeneration - generation captured when the attempt started.
   * @param auth - login document the attempt read.
   * @param ref - reference the attempt is about to write.
   * @returns true while the same login, config, and module state are current.
   */
  function stillOwnsAttempt(startedGeneration, auth, ref) {
    if (generation !== startedGeneration) return false;
    const currentConfig = store.readConfig();
    const currentAuth = store.readAuth();
    return currentAuth !== null
      && currentAuth.accessToken === auth.accessToken
      && currentAuth.family === auth.family
      && currentConfig.inferenceEnabled
      && currentConfig.inferenceCredentialRef === ref;
  }

  /**
   * Issue the Coding Plan project token and store it under the configured reference.
   * @param force - re-issue even while the stored expiry is outside the refresh lead.
   * @throws {HostError} login_expired when the upstream business APIs reject the login.
   */
  async function performSync(force) {
    lastError = null;
    const service = credentialsService();
    if (service === undefined) {
      recordFailure(CREDENTIALS_UNAVAILABLE);
      return;
    }

    const startedGeneration = generation;
    const config = store.readConfig();
    if (!config.inferenceEnabled) {
      await release(service, 'inference disabled');
      return;
    }

    const auth = store.readAuth();
    if (auth === null) return;

    const ref = config.inferenceCredentialRef;
    const recorded = auth.inference;
    const family = auth.family ?? config.family;
    const referenceChanged = recorded !== null && recorded.ref !== ref;
    // A token issued for the other family belongs to the other origin, so it must
    // be rewritten even while its recorded expiry still looks fresh.
    const familyChanged = recorded !== null && recorded.family !== family;
    if (referenceChanged) {
      await unsetQuietly(service, recorded.ref, 'credential reference changed');
    }

    const fresh = recorded !== null
      && recorded.ref === ref
      && !familyChanged
      && Number.isFinite(recorded.expiresAt)
      && recorded.expiresAt - now() > INFERENCE_REFRESH_LEAD_MS;
    if (!force && fresh) return;

    let material;
    try {
      material = await account.getProjectMaterial({ family, auth, force });
    } catch (error) {
      recordFailure(failureCode(error));
      if (isAuthorizationFailure(error)) {
        throw error instanceof HostError && error.code === LOGIN_EXPIRED
          ? error
          : new HostError(LOGIN_EXPIRED, 'The BigModel login is no longer valid', { status: 401 });
      }
      return;
    }

    const token = typeof material?.token === 'string' ? material.token : '';
    if (token === '') {
      recordFailure(INVALID_MATERIAL);
      return;
    }

    // A logout or config change that committed while the token was in flight owns
    // the next state; writing now would resurrect a credential the user released.
    if (!stillOwnsAttempt(startedGeneration, auth, ref)) return;

    const previousSource = recorded !== null && recorded.ref === ref
      ? recorded.previousSource ?? null
      : await describeSource(service, ref);

    try {
      await service.set(ref, token);
    } catch (error) {
      recordFailure(failureCode(error));
      return;
    }

    // The credentials write is the slow step; re-check that the login still owns
    // it and release the value rather than leaving one no stored login owns.
    if (!stillOwnsAttempt(startedGeneration, auth, ref)) {
      await unsetQuietly(service, ref, 'login changed during write');
      return;
    }

    try {
      store.writeAuth({
        ...auth,
        keyLocation: material?.keyLocation ?? auth.keyLocation ?? null,
        inference: {
          ref,
          family,
          writtenAt: now(),
          expiresAt: Number.isFinite(material?.expiresAt) ? material.expiresAt : null,
          previousSource,
        },
      });
    } catch (error) {
      // The credential is already stored; the next sync retries the bookkeeping.
      recordFailure(failureCode(error));
      return;
    }

    recordSuccess();
    logger?.info?.(`inference credential stored (${ref}${previousSource === null ? '' : `, previous source ${previousSource}`})`);
  }

  /**
   * Refresh the inference credential, sharing one attempt between concurrent callers.
   * @param options - force re-issues even while the stored expiry is fresh.
   * @returns a promise settling when the attempt finished.
   * @throws {HostError} login_expired when the upstream business APIs reject the login.
   */
  function sync(options = {}) {
    if (inFlight !== null) return inFlight;
    let promise;
    promise = performSync(options.force === true).finally(() => {
      if (inFlight === promise) inFlight = null;
    });
    inFlight = promise;
    return promise;
  }

  /**
   * Remove the reference this login wrote and drop its bookkeeping.
   * Used by logout and when the user disables the feature; a missing
   * credentials service or an already-absent reference is tolerated.
   * @returns a promise settling when the release attempt finished.
   */
  async function clear() {
    generation += 1;
    recordSuccess();
    const service = credentialsService();
    const auth = store.readAuth();
    const recorded = auth?.inference ?? null;
    if (recorded === null) return;
    if (service !== undefined) await unsetQuietly(service, recorded.ref, 'login cleared');
    try {
      store.writeAuth({ ...auth, inference: null });
    } catch (error) {
      recordFailure(failureCode(error));
    }
  }

  /**
   * Describe the inference credential for the plugin UI.
   * @returns enabled, seam availability, stored bookkeeping including the recorded family, and the last sync error.
   */
  async function status() {
    const service = credentialsService();
    const config = store.readConfig();
    const auth = store.readAuth();
    const recorded = auth?.inference ?? null;
    const expiresAt = recorded?.expiresAt ?? null;
    return {
      enabled: config.inferenceEnabled,
      available: service !== undefined,
      ref: recorded?.ref ?? null,
      family: recorded?.family ?? null,
      writtenAt: recorded?.writtenAt ?? null,
      expiresAt,
      expiresInMs: expiresAt === null ? null : Math.max(0, expiresAt - now()),
      error: service === undefined ? CREDENTIALS_UNAVAILABLE : lastError,
    };
  }

  /**
   * Start the renewal loop: one immediate attempt, then one per interval.
   * @returns a disposer that clears the timer; it leaves the stored credential in place.
   */
  function start() {
    /** Detached attempts must never surface a rejection; failures are recorded in status(). */
    const fireAndForget = () => {
      sync().catch(() => {
        // performSync recorded and logged the failure; a detached run must not
        // become an unhandled rejection.
      });
    };
    fireAndForget();
    const timer = setInterval(fireAndForget, INFERENCE_SYNC_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { sync, clear, status, start };
}
