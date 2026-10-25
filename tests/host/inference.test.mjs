import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_CONFIG,
  INFERENCE_REFRESH_LEAD_MS,
  INFERENCE_SYNC_INTERVAL_MS,
} from '../../lib/host/constants.js';
import { HostError } from '../../lib/host/http.js';
import { createInference } from '../../lib/host/inference.js';
import { createStore } from '../../lib/host/store.js';

/** The reference the `zai-coding-cn` pi-ai route resolves. */
const REF = DEFAULT_CONFIG.inferenceCredentialRef;
const OTHER_REF = 'BIGMODEL_CODING_CN_API_KEY';
const TOKEN = 'coding-plan-project-token-secret';
const ACCESS_TOKEN = 'zcode-access-token-secret';
const SECOND_TOKEN = 'coding-plan-project-token-refreshed';

/** Deterministic clock: tests advance it explicitly. */
function createClock(start = 1_760_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
      return current;
    },
    set: (value) => {
      current = value;
    },
  };
}

/** One login document as the OAuth module would have persisted it. */
function loggedInAuth(overrides = {}) {
  return {
    family: 'bigmodel',
    accessToken: ACCESS_TOKEN,
    zcodeJwtToken: 'zcode-jwt-token',
    refreshToken: undefined,
    expiresAt: null,
    loggedInAt: 1,
    user: { id: 'user-1', name: 'Tester', email: null, avatar: null },
    account: {},
    keyLocation: null,
    inference: null,
    ...overrides,
  };
}

/** In-memory store with the same read/write surface as `createStore`. */
function createMemoryStore({ config = {}, auth = null } = {}) {
  let currentConfig = { ...DEFAULT_CONFIG, ...config };
  let currentAuth = auth === null ? null : structuredClone(auth);
  const authWrites = [];
  return {
    authWrites,
    readConfig: () => structuredClone(currentConfig),
    writeConfig: (patch) => {
      currentConfig = { ...currentConfig, ...patch };
      return structuredClone(currentConfig);
    },
    readAuth: () => (currentAuth === null ? null : structuredClone(currentAuth)),
    writeAuth: (document) => {
      authWrites.push(structuredClone(document));
      currentAuth = structuredClone(document);
      return structuredClone(currentAuth);
    },
    clearAuth: () => {
      currentAuth = null;
      return true;
    },
    currentAuth: () => (currentAuth === null ? null : structuredClone(currentAuth)),
    setConfig: (patch) => {
      currentConfig = { ...currentConfig, ...patch };
    },
  };
}

/** Fake credentials provider: source layers, stored values, and ordered operation log. */
function createFakeCredentials({ sources = {}, values = {} } = {}) {
  const sourceByRef = new Map(Object.entries(sources));
  const valueByRef = new Map(Object.entries(values));
  const calls = { describe: [], set: [], unset: [] };
  /** Ordered credential mutations, used to prove which operation ran last. */
  const operations = [];
  return {
    calls,
    operations,
    values: valueByRef,
    async describe(ref) {
      calls.describe.push(ref);
      if (valueByRef.has(ref)) return { configured: true, source: sourceByRef.get(ref) ?? 'file', writable: true };
      const source = sourceByRef.get(ref);
      return source === undefined
        ? { configured: false, writable: true }
        : { configured: true, source, writable: true };
    },
    async set(ref, value) {
      calls.set.push({ ref, value });
      operations.push({ op: 'set', ref });
      valueByRef.set(ref, value);
      sourceByRef.set(ref, 'file');
    },
    async unset(ref) {
      calls.unset.push(ref);
      operations.push({ op: 'unset', ref });
      valueByRef.delete(ref);
    },
  };
}

/** Fake account module returning one material or raising one failure. */
function createFakeAccount({ material, error = null } = {}) {
  const calls = [];
  let nextError = error;
  let nextMaterial = material;
  return {
    calls,
    async getProjectMaterial(options) {
      calls.push(options);
      if (nextError !== null) throw nextError;
      return nextMaterial;
    },
    setError: (error) => {
      nextError = error;
    },
    setMaterial: (material) => {
      nextMaterial = material;
    },
  };
}

