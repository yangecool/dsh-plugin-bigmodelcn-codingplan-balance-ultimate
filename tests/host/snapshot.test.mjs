/**
 * Unit tests for lib/host/snapshot.js.
 *
 * The snapshot module is exercised entirely through injected fakes: a store,
 * the OAuth flow, the account/upstream modules, and the inference module. The
 * clock is a controllable value so TTL, stale and expiry behavior is exact.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HostError } from '../../lib/host/http.js';
import { createSnapshot } from '../../lib/host/snapshot.js';

const FIXED_NOW = Date.parse('2026-07-02T10:00:00Z');
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const KEY_LOCATION = Object.freeze({
  organizationId: 'org-1',
  projectId: 'proj-1',
  apiKeyId: 'key-1',
});

const ACCOUNT_DOC = Object.freeze({
  customerNumber: 'customer-1',
  customerName: 'Alice',
  nickName: 'alice',
  avatar: null,
  organizations: [],
});

const QUOTA = Object.freeze({
  level: 'pro',
  limits: [
    {
      type: 'TOKENS_LIMIT',
      unit: 3,
      number: 5,
      percentage: 25,
      nextResetTime: 1782881400000,
      usageDetails: [],
      window: 'fiveHour',
    },
    {
      type: 'TOKENS_LIMIT',
      unit: 6,
      number: 1,
      percentage: 40,
      usageDetails: [],
      window: 'week',
    },
    {
      type: 'TIME_LIMIT',
      unit: 5,
      number: 1,
      percentage: 12,
      nextResetTime: 1785500400000,
      usageDetails: [],
      window: 'tool',
    },
  ],
  envelope: { successful: true, message: '操作成功' },
  status: 200,
});

const SUBSCRIPTION = Object.freeze({
  active: true,
  productId: 'glm-coding-pro',
  productName: 'GLM Coding Pro',
  status: 'VALID',
  billingCycle: 'quarterly',
  renewTime: 1785549600000,
  expireAt: 1785549600000,
  autoRenew: true,
  raw: { item: 'sanitized upstream item' },
});

/** Subscription as exposed by the overview (the raw upstream item is dropped). */
const OVERVIEW_SUBSCRIPTION = Object.freeze({
  active: true,
  productId: 'glm-coding-pro',
  productName: 'GLM Coding Pro',
  status: 'VALID',
  billingCycle: 'quarterly',
  renewTime: 1785549600000,
  expireAt: 1785549600000,
  autoRenew: true,
});

/** Quota as exposed by the overview (envelope/status metadata is dropped). */
const OVERVIEW_QUOTA = Object.freeze({ level: 'pro', limits: QUOTA.limits });

const RESET_BLOCK = Object.freeze({
  fiveHour: { available: [{ expireAt: 1786000000000 }], latest: null },
  week: { available: [], latest: { usedAt: 1785990000000 } },
  hasUnreadHistory: true,
});

const USAGE_PAYLOAD = Object.freeze({
  range: '7d',
  timeZone: 'UTC',
  startTime: '2026-06-26 00:00:00',
  endTime: '2026-07-02 23:59:59',
  granularity: 'day',
  summary: {
    totalTokens: 2030,
    totalCalls: 5,
    activeDays: 2,
    peakDailyTokens: 1230,
    peakDailyTokensDate: '2026-07-01',
    currentStreakDays: 2,
    longestStreakDays: 2,
  },
  series: [
    { date: '2026-07-01', tokens: 1230, calls: 3 },
    { date: '2026-07-02', tokens: 800, calls: 2 },
  ],
  models: [{ modelCode: 'glm-4.6', modelName: 'glm-4.6', tokens: 2030, calls: 0 }],
  tools: [],
});

const silentLogger = { info() {}, warn() {}, debug() {} };

/** Stored auth document with a still-valid token. */
function createAuthDoc(overrides = {}) {
  return {
    family: 'bigmodel',
    accessToken: 'access-token',
    zcodeJwtToken: 'zcode-jwt',
    refreshToken: null,
    expiresAt: FIXED_NOW + HOUR,
    loggedInAt: FIXED_NOW - MINUTE,
    user: { id: 'user-1', name: 'Alice', email: null, avatar: null },
    account: { customerNumber: 'customer-1', customerName: 'Alice', avatar: null, organizations: [] },
    keyLocation: { ...KEY_LOCATION },
    inference: null,
    ...overrides,
  };
}

