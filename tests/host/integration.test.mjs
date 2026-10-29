/**
 * Integration tests for the plugin's Host wiring.
 *
 * These exercise the real route table over the real store/OAuth/snapshot modules
 * with only the network replaced, which catches interface drift between the
 * modules that unit tests mock away.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

import { createAccount } from '../../lib/host/account.js';
import { ROUTE_PREFIX } from '../../lib/host/constants.js';
import { createHttp } from '../../lib/host/http.js';
import { createInference } from '../../lib/host/inference.js';
import { createOAuth } from '../../lib/host/oauth.js';
import { registerRoutes } from '../../lib/host/routes.js';
import { createSnapshot } from '../../lib/host/snapshot.js';
import { createStore } from '../../lib/host/store.js';
import { createUpstream } from '../../lib/host/upstream.js';
import { apply } from '../../lib/index.js';

const homes = [];
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** One temporary Harness home per test. */
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'bmc-host-test-'));
  homes.push(home);
  return home;
}

/** JSON response body of a fake upstream. */
function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}

/** Response with a plain-text body (the connection carrier uses these). */
function textResponse(status, text) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    text: async () => text,
  };
}

/** Build the real route table over fake I/O. */
function harness({ fetchImpl, connection, now = () => Date.now() } = {}) {
  const logger = { info() {}, warn() {}, debug() {} };
  const store = createStore({ homeDir: tempHome(), logger });
  const http = createHttp({ fetchImpl, logger });
  const oauth = createOAuth({ http, store, logger, now });
  const account = createAccount({ http, store, logger, now });
  const upstream = createUpstream({ http, logger, now });
  const inference = createInference({ account, store, logger, now, credentials: () => undefined });
  const snapshot = createSnapshot({ store, oauth, account, upstream, inference, logger, now });
  const routes = new Map();
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
    registerUpgrade() {
      return () => {};
    },
  };
  const dispose = registerRoutes({
    webServer,
    store,
    oauth,
    account,
    upstream,
    snapshot,
    inference,
    logger,
    connection,
  });
  return { routes, store, oauth, dispose, fetchImpl };
}

/** Incoming request whose body is the given JSON value. */
function jsonRequest(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  stream.method = method;
  stream.url = url;
  return stream;
}

/** Response recorder resolving to status, headers, and parsed body. */
function responseRecorder() {
  let resolve;
  const done = new Promise((settle) => { resolve = settle; });
  const response = {
    status: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(body) {
      this.body = body === undefined ? undefined : String(body);
      resolve(this);
    },
    done,
  };
  return response;
}

/** Run one registered route and resolve its recorded response. */
async function call(harnessRef, path, { method = 'GET', body, url } = {}) {
  const routePath = `${ROUTE_PREFIX}${path.split('?')[0]}`;
  const handler = harnessRef.routes.get(routePath);
  assert.ok(handler, `route ${path} is registered`);
  const request = jsonRequest(method, url ?? `${ROUTE_PREFIX}${path}`, body);
  const response = responseRecorder();
  await handler(request, response);
  const recorded = await response.done;
  return { status: recorded.status, headers: recorded.headers, body: recorded.body };
}

/** Parse one JSON route response. */
function payload(result) {
  return JSON.parse(result.body);
}

test('status reports logged-out config, login, and inference state', async () => {
  const harnessRef = harness({ fetchImpl: async () => textResponse(401, 'no') });
  const result = await call(harnessRef, '/api/status');
  assert.equal(result.status, 200);
  const data = payload(result).data;
  assert.equal(data.auth.loggedIn, false);
  assert.equal(data.auth.loginExpired, false);
  assert.equal(data.login.state, 'idle');
  assert.equal(data.config.family, 'bigmodel');
  assert.equal(data.config.inferenceCredentialRef, 'ZAI_CODING_CN_API_KEY');
  assert.equal(data.inference.available, false);
  assert.equal(data.inference.error, 'credentials_unavailable');
  harnessRef.dispose();
});

test('login start returns the authorize URL and poll reports pending then ready', async () => {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  let pollCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/oauth/cli/init') {
      return jsonResponse({
        code: 0,
        msg: '',
        data: {
          flow_id: 'flow-1',
          authorize_url: 'https://bigmodel.cn/login?appId=zcode&state=x',
          expires_at: Math.floor((clock + 300_000) / 1000),
          poll_interval_sec: 2,
        },
      });
    }
    if (parsed.pathname === '/api/v1/oauth/cli/poll/flow-1') {
      pollCalls += 1;
      if (pollCalls === 1) return jsonResponse({ code: 0, data: { status: 'pending' } });
      return jsonResponse({
        code: 0,
        data: {
          status: 'ready',
          token: 'zcode-jwt',
          user: { user_id: 'u1', name: 'Tester' },
          bigmodel: { access_token: 'business-token' },
        },
      });
    }
    return textResponse(404, 'unexpected');
  };
  const harnessRef = harness({ fetchImpl, now });

  const start = await call(harnessRef, '/api/login', { method: 'POST', body: { family: 'bigmodel' } });
  assert.equal(start.status, 200);
  const started = payload(start).data;
  assert.match(started.authorizeUrl, /^https:\/\/bigmodel\.cn\/login\?/);
  assert.equal(started.pollIntervalMs, 2000);

  const pending = await call(harnessRef, '/api/login/poll');
  assert.equal(payload(pending).data.state, 'pending');

  clock += 2_500;
  const ready = await call(harnessRef, '/api/login/poll');
  assert.equal(payload(ready).data.state, 'ready');
  assert.equal(payload(ready).data.user.name, 'Tester');

  const status = await call(harnessRef, '/api/status');
  const data = payload(status).data;
  assert.equal(data.auth.loggedIn, true);
  assert.equal(data.auth.user.name, 'Tester');
  assert.equal(data.login.state, 'ready');
  harnessRef.dispose();
});

