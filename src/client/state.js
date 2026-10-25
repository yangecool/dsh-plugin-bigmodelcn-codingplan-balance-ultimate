/**
 * Singleton client store for the BigModel Coding Plan plugin.
 *
 * Owns every same-origin request to the plugin's Host routes, the OAuth login
 * polling loop, cached overview/usage/reset payloads, and the single error
 * surface components read. The snapshot is immutable between changes so
 * `useSyncExternalStore` can compare references; `subscribe` returns the
 * disposer React calls on unmount and `dispose()` tears down timers, requests,
 * and listeners when the plugin unloads. No React import, no top-level DOM
 * access: this module is importable from a plain Node process.
 */
import { coreDicts, interpolate } from './dicts-core.js';

const ROUTE_PREFIX = '/bigmodelcn-codingplan';
const API_BASE = `${ROUTE_PREFIX}/api`;
const DEFAULT_REFRESH_MINUTES = 30;
const OVERVIEW_TTL_MS = 30_000;
const USAGE_TTL_MS = 120_000;
const RESET_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 25_000;
const POLL_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 15_000;
const USAGE_RANGES = Object.freeze(['today', '7d', '30d']);
const LOGIN_STATES = new Set(['idle', 'starting', 'pending', 'ready', 'failed', 'expired']);
const EMPTY_LOGIN = Object.freeze({ state: 'idle', authorizeUrl: null, error: null });
const EMPTY_LOADING = Object.freeze({ overview: false, usage: false, reset: false, login: false });

/** Typed store failure; Host error codes pass through unchanged. */
class ClientError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
    this.status = status;
  }
}

/** Snapshot shape: config/auth/overview/usage/range/reset/inference/login/loading/error/lastUpdated. */
function initialSnapshot() {
  return {
    config: null,
    auth: null,
    overview: null,
    usage: null,
    usageRange: 'today',
    reset: null,
    inference: null,
    login: { ...EMPTY_LOGIN },
    loading: { ...EMPTY_LOADING },
    error: null,
    lastUpdated: null,
  };
}

let snapshot = initialSnapshot();
const listeners = new Set();
const inflight = new Map();
const lastAttempt = new Map();
const controllers = new Set();
let translateFn = null;
let errorScope = null;
let bootstrapped = false;
let disposed = false;
let pollTimer = null;
let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

/** Replace the snapshot reference and notify subscribers (one failing listener cannot strand the rest). */
function set(changes) {
  if (disposed) return;
  snapshot = { ...snapshot, ...changes };
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('bigmodelcn-balance: state listener failed', error);
    }
  }
}

/** Update one loading flag without rebuilding the whole snapshot. */
function setLoading(scope, value) {
  if (snapshot.loading[scope] === value) return;
  set({ loading: { ...snapshot.loading, [scope]: value === true } });
}

/** Merge a login progress patch. */
function setLogin(patch) {
  set({ login: { ...snapshot.login, ...patch } });
}

/**
 * Bind the dictionary translate function after locale registration.
 * @param fn - `(key, params) => string`; null falls back to the English core copy.
 */
export function setTranslate(fn) {
  translateFn = typeof fn === 'function' ? fn : null;
}

/** Translate a key with the bound function, else the English core dictionary. */
function translate(key, params) {
  if (translateFn !== null) {
    const value = translateFn(key, params);
    if (typeof value === 'string' && value !== '' && value !== key) return value;
  }
  const template = coreDicts.en[key];
  return interpolate(template === undefined ? key : template, params);
}

/** Map an arbitrary thrown value to the snapshot's `{ code, message }` shape. */
function normalizeError(error) {
  if (error instanceof ClientError) return { code: error.code, message: error.message };
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'internal_error';
  const raw = typeof error?.message === 'string' ? error.message.trim() : '';
  return { code, message: raw === '' ? translate('state.error') : raw };
}

/** Clear the top-level error only when it belongs to the settling scope. */
function clearScopeError(scope) {
  if (errorScope !== scope) return;
  errorScope = null;
  if (snapshot.error !== null) set({ error: null });
}

