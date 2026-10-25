/**
 * Host authentication tests: the ZCode CLI OAuth state machine and the
 * BigModel account/project-token authorization helpers.
 *
 * Every upstream call is mocked through `createHttp({ fetchImpl })`; time is
 * injected so poll intervals, flow expiry, cache TTLs, and token refresh are
 * deterministic. Fixtures under tests/fixtures hold sanitized upstream replies.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { HostError, createHttp } from '../../lib/host/http.js';
import {
  ACCESS_TOKEN_CLIENT_VERSION,
  FAMILIES,
  PROJECT_TOKEN_REFRESH_LEAD_MS,
  ZAI_BUSINESS_LOGIN_PATH,
  ZCODE_ORIGIN,
  OAUTH_INIT_PATH,
  oauthPollPath,
} from '../../lib/host/constants.js';
import { createOAuth } from '../../lib/host/oauth.js';
import { createAccount, pickPersonalProject } from '../../lib/host/account.js';

const INIT_URL = `${ZCODE_ORIGIN}${OAUTH_INIT_PATH}`;
const OAUTH_STARTED_AT = 1_782_999_000_000;
const ACCOUNT_NOW = 1_783_000_000_000;
const SECOND = 1_000;

const CUSTOMER_INFO_PATH = '/api/biz/customer/getCustomerInfo';
const KEY_LIST_PATH = '/api/biz/v1/organization/org-personal-0001/projects/proj-personal-0001/api_keys';
const TOKEN_PATH = `${KEY_LIST_PATH}/ak-personal-coding-plan-0001/access_tokens`;
const KEY_LOCATION = {
  organizationId: 'org-personal-0001',
  projectId: 'proj-personal-0001',
  apiKeyId: 'ak-personal-coding-plan-0001',
};

/** Parse one sanitized upstream fixture. */
function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

/** Build a deterministic JWT-shaped token with the given claims. */
function encodeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

/** Writable clock handed to the factories as `now`. */
function createClock(start) {
  let current = start;
  return {
    now: () => current,
    get value() {
      return current;
    },
    advance(milliseconds) {
      current += milliseconds;
    },
    set(value) {
      current = value;
    },
  };
}

/** Logger that records lines so tests can assert that no secret is written. */
function createLogger() {
  const lines = [];
  const record = (level) => (...args) => lines.push(`${level} ${args.map(String).join(' ')}`);
  return { lines, info: record('info'), warn: record('warn'), debug: record('debug'), error: record('error') };
}

/** In-memory stand-in for the plugin store. */
function createAuthStore(initial = null) {
  let auth = initial === null ? null : structuredClone(initial);
  const writes = [];
  return {
    readAuth: () => (auth === null ? null : structuredClone(auth)),
    writeAuth: (value) => {
      const stored = structuredClone(value);
      writes.push(stored);
      auth = stored;
      return structuredClone(stored);
    },
    clearAuth: () => {
      const had = auth !== null;
      auth = null;
      return had;
    },
    get current() {
      return auth === null ? null : structuredClone(auth);
    },
    get writes() {
      return writes;
    },
  };
}

/**
 * Build a fetch implementation plus a call log from one reply handler.
 * The handler returns `{ status?, body? }` or an Error to simulate a network failure.
 */
function createHttpHarness(handler) {
  const calls = [];
  const http = createHttp({
    fetchImpl: async (url, init = {}) => {
      const call = {
        url: String(url),
        method: (init.method ?? 'GET').toUpperCase(),
        headers: { ...(init.headers ?? {}) },
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const reply = await handler(call);
      if (reply instanceof Error) throw reply;
      const status = reply.status ?? 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers(),
        text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)),
      };
    },
  });
  return { http, calls };
}