/** Persisted-state store mock. */
function createStoreMock({ config, auth } = {}) {
  const state = {
    config: {
      family: 'bigmodel',
      refreshMinutes: 30,
      providerIds: [],
      showIndicatorWhenLoggedOut: false,
      usagePageUrl: '',
      inferenceEnabled: true,
      inferenceCredentialRef: 'ZAI_CODING_CN_API_KEY',
      ...config,
    },
    auth: auth === undefined ? createAuthDoc() : auth,
  };
  const writes = [];
  let clears = 0;
  return {
    state,
    writes,
    get clears() {
      return clears;
    },
    readConfig() {
      return { ...state.config };
    },
    readAuth() {
      return state.auth;
    },
    writeAuth(doc) {
      state.auth = doc;
      writes.push(doc);
      return doc;
    },
    clearAuth() {
      state.auth = null;
      clears += 1;
      return true;
    },
    setAuth(doc) {
      state.auth = doc;
    },
  };
}

/** Account module mock; every call is recorded. */
function createAccountMock(options = {}) {
  const calls = { loadAccount: [], ensureKeyLocation: [], clearCache: 0 };
  return {
    calls,
    async loadAccount(args) {
      calls.loadAccount.push(args);
      if (options.loadAccount) return options.loadAccount(args);
      return { ...ACCOUNT_DOC };
    },
    async ensureKeyLocation(args) {
      calls.ensureKeyLocation.push(args);
      if (options.ensureKeyLocation) return options.ensureKeyLocation(args);
      return { ...KEY_LOCATION };
    },
    clearCache() {
      calls.clearCache += 1;
    },
  };
}

/** Upstream module mock with per-method overrides and call counters. */
function createUpstreamMock(overrides = {}) {
  const calls = {
    subscription: 0,
    quota: 0,
    usage: 0,
    resetStatus: 0,
    useReset: 0,
    lastUsage: null,
    lastUseReset: null,
  };
  const wrap = (name, fallback) => async (args) => {
    calls[name] += 1;
    const override = overrides[name];
    return override ? override(args, calls[name]) : fallback(args);
  };
  return {
    calls,
    subscription: wrap('subscription', () => ({ ...SUBSCRIPTION })),
    quota: wrap('quota', () => ({ ...QUOTA, limits: QUOTA.limits.map((limit) => ({ ...limit })) })),
    usage: wrap('usage', (args) => {
      calls.lastUsage = args;
      return { ...USAGE_PAYLOAD, range: args.range, timeZone: args.timeZone };
    }),
    resetStatus: wrap('resetStatus', () => ({ ...RESET_BLOCK })),
    useReset: wrap('useReset', (args) => {
      calls.lastUseReset = args;
      return { used: true };
    }),
  };
}

/** OAuth module mock. */
function createOAuthMock(options = {}) {
  const calls = { poll: 0, logout: 0, pending: 0 };
  const state = {
    pollResult: options.pollResult ?? { state: 'idle' },
    pendingFlow: options.pendingFlow ?? null,
  };
  return {
    calls,
    state,
    setPollResult(result) {
      state.pollResult = result;
    },
    setPendingFlow(flow) {
      state.pendingFlow = flow;
    },
    pending() {
      calls.pending += 1;
      return state.pendingFlow;
    },
    async poll() {
      calls.poll += 1;
      return state.pollResult;
    },
    async logout() {
      calls.logout += 1;
    },
  };
}