/** Logger capturing every line so tests can prove tokens never reach it. */
function createFakeLogger() {
  const lines = [];
  const record = (line) => lines.push(line);
  return { lines, info: record, warn: record, debug: record };
}

/** Flush pending microtasks (mock timers keep `setImmediate` real). */
function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Build one inference instance with fakes; every collaborator is overridable. */
function build(options = {}) {
  const clock = options.clock ?? createClock();
  const store = options.store ?? createMemoryStore({
    config: options.config,
    auth: options.auth === undefined ? loggedInAuth() : options.auth,
  });
  const credentials = options.credentials ?? createFakeCredentials({ sources: { [REF]: 'env' } });
  const material = options.material ?? {
    token: TOKEN,
    expiresAt: clock.now() + 3_600_000,
    keyLocation: { organizationId: 'org-1', projectId: 'project-1', apiKeyId: 'key-1' },
  };
  const account = options.account ?? createFakeAccount({ material });
  const logger = options.logger ?? createFakeLogger();
  const getCredentials = options.getCredentials ?? (() => credentials);
  const inference = createInference({ account, store, credentials: getCredentials, logger, now: clock.now });
  return { inference, account, store, credentials, logger, clock, material };
}

test('reports the credentials seam as unavailable and writes nothing', async () => {
  const store = createMemoryStore({
    auth: loggedInAuth({ inference: { ref: REF, family: null, writtenAt: 1, expiresAt: 2, previousSource: 'env' } }),
  });
  const logger = createFakeLogger();
  const { inference, account } = build({ store, logger, getCredentials: () => undefined });

  await inference.sync();

  assert.equal(account.calls.length, 0);
  assert.deepEqual(store.authWrites, []);
  assert.deepEqual(await inference.status(), {
    enabled: true,
    available: false,
    ref: REF,
    family: null,
    writtenAt: 1,
    expiresAt: 2,
    expiresInMs: 0,
    error: 'credentials_unavailable',
  });
  assert.ok(logger.lines.some((line) => line.includes('credentials_unavailable')));
});

test('treats a Host composed without a credentials getter as unavailable', async () => {
  const store = createMemoryStore({ auth: loggedInAuth() });
  const account = createFakeAccount({ material: { token: TOKEN, expiresAt: 2_000, keyLocation: null } });
  const inference = createInference({ account, store, logger: createFakeLogger(), now: () => 1_000 });

  await inference.sync();

  const status = await inference.status();
  assert.equal(status.available, false);
  assert.equal(status.error, 'credentials_unavailable');
  assert.equal(account.calls.length, 0);
  assert.deepEqual(store.authWrites, []);
});

test('does nothing while the user is not logged in', async () => {
  const { inference, account, store } = build({ auth: null });

  await inference.sync();

  assert.equal(account.calls.length, 0);
  assert.deepEqual(store.authWrites, []);
  const status = await inference.status();
  assert.deepEqual(status, {
    enabled: true,
    available: true,
    ref: null,
    family: null,
    writtenAt: null,
    expiresAt: null,
    expiresInMs: null,
    error: null,
  });
});

test('unsets the recorded reference when the feature is disabled', async () => {
  const credentials = createFakeCredentials({
    sources: { [REF]: 'file' },
    values: { [REF]: TOKEN },
  });
  const store = createMemoryStore({
    config: { inferenceEnabled: false },
    auth: loggedInAuth({
      inference: { ref: REF, family: 'bigmodel', writtenAt: 1, expiresAt: 2, previousSource: 'env' },
    }),
  });
  const { inference, account } = build({ store, credentials, config: { inferenceEnabled: false } });

  await inference.sync();

  assert.deepEqual(credentials.calls.unset, [REF]);
  assert.equal(credentials.values.has(REF), false);
  assert.equal(store.currentAuth().inference, null);
  assert.equal(account.calls.length, 0);
  const status = await inference.status();
  assert.equal(status.enabled, false);
  assert.equal(status.ref, null);
  assert.equal(status.family, null);
  assert.equal(status.writtenAt, null);
  assert.equal(status.expiresAt, null);
  assert.equal(status.expiresInMs, null);
  assert.equal(status.error, null);
});

