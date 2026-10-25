/**
 * BigModel/Z.AI account and Coding Plan authorization.
 *
 * Three upstream steps back the plugin's data requests:
 *  1. customer info resolves the account's organizations and projects,
 *  2. project API-key management reuses (or creates) the Coding Plan key,
 *  3. access-token issuance mints the short-lived project token used as the
 *     authorization value of the monitor/business APIs.
 *
 * All request functions accept an injected clock and keep their caches in the
 * factory closure, so tests can create isolated instances and move time forward.
 */
import {
  ACCESS_TOKEN_CLIENT_TYPE,
  ACCESS_TOKEN_CLIENT_VERSION,
  API_KEY_NAME,
  CODING_PLAN_USAGE_SCENE,
  CUSTOMER_INFO_PATH,
  FAMILIES,
  FAMILY_IDS,
  PROJECT_TOKEN_REFRESH_LEAD_MS,
  REQUEST_TIMEOUT_MS,
  accessTokensPath,
  apiKeysPath,
} from './constants.js';
import { HostError, describeUrl } from './http.js';

/** Freshness of the in-memory customer-info cache; `force` bypasses it. */
const ACCOUNT_TTL_MS = 60 * 60_000;

/** Envelope success codes shared by the BigModel business, key, and token APIs. */
const SUCCESS_CODES = new Set([0, 200, '0', '200']);

/** ZCode project naming that marks the account's default personal workspace. */
const DEFAULT_ORGANIZATION_NAME = '默认机构';
const DEFAULT_PROJECT_NAME = '默认项目';

/** Personal projects carry this `projectType`; team projects must not be used. */
const TEAM_PROJECT_TYPE = '2';

/** Read a non-empty trimmed string. */
function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** True for a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Typed failure for a request that is not about a supported provider family. */
function invalidFamily(family) {
  return new HostError('invalid_request', `Unknown provider family "${String(family)}"`, { status: 400 });
}

/** Typed failure for a login whose credentials the service rejected. */
function loginExpired() {
  return new HostError('login_expired', 'The login has expired; sign in again', { status: 401 });
}

/** Typed failure for a response that is not the documented envelope. */
function invalidResponse(detail) {
  return new HostError('upstream_failed', 'The BigModel service returned an unexpected response', {
    status: 502,
    detail,
  });
}

/** Map a transport failure from http.request to a stable route error. */
function transportFailure(error) {
  if (error instanceof HostError && error.code === 'upstream_timeout') return error;
  return new HostError('upstream_failed', 'The BigModel service is unavailable', { status: 502, detail: 'transport' });
}

/** Build the authorization header used by key-management (not customer-info) requests. */
function keyAuthorization(family, accessToken) {
  return family === 'zai' ? `Bearer ${accessToken}` : accessToken;
}

/** Read a complete key location, or null when any id is missing. */
function readKeyLocation(value) {
  if (!isRecord(value)) return null;
  const organizationId = readString(value.organizationId);
  const projectId = readString(value.projectId);
  const apiKeyId = readString(value.apiKeyId);
  if (organizationId === undefined || projectId === undefined || apiKeyId === undefined) return null;
  return { organizationId, projectId, apiKeyId };
}

/**
 * Select the personal (non-team) project Coding Plan requests use.
 * Team projects are excluded, a organization/project named 默认机构/默认项目 wins,
 * and the first remaining entry is the fallback.
 * @param account - normalized customer info (`organizations[].projects[]`).
 * @returns `{ organizationId, projectId }`, or null when no personal project exists.
 */
export function pickPersonalProject(account) {
  const organizations = isRecord(account) && Array.isArray(account.organizations) ? account.organizations : [];
  const personal = [];
  for (const organization of organizations) {
    if (!isRecord(organization) || readString(organization.organizationId) === undefined) continue;
    const projects = (Array.isArray(organization.projects) ? organization.projects : []).filter(
      (project) =>
        isRecord(project) &&
        readString(project.projectId) !== undefined &&
        String(project.projectType ?? '').trim() !== TEAM_PROJECT_TYPE,
    );
    if (projects.length > 0) personal.push({ organization, projects });
  }
  if (personal.length === 0) return null;
  const selected =
    personal.find(({ organization }) => String(organization.organizationName ?? '').includes(DEFAULT_ORGANIZATION_NAME)) ??
    personal[0];
  const project =
    selected.projects.find((item) => String(item.projectName ?? '').includes(DEFAULT_PROJECT_NAME)) ??
    selected.projects[0];
  return {
    organizationId: readString(selected.organization.organizationId),
    projectId: readString(project.projectId),
  };
}