/** Inference module mock with per-method overrides. */
function createInferenceMock(overrides = {}) {
  const calls = { sync: [], clear: 0, status: 0 };
  return {
    calls,
    async sync(args) {
      calls.sync.push(args);
      if (overrides.sync) return overrides.sync(args, calls.sync.length);
      return { ok: true };
    },
    async clear() {
      calls.clear += 1;
      if (overrides.clear) return overrides.clear(calls.clear);
      return undefined;
    },
    async status() {
      calls.status += 1;
      if (overrides.status) return overrides.status(calls.status);
      return {
        enabled: true,
        available: true,
        ref: 'ZAI_CODING_CN_API_KEY',
        writtenAt: FIXED_NOW - MINUTE,
        expiresAt: FIXED_NOW + 10 * MINUTE,
        expiresInMs: 11 * MINUTE,
        error: null,
      };
    },
  };
}

/** Flush fire-and-forget inference sync promises. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Build one snapshot instance over all mocks. */
function createHarness(options = {}) {
  let clock = FIXED_NOW;
  const store = createStoreMock({ config: options.config, auth: options.auth });
  const account = createAccountMock(options.account);
  const upstream = createUpstreamMock(options.upstream);
  const oauth = createOAuthMock(options.oauth);
  const inference = options.inference === undefined ? createInferenceMock() : options.inference;
  const snapshot = createSnapshot({
    store,
    oauth,
    account,
    upstream,
    inference,
    logger: silentLogger,
    now: () => clock,
  });
  return {
    store,
    account,
    upstream,
    oauth,
    inference,
    snapshot,
    setNow(value) {
      clock = value;
    },
  };
}

describe('status', () => {
  it('reports the logged-out state without contacting upstream services', async () => {
    const harness = createHarness({ auth: null });
    const status = await harness.snapshot.status();
    assert.equal(status.config.family, 'bigmodel');
    assert.deepEqual(status.auth, {
      loggedIn: false,
      loginExpired: false,
      user: null,
      account: null,
      family: 'bigmodel',
    });
    assert.deepEqual(status.login, { state: 'idle' });
    assert.equal(status.inference.available, true);
    assert.equal(harness.upstream.calls.quota + harness.upstream.calls.subscription, 0);
    assert.equal(harness.account.calls.loadAccount.length, 0);
  });

  it('handles a locally expired token, keeping the user name for display', async () => {
    const harness = createHarness({ auth: createAuthDoc({ expiresAt: FIXED_NOW - 1 }) });
    const status = await harness.snapshot.status();
    assert.equal(status.auth.loggedIn, false);
    assert.equal(status.auth.loginExpired, true);
    assert.equal(status.auth.user.name, 'Alice');
    assert.equal(harness.store.state.auth, null);
    assert.equal(harness.store.clears, 1);
    assert.equal(harness.inference.calls.clear, 1);
  });

  it('reports the pending OAuth flow', async () => {
    const harness = createHarness({
      oauth: { pendingFlow: { authorizeUrl: 'https://zcode.z.ai/auth?flow=1', expiresAt: FIXED_NOW + 5 * MINUTE } },
    });
    const status = await harness.snapshot.status();
    assert.deepEqual(status.login, {
      state: 'pending',
      authorizeUrl: 'https://zcode.z.ai/auth?flow=1',
      expiresAt: FIXED_NOW + 5 * MINUTE,
    });
    assert.equal(status.auth.loggedIn, true);
  });

  it('reports the logged-in account', async () => {
    const harness = createHarness();
    const status = await harness.snapshot.status();
    assert.equal(status.auth.loggedIn, true);
    assert.equal(status.auth.loginExpired, false);
    assert.equal(status.auth.family, 'bigmodel');
    assert.equal(status.auth.account.customerName, 'Alice');
    assert.equal(status.auth.account.customerNumber, 'customer-1');
    assert.deepEqual(status.login, { state: 'ready' });
  });
});