/** Read one request header case-insensitively. */
function headerValue(call, name) {
  const entry = Object.entries(call.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

/** Path of one mocked request URL. */
function urlPath(call) {
  return new URL(call.url).pathname;
}

/** Instance under test for the OAuth flow. */
function createOAuthHarness(handler, options = {}) {
  const store = createAuthStore(options.initialAuth ?? null);
  const logger = createLogger();
  const clock = createClock(options.start ?? OAUTH_STARTED_AT);
  const { http, calls } = createHttpHarness(handler);
  const oauth = createOAuth({ http, store, logger, now: clock.now });
  return { oauth, store, logger, clock, calls };
}

/** Instance under test for account authorization. */
function createAccountHarness(handler, options = {}) {
  const store = createAuthStore(options.initialAuth ?? null);
  const logger = createLogger();
  const clock = options.clock ?? createClock(ACCOUNT_NOW);
  const { http, calls } = createHttpHarness(handler);
  const account = createAccount({ http, store, logger, now: clock.now });
  return { account, store, logger, clock, calls };
}

/** Record probe request headers and replay the given statuses. */
function createProbe(statuses) {
  const seen = [];
  const request = async (authorization) => {
    seen.push(authorization);
    const status = statuses[Math.min(seen.length - 1, statuses.length - 1)];
    return { status, body: {} };
  };
  return { seen, request };
}

/** Await a rejection and return it after asserting the promise rejected. */
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('Expected the promise to reject');
}

/** Assert both the code and the HTTP status of a typed HostError. */
function assertHostError(error, code, status) {
  assert.ok(error instanceof HostError, `expected a HostError, received ${String(error)}`);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
}

/** Customer info fixture already normalized the way loadAccount returns it. */
const NORMALIZED_ACCOUNT = {
  customerNumber: '10000000001',
  customerName: 'Alice',
  nickName: 'alice',
  avatar: 'https://example.com/avatar/alice.png',
  organizations: [
    {
      organizationId: 'org-personal-0001',
      organizationName: '默认机构',
      projects: [
        { projectId: 'proj-personal-0001', projectName: '默认项目', projectType: 1 },
        { projectId: 'proj-team-0001', projectName: 'Team Project', projectType: 2 },
      ],
    },
    {
      organizationId: 'org-team-0002',
      organizationName: 'Acme Team',
      projects: [{ projectId: 'proj-team-0002', projectName: 'Acme Coding Plan', projectType: 2 }],
    },
  ],
};

/** A customer-info payload that only contains team projects. */
const TEAM_ONLY_CUSTOMER = {
  code: 200,
  success: true,
  data: {
    organizations: [
      {
        organizationId: 'org-team-0002',
        organizationName: 'Acme Team',
        projects: [{ projectId: 'proj-team-0002', projectName: 'Acme Coding Plan', projectType: 2 }],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// OAuth: init
// ---------------------------------------------------------------------------

test('oauth start: posts init with a random bearer and maps the pending flow', async () => {
  const init = fixture('oauth-init');
  const harness = createOAuthHarness((call) => {
    assert.equal(call.method, 'POST');
    assert.equal(call.url, INIT_URL);
    return { body: init };
  });
  const started = await harness.oauth.start({ family: 'bigmodel' });

  assert.equal(started.family, 'bigmodel');
  assert.equal(started.expiresAt, OAUTH_STARTED_AT + 300_000);
  assert.equal(started.pollIntervalMs, 2_000);
  const authorizeUrl = new URL(started.authorizeUrl);
  assert.equal(authorizeUrl.origin, 'https://bigmodel.cn');
  assert.equal(authorizeUrl.searchParams.get('state'), '9d1f3c7a5e2b8f4a6c0d3e7b1a9f5c2d');
  assert.deepEqual(harness.oauth.pending(), {
    family: 'bigmodel',
    authorizeUrl: started.authorizeUrl,
    expiresAt: OAUTH_STARTED_AT + 300_000,
  });

  assert.equal(harness.calls.length, 1);
  const bearer = headerValue(harness.calls[0], 'authorization');
  assert.match(bearer, /^Bearer [0-9a-f]{64}$/);
  assert.equal(headerValue(harness.calls[0], 'content-type'), 'application/json');
  assert.deepEqual(harness.calls[0].body, { provider: 'bigmodel' });
});

test('oauth start: maps the zai family to its authorize provider', async () => {
  const init = fixture('oauth-init');
  const harness = createOAuthHarness(() => ({ body: init }));
  const started = await harness.oauth.start({ family: 'zai' });
  assert.equal(started.family, 'zai');
  assert.deepEqual(harness.calls[0].body, { provider: 'zai' });
});

test('oauth start: replaces an earlier pending flow', async () => {
  const init = fixture('oauth-init');
  const harness = createOAuthHarness(() => ({ body: init }));
  await harness.oauth.start({ family: 'bigmodel' });
  await harness.oauth.start({ family: 'zai' });
  assert.equal(harness.oauth.pending().family, 'zai');
  assert.equal(harness.calls.length, 2);
});

test('oauth start: maps transport and envelope failures to typed errors', async (t) => {
  await t.test('init 5xx reports oauth_unavailable', async () => {
    const harness = createOAuthHarness(() => ({ status: 503, body: { code: 500, msg: 'down' } }));
    const error = await rejection(harness.oauth.start({ family: 'bigmodel' }));
    assertHostError(error, 'oauth_unavailable', 502);
    assert.equal(harness.oauth.pending(), null);
  });

  await t.test('init network failure reports oauth_unavailable', async () => {
    const harness = createOAuthHarness(() => new Error('socket hang up'));
    const error = await rejection(harness.oauth.start({ family: 'bigmodel' }));
    assertHostError(error, 'oauth_unavailable', 502);
    assert.ok(!error.message.includes('socket'));
  });

  const invalidCases = [
    ['non-zero envelope code', (init) => ({ ...init, code: 1 })],
    ['missing data', (init) => ({ ...init, data: undefined })],
    ['missing flow id', (init) => ({ ...init, data: { ...init.data, flow_id: '  ' } })],
    ['missing authorize url', (init) => ({ ...init, data: { ...init.data, authorize_url: undefined } })],
    ['non-https authorize url', (init) => ({ ...init, data: { ...init.data, authorize_url: 'http://bigmodel.cn/login' } })],
    ['unparseable authorize url', (init) => ({ ...init, data: { ...init.data, authorize_url: 'not-a-url' } })],
    ['expired flow', (init) => ({ ...init, data: { ...init.data, expires_at: 1_782_998_000 } })],
    ['too-fast poll interval', (init) => ({ ...init, data: { ...init.data, poll_interval_sec: 0.5 } })],
    ['non-numeric poll interval', (init) => ({ ...init, data: { ...init.data, poll_interval_sec: '2' } })],
  ];
  for (const [label, mutate] of invalidCases) {
    await t.test(`init ${label} reports oauth_invalid_response`, async () => {
      const init = fixture('oauth-init');
      const harness = createOAuthHarness(() => ({ body: mutate(init) }));
      const error = await rejection(harness.oauth.start({ family: 'bigmodel' }));
      assertHostError(error, 'oauth_invalid_response', 502);
      assert.equal(harness.oauth.pending(), null);
      assert.equal(harness.store.writes.length, 0);
    });
  }

  await t.test('unknown family is rejected before any request', async () => {
    const harness = createOAuthHarness(() => ({ body: fixture('oauth-init') }));
    const error = await rejection(harness.oauth.start({ family: 'openai' }));
    assertHostError(error, 'invalid_request', 400);
    assert.equal(harness.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// OAuth: poll
// ---------------------------------------------------------------------------

test('oauth poll: honors the interval, persists the login, and reports ready', async () => {
  const init = fixture('oauth-init');
  const ready = fixture('oauth-poll-ready');
  const pollUrl = `${ZCODE_ORIGIN}${oauthPollPath(init.data.flow_id)}`;
  let polls = 0;
  const harness = createOAuthHarness((call) => {
    if (call.url === INIT_URL) return { body: init };
    assert.equal(call.url, pollUrl);
    polls += 1;
    return { body: polls === 1 ? { code: 0, data: { status: 'pending' } } : ready };
  });
  const { oauth, calls, store, clock, logger } = harness;
  const started = await oauth.start({ family: 'bigmodel' });

  assert.deepEqual(await oauth.poll(), { state: 'pending' });
  assert.equal(calls.length, 2);
  // Inside the poll interval the Host answers without another upstream call.
  assert.deepEqual(await oauth.poll(), { state: 'pending' });
  assert.equal(calls.length, 2);

  clock.advance(started.pollIntervalMs);
  const readyState = await oauth.poll();
  assert.equal(readyState.state, 'ready');
  assert.deepEqual(readyState.user, {
    id: 'u_zcode_0001',
    name: 'Alice',
    email: 'alice@example.com',
    avatar: 'https://example.com/avatar/alice.png',
  });
  assert.equal(oauth.pending(), null);
  assert.equal(polls, 2);
  // Poll requests reuse the random bearer generated for the init call.
  const bearer = headerValue(calls[0], 'authorization');
  assert.match(bearer, /^Bearer [0-9a-f]{64}$/);
  assert.equal(headerValue(calls[1], 'authorization'), bearer);
  assert.equal(headerValue(calls[2], 'authorization'), bearer);
  assert.equal(calls[1].method, 'GET');

  assert.equal(store.writes.length, 1);
  const [stored] = store.writes;
  assert.equal(stored.family, 'bigmodel');
  assert.equal(stored.accessToken, ready.data.bigmodel.access_token);
  assert.equal(stored.zcodeJwtToken, ready.data.token);
  assert.equal(stored.refreshToken, ready.data.bigmodel.refresh_token);
  // The fixture access token is not a JWT, so no expiry claim is decoded.
  assert.equal(stored.expiresAt, null);
  assert.equal(stored.loggedInAt, clock.value);
  assert.deepEqual(stored.user, readyState.user);
  assert.deepEqual(stored.account, {});
  assert.equal(stored.keyLocation, null);

  assert.deepEqual(await oauth.poll(), { state: 'ready', user: readyState.user });

  const secrets = [ready.data.token, ready.data.bigmodel.access_token, ready.data.bigmodel.refresh_token, bearer];
  for (const secret of secrets) {
    assert.ok(!logger.lines.join('\n').includes(secret), 'a token leaked into the logs');
  }
});

test('oauth poll: extracts the bigmodel access token and camel-case fallbacks', async (t) => {
  await t.test('bigmodel uses the bigmodel access token', async () => {
    const init = fixture('oauth-init');
    const ready = fixture('oauth-poll-ready');
    const harness = createOAuthHarness((call) => ({ body: call.url === INIT_URL ? init : ready }));
    await harness.oauth.start({ family: 'bigmodel' });
    const polled = await harness.oauth.poll();
    assert.equal(polled.state, 'ready');
    const [stored] = harness.store.writes;
    assert.equal(stored.family, 'bigmodel');
    assert.equal(stored.accessToken, ready.data.bigmodel.access_token);
    assert.equal(stored.zcodeJwtToken, ready.data.token);
    assert.equal(stored.refreshToken, ready.data.bigmodel.refresh_token);
  });

  await t.test('bigmodel falls back to the camelCase accessToken field', async () => {
    const init = fixture('oauth-init');
    const ready = fixture('oauth-poll-ready');
    ready.data.bigmodel = { accessToken: 'camel-access-token' };
    const harness = createOAuthHarness((call) => ({ body: call.url === INIT_URL ? init : ready }));
    await harness.oauth.start({ family: 'bigmodel' });
    const polled = await harness.oauth.poll();
    assert.equal(polled.state, 'ready');
    assert.equal(harness.store.writes[0].accessToken, 'camel-access-token');
    assert.equal(harness.store.writes[0].expiresAt, null);
  });

  await t.test('an opaque bigmodel token stores a null expiry', async () => {
    const init = fixture('oauth-init');
    const ready = fixture('oauth-poll-ready');
    const harness = createOAuthHarness((call) => ({ body: call.url === INIT_URL ? init : ready }));
    await harness.oauth.start({ family: 'bigmodel' });
    await harness.oauth.poll();
    // The fixture business token JWT payload has no exp claim.
    assert.equal(harness.store.writes[0].expiresAt, null);
    assert.equal(harness.store.writes[0].accessToken, ready.data.bigmodel.access_token);
  });
});

test('oauth poll: exchanges the zai OAuth token for a business JWT', async (t) => {
  const ZAI_LOGIN_URL = `${FAMILIES.zai.origin}${ZAI_BUSINESS_LOGIN_PATH}`;

  await t.test('stores the business token and decodes its JWT expiry', async () => {
    const init = fixture('oauth-init');
    const ready = fixture('oauth-poll-ready');
    const oauthToken = encodeJwt({ sub: 'u_zcode_0001', typ: 'zai-oauth' });
    ready.data.zai.access_token = oauthToken;
    const businessToken = encodeJwt({ sub: 'u_zcode_0001', exp: 1_783_000_500 });
    let loginCalls = 0;
    const harness = createOAuthHarness((call) => {
      if (call.url === INIT_URL) return { body: init };
      if (call.url === ZAI_LOGIN_URL) {
        loginCalls += 1;
        assert.equal(call.method, 'POST');
        assert.equal(headerValue(call, 'authorization'), undefined);
        assert.deepEqual(call.body, { token: oauthToken });
        return { body: { code: 0, data: { access_token: businessToken, expires_in: 300 } } };
      }
      return { body: ready };
    });
    await harness.oauth.start({ family: 'zai' });
    const polled = await harness.oauth.poll();
    assert.equal(polled.state, 'ready');
    assert.equal(loginCalls, 1);
    const [stored] = harness.store.writes;
    assert.equal(stored.family, 'zai');
    assert.equal(stored.accessToken, businessToken);
    assert.equal(stored.expiresAt, 1_783_000_500 * SECOND);
    assert.equal(stored.zcodeJwtToken, ready.data.token);
    assert.ok(!('refreshToken' in stored));
  });

  await t.test('falls back to expires_in for an opaque business token', async () => {
    const init = fixture('oauth-init');
    const ready = fixture('oauth-poll-ready');
    const harness = createOAuthHarness((call) => {
      if (call.url === INIT_URL) return { body: init };
      if (call.url === ZAI_LOGIN_URL) {
        return { body: { code: 0, data: { access_token: 'opaque-business-token', expires_in: 600 } } };
      }
      return { body: ready };
    });
    await harness.oauth.start({ family: 'zai' });
    const polled = await harness.oauth.poll();
    assert.equal(polled.state, 'ready');
    const [stored] = harness.store.writes;
    assert.equal(stored.accessToken, 'opaque-business-token');
    assert.equal(stored.expiresAt, OAUTH_STARTED_AT + 600 * SECOND);
  });

  await t.test('accepts the camelCase business token field', async () => {
    const init = fixture('oauth-init');
    const ready = fixture('oauth-poll-ready');
    const harness = createOAuthHarness((call) => {
      if (call.url === INIT_URL) return { body: init };
      if (call.url === ZAI_LOGIN_URL) return { body: { code: 200, data: { accessToken: 'camel-business-token' } } };
      return { body: ready };
    });
    await harness.oauth.start({ family: 'zai' });
    await harness.oauth.poll();
    assert.equal(harness.store.writes[0].accessToken, 'camel-business-token');
    assert.equal(harness.store.writes[0].expiresAt, null);
  });

  await t.test('a failed exchange reports zai_business_login_failed', async () => {
    const init = fixture('oauth-init');
    const ready = fixture('oauth-poll-ready');
    const harness = createOAuthHarness((call) => {
      if (call.url === INIT_URL) return { body: init };
      if (call.url === ZAI_LOGIN_URL) return { status: 500, body: { code: 500 } };
      return { body: ready };
    });
    await harness.oauth.start({ family: 'zai' });
    const polled = await harness.oauth.poll();
    assert.deepEqual(polled, { state: 'failed', error: 'zai_business_login_failed' });
    assert.equal(harness.oauth.pending(), null);
    assert.equal(harness.store.writes.length, 0);
    const secrets = [ready.data.zai.access_token, ready.data.token];
    for (const secret of secrets) {
      assert.ok(!harness.logger.lines.join('\n').includes(secret), 'a token leaked into the logs');
    }
  });

  await t.test('a non-zero exchange envelope reports zai_business_login_failed', async () => {
    const init = fixture('oauth-init');
    const ready = fixture('oauth-poll-ready');
    const harness = createOAuthHarness((call) => {
      if (call.url === INIT_URL) return { body: init };
      if (call.url === ZAI_LOGIN_URL) return { body: { code: 401, msg: 'denied' } };
      return { body: ready };
    });
    await harness.oauth.start({ family: 'zai' });
    assert.deepEqual(await harness.oauth.poll(), { state: 'failed', error: 'zai_business_login_failed' });
    assert.equal(harness.store.writes.length, 0);
  });

  await t.test('an exchange reply without a token reports zai_business_login_failed', async () => {
    const init = fixture('oauth-init');
    const ready = fixture('oauth-poll-ready');
    const harness = createOAuthHarness((call) => {
      if (call.url === INIT_URL) return { body: init };
      if (call.url === ZAI_LOGIN_URL) return { body: { code: 0, data: {} } };
      return { body: ready };
    });
    await harness.oauth.start({ family: 'zai' });
    assert.deepEqual(await harness.oauth.poll(), { state: 'failed', error: 'zai_business_login_failed' });
  });
});

test('oauth poll: handles failed, expired, transient, and malformed replies', async (t) => {
  const init = fixture('oauth-init');
  const ready = fixture('oauth-poll-ready');

  await t.test('failed status forgets the flow', async () => {
    const harness = createOAuthHarness((call) => ({
      body: call.url === INIT_URL ? init : { code: 0, data: { status: 'failed' } },
    }));
    await harness.oauth.start({ family: 'bigmodel' });
    const result = await harness.oauth.poll();
    assert.equal(result.state, 'failed');
    assert.equal(typeof result.error, 'string');
    assert.equal(harness.oauth.pending(), null);
    assert.equal(harness.store.writes.length, 0);
    assert.deepEqual(await harness.oauth.poll(), { state: 'idle' });
  });

  await t.test('expired flow is forgotten without another request', async () => {
    const harness = createOAuthHarness(() => ({ body: init }));
    const started = await harness.oauth.start({ family: 'bigmodel' });
    harness.clock.set(started.expiresAt + 1);
    assert.deepEqual(await harness.oauth.poll(), { state: 'expired' });
    assert.equal(harness.oauth.pending(), null);
    assert.equal(harness.calls.length, 1);
    assert.deepEqual(await harness.oauth.poll(), { state: 'idle' });
  });

  await t.test('a transport error keeps the flow and retries at the next interval', async () => {
    let pollAttempts = 0;
    const harness = createOAuthHarness((call) => {
      if (call.url === INIT_URL) return { body: init };
      pollAttempts += 1;
      if (pollAttempts === 1) return new Error('network down');
      return { body: ready };
    });
    const started = await harness.oauth.start({ family: 'bigmodel' });
    assert.deepEqual(await harness.oauth.poll(), { state: 'pending' });
    assert.notEqual(harness.oauth.pending(), null);
    harness.clock.advance(started.pollIntervalMs);
    const polled = await harness.oauth.poll();
    assert.equal(polled.state, 'ready');
    assert.equal(harness.calls.length, 3);
  });

  await t.test('a transient 5xx keeps the flow', async () => {
    const harness = createOAuthHarness((call) => ({
      body: call.url === INIT_URL ? init : undefined,
      status: call.url === INIT_URL ? 200 : 503,
    }));
    await harness.oauth.start({ family: 'bigmodel' });
    assert.deepEqual(await harness.oauth.poll(), { state: 'pending' });
    assert.notEqual(harness.oauth.pending(), null);
  });

  await t.test('a terminal 4xx reports failed and forgets the flow', async () => {
    const harness = createOAuthHarness((call) => ({
      status: call.url === INIT_URL ? 200 : 404,
      body: call.url === INIT_URL ? init : { msg: 'gone' },
    }));
    await harness.oauth.start({ family: 'bigmodel' });
    const result = await harness.oauth.poll();
    assert.equal(result.state, 'failed');
    assert.equal(harness.oauth.pending(), null);
  });

  await t.test('a ready reply without a user id is an invalid response', async () => {
    const broken = fixture('oauth-poll-ready');
    delete broken.data.user.user_id;
    const harness = createOAuthHarness((call) => ({ body: call.url === INIT_URL ? init : broken }));
    await harness.oauth.start({ family: 'bigmodel' });
    const error = await rejection(harness.oauth.poll());
    assertHostError(error, 'oauth_invalid_response', 502);
    assert.equal(harness.oauth.pending(), null);
    assert.equal(harness.store.writes.length, 0);
    const secrets = [broken.data.token, broken.data.bigmodel.access_token, broken.data.bigmodel.refresh_token];
    for (const secret of secrets) {
      assert.ok(!error.message.includes(secret), 'a token leaked into the error message');
      assert.ok(!harness.logger.lines.join('\n').includes(secret), 'a token leaked into the logs');
    }
  });

  await t.test('a ready reply without the family token is an invalid response', async () => {
    const broken = fixture('oauth-poll-ready');
    delete broken.data.bigmodel;
    const harness = createOAuthHarness((call) => ({ body: call.url === INIT_URL ? init : broken }));
    await harness.oauth.start({ family: 'bigmodel' });
    const error = await rejection(harness.oauth.poll());
    assertHostError(error, 'oauth_invalid_response', 502);
  });

  await t.test('a non-zero poll envelope is an invalid response', async () => {
    const harness = createOAuthHarness((call) => ({
      body: call.url === INIT_URL ? init : { code: 7, msg: 'bad', data: {} },
    }));
    await harness.oauth.start({ family: 'bigmodel' });
    const error = await rejection(harness.oauth.poll());
    assertHostError(error, 'oauth_invalid_response', 502);
    assert.equal(harness.oauth.pending(), null);
  });

  await t.test('an unknown poll status is an invalid response', async () => {
    const harness = createOAuthHarness((call) => ({
      body: call.url === INIT_URL ? init : { code: 0, data: { status: 'weird' } },
    }));
    await harness.oauth.start({ family: 'bigmodel' });
    const error = await rejection(harness.oauth.poll());
    assertHostError(error, 'oauth_invalid_response', 502);
  });
});

test('oauth poll: with no pending flow reports the stored login state', async () => {
  const empty = createOAuthHarness(() => {
    throw new Error('no request expected');
  });
  assert.deepEqual(await empty.oauth.poll(), { state: 'idle' });
  assert.equal(empty.calls.length, 0);

  const storedUser = { id: 'u_1', name: 'Alice' };
  const stored = createOAuthHarness(() => {
    throw new Error('no request expected');
  }, { initialAuth: { family: 'bigmodel', accessToken: 'stored-token', user: storedUser } });
  assert.deepEqual(await stored.oauth.poll(), { state: 'ready', user: storedUser });
  assert.equal(stored.calls.length, 0);
});

test('oauth logout and cancel: forget the flow and the stored login', async () => {
  const init = fixture('oauth-init');
  const harness = createOAuthHarness(() => ({ body: init }), {
    initialAuth: { family: 'bigmodel', accessToken: 'stored-token', user: { id: 'u_1', name: 'Alice' } },
  });
  await harness.oauth.start({ family: 'bigmodel' });
  await harness.oauth.cancel();
  assert.equal(harness.oauth.pending(), null);
  assert.deepEqual(await harness.oauth.poll(), { state: 'ready', user: { id: 'u_1', name: 'Alice' } });

  await harness.oauth.start({ family: 'bigmodel' });
  await harness.oauth.logout();
  assert.equal(harness.oauth.pending(), null);
  assert.equal(harness.store.current, null);
  assert.deepEqual(await harness.oauth.poll(), { state: 'idle' });
});

// ---------------------------------------------------------------------------
// Account: project selection
// ---------------------------------------------------------------------------

test('pickPersonalProject: excludes team projects and prefers default names', async (t) => {
  await t.test('uses 默认机构 and 默认项目 from the real customer info', () => {
    assert.deepEqual(pickPersonalProject(fixture('customer-info').data), {
      organizationId: 'org-personal-0001',
      projectId: 'proj-personal-0001',
    });
  });

  await t.test('prefers an organization named 默认机构 even when listed later', () => {
    const account = {
      organizations: [
        { organizationId: 'org-a', organizationName: 'Alpha', projects: [{ projectId: 'p-a', projectName: 'A', projectType: 1 }] },
        {
          organizationId: 'org-default',
          organizationName: '默认机构（个人）',
          projects: [{ projectId: 'p-default', projectName: 'Other', projectType: 1 }],
        },
      ],
    };
    assert.deepEqual(pickPersonalProject(account), { organizationId: 'org-default', projectId: 'p-default' });
  });

  await t.test('prefers 默认项目 inside the selected organization', () => {
    const account = {
      organizations: [
        {
          organizationId: 'org-a',
          organizationName: 'Alpha',
          projects: [
            { projectId: 'p-first', projectName: 'First', projectType: 1 },
            { projectId: 'p-default', projectName: '默认项目', projectType: 1 },
          ],
        },
      ],
    };
    assert.deepEqual(pickPersonalProject(account), { organizationId: 'org-a', projectId: 'p-default' });
  });

  await t.test('falls back to the first non-team organization and project', () => {
    const account = {
      organizations: [
        { organizationId: 'org-team', organizationName: 'Team', projects: [{ projectId: 'p-team', projectName: 'T', projectType: 2 }] },
        { organizationId: 'org-b', organizationName: 'Beta', projects: [{ projectId: 'p-b', projectName: 'B', projectType: '1' }] },
      ],
    };
    assert.deepEqual(pickPersonalProject(account), { organizationId: 'org-b', projectId: 'p-b' });
  });

  await t.test('excludes projectType 2 in both number and string form', () => {
    const account = {
      organizations: [
        {
          organizationId: 'org-a',
          organizationName: 'Alpha',
          projects: [
            { projectId: 'p-num', projectName: 'Number', projectType: 2 },
            { projectId: 'p-str', projectName: 'String', projectType: '2' },
            { projectId: 'p-ok', projectName: 'Kept', projectType: 1 },
          ],
        },
      ],
    };
    assert.deepEqual(pickPersonalProject(account), { organizationId: 'org-a', projectId: 'p-ok' });
  });

  await t.test('returns null when only team projects exist', () => {
    assert.equal(pickPersonalProject(TEAM_ONLY_CUSTOMER.data), null);
    assert.equal(pickPersonalProject({ organizations: [] }), null);
    assert.equal(pickPersonalProject({}), null);
  });
});

// ---------------------------------------------------------------------------
// Account: customer info
// ---------------------------------------------------------------------------

test('loadAccount: fetches and normalizes customer info', async () => {
  const harness = createAccountHarness(() => ({ body: fixture('customer-info') }));
  const account = await harness.account.loadAccount({ family: 'bigmodel', accessToken: 'access-big' });
  assert.deepEqual(account, NORMALIZED_ACCOUNT);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].url, `https://bigmodel.cn${CUSTOMER_INFO_PATH}`);
  assert.equal(harness.calls[0].method, 'GET');
  assert.equal(headerValue(harness.calls[0], 'authorization'), 'access-big');
  assert.equal(headerValue(harness.calls[0], 'content-type'), 'application/json');

  await harness.account.loadAccount({ family: 'bigmodel', accessToken: 'access-big' });
  assert.equal(harness.calls.length, 1);
  await harness.account.loadAccount({ family: 'bigmodel', accessToken: 'access-big', force: true });
  assert.equal(harness.calls.length, 2);
});

test('loadAccount: refetches once its in-memory cache expires', async () => {
  const harness = createAccountHarness(() => ({ body: fixture('customer-info') }), {
    initialAuth: { family: 'bigmodel', accessToken: 'access-big', account: NORMALIZED_ACCOUNT },
  });
  const first = await harness.account.loadAccount({ family: 'bigmodel', accessToken: 'access-big' });
  assert.deepEqual(first, NORMALIZED_ACCOUNT);
  assert.equal(harness.calls.length, 1);
  assert.equal(headerValue(harness.calls[0], 'authorization'), 'access-big');
  harness.clock.advance(60 * 60_000 + 1);
  await harness.account.loadAccount({ family: 'bigmodel', accessToken: 'access-big' });
  assert.equal(harness.calls.length, 2);
});

test('loadAccount: retries zai customer info with a Bearer credential', async () => {
  const harness = createAccountHarness((call) =>
    headerValue(call, 'authorization') === 'Bearer access-zai'
      ? { body: fixture('customer-info') }
      : { status: 401, body: { code: 401 } },
  );
  const account = await harness.account.loadAccount({ family: 'zai', accessToken: 'access-zai' });
  assert.deepEqual(account, NORMALIZED_ACCOUNT);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0].url, `https://api.z.ai${CUSTOMER_INFO_PATH}`);
  assert.equal(headerValue(harness.calls[0], 'authorization'), 'access-zai');
  assert.equal(headerValue(harness.calls[1], 'authorization'), 'Bearer access-zai');
});

test('loadAccount: maps unauthorized and upstream failures', async (t) => {
  await t.test('401 reports login_expired', async () => {
    const harness = createAccountHarness(() => ({ status: 401, body: { code: 401 } }));
    const error = await rejection(harness.account.loadAccount({ family: 'bigmodel', accessToken: 'old' }));
    assertHostError(error, 'login_expired', 401);
  });

  await t.test('a zai login rejected in both forms reports login_expired', async () => {
    const harness = createAccountHarness(() => ({ status: 403, body: { code: 403 } }));
    const error = await rejection(harness.account.loadAccount({ family: 'zai', accessToken: 'old' }));
    assertHostError(error, 'login_expired', 401);
    assert.equal(harness.calls.length, 2);
  });

  await t.test('an invalid envelope reports upstream_failed', async () => {
    const harness = createAccountHarness(() => ({ body: { code: 200, success: false, data: {} } }));
    const error = await rejection(harness.account.loadAccount({ family: 'bigmodel', accessToken: 'token' }));
    assertHostError(error, 'upstream_failed', 502);
  });

  await t.test('a missing data object reports upstream_failed', async () => {
    const harness = createAccountHarness(() => ({ body: { code: 200 } }));
    const error = await rejection(harness.account.loadAccount({ family: 'bigmodel', accessToken: 'token' }));
    assertHostError(error, 'upstream_failed', 502);
  });

  await t.test('an HTTP 500 reports upstream_failed', async () => {
    const harness = createAccountHarness(() => ({ status: 500, body: { code: 500 } }));
    const error = await rejection(harness.account.loadAccount({ family: 'bigmodel', accessToken: 'token' }));
    assertHostError(error, 'upstream_failed', 502);
  });

  await t.test('a network failure reports upstream_failed', async () => {
    const harness = createAccountHarness(() => new Error('connection reset'));
    const error = await rejection(harness.account.loadAccount({ family: 'bigmodel', accessToken: 'token' }));
    assertHostError(error, 'upstream_failed', 502);
    assert.ok(!error.message.includes('connection reset'));
  });

  await t.test('invalid arguments are rejected before any request', async () => {
    const harness = createAccountHarness(() => ({ body: fixture('customer-info') }));
    assertHostError(await rejection(harness.account.loadAccount({ family: 'openai', accessToken: 'token' })), 'invalid_request', 400);
    assertHostError(await rejection(harness.account.loadAccount({ family: 'bigmodel' })), 'not_logged_in', 409);
    assert.equal(harness.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Account: API-key location
// ---------------------------------------------------------------------------

test('ensureKeyLocation: reuses the existing Coding Plan API key', async () => {
  const harness = createAccountHarness((call) => {
    const path = urlPath(call);
    if (path === CUSTOMER_INFO_PATH) return { body: fixture('customer-info') };
    if (path === KEY_LIST_PATH) return { body: fixture('api-keys') };
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  });
  const location = await harness.account.ensureKeyLocation({ family: 'bigmodel', accessToken: 'token-big' });
  assert.deepEqual(location, KEY_LOCATION);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1].method, 'GET');
  assert.equal(harness.calls[1].url, `https://bigmodel.cn${KEY_LIST_PATH}`);
  assert.equal(headerValue(harness.calls[1], 'authorization'), 'token-big');
  assert.ok(harness.calls.every((call) => call.method !== 'POST'), 'the existing key must not be recreated');
});

test('ensureKeyLocation: creates the key with the Coding Plan usage scene', async () => {
  const harness = createAccountHarness((call) => {
    const path = urlPath(call);
    if (path === CUSTOMER_INFO_PATH) return { body: fixture('customer-info') };
    if (path === KEY_LIST_PATH) {
      return call.method === 'POST'
        ? { body: { code: 200, data: { apiKey: 'ak-created' } } }
        : { body: { code: 200, data: [] } };
    }
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  });
  const location = await harness.account.ensureKeyLocation({ family: 'bigmodel', accessToken: 'token-big' });
  assert.deepEqual(location, { organizationId: 'org-personal-0001', projectId: 'proj-personal-0001', apiKeyId: 'ak-created' });
  const post = harness.calls.find((call) => call.method === 'POST');
  assert.ok(post, 'expected a key creation request');
  assert.equal(post.url, `https://bigmodel.cn${KEY_LIST_PATH}`);
  assert.deepEqual(post.body, { name: 'zcode-api-key', usageScene: 1 });
});

test('ensureKeyLocation: zai headers, stored locations, and in-flight deduplication', async (t) => {
  await t.test('zai key management uses a Bearer credential', async () => {
    const harness = createAccountHarness((call) => {
      const path = urlPath(call);
      if (path === CUSTOMER_INFO_PATH) {
        return headerValue(call, 'authorization') === 'Bearer token-zai'
          ? { body: fixture('customer-info') }
          : { status: 401, body: { code: 401 } };
      }
      if (path === KEY_LIST_PATH) return { body: fixture('api-keys') };
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });
    const location = await harness.account.ensureKeyLocation({ family: 'zai', accessToken: 'token-zai' });
    assert.deepEqual(location, KEY_LOCATION);
    assert.equal(harness.calls[2].url, `https://api.z.ai${KEY_LIST_PATH}`);
    assert.equal(headerValue(harness.calls[2], 'authorization'), 'Bearer token-zai');
  });

  await t.test('a stored key location answers without a request', async () => {
    const harness = createAccountHarness(() => {
      throw new Error('no request expected');
    }, {
      initialAuth: { family: 'bigmodel', accessToken: 'token-big', keyLocation: KEY_LOCATION },
    });
    assert.deepEqual(await harness.account.ensureKeyLocation({ family: 'bigmodel', accessToken: 'token-big' }), KEY_LOCATION);
    assert.equal(harness.calls.length, 0);
  });

  await t.test('concurrent callers share one key-creation request', async () => {
    const harness = createAccountHarness((call) => {
      const path = urlPath(call);
      if (path === CUSTOMER_INFO_PATH) return { body: fixture('customer-info') };
      if (path === KEY_LIST_PATH) {
        return call.method === 'POST'
          ? { body: { code: 200, data: { apiKey: 'ak-shared' } } }
          : { body: { code: 200, data: [] } };
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });
    const [first, second] = await Promise.all([
      harness.account.ensureKeyLocation({ family: 'bigmodel', accessToken: 'token-big' }),
      harness.account.ensureKeyLocation({ family: 'bigmodel', accessToken: 'token-big' }),
    ]);
    assert.deepEqual(first, second);
    assert.equal(first.apiKeyId, 'ak-shared');
    assert.equal(harness.calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(harness.calls.filter((call) => urlPath(call) === CUSTOMER_INFO_PATH).length, 1);
  });
});

test('ensureKeyLocation: maps no_project, login_expired, and bad envelopes', async (t) => {
  await t.test('no personal project reports no_project', async () => {
    const harness = createAccountHarness(() => ({ body: TEAM_ONLY_CUSTOMER }));
    const error = await rejection(harness.account.ensureKeyLocation({ family: 'bigmodel', accessToken: 'token-big' }));
    assertHostError(error, 'no_project', 409);
    assert.equal(harness.calls.length, 1);
  });

  await t.test('an unauthorized key list reports login_expired', async () => {
    const harness = createAccountHarness((call) => {
      const path = urlPath(call);
      if (path === CUSTOMER_INFO_PATH) return { body: fixture('customer-info') };
      return { status: 403, body: { code: 403 } };
    });
    const error = await rejection(harness.account.ensureKeyLocation({ family: 'bigmodel', accessToken: 'token-big' }));
    assertHostError(error, 'login_expired', 401);
  });

  await t.test('a malformed key list reports upstream_failed', async () => {
    const harness = createAccountHarness((call) => {
      const path = urlPath(call);
      if (path === CUSTOMER_INFO_PATH) return { body: fixture('customer-info') };
      return { body: { code: 200, data: {} } };
    });
    const error = await rejection(harness.account.ensureKeyLocation({ family: 'bigmodel', accessToken: 'token-big' }));
    assertHostError(error, 'upstream_failed', 502);
  });

  await t.test('a same-name key without an id is not duplicated', async () => {
    const harness = createAccountHarness((call) => {
      const path = urlPath(call);
      if (path === CUSTOMER_INFO_PATH) return { body: fixture('customer-info') };
      return { body: { code: 200, data: [{ name: 'zcode-api-key' }] } };
    });
    const error = await rejection(harness.account.ensureKeyLocation({ family: 'bigmodel', accessToken: 'token-big' }));
    assertHostError(error, 'upstream_failed', 502);
    assert.ok(harness.calls.every((call) => call.method !== 'POST'));
  });
});

// ---------------------------------------------------------------------------
// Account: project access tokens
// ---------------------------------------------------------------------------

test('issueProjectToken: parses the token and computes the earliest expiry', async (t) => {
  await t.test('uses the sanitized access-token fixture', async () => {
    const tokenFixture = fixture('access-tokens');
    const harness = createAccountHarness((call) => {
      assert.equal(urlPath(call), TOKEN_PATH);
      assert.equal(call.method, 'POST');
      assert.equal(headerValue(call, 'authorization'), 'Bearer access-token');
      assert.equal(call.body.clientType, 'zcode');
      assert.equal(call.body.clientVersion, ACCESS_TOKEN_CLIENT_VERSION);
      return { body: tokenFixture };
    });
    const issued = await harness.account.issueProjectToken({
      family: 'bigmodel',
      accessToken: 'access-token',
      keyLocation: KEY_LOCATION,
    });
    assert.deepEqual(issued, {
      token: tokenFixture.data.accessToken,
      expiresAt: tokenFixture.data.expiresAt * SECOND,
    });
    assert.equal(harness.calls[0].url, `https://bigmodel.cn${TOKEN_PATH}`);
  });

  await t.test('expiresIn wins when it is earlier than expiresAt', async () => {
    const nowSeconds = Math.floor(ACCOUNT_NOW / SECOND);
    const harness = createAccountHarness(() => ({
      body: { code: 200, data: { accessToken: 'token-a', expiresAt: nowSeconds + 600, expiresIn: 120 } },
    }));
    const issued = await harness.account.issueProjectToken({
      family: 'bigmodel',
      accessToken: 'access-token',
      keyLocation: KEY_LOCATION,
    });
    assert.deepEqual(issued, { token: 'token-a', expiresAt: ACCOUNT_NOW + 120 * SECOND });
  });

  await t.test('expiresAt wins when it is earlier than expiresIn', async () => {
    const nowSeconds = Math.floor(ACCOUNT_NOW / SECOND);
    const harness = createAccountHarness(() => ({
      body: { code: 200, data: { accessToken: 'token-b', expiresAt: nowSeconds + 60, expiresIn: 600 } },
    }));
    const issued = await harness.account.issueProjectToken({
      family: 'bigmodel',
      accessToken: 'access-token',
      keyLocation: KEY_LOCATION,
    });
    assert.deepEqual(issued, { token: 'token-b', expiresAt: ACCOUNT_NOW + 60 * SECOND });
  });

  await t.test('accepts snake_case token fields', async () => {
    const nowSeconds = Math.floor(ACCOUNT_NOW / SECOND);
    const harness = createAccountHarness(() => ({
      body: { code: 200, data: { access_token: 'token-snake', expires_at: nowSeconds + 300, expires_in: 60 } },
    }));
    const issued = await harness.account.issueProjectToken({
      family: 'bigmodel',
      accessToken: 'access-token',
      keyLocation: KEY_LOCATION,
    });
    assert.deepEqual(issued, { token: 'token-snake', expiresAt: ACCOUNT_NOW + 60 * SECOND });
  });

  await t.test('a disabled project token reports no_coding_plan', async () => {
    const harness = createAccountHarness(() => ({ body: { code: 200, data: { enable: false } } }));
    const error = await rejection(
      harness.account.issueProjectToken({ family: 'bigmodel', accessToken: 'access-token', keyLocation: KEY_LOCATION }),
    );
    assertHostError(error, 'no_coding_plan', 409);
  });

  await t.test('an unauthorized token request reports login_expired', async () => {
    const harness = createAccountHarness(() => ({ status: 401, body: { code: 401 } }));
    const error = await rejection(
      harness.account.issueProjectToken({ family: 'bigmodel', accessToken: 'access-token', keyLocation: KEY_LOCATION }),
    );
    assertHostError(error, 'login_expired', 401);
  });

  await t.test('incomplete token payloads report upstream_failed', async () => {
    for (const data of [{}, { accessToken: 'token' }, { expiresAt: 1_783_000_600 }]) {
      const harness = createAccountHarness(() => ({ body: { code: 200, data } }));
      const error = await rejection(
        harness.account.issueProjectToken({ family: 'bigmodel', accessToken: 'access-token', keyLocation: KEY_LOCATION }),
      );
      assertHostError(error, 'upstream_failed', 502);
    }
  });

  await t.test('a missing key location reports no_project', async () => {
    const harness = createAccountHarness(() => ({ body: fixture('access-tokens') }));
    const error = await rejection(harness.account.issueProjectToken({ family: 'bigmodel', accessToken: 'access-token' }));
    assertHostError(error, 'no_project', 409);
    assert.equal(harness.calls.length, 0);
  });
});

test('issueProjectToken: caches the token, honors force, and refreshes near expiry', async () => {
  const harness = createAccountHarness(() => ({ body: fixture('access-tokens') }));
  const call = () =>
    harness.account.issueProjectToken({ family: 'bigmodel', accessToken: 'access-token', keyLocation: KEY_LOCATION });

  const first = await call();
  assert.equal(first.token, fixture('access-tokens').data.accessToken);
  assert.equal(harness.calls.length, 1);
  const second = await call();
  assert.deepEqual(second, first);
  assert.equal(harness.calls.length, 1, 'a cached token must not be reissued');

  await harness.account.issueProjectToken({
    family: 'bigmodel',
    accessToken: 'access-token',
    keyLocation: KEY_LOCATION,
    force: true,
  });
  assert.equal(harness.calls.length, 2, 'force must reissue the token');

  harness.clock.advance(600 * SECOND - PROJECT_TOKEN_REFRESH_LEAD_MS + 1);
  await call();
  assert.equal(harness.calls.length, 3, 'a token inside the refresh lead must be reissued');
});

// ---------------------------------------------------------------------------
// Account: project material
// ---------------------------------------------------------------------------

test('getProjectMaterial: caches, refreshes, and returns the key location', async () => {
  const auth = { accessToken: 'material-access', keyLocation: KEY_LOCATION };
  let issued = 0;
  const harness = createAccountHarness((call) => {
    assert.equal(urlPath(call), TOKEN_PATH);
    issued += 1;
    return {
      body: {
        code: 200,
        data: {
          accessToken: `material-${issued}`,
          expiresAt: Math.floor(harness.clock.value / SECOND) + 600,
          expiresIn: 600,
        },
      },
    };
  });
  const material = () => harness.account.getProjectMaterial({ family: 'bigmodel', auth });

  const first = await material();
  assert.deepEqual(first, {
    token: 'material-1',
    expiresAt: ACCOUNT_NOW + 600 * SECOND,
    keyLocation: KEY_LOCATION,
  });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.store.writes.length, 0, 'the project token must not be persisted');
  assert.ok(!harness.logger.lines.join('\n').includes(first.token), 'the project token leaked into the logs');

  const second = await material();
  assert.deepEqual(second, first);
  assert.equal(harness.calls.length, 1);

  // Less than the refresh lead remains: reissue and return the new token.
  harness.clock.advance(first.expiresAt - ACCOUNT_NOW - PROJECT_TOKEN_REFRESH_LEAD_MS + 1);
  const third = await material();
  assert.equal(third.token, 'material-2');
  assert.equal(harness.calls.length, 2);

  await harness.account.getProjectMaterial({ family: 'bigmodel', auth, force: true });
  assert.equal(harness.calls.length, 3);

  harness.account.clearCache();
  const fifth = await material();
  assert.equal(fifth.token, 'material-4');
  assert.equal(harness.calls.length, 4);
});

test('getProjectMaterial: resolves a missing key location and maps failures', async (t) => {
  await t.test('resolves the project, key, and token when no location is stored', async () => {
    const harness = createAccountHarness((call) => {
      const path = urlPath(call);
      if (path === CUSTOMER_INFO_PATH) return { body: fixture('customer-info') };
      if (path === KEY_LIST_PATH) return { body: fixture('api-keys') };
      if (path === TOKEN_PATH) return { body: fixture('access-tokens') };
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });
    const material = await harness.account.getProjectMaterial({
      family: 'bigmodel',
      auth: { accessToken: 'access-token' },
    });
    assert.deepEqual(material.keyLocation, KEY_LOCATION);
    assert.equal(material.token, fixture('access-tokens').data.accessToken);
    assert.equal(harness.calls.length, 3);
  });

  await t.test('no personal project reports no_project', async () => {
    const harness = createAccountHarness(() => ({ body: TEAM_ONLY_CUSTOMER }));
    const error = await rejection(
      harness.account.getProjectMaterial({ family: 'bigmodel', auth: { accessToken: 'access-token' } }),
    );
    assertHostError(error, 'no_project', 409);
    assert.equal(harness.calls.length, 1);
  });

  await t.test('a missing access token reports not_logged_in', async () => {
    const harness = createAccountHarness(() => ({ body: fixture('access-tokens') }));
    const error = await rejection(harness.account.getProjectMaterial({ family: 'bigmodel', auth: {} }));
    assertHostError(error, 'not_logged_in', 409);
    assert.equal(harness.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Account: authorization probing
// ---------------------------------------------------------------------------

test('probeAuthorization: tries the project token first', async (t) => {
  await t.test('the raw project token wins and is cached', async () => {
    const tokenFixture = fixture('access-tokens');
    const harness = createAccountHarness(() => ({ body: tokenFixture }));
    const auth = { accessToken: 'access-token', keyLocation: KEY_LOCATION };
    const probe = createProbe([200]);
    const result = await harness.account.probeAuthorization({
      family: 'bigmodel',
      auth,
      channel: 'monitor',
      request: probe.request,
    });
    assert.equal(result.kind, 'project-raw');
    assert.equal(result.authorization, tokenFixture.data.accessToken);
    assert.deepEqual(result.response, { status: 200, body: {} });
    assert.deepEqual(probe.seen, [tokenFixture.data.accessToken]);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].method, 'POST');
    assert.equal(headerValue(harness.calls[0], 'authorization'), 'Bearer access-token');

    const cached = createProbe([200]);
    const cachedResult = await harness.account.probeAuthorization({
      family: 'bigmodel',
      auth,
      channel: 'monitor',
      request: cached.request,
    });
    assert.equal(cachedResult.kind, 'project-raw');
    assert.deepEqual(cached.seen, [tokenFixture.data.accessToken]);
    assert.equal(harness.calls.length, 1, 'the cached winner and token must not be reissued');
  });

  await t.test('a Bearer project token wins when the raw form is rejected', async () => {
    const tokenFixture = fixture('access-tokens');
    const harness = createAccountHarness(() => ({ body: tokenFixture }));
    const probe = createProbe([401, 200]);
    const result = await harness.account.probeAuthorization({
      family: 'bigmodel',
      auth: { accessToken: 'access-token', keyLocation: KEY_LOCATION },
      channel: 'monitor',
      request: probe.request,
    });
    assert.equal(result.kind, 'project-bearer');
    assert.equal(result.authorization, `Bearer ${tokenFixture.data.accessToken}`);
    assert.deepEqual(probe.seen, [tokenFixture.data.accessToken, `Bearer ${tokenFixture.data.accessToken}`]);
    assert.equal(harness.calls.length, 1);
  });

  await t.test('any non-auth status wins immediately', async () => {
    const tokenFixture = fixture('access-tokens');
    const harness = createAccountHarness(() => ({ body: tokenFixture }));
    for (const status of [200, 400, 409]) {
      const probe = createProbe([status]);
      const result = await harness.account.probeAuthorization({
        family: 'bigmodel',
        auth: { accessToken: 'access-token', keyLocation: KEY_LOCATION },
        channel: 'business',
        request: probe.request,
      });
      assert.equal(result.kind, 'project-raw');
      assert.equal(result.response.status, status);
      assert.equal(probe.seen.length, 1);
    }
  });
});

test('probeAuthorization: falls back to the OAuth access token after PAT rejections', async (t) => {
  const tokenFixture = fixture('access-tokens');

  await t.test('falls back to the raw access token', async () => {
    const harness = createAccountHarness(() => ({ body: tokenFixture }));
    const probe = createProbe([401, 401, 200]);
    const result = await harness.account.probeAuthorization({
      family: 'bigmodel',
      auth: { accessToken: 'access-token', keyLocation: KEY_LOCATION },
      channel: 'monitor',
      request: probe.request,
    });
    assert.equal(result.kind, 'access-raw');
    assert.equal(result.authorization, 'access-token');
    assert.deepEqual(probe.seen, [tokenFixture.data.accessToken, `Bearer ${tokenFixture.data.accessToken}`, 'access-token']);
    assert.equal(harness.calls.length, 1);
  });

  await t.test('falls back to the Bearer access token', async () => {
    const harness = createAccountHarness(() => ({ body: tokenFixture }));
    const probe = createProbe([401, 401, 401, 200]);
    const result = await harness.account.probeAuthorization({
      family: 'bigmodel',
      auth: { accessToken: 'access-token', keyLocation: KEY_LOCATION },
      channel: 'business',
      request: probe.request,
    });
    assert.equal(result.kind, 'access-bearer');
    assert.equal(result.authorization, 'Bearer access-token');
    assert.equal(probe.seen.at(-1), 'Bearer access-token');
  });

  await t.test('resolves a key location when the stored auth has none', async () => {
    const harness = createAccountHarness((call) => {
      const path = urlPath(call);
      if (path === CUSTOMER_INFO_PATH) return { body: fixture('customer-info') };
      if (path === KEY_LIST_PATH) return { body: fixture('api-keys') };
      if (path === TOKEN_PATH) return { body: tokenFixture };
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });
    const probe = createProbe([200]);
    const result = await harness.account.probeAuthorization({
      family: 'bigmodel',
      auth: { accessToken: 'access-token', keyLocation: null },
      channel: 'monitor',
      request: probe.request,
    });
    assert.equal(result.kind, 'project-raw');
    assert.equal(result.authorization, tokenFixture.data.accessToken);
    assert.equal(harness.calls.length, 3);
  });
});

test('probeAuthorization: separates channels, clears its cache, and maps failures', async (t) => {
  await t.test('each channel caches its own winning form', async () => {
    const tokenFixture = fixture('access-tokens');
    const harness = createAccountHarness(() => ({ body: tokenFixture }));
    const auth = { accessToken: 'access-token', keyLocation: KEY_LOCATION };
    const monitor = createProbe([401, 401, 200]);
    const monitorResult = await harness.account.probeAuthorization({
      family: 'bigmodel',
      auth,
      channel: 'monitor',
      request: monitor.request,
    });
    assert.equal(monitorResult.kind, 'access-raw');
    assert.equal(harness.calls.length, 1);

    const business = createProbe([200]);
    const businessResult = await harness.account.probeAuthorization({
      family: 'bigmodel',
      auth,
      channel: 'business',
      request: business.request,
    });
    assert.equal(businessResult.kind, 'project-raw');
    assert.deepEqual(business.seen, [tokenFixture.data.accessToken]);
    assert.equal(harness.calls.length, 1, 'the project token is shared through the material cache');
  });

  await t.test('clearCache makes the next probe start over', async () => {
    const tokenFixture = fixture('access-tokens');
    const harness = createAccountHarness(() => ({ body: tokenFixture }));
    const auth = { accessToken: 'access-token', keyLocation: KEY_LOCATION };
    await harness.account.probeAuthorization({
      family: 'bigmodel',
      auth,
      channel: 'monitor',
      request: createProbe([401, 401, 200]).request,
    });
    assert.equal(harness.calls.length, 1);
    harness.account.clearCache();
    const restarted = createProbe([200]);
    const result = await harness.account.probeAuthorization({
      family: 'bigmodel',
      auth,
      channel: 'monitor',
      request: restarted.request,
    });
    assert.equal(result.kind, 'project-raw');
    assert.deepEqual(restarted.seen, [tokenFixture.data.accessToken]);
    assert.equal(harness.calls.length, 2);
  });

  await t.test('every candidate rejected reports login_expired', async () => {
    const tokenFixture = fixture('access-tokens');
    const harness = createAccountHarness(() => ({ body: tokenFixture }));
    const probe = createProbe([401]);
    const error = await rejection(
      harness.account.probeAuthorization({
        family: 'bigmodel',
        auth: { accessToken: 'access-token', keyLocation: KEY_LOCATION },
        channel: 'monitor',
        request: probe.request,
      }),
    );
    assertHostError(error, 'login_expired', 401);
    assert.deepEqual(probe.seen, [
      tokenFixture.data.accessToken,
      `Bearer ${tokenFixture.data.accessToken}`,
      'access-token',
      'Bearer access-token',
    ]);
    assert.equal(harness.calls.length, 1);

    // The failed probe must not leave a cached winner behind.
    const retried = createProbe([200]);
    const retriedResult = await harness.account.probeAuthorization({
      family: 'bigmodel',
      auth: { accessToken: 'access-token', keyLocation: KEY_LOCATION },
      channel: 'monitor',
      request: retried.request,
    });
    assert.equal(retriedResult.kind, 'project-raw');
    assert.equal(retried.seen[0], tokenFixture.data.accessToken);
  });

  await t.test('a missing project reports no_project before probing', async () => {
    const harness = createAccountHarness(() => ({ body: TEAM_ONLY_CUSTOMER }));
    const probe = createProbe([401]);
    const error = await rejection(
      harness.account.probeAuthorization({
        family: 'bigmodel',
        auth: { accessToken: 'access-token' },
        channel: 'monitor',
        request: probe.request,
      }),
    );
    assertHostError(error, 'no_project', 409);
    assert.deepEqual(probe.seen, []);
    assert.equal(harness.calls.length, 1);
  });

  await t.test('a disabled project token reports no_coding_plan', async () => {
    const harness = createAccountHarness(() => ({ body: { code: 200, data: { enable: false } } }));
    const probe = createProbe([401]);
    const error = await rejection(
      harness.account.probeAuthorization({
        family: 'bigmodel',
        auth: { accessToken: 'access-token', keyLocation: KEY_LOCATION },
        channel: 'monitor',
        request: probe.request,
      }),
    );
    assertHostError(error, 'no_coding_plan', 409);
    assert.deepEqual(probe.seen, []);
  });

  await t.test('a transport failure from the request callback propagates', async () => {
    const harness = createAccountHarness(() => ({ body: fixture('access-tokens') }));
    const request = async () => {
      throw new Error('channel closed');
    };
    const error = await rejection(
      harness.account.probeAuthorization({
        family: 'bigmodel',
        auth: { accessToken: 'access-token', keyLocation: KEY_LOCATION },
        channel: 'monitor',
        request,
      }),
    );
    assert.equal(error.message, 'channel closed');
  });

  await t.test('invalid arguments are rejected without probing', async () => {
    const harness = createAccountHarness(() => ({ body: fixture('access-tokens') }));
    const probe = createProbe([200]);
    assertHostError(
      await rejection(
        harness.account.probeAuthorization({ family: 'bigmodel', auth: null, channel: 'monitor', request: probe.request }),
      ),
      'not_logged_in',
      409,
    );
    assertHostError(
      await rejection(
        harness.account.probeAuthorization({
          family: 'bigmodel',
          auth: { accessToken: 'token' },
          channel: 'other',
          request: probe.request,
        }),
      ),
      'invalid_request',
      400,
    );
    assertHostError(
      await rejection(
        harness.account.probeAuthorization({
          family: 'openai',
          auth: { accessToken: 'token' },
          channel: 'monitor',
          request: probe.request,
        }),
      ),
      'invalid_request',
      400,
    );
    assertHostError(
      await rejection(
        harness.account.probeAuthorization({
          family: 'bigmodel',
          auth: { accessToken: 'token' },
          channel: 'monitor',
          request: undefined,
        }),
      ),
      'invalid_request',
      400,
    );
    assert.equal(probe.seen.length, 0);
    assert.equal(harness.calls.length, 0);
  });
});