test('writes the project token and bookkeeping on the first sync', async () => {
  const { inference, account, store, credentials, logger, clock, material } = build();

  await inference.sync();

  assert.deepEqual(credentials.calls.set, [{ ref: REF, value: TOKEN }]);
  const auth = store.currentAuth();
  assert.deepEqual(auth.inference, {
    ref: REF,
    family: 'bigmodel',
    writtenAt: clock.now(),
    expiresAt: material.expiresAt,
    previousSource: 'env',
  });
  assert.deepEqual(auth.keyLocation, material.keyLocation);
  assert.deepEqual(account.calls, [{ family: 'bigmodel', auth: loggedInAuth(), force: false }]);
  assert.deepEqual(await inference.status(), {
    enabled: true,
    available: true,
    ref: REF,
    family: 'bigmodel',
    writtenAt: clock.now(),
    expiresAt: material.expiresAt,
    expiresInMs: material.expiresAt - clock.now(),
    error: null,
  });
  assert.ok(logger.lines.every((line) => !line.includes(TOKEN)));
  assert.ok(logger.lines.every((line) => !line.includes(ACCESS_TOKEN)));
});

test('skips upstream work while the stored expiry is outside the refresh lead', async () => {
  const { inference, account, clock, material } = build();
  await inference.sync();
  assert.equal(account.calls.length, 1);

  clock.advance(material.expiresAt - clock.now() - INFERENCE_REFRESH_LEAD_MS - 1_000);
  await inference.sync();
  assert.equal(account.calls.length, 1);

  clock.advance(2_000);
  assert.ok(material.expiresAt - clock.now() <= INFERENCE_REFRESH_LEAD_MS);
  await inference.sync();
  assert.equal(account.calls.length, 2);
});

test('force re-issues even while the stored expiry is fresh', async () => {
  const { inference, account, credentials, clock } = build();
  await inference.sync();
  assert.equal(account.calls.length, 1);

  clock.advance(30_000);
  await inference.sync({ force: true });

  assert.equal(account.calls.length, 2);
  assert.equal(credentials.calls.set.length, 2);
  assert.equal(credentials.calls.set[1].ref, REF);
});

test('keeps the original previousSource across refreshes', async () => {
  const { inference, store, clock } = build();
  await inference.sync();
  assert.equal(store.currentAuth().inference.previousSource, 'env');

  clock.advance(3_000_000);
  await inference.sync({ force: true });

  // The reference now resolves from the value this module wrote; the first
  // observed source must survive further refreshes.
  assert.equal(store.currentAuth().inference.previousSource, 'env');
  assert.equal(store.currentAuth().inference.writtenAt, clock.now());
});

test('moves the credential when the configured reference changes', async () => {
  const credentials = createFakeCredentials({
    sources: { [REF]: 'file', [OTHER_REF]: 'env' },
    values: { [REF]: 'previous-token' },
  });
  const store = createMemoryStore({
    config: { inferenceCredentialRef: OTHER_REF },
    auth: loggedInAuth({
      inference: { ref: REF, family: 'bigmodel', writtenAt: 1, expiresAt: 9_999_999_999_999, previousSource: 'env' },
    }),
  });
  const { inference, account } = build({ store, credentials });

  await inference.sync();

  assert.deepEqual(credentials.calls.unset, [REF]);
  assert.equal(credentials.values.has(REF), false);
  assert.deepEqual(credentials.calls.set, [{ ref: OTHER_REF, value: TOKEN }]);
  const auth = store.currentAuth();
  assert.equal(auth.inference.ref, OTHER_REF);
  assert.equal(auth.inference.family, 'bigmodel');
  assert.equal(auth.inference.previousSource, 'env');
  assert.equal(account.calls.length, 1);
  assert.equal((await inference.status()).ref, OTHER_REF);
});