describe('overview', () => {
  it('reports the logged-out overview and still syncs inference in the background', async () => {
    const harness = createHarness({ auth: null });
    const overview = await harness.snapshot.overview({ force: true });
    assert.equal(overview.family, 'bigmodel');
    assert.equal(overview.generatedAt, FIXED_NOW);
    assert.equal(overview.auth.loggedIn, false);
    assert.equal(overview.subscription, null);
    assert.equal(overview.quota, null);
    assert.equal(overview.remaining, null);
    assert.equal(overview.reset, null);
    assert.equal(overview.stale, false);
    assert.equal(overview.error, null);
    assert.equal(overview.inference.available, true);
    assert.equal(harness.upstream.calls.quota, 0);
    await flush();
    assert.deepEqual(harness.inference.calls.sync, [{ force: true }]);
  });

  it('aggregates account, subscription, quota, remaining and reset', async () => {
    const harness = createHarness();
    const overview = await harness.snapshot.overview({ force: true });
    assert.equal(overview.generatedAt, FIXED_NOW);
    assert.equal(overview.auth.loggedIn, true);
    assert.equal(overview.auth.account.customerName, 'Alice');
    assert.equal(overview.auth.keyLocation.organizationId, 'org-1');
    assert.deepEqual(overview.subscription, OVERVIEW_SUBSCRIPTION);
    assert.deepEqual(overview.quota, OVERVIEW_QUOTA);
    // The compact remaining block uses the TIME_LIMIT primary: 12% used -> 88% left.
    assert.deepEqual(overview.remaining, {
      percentage: 88,
      nextResetTime: 1785500400000,
    });
    assert.deepEqual(overview.reset, RESET_BLOCK);
    assert.equal(overview.stale, false);
    assert.equal(overview.error, null);
    assert.equal(harness.account.calls.loadAccount.length, 1);
    assert.equal(harness.account.calls.loadAccount[0].family, 'bigmodel');
    assert.equal(harness.account.calls.loadAccount[0].accessToken, 'access-token');
    assert.equal(harness.upstream.calls.subscription, 1);
    assert.equal(harness.upstream.calls.quota, 1);
    assert.equal(harness.upstream.calls.resetStatus, 1);
    // The account document is written back into the auth file.
    assert.equal(harness.store.writes.at(-1).account.customerName, 'Alice');
    await flush();
    assert.deepEqual(harness.inference.calls.sync, [{ force: true }]);
  });

  it('caches within the TTL, re-fetches after it, and force bypasses it', async () => {
    // A long-lived token keeps the clock moves below from expiring the login.
    const harness = createHarness({ auth: createAuthDoc({ expiresAt: FIXED_NOW + 10 * HOUR }) });
    await harness.snapshot.overview({ force: true });
    await harness.snapshot.overview();
    assert.equal(harness.upstream.calls.quota, 1);
    assert.equal(harness.account.calls.loadAccount.length, 1);

    harness.setNow(FIXED_NOW + 31 * SECOND);
    await harness.snapshot.overview();
    assert.equal(harness.upstream.calls.quota, 2);
    // The customer info cache is one hour, so it survives the overview TTL.
    assert.equal(harness.account.calls.loadAccount.length, 1);

    harness.setNow(FIXED_NOW + HOUR + SECOND);
    await harness.snapshot.overview();
    assert.equal(harness.account.calls.loadAccount.length, 2);

    await harness.snapshot.overview({ force: true });
    assert.equal(harness.upstream.calls.quota, 4);
    assert.equal(harness.account.calls.loadAccount.length, 3);
    assert.equal(harness.account.calls.loadAccount.at(-1).force, true);
  });

  it('shares one in-flight request between concurrent overview calls', async () => {
    let releaseQuota;
    const quotaGate = new Promise((resolve) => {
      releaseQuota = resolve;
    });
    const harness = createHarness({
      upstream: {
        quota: async () => {
          await quotaGate;
          return { ...QUOTA, limits: [] };
        },
      },
    });
    const first = harness.snapshot.overview({ force: true });
    const second = harness.snapshot.overview({ force: true });
    await flush();
    releaseQuota();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.generatedAt, two.generatedAt);
    assert.equal(harness.upstream.calls.quota, 1);
    assert.equal(harness.upstream.calls.subscription, 1);
    assert.equal(harness.account.calls.loadAccount.length, 1);
  });

  it('keeps the last good payload marked stale when upstream fails', async () => {
    let failing = false;
    const harness = createHarness({
      upstream: {
        quota: async () => {
          if (failing) throw new HostError('upstream_failed', 'Upstream request failed', { status: 502 });
          return { ...QUOTA, limits: QUOTA.limits.map((limit) => ({ ...limit })) };
        },
      },
    });
    const fresh = await harness.snapshot.overview({ force: true });
    failing = true;
    const stale = await harness.snapshot.overview({ force: true });
    assert.equal(stale.stale, true);
    assert.equal(stale.error.code, 'upstream_failed');
    assert.equal(stale.generatedAt, fresh.generatedAt);
    assert.deepEqual(stale.subscription, fresh.subscription);
    assert.deepEqual(stale.quota, fresh.quota);
    assert.deepEqual(stale.remaining, fresh.remaining);
    assert.equal(stale.auth.loggedIn, true);
    assert.equal(stale.inference.available, true);
  });

  it('does not hide a good subscription behind a failed quota', async () => {
    const harness = createHarness({
      upstream: {
        quota: async () => {
          throw new HostError('upstream_failed', 'Upstream request failed', { status: 502 });
        },
      },
    });
    const overview = await harness.snapshot.overview({ force: true });
    assert.equal(overview.stale, false);
    assert.equal(overview.error.code, 'upstream_failed');
    assert.deepEqual(overview.subscription, OVERVIEW_SUBSCRIPTION);
    assert.equal(overview.quota, null);
    assert.equal(overview.remaining, null);
    assert.equal(overview.reset.hasUnreadHistory, true);
  });

  it('distinguishes a no-plan account from an upstream failure', async () => {
    const noPlanError = () => {
      throw new HostError('no_coding_plan', 'The account has no active Coding Plan', { status: 409 });
    };
    const harness = createHarness({
      upstream: { subscription: noPlanError, quota: noPlanError },
    });
    const overview = await harness.snapshot.overview({ force: true });
    assert.equal(overview.error.code, 'no_coding_plan');
    assert.equal(overview.stale, false);
    assert.equal(overview.subscription, null);
    assert.equal(overview.quota, null);
  });

  it('treats an inactive subscription list without a Coding Plan as no-plan', async () => {
    const harness = createHarness({
      upstream: {
        subscription: async () => ({ ...SUBSCRIPTION, active: false, productId: null, productName: null }),
        quota: async () => {
          throw new HostError('no_coding_plan', 'The account has no active Coding Plan', { status: 409 });
        },
      },
    });
    const overview = await harness.snapshot.overview({ force: true });
    assert.equal(overview.error.code, 'no_coding_plan');
  });

  it('keeps an expired plan visible as data, not as a no-plan error', async () => {
    const harness = createHarness({
      upstream: {
        subscription: async () => ({
          ...SUBSCRIPTION,
          active: false,
          status: 'EXPIRED',
        }),
      },
    });
    const overview = await harness.snapshot.overview({ force: true });
    assert.equal(overview.error, null);
    assert.equal(overview.subscription.active, false);
    assert.equal(overview.subscription.status, 'EXPIRED');
  });

  it('clears the login on an upstream 401 and stops serving last good data', async () => {
    const harness = createHarness({
      upstream: {
        quota: async () => {
          throw new HostError('login_expired', 'The login has expired', { status: 401 });
        },
      },
    });
    const overview = await harness.snapshot.overview({ force: true });
    assert.equal(overview.error.code, 'login_expired');
    assert.equal(overview.auth.loginExpired, true);
    assert.equal(harness.store.state.auth, null);
    assert.equal(harness.store.clears, 1);
    assert.equal(harness.inference.calls.clear, 1);

    const after = await harness.snapshot.overview();
    assert.equal(after.auth.loggedIn, false);
    assert.equal(after.auth.loginExpired, true);
    assert.equal(harness.upstream.calls.quota, 1);
  });

  it('propagates a login_expired from the customer info read', async () => {
    const harness = createHarness({
      account: {
        loadAccount: async () => {
          throw new HostError('login_expired', 'The login has expired', { status: 401 });
        },
      },
    });
    const overview = await harness.snapshot.overview({ force: true });
    assert.equal(overview.error.code, 'login_expired');
    assert.equal(overview.auth.loginExpired, true);
    assert.equal(harness.store.state.auth, null);
  });

  it('survives a customer info failure and still reports the quota', async () => {
    const harness = createHarness({
      account: {
        loadAccount: async () => {
          throw new HostError('upstream_failed', 'Upstream request failed', { status: 502 });
        },
      },
    });
    const overview = await harness.snapshot.overview({ force: true });
    assert.equal(overview.error, null);
    assert.deepEqual(overview.subscription, OVERVIEW_SUBSCRIPTION);
    assert.deepEqual(overview.quota, OVERVIEW_QUOTA);
  });

  it('writes the resolved key location back into the auth document', async () => {
    const harness = createHarness({ auth: createAuthDoc({ keyLocation: null }) });
    const overview = await harness.snapshot.overview({ force: true });
    assert.deepEqual(overview.auth.keyLocation, KEY_LOCATION);
    assert.deepEqual(harness.store.state.auth.keyLocation, KEY_LOCATION);
    assert.equal(harness.account.calls.ensureKeyLocation.length, 1);
    assert.equal(harness.account.calls.ensureKeyLocation[0].accessToken, 'access-token');
  });

  it('never lets a failing inference sync break the overview', async () => {
    const harness = createHarness({
      inference: createInferenceMock({
        sync: async () => {
          throw new Error('credentials service exploded');
        },
      }),
    });
    const overview = await harness.snapshot.overview({ force: true });
    assert.equal(overview.error, null);
    await flush();
    assert.equal(harness.inference.calls.sync.length, 1);
  });
});