/** Force the logged-out/expired auth state; cached payloads stay for display. */
function applyExpiredAuth() {
  stopLoginPolling();
  const previous = snapshot.auth;
  set({
    auth: {
      loggedIn: false,
      loginExpired: true,
      user: previous?.user ?? null,
      account: previous?.account ?? null,
      family: previous?.family ?? snapshot.config?.family ?? null,
    },
    inference: null,
    login: { state: 'expired', authorizeUrl: null, error: translate('auth.loginExpiredBody') },
  });
  setLoading('login', false);
}

/** Record a failure for one scope; a `login_expired` code clears the auth state. */
function recordError(scope, error) {
  const normalized = normalizeError(error);
  errorScope = scope;
  if (normalized.code === 'login_expired') applyExpiredAuth();
  set({ error: normalized });
  return normalized;
}

/** Read a finite number; null otherwise. */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Map a Host inference payload to the snapshot inference block.
 * Keeps credential metadata only (never a token) and tolerates a Host that
 * reports its error as `{ code, message }` instead of a code string.
 * @param inference - the `inference` object from `/api/status` or `/api/overview`.
 * @returns the normalized block, or null when the Host publishes none.
 */
function inferenceFromPayload(inference) {
  if (inference === null || typeof inference !== 'object' || Array.isArray(inference)) return null;
  const rawError = inference.error;
  const error = typeof rawError === 'string' && rawError !== ''
    ? rawError
    : rawError !== null && typeof rawError === 'object' && typeof rawError.code === 'string' && rawError.code !== ''
      ? rawError.code
      : null;
  return {
    enabled: inference.enabled === true,
    available: inference.available === true,
    ref: typeof inference.ref === 'string' && inference.ref !== '' ? inference.ref : null,
    family: typeof inference.family === 'string' && inference.family !== '' ? inference.family : null,
    writtenAt: finiteNumber(inference.writtenAt),
    expiresAt: finiteNumber(inference.expiresAt),
    expiresInMs: finiteNumber(inference.expiresInMs),
    error,
  };
}

/** Map a Host auth payload to the snapshot auth fields. */
function authFromPayload(auth) {
  if (auth === null || typeof auth !== 'object') return null;
  return {
    loggedIn: auth.loggedIn === true,
    loginExpired: auth.loginExpired === true,
    user: auth.user ?? null,
    account: auth.account ?? null,
    family: typeof auth.family === 'string' && auth.family !== '' ? auth.family : null,
  };
}

/** Map a Host login payload to the snapshot login block. */
function loginFromPayload(login) {
  if (login === null || typeof login !== 'object') return { ...EMPTY_LOGIN };
  return {
    state: LOGIN_STATES.has(login.state) ? login.state : 'idle',
    authorizeUrl: typeof login.authorizeUrl === 'string' && login.authorizeUrl !== '' ? login.authorizeUrl : null,
    error: typeof login.error === 'string' && login.error !== '' ? login.error : null,
  };
}

/** Same-origin URL for one Host API route. */
function routeUrl(path, query) {
  const search = query === undefined ? '' : new URLSearchParams(query).toString();
  return `${API_BASE}${path}${search === '' ? '' : `?${search}`}`;
}

/** Browser time zone for the usage query, or UTC outside a browser. */
function timeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Call one Host route and unwrap `{ data }`.
 * @param path - route path after `/api`.
 * @param options - `method`, JSON `body`, `query` params, `timeoutMs`.
 * @returns the unwrapped data payload.
 * @throws {ClientError} with the Host code for HTTP failures, `network_error` /
 *   `upstream_timeout` for transport failures.
 */