test('rewrites the credential when the recorded family differs from the login', async () => {
  const clock = createClock();
  const store = createMemoryStore({
    auth: loggedInAuth({
      family: 'bigmodel',
      inference: {
        ref: REF,
        family: 'zai',
        writtenAt: 1,
        expiresAt: clock.now() + 3_600_000,
        previousSource: 'env',
      },
    }),
  });
  const material = { token: SECOND_TOKEN, expiresAt: clock.now() + 7_200_000, keyLocation: null };
  const account = createFakeAccount({ material });
  const credentials = createFakeCredentials({ sources: { [REF]: 'env' } });
  const { inference } = build({ clock, store, credentials, account });

  await inference.sync();

  // The stored token belongs to the other origin: refresh even though the recorded expiry is fresh.
  assert.equal(account.calls.length, 1);
  assert.deepEqual(credentials.calls.unset, []);
  assert.deepEqual(credentials.calls.set, [{ ref: REF, value: SECOND_TOKEN }]);
  const auth = store.currentAuth();
  assert.equal(auth.inference.family, 'bigmodel');
  assert.equal(auth.inference.expiresAt, material.expiresAt);
  const status = await inference.status();
  assert.equal(status.family, 'bigmodel');
  assert.equal(status.error, null);
});

test('rewrites bookkeeping recorded before family tracking', async () => {
  const clock = createClock();
  const store = createMemoryStore({
    auth: loggedInAuth({
      inference: { ref: REF, family: null, writtenAt: 1, expiresAt: clock.now() + 3_600_000, previousSource: 'env' },
    }),
  });
  const { inference, account } = build({ clock, store });

  await inference.sync();

  assert.equal(account.calls.length, 1);
  assert.equal(store.currentAuth().inference.family, 'bigmodel');
  assert.equal((await inference.status()).family, 'bigmodel');
});

test('rejects with login_expired when the business APIs reject the login', async () => {
  const { inference, account, credentials, logger } = build();
  account.setError(new HostError('login_expired', `login rejected for ${TOKEN}`, { status: 401 }));

  await assert.rejects(inference.sync(), (error) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.code, 'login_expired');
    assert.equal(error.status, 401);
    return true;
  });

  assert.deepEqual(credentials.calls.set, []);
  assert.equal((await inference.status()).error, 'login_expired');
  assert.ok(logger.lines.every((line) => !line.includes(TOKEN)));

  account.setError(Object.assign(new Error(`denied ${TOKEN}`), { status: 403 }));
  await assert.rejects(inference.sync(), (error) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.code, 'login_expired');
    assert.equal(error.status, 401);
    return true;
  });
});

test('records a non-auth upstream failure without throwing', async () => {
  const { inference, account, credentials } = build();
  account.setError(new HostError('no_coding_plan', 'No Coding Plan for this login', { status: 409 }));

  await inference.sync();

  assert.deepEqual(credentials.calls.set, []);
  assert.equal((await inference.status()).error, 'no_coding_plan');

  account.setError(null);
  await inference.sync();
  assert.equal((await inference.status()).error, null);
  assert.equal(credentials.calls.set.length, 1);
});

test('shares one in-flight attempt between concurrent callers', async () => {
  const clock = createClock();
  let releaseMaterial;
  const gate = new Promise((resolve) => {
    releaseMaterial = resolve;
  });
  const account = {
    calls: [],
    async getProjectMaterial(options) {
      account.calls.push(options);
      return gate;
    },
  };
  const { inference } = build({ clock, account });

  const first = inference.sync();
  const second = inference.sync();
  assert.equal(first, second);
  assert.equal(account.calls.length, 1);

  releaseMaterial({
    token: TOKEN,
    expiresAt: clock.now() + 3_600_000,
    keyLocation: null,
  });
  await first;
  assert.equal((await inference.status()).ref, REF);

  await inference.sync();
  assert.equal(account.calls.length, 1);
});

