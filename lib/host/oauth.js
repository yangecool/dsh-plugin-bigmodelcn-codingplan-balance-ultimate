/**
 * ZCode CLI OAuth flow behind the plugin's login button.
 *
 * Starting a flow calls the ZCode relay's CLI init endpoint and returns the
 * browser URL the user opens. While the user authorizes there, the Host polls
 * the flow until the relay reports tokens; one flow is pending per plugin
 * instance. Tokens are persisted through the store, never logged, and never
 * included in an error message.
 */
import { randomBytes } from 'node:crypto';
import {
  FAMILIES,
  FAMILY_IDS,
  OAUTH_FLOW_TIMEOUT_MS,
  OAUTH_INIT_PATH,
  REQUEST_TIMEOUT_MS,
  ZAI_BUSINESS_LOGIN_PATH,
  ZCODE_ORIGIN,
  oauthPollPath,
} from './constants.js';
import { HostError, describeUrl, jwtExpiresAt } from './http.js';

/** Shortest poll interval accepted from the relay; anything faster busy-loops the GUI. */
const MIN_POLL_INTERVAL_MS = 1_000;

const INVALID_RESPONSE_MESSAGE = 'The BigModel authorization service returned an unexpected response';
const UNAVAILABLE_MESSAGE = 'The BigModel authorization service is unavailable';
const FAILED_MESSAGE = 'The browser authorization was not completed';

/** Read a non-empty trimmed string. */
function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** True for a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Typed failure for an unreachable or failing OAuth relay. */
function unavailable() {
  return new HostError('oauth_unavailable', UNAVAILABLE_MESSAGE, { status: 502 });
}

/** Typed failure for a reply that cannot be the documented envelope. */
function invalidResponse() {
  return new HostError('oauth_invalid_response', INVALID_RESPONSE_MESSAGE, { status: 502 });
}

/** Typed failure for a family argument outside the supported set. */
function invalidFamily(family) {
  return new HostError('invalid_request', `Unknown provider family "${String(family)}"`, { status: 400 });
}

/** Typed failure for the Z.AI OAuth-to-business token exchange. */
function businessLoginFailure() {
  return new HostError('zai_business_login_failed', 'The Z.AI business login exchange failed', { status: 502 });
}

/**
 * Build the OAuth controller bound to one plugin instance.
 * @param options - HTTP client, auth store, logger, and clock injection.
 * @returns start, poll, cancel, pending, and logout; the state machine is documented in notes/contracts.md.
 */