async function request(path, options = {}) {
  const { method = 'GET', body, query, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (controller !== null) controllers.add(controller);
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await globalThis.fetch(routeUrl(path, query), {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller === null ? undefined : controller.signal,
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const hostError = payload !== null && typeof payload === 'object' ? payload.error : undefined;
    if (hostError !== null && typeof hostError === 'object') {
      throw new ClientError(
        typeof hostError.code === 'string' && hostError.code !== '' ? hostError.code : 'internal_error',
        typeof hostError.message === 'string' ? hostError.message : '',
        response.status,
      );
    }
    if (response.ok !== true) throw new ClientError('internal_error', translate('state.error'), response.status);
    if (payload === null || typeof payload !== 'object' || !('data' in payload)) {
      throw new ClientError('internal_error', translate('state.error'), response.status);
    }
    return payload.data;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    const aborted = controller !== null && controller.signal.aborted === true;
    throw new ClientError(aborted ? 'upstream_timeout' : 'network_error', translate('state.networkError'));
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (controller !== null) controllers.delete(controller);
  }
}

/** Share one in-flight promise per cache key. */
function runOnce(key, task) {
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;
  const promise = Promise.resolve().then(task).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/** Kick the one-time config + status load without blocking the caller. */
function ensureBootstrap() {
  if (bootstrapped || disposed || inflight.has('bootstrap')) return;
  void bootstrap();
}

/** Normalize the upstream poll interval into a safe timer delay. */
function normalizePollInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, numeric));
}

/** Schedule the next login poll; at most one timer exists at a time. */
function scheduleLoginPoll() {
  stopLoginPolling();
  if (disposed) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void pollLogin();
  }, pollIntervalMs);
  if (typeof pollTimer?.unref === 'function') pollTimer.unref();
}

/** Cancel a scheduled login poll. */
function stopLoginPolling() {
  if (pollTimer === null) return;
  clearTimeout(pollTimer);
  pollTimer = null;
}

