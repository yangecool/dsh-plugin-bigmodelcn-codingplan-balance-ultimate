/**
 * Plugin-owned persistence in the Harness home.
 *
 * Two files live under `$DSH_HOME` (default `~/.dsh`):
 *  - `bigmodelcn-codingplan.json` — user configuration (non-secret).
 *  - `bigmodelcn-codingplan-auth.json` — BigModel OAuth tokens and the resolved
 *    account/key location (secret; created with mode 0600).
 *
 * The plugin owns this store instead of a Harness settings namespace so tokens
 * never enter the settings document or a session log, and so updates never
 * touch the credentials.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_CONFIG, FAMILY_IDS, MAX_CONFIG_BYTES } from './constants.js';
import { clampInteger } from './http.js';

const CONFIG_FILE = 'bigmodelcn-codingplan.json';
const AUTH_FILE = 'bigmodelcn-codingplan-auth.json';

/** Resolve the Harness home the same way the rest of the Host does. */
function resolveHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh');
}

/** Keep only string entries of a provider-id gate list. */
function sanitizeProviderIds(value) {
  if (!Array.isArray(value)) return [...DEFAULT_CONFIG.providerIds];
  const ids = value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return ids.slice(0, 32);
}

/** One credential reference name: a POSIX identifier pi-ai can resolve. */
function sanitizeCredentialRef(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate) ? candidate : DEFAULT_CONFIG.inferenceCredentialRef;
}

/** Validate one user-config document, falling back per field. */
export function sanitizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const family = FAMILY_IDS.includes(source.family) ? source.family : DEFAULT_CONFIG.family;
  return {
    family,
    refreshMinutes: clampInteger(source.refreshMinutes, 1, 1440, DEFAULT_CONFIG.refreshMinutes),
    providerIds: sanitizeProviderIds(source.providerIds),
    showIndicatorWhenLoggedOut: source.showIndicatorWhenLoggedOut === true,
    usagePageUrl: typeof source.usagePageUrl === 'string' ? source.usagePageUrl.trim() : '',
    inferenceEnabled: source.inferenceEnabled !== false,
    inferenceCredentialRef: sanitizeCredentialRef(source.inferenceCredentialRef),
  };
}

/** Read a non-empty trimmed string. */
function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Validate one stored auth document; null when it cannot represent a login. */
export function sanitizeAuth(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const accessToken = readString(source.accessToken);
  if (accessToken === undefined) return null;
  const user = source.user && typeof source.user === 'object' ? source.user : {};
  const account = source.account && typeof source.account === 'object' ? source.account : {};
  const location = source.keyLocation && typeof source.keyLocation === 'object' ? source.keyLocation : null;
  return {
    family: FAMILY_IDS.includes(source.family) ? source.family : DEFAULT_CONFIG.family,
    accessToken,
    zcodeJwtToken: readString(source.zcodeJwtToken),
    refreshToken: readString(source.refreshToken),
    expiresAt: Number.isFinite(source.expiresAt) ? source.expiresAt : null,
    loggedInAt: Number.isFinite(source.loggedInAt) ? source.loggedInAt : null,
    user: {
      id: readString(user.id),
      name: readString(user.name),
      email: readString(user.email),
      avatar: readString(user.avatar),
    },
    account: {
      customerNumber: readString(account.customerNumber),
      customerName: readString(account.customerName),
      avatar: readString(account.avatar),
      organizations: Array.isArray(account.organizations) ? account.organizations : [],
    },
    keyLocation: location && readString(location.organizationId) && readString(location.projectId) && readString(location.apiKeyId)
      ? {
          organizationId: readString(location.organizationId),
          projectId: readString(location.projectId),
          apiKeyId: readString(location.apiKeyId),
        }
      : null,
    inference: sanitizeInference(source.inference),
  };
}

/** Bookkeeping for the credential reference this login wrote into the credential store. */
function sanitizeInference(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (source === null) return null;
  const ref = readString(source.ref);
  if (ref === undefined) return null;
  return {
    ref,
    family: readString(source.family) ?? null,
    writtenAt: Number.isFinite(source.writtenAt) ? source.writtenAt : null,
    expiresAt: Number.isFinite(source.expiresAt) ? source.expiresAt : null,
    previousSource: readString(source.previousSource) ?? null,
  };
}

/** Write one file atomically with a restrictive mode. */
function writeAtomic(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { encoding: 'utf8', mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

/** Read one JSON file; undefined when it is missing or unreadable. */
function readJson(path, logger, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.(`${label}: could not be read (${error?.code ?? 'unknown'})`);
    return undefined;
  }
  if (text.length > MAX_CONFIG_BYTES) {
    logger?.warn?.(`${label}: ignored because it exceeds the size limit`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    logger?.warn?.(`${label}: ignored because it is not valid JSON`);
    return undefined;
  }
}

/**
 * Build the store bound to one plugin instance.
 * @param options - optional logger used for corrupt-file diagnostics.
 * @returns config and auth read/write helpers with their file paths.
 */
export function createStore(options = {}) {
  const logger = options.logger;
  const home = options.homeDir ?? resolveHome();
  const configPath = options.configPath ?? join(home, CONFIG_FILE);
  const authPath = options.authPath ?? join(home, AUTH_FILE);

  return {
    /** @returns absolute path of the non-secret config file. */
    configPath: () => configPath,
    /** @returns absolute path of the secret auth file. */
    authPath: () => authPath,

    /** Read the user config, applying defaults for missing or invalid fields. */
    readConfig() {
      return sanitizeConfig(readJson(configPath, logger, 'bigmodelcn-codingplan.json'));
    },

    /**
     * Merge a partial config patch and persist it.
     * @param patch - subset of the config document from the settings UI.
     * @returns the persisted, sanitized config.
     */
    writeConfig(patch) {
      const next = sanitizeConfig({ ...this.readConfig(), ...patch });
      writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
      return next;
    },

    /** Read the stored login; null when the file is absent or unusable. */
    readAuth() {
      return sanitizeAuth(readJson(authPath, logger, 'bigmodelcn-codingplan-auth.json'));
    },

    /**
     * Persist a login document.
     * @param auth - login document produced by the OAuth flow.
     * @returns the sanitized document.
     */
    writeAuth(auth) {
      const next = sanitizeAuth(auth);
      if (next === null) throw new Error('bigmodelcn-balance: refusing to persist an auth document without an access token');
      writeAtomic(authPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
      return next;
    },

    /** Remove the stored login; a missing file is not an error. */
    clearAuth() {
      try {
        unlinkSync(authPath);
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        logger?.warn?.(`bigmodelcn-codingplan-auth.json: could not be removed (${error?.code ?? 'unknown'})`);
        return false;
      }
    },
  };
}