test('clear() unsets the written reference and drops the bookkeeping', async () => {
  const { inference, store, credentials } = build();
  await inference.sync();
  assert.equal((await inference.status()).ref, REF);

  await inference.clear();

  assert.deepEqual(credentials.calls.unset, [REF]);
  assert.equal(credentials.values.has(REF), false);
  assert.equal(store.currentAuth().inference, null);
  const status = await inference.status();
  assert.equal(status.ref, null);
  assert.equal(status.writtenAt, null);
  assert.equal(status.expiresAt, null);
  assert.equal(status.expiresInMs, null);
  assert.equal(status.error, null);

  await inference.clear();
  assert.deepEqual(credentials.calls.unset, [REF]);
});

test('clear() keeps the bookkeeping when the credential release fails, so a later logout retries', async () => {
  const { inference, store, credentials } = build();
  await inference.sync();
  const release = credentials.unset.bind(credentials);
  credentials.unset = async () => {
    throw new Error('credentials document is not writable');
  };

  await inference.clear();

  // The recorded reference stays the only pointer to the stored value.
  assert.equal(store.currentAuth().inference.ref, REF);
  assert.equal((await inference.status()).error, 'internal_error');

  credentials.unset = release;
  await inference.releaseLogin();

  assert.equal(store.currentAuth(), null);
  assert.equal(credentials.values.has(REF), false);
  assert.equal(credentials.operations.at(-1).op, 'unset');
});

test('clear() keeps the bookkeeping without a credentials service', async () => {
  const store = createMemoryStore({
    auth: loggedInAuth({
      inference: { ref: REF, family: 'bigmodel', writtenAt: 1, expiresAt: 2, previousSource: 'env' },
    }),
  });
  const { inference } = build({ store, getCredentials: () => undefined });

  await inference.clear();

  assert.equal(store.currentAuth().inference.ref, REF);
  assert.equal((await inference.status()).available, false);
});

test('a disabled-feature sync keeps the bookkeeping when the release fails', async () => {
  const credentials = createFakeCredentials({ sources: { [REF]: 'file' }, values: { [REF]: TOKEN } });
  const store = createMemoryStore({
    config: { inferenceEnabled: false },
    auth: loggedInAuth({
      inference: { ref: REF, family: 'bigmodel', writtenAt: 1, expiresAt: 2, previousSource: 'env' },
    }),
  });
  const { inference, account } = build({ store, credentials, config: { inferenceEnabled: false } });
  const release = credentials.unset.bind(credentials);
  credentials.unset = async () => {
    throw new Error('credentials document is not writable');
  };

  await inference.sync();

  assert.equal(store.currentAuth().inference.ref, REF);
  assert.equal((await inference.status()).error, 'internal_error');
  assert.equal(credentials.values.has(REF), true);

  credentials.unset = release;
  await inference.sync();

  assert.equal(store.currentAuth().inference, null);
  assert.equal(credentials.values.has(REF), false);
  assert.equal(account.calls.length, 0);
});

test('releaseLogin() records a failed credential release without throwing', async () => {
  const { inference, store, credentials } = build();
  await inference.sync();
  credentials.unset = async () => {
    throw new Error('credentials document is not writable');
  };

  await inference.releaseLogin();

  // The auth document is gone first by design, so a failed unset can only be
  // surfaced through status; it must never take the logout path down.
  assert.equal(store.currentAuth(), null);
  assert.equal((await inference.status()).error, 'internal_error');
});

test('a renewal attempt starting during clear() cannot commit the credential', async () => {
  const { inference, account, store, credentials } = build();
  await inference.sync();
  assert.equal(credentials.calls.set.length, 1);
  assert.equal(account.calls.length, 1);

  let releaseUnset;
  const unsetGate = new Promise((resolve) => {
    releaseUnset = resolve;
  });
  const unsetCredential = credentials.unset.bind(credentials);
  credentials.unset = async (ref) => {
    await unsetGate;
    return unsetCredential(ref);
  };

  const clearing = inference.clear();
  await flushAsync();
  assert.deepEqual(credentials.calls.unset, []);

  // The renewal tick starts after clear() raised its fence and bumped the generation.
  const attempt = inference.sync({ force: true });
  await attempt;
  assert.equal(account.calls.length, 1, 'a fenced attempt must not issue a token');

  releaseUnset();
  await clearing;

  assert.equal(credentials.calls.set.length, 1, 'no set may commit during cleanup');
  assert.equal(credentials.operations.at(-1).op, 'unset', 'unset must be the last credential operation');
  assert.equal(credentials.values.has(REF), false);
  assert.equal(store.currentAuth().inference, null);
});