describe('usage', () => {
  it('returns the documented usage payload and caches it', async () => {
    const harness = createHarness();
    const usage = await harness.snapshot.usage({ range: '7d', timeZone: 'UTC' });
    assert.equal(usage.generatedAt, FIXED_NOW);
    assert.deepEqual(Object.keys(usage), [
      'range',
      'timeZone',
      'generatedAt',
      'granularity',
      'summary',
      'series',
      'models',
      'tools',
    ]);
    assert.equal(usage.range, '7d');
    assert.equal(usage.timeZone, 'UTC');
    assert.equal(usage.granularity, 'day');
    assert.equal(usage.summary.totalTokens, 2030);
    assert.equal(harness.upstream.calls.usage, 1);
    assert.equal(harness.upstream.calls.lastUsage.range, '7d');
    assert.equal(harness.upstream.calls.lastUsage.timeZone, 'UTC');

    await harness.snapshot.usage({ range: '7d', timeZone: 'UTC' });
    assert.equal(harness.upstream.calls.usage, 1);

    await harness.snapshot.usage({ range: '7d', timeZone: 'UTC', force: true });
    assert.equal(harness.upstream.calls.usage, 2);

    await harness.snapshot.usage({ range: 'today', timeZone: 'UTC' });
    assert.equal(harness.upstream.calls.usage, 3);
  });

  it('rejects an unknown range without contacting upstream', async () => {
    const harness = createHarness();
    await assert.rejects(harness.snapshot.usage({ range: '90d' }), (error) => {
      assert.equal(error.code, 'invalid_request');
      assert.equal(error.status, 400);
      return true;
    });
    assert.equal(harness.upstream.calls.usage, 0);
  });

  it('requires a login', async () => {
    const harness = createHarness({ auth: null });
    await assert.rejects(harness.snapshot.usage({ range: 'today' }), (error) => {
      assert.equal(error.code, 'not_logged_in');
      assert.equal(error.status, 409);
      return true;
    });
  });

  it('clears the login on an upstream 401', async () => {
    const harness = createHarness({
      upstream: {
        usage: async () => {
          throw new HostError('login_expired', 'The login has expired', { status: 401 });
        },
      },
    });
    await assert.rejects(harness.snapshot.usage({ range: '7d' }), (error) => {
      assert.equal(error.code, 'login_expired');
      return true;
    });
    assert.equal(harness.store.state.auth, null);
    assert.equal(harness.inference.calls.clear, 1);
  });

  it('surfaces upstream failures for the inline retry', async () => {
    const harness = createHarness({
      upstream: {
        usage: async () => {
          throw new HostError('upstream_timeout', 'Upstream request timed out', { status: 502 });
        },
      },
    });
    await assert.rejects(harness.snapshot.usage({ range: '7d' }), (error) => {
      assert.equal(error.code, 'upstream_timeout');
      return true;
    });
  });
});