test('config updates persist and unknown families are rejected', async () => {
  const harnessRef = harness({ fetchImpl: async () => textResponse(401, 'no') });
  const saved = await call(harnessRef, '/api/config', {
    method: 'POST',
    body: { refreshMinutes: 5, inferenceEnabled: false, providerIds: [' zai-coding-cn '] },
  });
  assert.equal(saved.status, 200);
  const data = payload(saved).data;
  assert.equal(data.refreshMinutes, 5);
  assert.equal(data.inferenceEnabled, false);
  assert.deepEqual(data.providerIds, ['zai-coding-cn']);

  const badLogin = await call(harnessRef, '/api/login', { method: 'POST', body: { family: 'nope' } });
  assert.equal(badLogin.status, 400);
  assert.equal(payload(badLogin).error.code, 'invalid_request');
  harnessRef.dispose();
});

test('logged-out usage and reset routes answer not_logged_in', async () => {
  const harnessRef = harness({ fetchImpl: async () => textResponse(401, 'no') });
  const usage = await call(harnessRef, '/api/usage');
  assert.equal(usage.status, 409);
  assert.equal(payload(usage).error.code, 'not_logged_in');

  const reset = await call(harnessRef, '/api/reset');
  assert.equal(reset.status, 409);

  const use = await call(harnessRef, '/api/reset/use', {
    method: 'POST',
    body: { resetType: 'FIVE_HOUR', idempotencyKey: 'key-1' },
  });
  assert.equal(use.status, 409);
  harnessRef.dispose();
});

test('route validation rejects unknown ranges, methods, and reset bodies', async () => {
  const harnessRef = harness({ fetchImpl: async () => textResponse(401, 'no') });
  const range = await call(harnessRef, '/api/usage?range=forever');
  assert.equal(range.status, 400);
  assert.equal(payload(range).error.code, 'invalid_request');

  const method = await call(harnessRef, '/api/status', { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, 'GET');

  const badResetType = await call(harnessRef, '/api/reset/use', {
    method: 'POST',
    body: { resetType: 'five_hour', idempotencyKey: 'key-1' },
  });
  assert.equal(badResetType.status, 400);

  const missingKey = await call(harnessRef, '/api/reset/use', {
    method: 'POST',
    body: { resetType: 'WEEK' },
  });
  assert.equal(missingKey.status, 400);
  harnessRef.dispose();
});

test('unauthenticated peers are refused by the connection gate', async () => {
  const harnessRef = harness({
    fetchImpl: async () => textResponse(401, 'no'),
    connection: () => ({ requestRejection: () => 401 }),
  });
  const result = await call(harnessRef, '/api/status');
  assert.equal(result.status, 401);
  assert.equal(result.body, 'unauthorized\n');

  harnessRef.dispose();
  const untrusted = harness({
    fetchImpl: async () => textResponse(401, 'no'),
    connection: () => ({ requestRejection: () => 403 }),
  });
  const forbidden = await call(untrusted, '/api/overview');
  assert.equal(forbidden.status, 403);
  untrusted.dispose();
});

test('overview reports the logged-out state without upstream calls', async () => {
  let upstreamCalls = 0;
  const harnessRef = harness({
    fetchImpl: async () => {
      upstreamCalls += 1;
      return textResponse(401, 'no');
    },
  });
  const result = await call(harnessRef, '/api/overview');
  assert.equal(result.status, 200);
  const data = payload(result).data;
  assert.equal(data.auth.loggedIn, false);
  assert.equal(data.quota, null);
  assert.equal(upstreamCalls, 0);
  harnessRef.dispose();
});

test('an oversized request body is answered with 413 instead of a reset stream', async () => {
  const harnessRef = harness({ fetchImpl: async () => textResponse(401, 'no') });
  const handler = harnessRef.routes.get(`${ROUTE_PREFIX}/api/config`);
  assert.ok(handler, 'config route is registered');
  const body = Buffer.alloc(128 * 1024, 0x61);
  const request = Readable.from([body]);
  request.method = 'POST';
  request.url = `${ROUTE_PREFIX}/api/config`;
  const response = responseRecorder();
  await handler(request, response);
  const recorded = await response.done;
  assert.equal(recorded.status, 413);
  assert.equal(JSON.parse(recorded.body).error.code, 'invalid_request');
  harnessRef.dispose();
});

test('host entry wires every route under the plugin prefix and disposes them', async () => {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    // The settings service never arrives in this harness; the startup
    // provisioning callback must simply stay dormant.
    inject(names, callback) {
      return () => {};
    },
    get() {
      return undefined;
    },
  };
  apply(ctx);
  const expected = [
    '/api/status', '/api/login', '/api/login/poll', '/api/logout', '/api/config',
    '/api/overview', '/api/usage', '/api/reset', '/api/reset/use',
  ];
  assert.deepEqual([...routes.keys()].sort(), expected.map((path) => `${ROUTE_PREFIX}${path}`).sort());
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(routes.size, 0);
});