test('a renewal attempt starting during releaseLogin() cannot commit the credential', async () => {
  const { inference, account, store, credentials } = build();
  await inference.sync();
  assert.equal(credentials.calls.set.length, 1);
  assert.equal(account.calls.length, 1);

  const order = [];
  const clearAuth = store.clearAuth.bind(store);
  store.clearAuth = () => {
    order.push('clearAuth');
    return clearAuth();
  };
  let releaseUnset;
  const unsetGate = new Promise((resolve) => {
    releaseUnset = resolve;
  });
  const unsetCredential = credentials.unset.bind(credentials);
  credentials.unset = async (ref) => {
    await unsetGate;
    order.push('unset');
    return unsetCredential(ref);
  };

  const releasing = inference.releaseLogin();
  assert.equal(inference.releaseLogin(), releasing, 'concurrent logouts share one cleanup');
  await flushAsync();
  assert.deepEqual(credentials.calls.unset, []);
  // The auth document must be gone before the credential reference is touched.
  assert.deepEqual(order, ['clearAuth']);

  const attempt = inference.sync({ force: true });
  await attempt;
  assert.equal(account.calls.length, 1, 'a fenced attempt must not issue a token');

  releaseUnset();
  await releasing;

  assert.deepEqual(order, ['clearAuth', 'unset']);
  assert.equal(credentials.calls.set.length, 1, 'no set may commit during cleanup');
  assert.equal(credentials.operations.at(-1).op, 'unset', 'unset must be the last credential operation');
  assert.equal(credentials.values.has(REF), false);
  assert.equal(store.currentAuth(), null);
});

test('an attempt in flight when the user logs out does not write the credential', async () => {
  const clock = createClock();
  let releaseMaterial;
  const gate = new Promise((resolve) => {
    releaseMaterial = resolve;
  });
  const account = {
    calls: [],
    async getProjectMaterial(options) {
      account.calls.push(options);
      return gate;
    },
  };
  const store = createMemoryStore({ auth: loggedInAuth() });
  const credentials = createFakeCredentials({ sources: { [REF]: 'env' } });
  const { inference } = build({ clock, account, store, credentials });

  const attempt = inference.sync();
  await flushAsync();
  assert.equal(account.calls.length, 1);

  // releaseLogin fences the attempt and waits for it before deleting the login.
  const releasing = inference.releaseLogin();
  await flushAsync();
  releaseMaterial({ token: TOKEN, expiresAt: clock.now() + 3_600_000, keyLocation: null });
  await attempt;
  await releasing;

  assert.deepEqual(credentials.calls.set, []);
  assert.equal(store.currentAuth(), null);
  const status = await inference.status();
  assert.equal(status.ref, null);
  assert.equal(status.error, null);
});

test('releases the credential when logout commits during the credential write', async () => {
  const clock = createClock();
  let releaseSet;
  const gate = new Promise((resolve) => {
    releaseSet = resolve;
  });
  const credentials = createFakeCredentials({ sources: { [REF]: 'env' } });
  const writeCredential = credentials.set.bind(credentials);
  credentials.set = async (ref, value) => {
    await gate;
    return writeCredential(ref, value);
  };
  const store = createMemoryStore({ auth: loggedInAuth() });
  const account = createFakeAccount({ material: { token: TOKEN, expiresAt: clock.now() + 3_600_000, keyLocation: null } });
  const inference = createInference({
    account,
    store,
    credentials: () => credentials,
    logger: createFakeLogger(),
    now: clock.now,
  });

  const attempt = inference.sync();
  await flushAsync();
  assert.deepEqual(credentials.calls.set, []);

  const releasing = inference.releaseLogin();
  await flushAsync();
  releaseSet();
  await attempt;
  await releasing;

  assert.deepEqual(credentials.calls.unset, [REF]);
  assert.equal(credentials.values.has(REF), false);
  assert.equal(store.currentAuth(), null);
  assert.equal(credentials.operations.at(-1).op, 'unset');
});