describe('reset', () => {
  it('returns and caches the reset block, with force support', async () => {
    const harness = createHarness();
    const block = await harness.snapshot.reset();
    assert.deepEqual(block, RESET_BLOCK);
    await harness.snapshot.reset();
    assert.equal(harness.upstream.calls.resetStatus, 1);
    harness.setNow(FIXED_NOW + 61 * SECOND);
    await harness.snapshot.reset();
    assert.equal(harness.upstream.calls.resetStatus, 2);
    await harness.snapshot.reset({ force: true });
    assert.equal(harness.upstream.calls.resetStatus, 3);
  });

  it('requires a login', async () => {
    const harness = createHarness({ auth: null });
    await assert.rejects(harness.snapshot.reset(), (error) => {
      assert.equal(error.code, 'not_logged_in');
      assert.equal(error.status, 409);
      return true;
    });
  });

  it('reports reset_unavailable without the ZCode login credential', async () => {
    const harness = createHarness({ auth: createAuthDoc({ zcodeJwtToken: null }) });
    await assert.rejects(harness.snapshot.reset(), (error) => {
      assert.equal(error.code, 'reset_unavailable');
      assert.equal(error.status, 409);
      return true;
    });
    assert.equal(harness.upstream.calls.resetStatus, 0);
  });

  it('maps throttling and clears the login on 401', async () => {
    const throttled = createHarness({
      upstream: {
        resetStatus: async () => {
          throw new HostError('rate_limited', 'Too many requests', { status: 429 });
        },
      },
    });
    await assert.rejects(throttled.snapshot.reset(), (error) => {
      assert.equal(error.code, 'reset_throttled');
      assert.equal(error.status, 429);
      return true;
    });

    const expired = createHarness({
      upstream: {
        resetStatus: async () => {
          throw new HostError('login_expired', 'The login has expired', { status: 401 });
        },
      },
    });
    await assert.rejects(expired.snapshot.reset(), (error) => {
      assert.equal(error.code, 'login_expired');
      return true;
    });
    assert.equal(expired.store.state.auth, null);
  });
});