/** Stable idempotency key for the reset-consumption route. */
function createIdempotencyKey() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `bmc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Whether the current document is hidden (`tick` pauses auto-refresh then). */
function isHidden() {
  return globalThis.document !== undefined && globalThis.document.visibilityState === 'hidden';
}

/** Configured auto-refresh interval in milliseconds. */
function refreshIntervalMs() {
  const minutes = Number(snapshot.config?.refreshMinutes);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_REFRESH_MINUTES;
  return safe * 60_000;
}

/**
 * Load config + login status once; failures surface through `error`.
 * @returns the snapshot after the attempt.
 */
export function bootstrap() {
  if (bootstrapped) return Promise.resolve(snapshot);
  return runOnce('bootstrap', async () => {
    try {
      const data = await request('/status', { timeoutMs: STATUS_TIMEOUT_MS });
      const config = data?.config !== null && typeof data?.config === 'object' ? data.config : null;
      const login = loginFromPayload(data?.login);
      bootstrapped = true;
      set({
        config,
        auth: authFromPayload(data?.auth),
        inference: inferenceFromPayload(data?.inference),
        login,
      });
      clearScopeError('bootstrap');
      if (login.state === 'pending') scheduleLoginPoll();
    } catch (error) {
      recordError('bootstrap', error);
    }
    return snapshot;
  });
}

/**
 * Refresh the aggregated overview.
 * @param options - `force` bypasses the 30 s freshness window.
 * @returns the overview payload, or null on failure.
 */
export function refreshOverview(options) {
  ensureBootstrap();
  const force = options?.force === true;
  const cached = snapshot.overview;
  if (!force && cached !== null && Date.now() - (lastAttempt.get('overview') ?? 0) < OVERVIEW_TTL_MS) {
    return Promise.resolve(cached);
  }
  return runOnce('overview', async () => {
    setLoading('overview', true);
    try {
      const data = await request('/overview', { query: force ? { force: '1' } : undefined });
      if (data === null || typeof data !== 'object') return null;
      const auth = authFromPayload(data.auth);
      const changes = {
        overview: data,
        inference: inferenceFromPayload(data.inference),
        lastUpdated: Number.isFinite(data.generatedAt) ? data.generatedAt : Date.now(),
      };
      if (auth !== null) changes.auth = auth;
      set(changes);
      if (auth !== null && auth.loginExpired) applyExpiredAuth();
      const hostError = data.error;
      if (hostError !== null && typeof hostError === 'object') {
        recordError('overview', new ClientError(
          typeof hostError.code === 'string' && hostError.code !== '' ? hostError.code : 'upstream_failed',
          typeof hostError.message === 'string' ? hostError.message : '',
        ));
      } else {
        clearScopeError('overview');
      }
      return data;
    } catch (error) {
      recordError('overview', error);
      return null;
    } finally {
      lastAttempt.set('overview', Date.now());
      setLoading('overview', false);
    }
  });
}

/**
 * Load usage statistics for one range.
 * @param range - `'today'` | `'7d'` | `'30d'`; omitted keeps the current range.
 * @param options - `force` bypasses the 2 min freshness window.
 * @returns the usage payload, or null on failure.
 */
export function loadUsage(range, options) {
  ensureBootstrap();
  const selected = USAGE_RANGES.includes(range) ? range : snapshot.usageRange;
  if (selected !== snapshot.usageRange) set({ usageRange: selected, usage: null });
  const force = options?.force === true;
  const cached = snapshot.usage;
  if (!force && cached !== null && cached.range === selected && Date.now() - (lastAttempt.get('usage') ?? 0) < USAGE_TTL_MS) {
    return Promise.resolve(cached);
  }
  return runOnce(`usage:${selected}`, async () => {
    setLoading('usage', true);
    try {
      const query = { range: selected, tz: timeZone(), ...(force ? { force: '1' } : {}) };
      const data = await request('/usage', { query });
      if (data === null || typeof data !== 'object') return null;
      if (snapshot.usageRange === selected) set({ usage: data });
      clearScopeError('usage');
      return data;
    } catch (error) {
      recordError('usage', error);
      return null;
    } finally {
      lastAttempt.set('usage', Date.now());
      setLoading('usage', false);
    }
  });
}

/**
 * Load the reset-chances block.
 * @param options - `force` bypasses the 1 min freshness window.
 * @returns the reset payload, or null on failure.
 */
export function loadReset(options) {
  ensureBootstrap();
  const force = options?.force === true;
  if (!force && snapshot.reset !== null && Date.now() - (lastAttempt.get('reset') ?? 0) < RESET_TTL_MS) {
    return Promise.resolve(snapshot.reset);
  }
  return runOnce('reset', async () => {
    setLoading('reset', true);
    try {
      const data = await request('/reset', { query: force ? { force: '1' } : undefined });
      if (data === null || typeof data !== 'object') return null;
      set({ reset: data });
      clearScopeError('reset');
      return data;
    } catch (error) {
      recordError('reset', error);
      return null;
    } finally {
      lastAttempt.set('reset', Date.now());
      setLoading('reset', false);
    }
  });
}

/**
 * Consume one reset chance, then refresh reset and overview in the background.
 * @param resetType - reset kind accepted by the Host (`'fiveHour'` | `'week'`).
 * @returns `{ ok: true }` or `{ ok: false, error }`; never rejects.
 */
export function useReset(resetType) {
  if (typeof resetType !== 'string' || resetType === '') {
    return Promise.resolve({ ok: false, error: { code: 'invalid_request', message: translate('state.error') } });
  }
  return runOnce(`reset-use:${resetType}`, async () => {
    try {
      await request('/reset/use', {
        method: 'POST',
        body: { resetType, idempotencyKey: createIdempotencyKey() },
      });
      clearScopeError('reset');
      void loadReset({ force: true });
      void refreshOverview({ force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: recordError('reset', error) };
    }
  });
}

/**
 * Start an OAuth login flow and begin polling.
 * @param options - optional `family` (`'bigmodel'` | `'zai'`); the Host config applies otherwise.
 * @returns the upstream authorize URL the page opens in a browser tab.
 * @throws {ClientError} with the normalized code/message on failure (the login block also records it).
 */
export function startLogin(options) {
  const family = typeof options?.family === 'string' && options.family !== '' ? options.family : undefined;
  setLogin({ state: 'starting', authorizeUrl: null, error: null });
  setLoading('login', true);
  errorScope = null;
  if (snapshot.error !== null) set({ error: null });
  return runOnce('login-start', async () => {
    try {
      const data = await request('/login', {
        method: 'POST',
        body: family === undefined ? {} : { family },
        timeoutMs: LOGIN_TIMEOUT_MS,
      });
      const authorizeUrl = typeof data?.authorizeUrl === 'string' ? data.authorizeUrl : '';
      if (authorizeUrl === '') throw new ClientError('oauth_invalid_response', translate('auth.loginFailed'));
      pollIntervalMs = normalizePollInterval(data?.pollIntervalMs);
      setLogin({ state: 'pending', authorizeUrl, error: null });
      scheduleLoginPoll();
      clearScopeError('login');
      return authorizeUrl;
    } catch (error) {
      const normalized = error instanceof ClientError ? error : new ClientError('network_error', translate('auth.loginFailed'));
      recordError('login', normalized);
      setLogin({ state: 'failed', authorizeUrl: null, error: normalized.message });
      throw normalized;
    } finally {
      setLoading('login', false);
    }
  });
}

/** Stop local login polling and clear the pending login block. */
export function cancelLogin() {
  stopLoginPolling();
  setLogin({ state: 'idle', authorizeUrl: null, error: null });
  setLoading('login', false);
}

/** Poll the Host login flow once; the loop reschedules itself while pending. */
export async function pollLogin() {
  const currentState = snapshot.login.state;
  if (currentState !== 'pending' && currentState !== 'starting') return snapshot.login;
  return runOnce('login-poll', pollLoginOnce);
}

/** One poll response, mapped onto the login block. */
async function pollLoginOnce() {
  let data;
  try {
    data = await request('/login/poll', { timeoutMs: POLL_TIMEOUT_MS });
  } catch {
    // Transport hiccups keep the flow alive; the next scheduled poll retries.
    scheduleLoginPoll();
    return snapshot.login;
  }
  const state = typeof data?.state === 'string' ? data.state : 'pending';
  if (state === 'pending') {
    scheduleLoginPoll();
    return snapshot.login;
  }
  stopLoginPolling();
  switch (state) {
    case 'ready': {
      setLogin({ state: 'ready', authorizeUrl: null, error: null });
      await afterLoginReady();
      return snapshot.login;
    }
    case 'failed': {
      const message = typeof data?.error === 'string' && data.error !== '' ? data.error : translate('auth.loginFailed');
      setLogin({ state: 'failed', authorizeUrl: null, error: message });
      recordError('login', new ClientError('login_failed', message));
      return snapshot.login;
    }
    case 'expired': {
      setLogin({ state: 'expired', authorizeUrl: null, error: translate('auth.loginExpiredBody') });
      setLoading('login', false);
      return snapshot.login;
    }
    case 'idle':
    default: {
      setLogin({ state: 'idle', authorizeUrl: null, error: null });
      setLoading('login', false);
      return snapshot.login;
    }
  }
}

/** After a successful login: refresh status and overview once. */
async function afterLoginReady() {
  setLoading('login', false);
  stopLoginPolling();
  try {
    const data = await request('/status', { timeoutMs: STATUS_TIMEOUT_MS });
    if (data !== null && typeof data === 'object') {
      const login = loginFromPayload(data.login);
      const changes = {
        inference: inferenceFromPayload(data.inference),
        login: login.state === 'ready' ? { ...login, state: 'idle' } : login,
      };
      if (data.config !== null && typeof data.config === 'object') changes.config = data.config;
      const auth = authFromPayload(data.auth);
      if (auth !== null) changes.auth = auth;
      bootstrapped = true;
      set(changes);
      clearScopeError('login');
    }
  } catch {
    // A completed OAuth flow is not undone by a failed status refresh; the
    // overview refresh below reports the failure through the shared error.
  }
  await refreshOverview({ force: true });
}

/**
 * Sign out and clear cached account data.
 * @returns `{ ok: true }` or `{ ok: false, error }`; never rejects.
 */
export function logout() {
  return runOnce('logout', async () => {
    stopLoginPolling();
    try {
      await request('/logout', { method: 'POST' });
    } catch (error) {
      return { ok: false, error: recordError('auth', error) };
    }
    set({
      auth: { loggedIn: false, loginExpired: false, user: null, account: null, family: snapshot.config?.family ?? null },
      overview: null,
      usage: null,
      reset: null,
      inference: null,
      login: { ...EMPTY_LOGIN },
      lastUpdated: null,
    });
    lastAttempt.clear();
    errorScope = null;
    if (snapshot.error !== null) set({ error: null });
    return { ok: true };
  });
}

/**
 * Persist a partial config patch and apply the sanitized config immediately.
 * A signed-in store refreshes the overview in the background afterward, so a
 * family or refresh-interval change is reflected without a reload.
 * @param patch - subset of the plugin config.
 * @returns `{ ok: true, config }` or `{ ok: false, error }`; never rejects.
 */
export function saveConfig(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return Promise.resolve({ ok: false, error: { code: 'invalid_request', message: translate('state.error') } });
  }
  return runOnce('config-save', async () => {
    try {
      const data = await request('/config', { method: 'POST', body: patch });
      const config = data !== null && typeof data === 'object' ? data : null;
      if (config !== null) set({ config });
      clearScopeError('config');
      const loggedIn = snapshot.auth !== null && snapshot.auth.loggedIn === true;
      if (loggedIn) void refreshOverview({ force: true });
      return { ok: true, config };
    } catch (error) {
      return { ok: false, error: recordError('config', error) };
    }
  });
}

/**
 * Select the usage range. Does not fetch; call `loadUsage(range)` for data.
 * @param range - `'today'` | `'7d'` | `'30d'`.
 * @returns the active range after the call.
 */
export function setUsageRange(range) {
  if (!USAGE_RANGES.includes(range)) return snapshot.usageRange;
  if (range !== snapshot.usageRange) set({ usageRange: range, usage: null });
  return range;
}

/** Clear the shared error notice. */
export function dismissError() {
  errorScope = null;
  if (snapshot.error !== null) set({ error: null });
}

/**
 * Auto-refresh entry point, called by the entry's 30 s ticker.
 * Honors `config.refreshMinutes`, pauses in hidden documents, resumes a
 * pending login poll, and bootstraps a store that was never started.
 * @returns a promise settling after the triggered requests finish.
 */
export function tick() {
  if (disposed || isHidden()) return Promise.resolve();
  if (!bootstrapped) return bootstrap().then(() => undefined);
  const tasks = [];
  if (snapshot.login.state === 'pending') tasks.push(pollLogin());
  const loggedIn = snapshot.auth !== null && snapshot.auth.loggedIn === true;
  if (snapshot.config !== null) {
    const interval = refreshIntervalMs();
    const stale = (key) => Date.now() - (lastAttempt.get(key) ?? 0) >= interval;
    if (loggedIn && stale('overview')) tasks.push(refreshOverview());
    if (loggedIn && snapshot.usage !== null && stale('usage')) tasks.push(loadUsage(snapshot.usageRange));
    if (loggedIn && snapshot.reset !== null && stale('reset')) tasks.push(loadReset());
  }
  return tasks.length === 0 ? Promise.resolve() : Promise.all(tasks).then(() => undefined);
}

/** Detach every timer, request, and subscriber; called when the plugin unloads. */
export function dispose() {
  disposed = true;
  stopLoginPolling();
  for (const controller of controllers) {
    try {
      controller.abort();
    } catch {
      // Aborting a request that already settled never throws.
    }
  }
  controllers.clear();
  listeners.clear();
  inflight.clear();
}

/** Subscribe to snapshot changes; returns the disposer React calls on unmount. */
function subscribe(listener) {
  if (typeof listener !== 'function' || disposed) return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** @returns the current immutable snapshot (stable until the next change). */
function getSnapshot() {
  return snapshot;
}

/**
 * Store singleton shared by every client module and component.
 * @type {{ subscribe: (fn: () => void) => () => void, getSnapshot: () => object }}
 */
export const state = Object.freeze({
  subscribe,
  getSnapshot,
  bootstrap,
  refreshOverview,
  loadUsage,
  loadReset,
  useReset,
  startLogin,
  pollLogin,
  cancelLogin,
  logout,
  saveConfig,
  setUsageRange,
  tick,
  dismissError,
  translate,
  dispose,
});