export function createOAuth({ http, store, logger, now = () => Date.now() }) {
  /** Pending flow, or null when no login is in progress. */
  let flow = null;
  /** Monotonic start counter: a slow init response must not replace a newer flow. */
  let generation = 0;

  /** Validate a family id and return its protocol entry. */
  function familyEntry(family) {
    if (typeof family !== 'string' || !FAMILY_IDS.includes(family)) throw invalidFamily(family);
    return FAMILIES[family];
  }

  /**
   * Remember the details of one polled flow.
   * @param envelope - parsed init response body.
   * @param family - validated family id.
   * @returns the client-facing start payload.
   */
  function beginFlow(envelope, family) {
    const data = isRecord(envelope) && envelope.code === 0 && isRecord(envelope.data) ? envelope.data : null;
    const flowId = readString(data?.flow_id);
    const authorizeUrlText = readString(data?.authorize_url);
    const expiresAtSeconds = data?.expires_at;
    const pollIntervalSeconds = data?.poll_interval_sec;
    if (
      flowId === undefined ||
      authorizeUrlText === undefined ||
      typeof expiresAtSeconds !== 'number' ||
      !Number.isFinite(expiresAtSeconds) ||
      typeof pollIntervalSeconds !== 'number' ||
      !Number.isFinite(pollIntervalSeconds)
    ) {
      throw invalidResponse();
    }
    let authorizeUrl;
    try {
      authorizeUrl = new URL(authorizeUrlText);
    } catch {
      throw invalidResponse();
    }
    if (authorizeUrl.protocol !== 'https:') throw invalidResponse();

    const startedAt = now();
    const initExpiresAt = expiresAtSeconds * 1_000;
    const expiresAt = Math.min(initExpiresAt, startedAt + OAUTH_FLOW_TIMEOUT_MS);
    const remainingMs = expiresAt - startedAt;
    const pollIntervalMs = pollIntervalSeconds * 1_000;
    if (remainingMs <= 0 || pollIntervalMs < MIN_POLL_INTERVAL_MS || pollIntervalMs >= remainingMs) {
      throw invalidResponse();
    }

    return { family, flowId, authorizeUrl: authorizeUrl.toString(), expiresAt, pollIntervalMs, startedAt };
  }

  /**
   * Exchange the Z.AI OAuth access token for the business JWT used by api.z.ai.
   * The login request carries no authorization header; the raw OAuth token is
   * the request body field.
   * @param oauthAccessToken - Z.AI OAuth access token from the ready poll payload.
   * @returns the business JWT and its optional lifetime in milliseconds.
   */
  async function exchangeZaiBusinessToken(oauthAccessToken) {
    const url = `${FAMILIES.zai.origin}${ZAI_BUSINESS_LOGIN_PATH}`;
    let response;
    try {
      response = await http.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        json: { token: oauthAccessToken },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      logger?.warn?.(`zai business login failed: ${describeUrl(url)} (${error instanceof HostError ? error.code : 'transport'})`);
      throw businessLoginFailure();
    }
    if (response.status >= 500) {
      logger?.warn?.(`zai business login failed: ${describeUrl(url)} (status ${response.status})`);
      throw businessLoginFailure();
    }
    if (response.status < 200 || response.status >= 300) {
      logger?.warn?.(`zai business login rejected: ${describeUrl(url)} (status ${response.status})`);
      throw businessLoginFailure();
    }
    const body = response.body;
    const code = isRecord(body) ? body.code : undefined;
    const successCode = code === undefined || code === null || code === 0 || code === 200 || code === '0' || code === '200';
    if (!isRecord(body) || !successCode || body.success === false) {
      logger?.warn?.(`zai business login invalid envelope: ${describeUrl(url)}`);
      throw businessLoginFailure();
    }
    const data = isRecord(body.data) ? body.data : null;
    const accessToken = readString(data?.access_token) ?? readString(data?.accessToken);
    if (accessToken === undefined) {
      logger?.warn?.(`zai business login invalid envelope: ${describeUrl(url)}`);
      throw businessLoginFailure();
    }
    const expiresInSeconds = Number(data?.expires_in);
    const expiresInMs = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds * 1_000 : null;
    logger?.info?.(`zai business login completed: ${describeUrl(url)}`);
    return { accessToken, expiresInMs };
  }

  /**
   * Start one login flow, replacing any flow that was still pending.
   * @param options - the selected provider family.
   * @returns authorize URL, expiry, poll cadence, and family for the Client.
   * @throws {HostError} invalid_request, oauth_unavailable, or oauth_invalid_response.
   */
  async function start({ family } = {}) {
    const entry = familyEntry(family);
    generation += 1;
    const startedGeneration = generation;
    flow = null;
    const pollToken = randomBytes(32).toString('hex');
    const initUrl = `${ZCODE_ORIGIN}${OAUTH_INIT_PATH}`;
    let response;
    try {
      response = await http.request(initUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${pollToken}`, 'content-type': 'application/json' },
        json: { provider: entry.authorizeProvider },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      logger?.warn?.(`oauth init failed: ${describeUrl(initUrl)} (${error instanceof HostError ? error.code : 'transport'})`);
      throw unavailable();
    }
    if (response.status >= 500) {
      logger?.warn?.(`oauth init failed: ${describeUrl(initUrl)} (status ${response.status})`);
      throw unavailable();
    }
    if (response.status < 200 || response.status >= 300) {
      logger?.warn?.(`oauth init rejected: ${describeUrl(initUrl)} (status ${response.status})`);
      throw invalidResponse();
    }

    const started = beginFlow(response.body, family);
    // A newer start (or a cancel) owns the pending slot; this reply only serves its caller.
    if (generation !== startedGeneration) {
      return { authorizeUrl: started.authorizeUrl, expiresAt: started.expiresAt, pollIntervalMs: started.pollIntervalMs, family };
    }
    flow = {
      family,
      flowId: started.flowId,
      pollToken,
      authorizeUrl: started.authorizeUrl,
      expiresAt: started.expiresAt,
      pollIntervalMs: started.pollIntervalMs,
      nextPollAt: started.startedAt,
    };
    logger?.info?.(`oauth flow started: ${describeUrl(initUrl)} (interval ${started.pollIntervalMs}ms)`);
    return { authorizeUrl: started.authorizeUrl, expiresAt: started.expiresAt, pollIntervalMs: started.pollIntervalMs, family };
  }

  /**
   * Persist the tokens of a ready flow.
   * The BigModel family already returns its business token; the Z.AI family
   * returns an OAuth token that is exchanged for a business JWT first.
   * @param family - validated family id.
   * @param data - ready poll payload.
   * @returns the stored user summary; the exchange failure propagates as a typed HostError.
   */
  async function completeFlow(family, data) {
    const familyPayload = isRecord(data[family]) ? data[family] : null;
    const userPayload = isRecord(data.user) ? data.user : null;
    const zcodeJwtToken = readString(data.token);
    const providerAccessToken =
      family === 'zai'
        ? readString(familyPayload?.access_token)
        : readString(familyPayload?.access_token) ?? readString(familyPayload?.accessToken);
    const userId = readString(userPayload?.user_id);
    if (zcodeJwtToken === undefined || providerAccessToken === undefined || userId === undefined) {
      throw invalidResponse();
    }
    const email = readString(userPayload?.email);
    const avatar = readString(userPayload?.avatar);
    const refreshToken =
      family === 'bigmodel'
        ? readString(familyPayload?.refresh_token) ?? readString(familyPayload?.refreshToken)
        : undefined;
    const exchange =
      family === 'zai' ? await exchangeZaiBusinessToken(providerAccessToken) : { accessToken: providerAccessToken, expiresInMs: null };
    const accessToken = exchange.accessToken;
    const jwtExpiresAtMs = jwtExpiresAt(accessToken);
    const expiresAt =
      jwtExpiresAtMs ?? (exchange.expiresInMs === null ? null : now() + exchange.expiresInMs);
    const user = {
      id: userId,
      name: readString(userPayload?.name) ?? email ?? userId,
      email: email ?? null,
      avatar: avatar ?? null,
    };
    store.writeAuth({
      family,
      accessToken,
      zcodeJwtToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      expiresAt,
      loggedInAt: now(),
      user,
      account: {},
      keyLocation: null,
    });
    logger?.info?.(`oauth flow completed for ${family}`);
    return user;
  }

  /**
   * Advance the pending flow, performing at most one poll request.
   * @returns idle, pending, ready, failed, or expired state for the Client.
   * @throws {HostError} oauth_invalid_response for a terminal malformed ready reply.
   */
  async function poll() {
    if (flow === null) {
      const auth = store.readAuth();
      return auth === null ? { state: 'idle' } : { state: 'ready', user: auth.user };
    }
    const current = flow;
    const at = now();
    if (at > current.expiresAt) {
      flow = null;
      logger?.info?.('oauth flow expired');
      return { state: 'expired' };
    }
    if (at < current.nextPollAt) return { state: 'pending' };
    current.nextPollAt = at + current.pollIntervalMs;

    const pollUrl = `${ZCODE_ORIGIN}${oauthPollPath(current.flowId)}`;
    let response;
    try {
      response = await http.request(pollUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${current.pollToken}` },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      // A single network failure or timeout must not cancel a flow the browser may still complete.
      logger?.warn?.(`oauth poll will retry: ${describeUrl(pollUrl)} (${error instanceof HostError ? error.code : 'transport'})`);
      return { state: 'pending' };
    }
    if (flow !== current) return flow === null ? { state: 'idle' } : { state: 'pending' };
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      logger?.warn?.(`oauth poll will retry: ${describeUrl(pollUrl)} (status ${response.status})`);
      return { state: 'pending' };
    }
    if (response.status < 200 || response.status >= 300) {
      flow = null;
      logger?.warn?.(`oauth poll failed: ${describeUrl(pollUrl)} (status ${response.status})`);
      return { state: 'failed', error: FAILED_MESSAGE };
    }

    const data = isRecord(response.body) && response.body.code === 0 && isRecord(response.body.data) ? response.body.data : null;
    if (data === null) {
      flow = null;
      throw invalidResponse();
    }
    const status = readString(data.status);
    if (status === 'pending') return { state: 'pending' };
    if (status === 'failed') {
      flow = null;
      logger?.warn?.(`oauth poll failed: ${describeUrl(pollUrl)} (status failed)`);
      return { state: 'failed', error: FAILED_MESSAGE };
    }
    if (status !== 'ready') {
      flow = null;
      throw invalidResponse();
    }

    let user;
    try {
      user = await completeFlow(current.family, data);
    } catch (error) {
      flow = null;
      // The Z.AI OAuth token was valid but the business exchange failed: report
      // the stable failure code instead of leaking anything about the token.
      if (error instanceof HostError && error.code === 'zai_business_login_failed') {
        return { state: 'failed', error: error.code };
      }
      throw error;
    }
    flow = null;
    return { state: 'ready', user };
  }

  /** Forget the pending flow, if any; an in-flight start can no longer install itself. */
  async function cancel() {
    generation += 1;
    flow = null;
  }

  /** @returns the pending flow metadata, or null when no login is in progress. */
  function pending() {
    return flow === null
      ? null
      : { family: flow.family, authorizeUrl: flow.authorizeUrl, expiresAt: flow.expiresAt };
  }

  /** Forget any pending flow and remove the stored login. */
  async function logout() {
    await cancel();
    store.clearAuth();
  }

  return { start, poll, cancel, pending, logout };
}