describe('useReset', () => {
  it('maps the route reset types to the ZCode wire enum', async () => {
    const harness = createHarness();
    assert.deepEqual(
      await harness.snapshot.useReset({ resetType: 'five_hour', idempotencyKey: 'key-1' }),
      { used: true },
    );
    assert.equal(harness.upstream.calls.lastUseReset.resetType, 'FIVE_HOUR');
    assert.equal(harness.upstream.calls.lastUseReset.idempotencyKey, 'key-1');
    assert.equal(harness.upstream.calls.lastUseReset.family, 'bigmodel');

    await harness.snapshot.useReset({ resetType: 'week', idempotencyKey: 'key-2' });
    assert.equal(harness.upstream.calls.lastUseReset.resetType, 'WEEK');
  });

  it('invalidates the reset and overview caches after a successful use', async () => {
    const harness = createHarness();
    await harness.snapshot.overview({ force: true });
    await harness.snapshot.reset();
    assert.equal(harness.upstream.calls.quota, 1);
    assert.equal(harness.upstream.calls.resetStatus, 1);

    await harness.snapshot.useReset({ resetType: 'five_hour', idempotencyKey: 'key-1' });
    await harness.snapshot.overview();
    await harness.snapshot.reset();
    assert.equal(harness.upstream.calls.quota, 2);
    assert.equal(harness.upstream.calls.resetStatus, 2);
  });

  it('rejects invalid reset types and idempotency keys before calling upstream', async () => {
    const harness = createHarness();
    for (const request of [
      { resetType: 'month', idempotencyKey: 'key-1' },
      { resetType: 'WEEK', idempotencyKey: '' },
      { resetType: 'WEEK', idempotencyKey: 'x'.repeat(65) },
    ]) {
      await assert.rejects(harness.snapshot.useReset(request), (error) => {
        assert.equal(error.code, 'invalid_request');
        assert.equal(error.status, 400);
        return true;
      });
    }
    assert.equal(harness.upstream.calls.useReset, 0);
  });

  it('rejects the reset use when the account has no ZCode credential', async () => {
    const harness = createHarness({ auth: createAuthDoc({ zcodeJwtToken: null }) });
    await assert.rejects(
      harness.snapshot.useReset({ resetType: 'week', idempotencyKey: 'key-1' }),
      (error) => {
        assert.equal(error.code, 'reset_unavailable');
        return true;
      },
    );
    assert.equal(harness.upstream.calls.useReset, 0);
  });

  it('maps upstream throttling to reset_throttled', async () => {
    const harness = createHarness({
      upstream: {
        useReset: async () => {
          throw new HostError('reset_throttled', 'The reset request was throttled; retry later', {
            status: 429,
          });
        },
      },
    });
    await assert.rejects(
      harness.snapshot.useReset({ resetType: 'week', idempotencyKey: 'key-1' }),
      (error) => {
        assert.equal(error.code, 'reset_throttled');
        assert.equal(error.status, 429);
        return true;
      },
    );
  });
});