test('disposing the renewal loop fences a credential commit in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const clock = createClock();
  let releaseSet;
  const setGate = new Promise((resolve) => {
    releaseSet = resolve;
  });
  const credentials = createFakeCredentials({ sources: { [REF]: 'env' } });
  const writeCredential = credentials.set.bind(credentials);
  credentials.set = async (ref, value) => {
    await setGate;
    return writeCredential(ref, value);
  };
  const account = createFakeAccount({
    material: { token: TOKEN, expiresAt: clock.now() + 3_600_000, keyLocation: null },
  });
  const store = createMemoryStore({ auth: loggedInAuth() });
  const inference = createInference({
    account,
    store,
    credentials: () => credentials,
    logger: createFakeLogger(),
    now: clock.now,
  });

  const dispose = inference.start();
  await flushAsync();
  assert.deepEqual(credentials.calls.set, []);

  dispose();
  releaseSet();
  await flushAsync();

  assert.deepEqual(credentials.calls.unset, [REF], 'the fenced write is released again');
  assert.equal(credentials.values.has(REF), false);
  assert.equal(store.currentAuth().inference, null);
  assert.equal(credentials.operations.at(-1).op, 'unset');

  const callsBefore = account.calls.length;
  await inference.sync({ force: true });
  assert.equal(account.calls.length, callsBefore, 'a disposed loop must not start attempts');
});

test('start() syncs immediately, renews on the interval, and stops on dispose', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { inference, account, credentials, clock } = build();

  const dispose = inference.start();
  await inference.sync();
  assert.equal(account.calls.length, 1);
  assert.equal(credentials.calls.set.length, 1);

  clock.advance(4_000_000);
  t.mock.timers.tick(INFERENCE_SYNC_INTERVAL_MS);
  await flushAsync();
  assert.equal(account.calls.length, 2);
  assert.equal(credentials.calls.set.length, 2);

  clock.advance(4_000_000);
  dispose();
  t.mock.timers.tick(INFERENCE_SYNC_INTERVAL_MS);
  await flushAsync();
  assert.equal(account.calls.length, 2);
  assert.deepEqual(credentials.calls.unset, []);
});

test('the renewal loop records a login_expired failure without throwing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { inference, account } = build();
  account.setError(new HostError('login_expired', `login rejected for ${TOKEN}`, { status: 401 }));

  const dispose = inference.start();
  await flushAsync();

  assert.equal((await inference.status()).error, 'login_expired');
  t.mock.timers.tick(INFERENCE_SYNC_INTERVAL_MS);
  await flushAsync();
  assert.equal(account.calls.length, 2);
  dispose();
});

test('persists the bookkeeping through the real auth store', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bigmodelcn-inference-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createStore({ homeDir: directory });
  store.writeAuth({ family: 'bigmodel', accessToken: ACCESS_TOKEN, user: { id: 'user-1' }, account: {}, keyLocation: null });
  const clock = createClock();
  const credentials = createFakeCredentials({ sources: { [REF]: 'env' } });
  const material = {
    token: TOKEN,
    expiresAt: clock.now() + 3_600_000,
    keyLocation: { organizationId: 'org-1', projectId: 'project-1', apiKeyId: 'key-1' },
  };
  const account = createFakeAccount({ material });
  const inference = createInference({ account, store, credentials: () => credentials, logger: createFakeLogger(), now: clock.now });

  await inference.sync();

  const persisted = store.readAuth();
  assert.deepEqual(persisted.inference, {
    ref: REF,
    family: 'bigmodel',
    writtenAt: clock.now(),
    expiresAt: material.expiresAt,
    previousSource: 'env',
  });
  assert.deepEqual(persisted.keyLocation, material.keyLocation);
  const raw = readFileSync(store.authPath(), 'utf8');
  assert.ok(raw.includes('"inference"'));
  assert.ok(raw.includes('"family": "bigmodel"'));
  assert.ok(!raw.includes(TOKEN));
  assert.equal(credentials.values.get(REF), TOKEN);
});