/** Normalize one customer-info payload into the documented account document. */
function normalizeAccount(data) {
  if (!isRecord(data)) throw invalidResponse('customer_info');
  const organizations = Array.isArray(data.organizations) ? data.organizations : [];
  return {
    customerNumber: readString(data.customerNumber) ?? null,
    customerName: readString(data.customerName) ?? null,
    nickName: readString(data.nickName) ?? null,
    avatar: readString(data.avatar) ?? null,
    organizations: organizations.filter(isRecord).map((organization) => ({
      organizationId: readString(organization.organizationId) ?? '',
      organizationName: readString(organization.organizationName) ?? null,
      projects: (Array.isArray(organization.projects) ? organization.projects : []).filter(isRecord).map((project) => ({
        projectId: readString(project.projectId) ?? '',
        projectName: readString(project.projectName) ?? null,
        projectType:
          typeof project.projectType === 'string' || typeof project.projectType === 'number'
            ? project.projectType
            : null,
      })),
    })),
  };
}

/**
 * Build the account controller bound to one plugin instance.
 * @param options - HTTP client, auth store, logger, and clock injection.
 * @returns customer info, key location, project token, authorization probing, and clearCache.
 */
export function createAccount({ http, store, logger, now = () => Date.now() }) {
  const accountCache = new Map();
  const accountInFlight = new Map();
  const locationCache = new Map();
  const locationInFlight = new Map();
  const projectTokenCache = new Map();
  const projectTokenInFlight = new Map();
  const materialCache = new Map();
  const materialInFlight = new Map();
  const candidateCache = new Map();

  /** Validate a family id and return its protocol entry. */
  function familyEntry(family) {
    if (typeof family !== 'string' || !FAMILY_IDS.includes(family)) throw invalidFamily(family);
    return FAMILIES[family];
  }

  /** Validate a non-empty access token. */
  function readAccessToken(accessToken) {
    const token = readString(accessToken);
    if (token === undefined) throw new HostError('not_logged_in', 'Sign in first', { status: 409 });
    return token;
  }

  /** The stored login when it belongs to the requested family and token. */
  function storedAuth(family, accessToken) {
    const auth = store.readAuth();
    if (!isRecord(auth) || auth.family !== family || auth.accessToken !== accessToken) return null;
    return auth;
  }

  /** Perform one request, mapping transport failures to typed HostErrors. */
  async function requestJson(url, init) {
    try {
      return await http.request(url, init);
    } catch (error) {
      throw transportFailure(error);
    }
  }

  /**
   * Validate one response envelope and unwrap `data`.
   * @param response - result of http.request.
   * @param detail - stable diagnostic tag for logs.
   * @returns the response's `data` value.
   */
  function readEnvelopeData(response, detail) {
    const body = response.body;
    const bodyCode = isRecord(body) ? body.code : undefined;
    if (response.status === 401 || response.status === 403 || bodyCode === 401 || bodyCode === 403) {
      throw loginExpired();
    }
    if (response.status < 200 || response.status >= 300) {
      logger?.warn?.(`upstream request rejected: status ${response.status} (${detail})`);
      throw new HostError('upstream_failed', 'The BigModel service rejected the request', {
        status: 502,
        detail: `status_${response.status}`,
      });
    }
    if (!isRecord(body) || !SUCCESS_CODES.has(body.code) || body.success === false) {
      throw invalidResponse(detail);
    }
    return body.data;
  }

  /** Fetch and normalize customer info for one family. */
  async function fetchAccount(family, accessToken) {
    const entry = familyEntry(family);
    const url = `${entry.origin}${CUSTOMER_INFO_PATH}`;
    const headers = { authorization: accessToken, 'content-type': 'application/json' };
    let response = await requestJson(url, { method: 'GET', headers, timeoutMs: REQUEST_TIMEOUT_MS });
    // BigModel requires the raw business token; some Z.AI deployments answer the
    // same endpoint for a Bearer credential, so retry that form once there.
    if (family === 'zai' && (response.status === 401 || response.status === 403)) {
      response = await requestJson(url, {
        method: 'GET',
        headers: { ...headers, authorization: `Bearer ${accessToken}` },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    }
    return normalizeAccount(readEnvelopeData(response, 'customer_info'));
  }

  /**
   * Read the account's customer info, cached for one hour in memory.
   * @param options - provider family, OAuth access token, and cache-bypass flag.
   * @returns normalized account document.
   */
  async function loadAccount({ family, accessToken, force = false } = {}) {
    const selected = familyEntry(family).id;
    const token = readAccessToken(accessToken);
    const cacheKey = `${selected}:${token}`;
    const at = now();
    const cached = accountCache.get(cacheKey);
    if (!force && cached !== undefined && at - cached.fetchedAt < ACCOUNT_TTL_MS) return cached.value;
    // The stored auth document keeps the last account for display, but customer
    // info is refetched after this cache expires so the snapshot's hourly refresh
    // still observes organization/project changes.
    const inFlight = accountInFlight.get(cacheKey);
    if (inFlight !== undefined) return inFlight;
    const promise = fetchAccount(selected, token)
      .then((value) => {
        accountCache.set(cacheKey, { value, fetchedAt: now() });
        return value;
      })
      .finally(() => {
        accountInFlight.delete(cacheKey);
      });
    accountInFlight.set(cacheKey, promise);
    return promise;
  }

  /** Resolve the personal project, its API-key list URL, and request headers. */
  async function resolveKeyLocation(family, accessToken) {
    const entry = familyEntry(family);
    const account = await loadAccount({ family, accessToken });
    const project = pickPersonalProject(account);
    if (project === null) {
      throw new HostError('no_project', 'No personal project is available for the Coding Plan', { status: 409 });
    }
    const url = `${entry.origin}${apiKeysPath(project.organizationId, project.projectId)}`;
    const headers = { authorization: keyAuthorization(family, accessToken), 'content-type': 'application/json' };
    const list = readEnvelopeData(
      await requestJson(url, { method: 'GET', headers, timeoutMs: REQUEST_TIMEOUT_MS }),
      'api_key_list',
    );
    if (!Array.isArray(list)) throw invalidResponse('api_key_list');
    const named = list.filter((entryValue) => isRecord(entryValue) && entryValue.name === API_KEY_NAME);
    const existing = named.find((entryValue) => readString(entryValue.apiKey) !== undefined);
    if (existing !== undefined) {
      logger?.info?.(`coding plan api key reused: ${describeUrl(url)}`);
      return { ...project, apiKeyId: readString(existing.apiKey) };
    }
    // A same-name key without an id cannot be reused safely; creating a second one
    // would leave two Coding Plan keys behind.
    if (named.length > 0) throw invalidResponse('api_key_entry');
    const created = readEnvelopeData(
      await requestJson(url, {
        method: 'POST',
        headers,
        json: { name: API_KEY_NAME, usageScene: CODING_PLAN_USAGE_SCENE },
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
      'api_key_create',
    );
    const apiKeyId = isRecord(created) ? readString(created.apiKey) ?? readString(created.apiKeyId) : undefined;
    if (apiKeyId === undefined) throw invalidResponse('api_key_create');
    logger?.info?.(`coding plan api key created: ${describeUrl(url)}`);
    return { ...project, apiKeyId };
  }

  /**
   * Resolve the project key location, reusing a stored or cached location.
   * @param options - provider family, OAuth access token, and cache-bypass flag.
   * @returns `{ organizationId, projectId, apiKeyId }`.
   */
  async function ensureKeyLocation({ family, accessToken, force = false } = {}) {
    const selected = familyEntry(family).id;
    const token = readAccessToken(accessToken);
    const cacheKey = `${selected}:${token}`;
    if (!force) {
      const cached = locationCache.get(cacheKey);
      if (cached !== undefined) return { ...cached };
      const stored = storedAuth(selected, token);
      const storedLocation = readKeyLocation(stored?.keyLocation);
      if (storedLocation !== null) {
        locationCache.set(cacheKey, storedLocation);
        return { ...storedLocation };
      }
    }
    const inFlight = locationInFlight.get(cacheKey);
    if (inFlight !== undefined) return inFlight;
    const promise = resolveKeyLocation(selected, token)
      .then((location) => {
        locationCache.set(cacheKey, location);
        return { ...location };
      })
      .finally(() => {
        locationInFlight.delete(cacheKey);
      });
    locationInFlight.set(cacheKey, promise);
    return promise;
  }

  /** Issue and cache one project access token. */
  async function fetchProjectToken(family, accessToken, keyLocation) {
    const entry = familyEntry(family);
    const url = `${entry.origin}${accessTokensPath(keyLocation.organizationId, keyLocation.projectId, keyLocation.apiKeyId)}`;
    const data = readEnvelopeData(
      await requestJson(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        json: { clientType: ACCESS_TOKEN_CLIENT_TYPE, clientVersion: ACCESS_TOKEN_CLIENT_VERSION },
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
      'project_token',
    );
    if (!isRecord(data)) throw invalidResponse('project_token');
    if (data.enable === false) {
      throw new HostError('no_coding_plan', 'This account has no active Coding Plan', { status: 409 });
    }
    const token = readString(data.accessToken) ?? readString(data.access_token);
    const expiresAtSeconds = Number(data.expiresAt ?? data.expires_at);
    const expiresInSeconds = Number(data.expiresIn ?? data.expires_in);
    const issuedAt = now();
    const expiries = [];
    if (Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0) expiries.push(expiresAtSeconds * 1_000);
    if (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) expiries.push(issuedAt + expiresInSeconds * 1_000);
    if (token === undefined || expiries.length === 0) throw invalidResponse('project_token_fields');
    const expiresAt = Math.min(...expiries);
    logger?.info?.(`project access token issued: ${describeUrl(url)}`);
    return { token, expiresAt };
  }

  /**
   * Issue a project access token, reusing a cached one while it is not near expiry.
   * @param options - provider family, OAuth access token, key location, and cache-bypass flag.
   * @returns `{ token, expiresAt }`.
   */
  async function issueProjectToken({ family, accessToken, keyLocation, force = false } = {}) {
    const selected = familyEntry(family).id;
    const token = readAccessToken(accessToken);
    const location = readKeyLocation(keyLocation);
    if (location === null) throw new HostError('no_project', 'No Coding Plan project is available', { status: 409 });
    const cacheKey = `${selected}:${location.organizationId}:${location.projectId}:${location.apiKeyId}`;
    const at = now();
    if (!force) {
      const cached = projectTokenCache.get(cacheKey);
      if (cached !== undefined && at + PROJECT_TOKEN_REFRESH_LEAD_MS < cached.expiresAt) {
        return { token: cached.token, expiresAt: cached.expiresAt };
      }
    }
    const inFlight = projectTokenInFlight.get(cacheKey);
    if (inFlight !== undefined) return inFlight;
    const promise = fetchProjectToken(selected, token, location)
      .then((value) => {
        projectTokenCache.set(cacheKey, value);
        return { token: value.token, expiresAt: value.expiresAt };
      })
      .finally(() => {
        projectTokenInFlight.delete(cacheKey);
      });
    projectTokenInFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Resolve the project token used for model inference, shared by every caller.
   * @param options - provider family, stored auth document, and cache-bypass flag.
   * @returns `{ token, expiresAt, keyLocation }`; the token is never persisted or logged.
   */
  async function getProjectMaterial({ family, auth, force = false } = {}) {
    const selected = familyEntry(family).id;
    const accessToken = readAccessToken(auth?.accessToken);
    const cacheKey = `${selected}:${accessToken}`;
    const at = now();
    const inFlight = materialInFlight.get(cacheKey);
    if (inFlight !== undefined) return inFlight;
    const cached = materialCache.get(cacheKey);
    if (!force && cached !== undefined && at + PROJECT_TOKEN_REFRESH_LEAD_MS < cached.expiresAt) {
      return { token: cached.token, expiresAt: cached.expiresAt, keyLocation: { ...cached.keyLocation } };
    }
    const promise = (async () => {
      const keyLocation =
        readKeyLocation(auth?.keyLocation) ?? (await ensureKeyLocation({ family: selected, accessToken }));
      const issued = await issueProjectToken({
        family: selected,
        accessToken,
        keyLocation,
        force,
      });
      const material = { token: issued.token, expiresAt: issued.expiresAt, keyLocation: { ...keyLocation } };
      materialCache.set(cacheKey, material);
      return { token: material.token, expiresAt: material.expiresAt, keyLocation: { ...material.keyLocation } };
    })().finally(() => {
      materialInFlight.delete(cacheKey);
    });
    materialInFlight.set(cacheKey, promise);
    return promise;
  }

  /** The authorization header value for one probe candidate. */
  async function candidateAuthorization(kind, family, accessToken, auth, resolveMaterial) {
    if (kind === 'access-raw') return accessToken;
    if (kind === 'access-bearer') return `Bearer ${accessToken}`;
    const material = await resolveMaterial(auth, family, accessToken);
    return kind === 'project-bearer' ? `Bearer ${material.token}` : material.token;
  }

  /**
   * Probe one upstream endpoint until an authorization form is accepted.
   * The project access token is tried first: every Coding Plan monitor, usage,
   * and personal subscription read is PAT-scoped, while the OAuth business token
   * is only accepted by customer info, key management, and reset headers. The
   * project token is issued lazily on the first probe that needs it, the winning
   * form is cached per family and channel, and a business envelope status always wins.
   * @param options - provider family, stored auth, channel, and request callback.
   * @returns `{ authorization, response, kind }`; kind is `project-raw`, `project-bearer`,
   *   `access-raw`, or `access-bearer` and identifies the accepted credential form.
   */
  async function probeAuthorization({ family, auth, channel, request } = {}) {
    const selected = familyEntry(family).id;
    if (channel !== 'monitor' && channel !== 'business') {
      throw new HostError('invalid_request', 'channel must be "monitor" or "business"', { status: 400 });
    }
    if (typeof request !== 'function') {
      throw new HostError('invalid_request', 'request must be a function', { status: 400 });
    }
    const accessToken = readAccessToken(auth?.accessToken);
    const cacheKey = `${selected}:${channel}`;
    const candidates = ['project-raw', 'project-bearer', 'access-raw', 'access-bearer'];
    const cachedKind = candidateCache.get(cacheKey);
    const order =
      cachedKind !== undefined && candidates.includes(cachedKind)
        ? [cachedKind, ...candidates.filter((kind) => kind !== cachedKind)]
        : candidates;
    const material = (authValue, familyValue, tokenValue) =>
      getProjectMaterial({
        family: familyValue,
        auth: { accessToken: tokenValue, keyLocation: readKeyLocation(authValue?.keyLocation) },
      });
    try {
      for (const kind of order) {
        const authorization = await candidateAuthorization(kind, selected, accessToken, auth, material);
        const response = await request(authorization);
        const status = response?.status;
        // Only an explicit auth rejection means the credential form is wrong; a
        // business error (409/400 on a valid credential) settles the channel.
        if (status !== 401 && status !== 403) {
          candidateCache.set(cacheKey, kind);
          return { authorization, response, kind };
        }
      }
    } catch (error) {
      candidateCache.delete(cacheKey);
      throw error;
    }
    candidateCache.delete(cacheKey);
    throw loginExpired();
  }

  /** Drop every in-memory cache, e.g. after logout or a completed login. */
  function clearCache() {
    accountCache.clear();
    locationCache.clear();
    projectTokenCache.clear();
    materialCache.clear();
    candidateCache.clear();
  }

  return {
    loadAccount,
    pickPersonalProject,
    ensureKeyLocation,
    issueProjectToken,
    getProjectMaterial,
    probeAuthorization,
    clearCache,
  };
}