describe('loginStatus and logout', () => {
  it('delegates polling without touching inference while pending', async () => {
    const harness = createHarness();
    harness.oauth.setPollResult({ state: 'pending' });
    assert.deepEqual(await harness.snapshot.loginStatus(), { state: 'pending' });
    assert.equal(harness.oauth.calls.poll, 1);
    assert.equal(harness.inference.calls.sync.length, 0);
  });

  it('writes the inference credential after a completed login and drops caches', async () => {
    const harness = createHarness();
    await harness.snapshot.overview({ force: true });
    assert.equal(harness.upstream.calls.quota, 1);

    harness.oauth.setPollResult({ state: 'ready', user: { id: 'user-2', name: 'Bob' } });
    const result = await harness.snapshot.loginStatus();
    assert.equal(result.state, 'ready');
    assert.deepEqual(harness.inference.calls.sync.at(-1), { force: true });

    await harness.snapshot.overview();
    assert.equal(harness.upstream.calls.quota, 2);
  });

  it('clears the inference credential, the auth document and the caches on logout', async () => {
    const harness = createHarness();
    await harness.snapshot.overview({ force: true });
    assert.deepEqual(await harness.snapshot.logout(), { ok: true });
    assert.equal(harness.inference.calls.clear, 1);
    assert.equal(harness.oauth.calls.logout, 1);
    assert.equal(harness.store.state.auth, null);

    await assert.rejects(harness.snapshot.usage({ range: 'today' }), (error) => {
      assert.equal(error.code, 'not_logged_in');
      return true;
    });
    const status = await harness.snapshot.status();
    assert.equal(status.auth.loggedIn, false);
    assert.equal(status.auth.loginExpired, false);
    assert.equal(status.login.state, 'idle');
  });

  it('works without the optional inference module', async () => {
    const store = createStoreMock();
    const snapshot = createSnapshot({
      store,
      oauth: createOAuthMock(),
      account: createAccountMock(),
      upstream: createUpstreamMock(),
      logger: silentLogger,
      now: () => FIXED_NOW,
    });
    const status = await snapshot.status();
    assert.deepEqual(status.inference, {
      enabled: false,
      available: false,
      ref: null,
      family: null,
      writtenAt: null,
      expiresAt: null,
      expiresInMs: null,
      error: 'inference_unavailable',
    });
    const overview = await snapshot.overview({ force: true });
    assert.equal(overview.error, null);
    assert.equal(overview.inference.available, false);
    assert.deepEqual(await snapshot.logout(), { ok: true });
  });

  it('survives an inference status failure', async () => {
    const harness = createHarness({
      inference: createInferenceMock({
        status: async () => {
          throw new Error('credentials service exploded');
        },
      }),
    });
    const status = await harness.snapshot.status();
    assert.equal(status.inference.error, 'inference_status_failed');
    assert.equal(status.inference.available, false);
    const overview = await harness.snapshot.overview({ force: true });
    assert.equal(overview.inference.error, 'inference_status_failed');
  });
});
