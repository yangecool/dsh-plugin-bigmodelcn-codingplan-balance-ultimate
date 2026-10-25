/**
 * Unit tests for the shared formatting helpers and the state store.
 *
 * Format helpers are pure. Store behavior is exercised against a mocked
 * `globalThis.fetch` and a fresh module instance per test (the store is a
 * singleton, so each test imports it through a unique URL query).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as format from '../../src/client/format.js';
import { coreDicts, interpolate } from '../../src/client/dicts-core.js';

/** Translate function over one core dictionary (mirrors the locale service). */
function makeT(locale = 'en') {
  const dict = coreDicts[locale];
  return (key, params) => interpolate(dict[key] === undefined ? key : dict[key], params);
}

const DAY = 86_400_000;

test('formatPercent formats, clamps, and tolerates missing values', () => {
  assert.equal(format.formatPercent(72.4), '72%');
  assert.equal(format.formatPercent(72.45, 1), '72.5%');
  assert.equal(format.formatPercent(72.45, 'zh', 1), '72.5%');
  assert.equal(format.formatPercent(140), '100%');
  assert.equal(format.formatPercent(-3), '0%');
  assert.equal(format.formatPercent(null), '');
  assert.equal(format.formatPercent('nope'), '');
  assert.equal(format.formatPercent(8, 'zh'), '8%');
});

test('remainingPercent inverts the used ratio and falls back to counts', () => {
  assert.equal(format.remainingPercent({ percentage: 25 }), 75);
  assert.equal(format.remainingPercent({ percentage: 0 }), 100);
  assert.equal(format.remainingPercent({ percentage: 140 }), 0);
  assert.equal(format.remainingPercent({ number: 100, remaining: 40 }), 40);
  assert.equal(format.remainingPercent({ number: 100, usage: 70 }), 30);
  assert.equal(format.remainingPercent(null), 0);
  assert.equal(format.remainingPercent({}), 0);
});

test('limit totals, used, and remaining agree across payload shapes', () => {
  const fromCounts = { number: 200, remaining: 50, percentage: 75 };
  assert.equal(format.limitTotal(fromCounts), 200);
  assert.equal(format.limitUsed(fromCounts), 150);
  assert.equal(format.remainingOf(fromCounts), 50);

  const fromUsage = { usage: 12, remaining: 8 };
  assert.equal(format.limitTotal(fromUsage), 20);
  assert.equal(format.limitUsed(fromUsage), 12);
  assert.equal(format.remainingOf(fromUsage), 8);

  const fromPercentage = { number: 80, percentage: 25 };
  assert.equal(format.limitUsed(fromPercentage), 20);
  assert.equal(format.remainingOf(fromPercentage), 60);

  assert.equal(format.limitTotal(null), 0);
  assert.equal(format.limitUsed(undefined), 0);
  assert.equal(format.remainingOf({}), 0);
});

test('number helpers use Intl grouping and compact notation', () => {
  assert.equal(format.formatNumber(1234), '1,234');
  assert.equal(format.formatNumber(1234, 'en'), '1,234');
  assert.equal(format.formatNumber(null), '');
  assert.equal(format.formatCompact(1500, 'en'), '1.5K');
  assert.match(format.formatCompact(15000, 'zh'), /1\.5万/);
  assert.equal(format.formatCompact(null), '');
  assert.equal(format.formatCredits(12.345), '12.35');
  assert.equal(format.formatCredits(12, 'en', 'credits'), '12 credits');
  assert.equal(format.formatCredits(undefined), '');
});

test('formatDateTime and formatResetAt format valid timestamps only', () => {
  assert.equal(format.formatDateTime(null), '');
  assert.equal(format.formatDateTime('not-a-date'), '');
  const fixed = new Date(2026, 4, 21, 15, 30, 0).getTime();
  assert.match(format.formatDateTime(fixed, 'en'), /2026/);
  assert.match(format.formatDateTime(fixed, 'zh'), /2026/);

  const sameDay = new Date(2026, 4, 21, 9, 5, 0).getTime();
  const now = new Date(2026, 4, 21, 8, 0, 0).getTime();
  assert.equal(format.formatResetAt(sameDay, 'en', now), '09:05');
  assert.match(format.formatResetAt(sameDay + DAY, 'en', now), /May/);
  assert.equal(format.formatResetAt(null, 'en', now), '');
});

test('countdown localizes remaining time from a timestamp or a duration', () => {
  const t = makeT('en');
  const now = 1_700_000_000_000;
  assert.equal(format.countdown(now + (2 * 60 + 30) * 60_000, t, now), '2 hr 30 min');
  assert.equal(format.countdown(2 * 60 * 60_000, t, now), '2 hr');
  assert.equal(format.countdown(now + (2 * DAY + 3 * 60 * 60_000), t, now), '2 d 3 hr');
  assert.equal(format.countdown(now - 1000, t, now), 'Resetting now');
  assert.equal(format.countdown(30_000, t, now), '1 min');
  assert.equal(format.countdown(null, t, now), '');
  assert.equal(format.countdown(2 * 60 * 60_000, makeT('zh'), now), '2 小时');
});

test('windowLabel resolves windows from the normalized field or legacy type/unit', () => {
  const t = makeT('en');
  assert.equal(format.resolveWindow({ window: 'week' }), 'week');
  assert.equal(format.resolveWindow({ window: 'tool' }), 'tool');
  assert.equal(format.resolveWindow({ unit: 3 }), 'fiveHour');
  assert.equal(format.resolveWindow({ unit: 6 }), 'week');
  assert.equal(format.resolveWindow({ type: 'TIME_LIMIT' }), 'tool');
  assert.equal(format.resolveWindow({}), 'other');
  assert.equal(format.resolveWindow(null), 'other');
  assert.equal(format.windowLabel({ window: 'fiveHour' }, t), '5-hour');
  assert.equal(format.windowLabel({ window: 'week' }, t), 'Weekly');
  assert.equal(format.windowLabel({ type: 'TIME_LIMIT' }, t), 'Tools');
  assert.equal(format.windowLabel({ unit: 3 }, makeT('zh')), '5 小时');
});

test('durationMinutes, formatRelative, and formatLocaleId', () => {
  assert.equal(format.durationMinutes(90_000), 2);
  assert.equal(format.durationMinutes(0), 0);
  assert.equal(format.durationMinutes(-5), 0);
  assert.equal(format.durationMinutes(undefined), 0);

  const t = makeT('en');
  const now = 1_700_000_000_000;
  assert.equal(format.formatRelative(now - 5_000, t, now), 'Just now');
  assert.equal(format.formatRelative(now - 5 * 60_000, t, now), '5 min ago');
  assert.equal(format.formatRelative(now - 3 * 3_600_000, t, now), '3 hr ago');
  assert.equal(format.formatRelative(now - 2 * DAY, t, now), '2 d ago');
  assert.equal(format.formatRelative(null, t, now), '');

  assert.equal(format.formatLocaleId('zh'), 'zh');
  assert.equal(format.formatLocaleId('zh-CN'), 'zh');
  assert.equal(format.formatLocaleId('en-US'), 'en');
  assert.equal(format.formatLocaleId(undefined), 'en');
});

test('core dictionaries stay bilingual with matching placeholders', () => {
  const zhKeys = Object.keys(coreDicts.zh);
  const enKeys = Object.keys(coreDicts.en);
  assert.deepEqual(zhKeys.sort(), enKeys.sort());
  const required = [
    'action.refresh', 'action.retry', 'action.close', 'action.cancel', 'action.save', 'action.login',
    'action.logout', 'action.openUsagePage', 'action.viewDetails', 'action.confirm', 'action.back',
    'state.loading', 'state.loadingSlow', 'state.error', 'state.networkError', 'state.notLoggedIn',
    'state.loginExpired', 'state.noPlan', 'state.empty', 'state.updating', 'state.justNow',
    'state.minutesAgo', 'state.hoursAgo', 'state.daysAgo',
    'auth.loginTitle', 'auth.loginBody', 'auth.loginButton', 'auth.loginWaiting', 'auth.loginWaitingHint',
    'auth.loginFailed', 'auth.loginExpiredBody', 'auth.loginPopupBlocked', 'auth.account', 'auth.family',
    'auth.expiresAt', 'auth.renewTime', 'auth.billingCycle', 'auth.billingCycleAutopay',
    'auth.billingCycleRenew', 'auth.billingCycleNone', 'auth.logoutConfirm',
    'app.nav', 'app.title', 'app.subtitle',
    'time.today', 'time.tomorrow', 'time.resetIn', 'time.resetAt', 'time.hoursShort',
    'time.minutesShort', 'time.daysShort',
  ];
  for (const key of required) {
    assert.ok(zhKeys.includes(key), `zh dictionary is missing ${key}`);
    assert.ok(enKeys.includes(key), `en dictionary is missing ${key}`);
  }
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of zhKeys) {
    assert.deepEqual(placeholders(coreDicts.zh[key]), placeholders(coreDicts.en[key]), `placeholder mismatch for ${key}`);
  }
  // English copy is sentence case: it starts uppercase and is not shouting.
  for (const key of enKeys) {
    const value = coreDicts.en[key];
    assert.notEqual(value, '', `${key} must have English copy`);
    if (/^[A-Za-z]/.test(value)) {
      assert.match(value, /^[A-Z]/, `English copy for ${key} must start uppercase`);
      assert.ok(!/\b[A-Z]{3,}\b/.test(value.replace(/\{\w+\}/g, '')), `English copy for ${key} is shouting`);
    }
  }
  assert.equal(interpolate('{n} min', { n: 3 }), '3 min');
  assert.equal(interpolate('{n} min', {}), '{n} min');
});

// ---------------------------------------------------------------------------
// State store: singleton behavior against a mocked same-origin fetch.
// ---------------------------------------------------------------------------

const STATE_URL = new URL('../../src/client/state.js', import.meta.url).href;
let stateImportCount = 0;

/** Import a fresh store instance (the store is a per-module singleton). */
async function freshState() {
  stateImportCount += 1;
  return import(`${STATE_URL}?case=${stateImportCount}`);
}

/** JSON envelope helpers for the mocked Host routes. */
const ok = (data) => ({ status: 200, body: { data } });
const hostError = (status, code, message = 'host failure') => ({ status, body: { error: { code, message } } });

/**
 * Install a route-table fetch mock.
 * @param routes - map of `"METHOD /path"` (or `"METHOD /path?query"`) to a
 *   result object, a function of `{ url, init }`, or an Error to throw.
 * @returns captured calls and a restore function.
 */
function installFetch(routes) {
  const calls = [];
  const hadFetch = 'fetch' in globalThis;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const text = String(url);
    const parsed = new URL(text, 'http://localhost');
    const method = init.method ?? 'GET';
    calls.push({ url: text, method, body: init.body, path: parsed.pathname, search: parsed.search });
    const handler = routes[`${method} ${parsed.pathname}${parsed.search}`]
      ?? routes[`${method} ${parsed.pathname}`]
      ?? routes[`GET ${parsed.pathname}`];
    if (handler === undefined) throw new Error(`unexpected fetch: ${method} ${parsed.pathname}${parsed.search}`);
    const result = typeof handler === 'function' ? handler({ url: parsed, init }) : handler;
    if (result instanceof Error) throw result;
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
    };
  };
  return {
    calls,
    restore() {
      if (hadFetch) globalThis.fetch = original;
      else delete globalThis.fetch;
    },
  };
}

const baseConfig = {
  family: 'bigmodel',
  refreshMinutes: 30,
  providerIds: ['zai-coding-cn'],
  showIndicatorWhenLoggedOut: false,
  usagePageUrl: '',
};
const loggedInAuth = { loggedIn: true, loginExpired: false, user: { name: 'Tester' }, account: null, family: 'bigmodel' };
const inferenceStatus = (overrides = {}) => ({
  enabled: true,
  available: true,
  ref: 'ZAI_CODING_CN_API_KEY',
  family: 'bigmodel',
  writtenAt: 1_700_000_000_000,
  expiresAt: 1_700_000_360_000,
  expiresInMs: 360_000,
  error: null,
  ...overrides,
});
const statusPayload = (overrides = {}) => ok({
  config: baseConfig,
  auth: loggedInAuth,
  login: { state: 'idle' },
  ...overrides,
});

test('state.bootstrap loads config, auth, inference and login once and notifies subscribers', async () => {
  const { state } = await freshState();
  const mock = installFetch({ 'GET /bigmodelcn-codingplan/api/status': statusPayload({ inference: inferenceStatus() }) });
  try {
    let notifications = 0;
    const unsubscribe = state.subscribe(() => {
      notifications += 1;
    });
    const before = state.getSnapshot();
    assert.equal(before.inference, null, 'inference starts null');
    const snapshot = await state.bootstrap();
    assert.equal(snapshot.config.family, 'bigmodel');
    assert.equal(snapshot.auth.loggedIn, true);
    assert.equal(snapshot.login.state, 'idle');
    assert.deepEqual(snapshot.inference, {
      enabled: true,
      available: true,
      ref: 'ZAI_CODING_CN_API_KEY',
      family: 'bigmodel',
      writtenAt: 1_700_000_000_000,
      expiresAt: 1_700_000_360_000,
      expiresInMs: 360_000,
      error: null,
    });
    assert.notEqual(state.getSnapshot(), before);
    assert.ok(notifications > 0, 'subscribers are notified');
    await state.bootstrap();
    assert.equal(mock.calls.length, 1, 'bootstrap is a one-time load');
    unsubscribe();
    const settled = notifications;
    state.dismissError();
    assert.equal(notifications, settled, 'unsubscribed listeners stop receiving changes');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state maps transport failures to a typed network error', async () => {
  const { state, setTranslate } = await freshState();
  setTranslate(makeT('en'));
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': () => new Error('offline'),
  });
  try {
    await state.bootstrap();
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.error.code, 'network_error');
    assert.equal(snapshot.error.message, 'Network error');
    assert.equal(snapshot.loading.overview, false);
    assert.equal(snapshot.config, null);
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state maps host error envelopes and 401 login_expired clears auth', async () => {
  const { state } = await freshState();
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': statusPayload({ inference: inferenceStatus() }),
    'GET /bigmodelcn-codingplan/api/overview': hostError(401, 'login_expired', 'expired'),
  });
  try {
    await state.bootstrap();
    assert.equal(state.getSnapshot().inference.ref, 'ZAI_CODING_CN_API_KEY');
    await state.refreshOverview({ force: true });
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.error.code, 'login_expired');
    assert.equal(snapshot.auth.loggedIn, false);
    assert.equal(snapshot.auth.loginExpired, true);
    assert.equal(snapshot.auth.user.name, 'Tester');
    assert.equal(snapshot.login.state, 'expired');
    assert.equal(snapshot.inference, null, 'an expired login clears the credential block');
    assert.equal(snapshot.loading.overview, false);
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state dedupes in-flight overview requests and records lastUpdated', async () => {
  const { state } = await freshState();
  const generatedAt = 1_700_000_123_000;
  const overview = { generatedAt, auth: loggedInAuth, subscription: null, quota: null, remaining: null, reset: null, stale: false, error: null };
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': statusPayload(),
    'GET /bigmodelcn-codingplan/api/overview?force=1': ok(overview),
  });
  try {
    await state.bootstrap();
    const [first, second] = await Promise.all([
      state.refreshOverview({ force: true }),
      state.refreshOverview({ force: true }),
    ]);
    assert.equal(first, second);
    assert.equal(mock.calls.filter((call) => call.path.endsWith('/overview')).length, 1);
    assert.equal(state.getSnapshot().lastUpdated, generatedAt);
    assert.equal(state.getSnapshot().overview.generatedAt, generatedAt);
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state surfaces overview host errors without dropping the payload', async () => {
  const { state } = await freshState();
  const overview = { generatedAt: Date.now(), auth: loggedInAuth, quota: null, stale: true, error: { code: 'upstream_failed', message: 'boom' } };
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': statusPayload(),
    'GET /bigmodelcn-codingplan/api/overview?force=1': ok(overview),
  });
  try {
    await state.bootstrap();
    await state.refreshOverview({ force: true });
    assert.equal(state.getSnapshot().error.code, 'upstream_failed');
    assert.equal(state.getSnapshot().overview.stale, true);
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state loadUsage selects the range, sends the time zone, and caches per range', async () => {
  const { state } = await freshState();
  const usage = { range: '7d', generatedAt: 1, summary: { totalTokens: 42 }, series: [], models: [], tools: [] };
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': statusPayload(),
    'GET /bigmodelcn-codingplan/api/usage': ({ url }) => (url.searchParams.get('range') === '7d' ? ok(usage) : ok({ ...usage, range: url.searchParams.get('range') })),
  });
  try {
    await state.bootstrap();
    const loaded = await state.loadUsage('7d');
    assert.equal(loaded.range, '7d');
    assert.equal(state.getSnapshot().usageRange, '7d');
    assert.equal(state.getSnapshot().usage.summary.totalTokens, 42);
    const usageCall = mock.calls.find((call) => call.path.endsWith('/usage'));
    assert.equal(usageCall.search.includes('range=7d'), true);
    assert.equal(usageCall.search.includes('tz='), true);

    await state.loadUsage('7d');
    assert.equal(mock.calls.filter((call) => call.path.endsWith('/usage')).length, 1, 'fresh usage is cached');

    await state.loadUsage('30d', { force: true });
    assert.equal(mock.calls.filter((call) => call.path.endsWith('/usage')).length, 2);
    assert.equal(state.getSnapshot().usageRange, '30d');

    state.setUsageRange('today');
    assert.equal(state.getSnapshot().usage, null, 'changing range invalidates the payload');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state loadReset caches, force reloads, and useReset reports success', async () => {
  const { state } = await freshState();
  const resetBlock = { fiveHour: { available: [], latest: null }, week: { available: [], latest: null }, hasUnreadHistory: false };
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': statusPayload(),
    'GET /bigmodelcn-codingplan/api/reset': ok(resetBlock),
    'GET /bigmodelcn-codingplan/api/overview': ok({ generatedAt: Date.now(), auth: loggedInAuth, error: null }),
    'POST /bigmodelcn-codingplan/api/reset/use': ok({ used: true }),
  });
  try {
    await state.bootstrap();
    await state.loadReset();
    await state.loadReset();
    assert.equal(mock.calls.filter((call) => call.path.endsWith('/reset')).length, 1, 'fresh reset block is cached');
    await state.loadReset({ force: true });
    assert.equal(mock.calls.filter((call) => call.path.endsWith('/reset')).length, 2);
    assert.deepEqual(state.getSnapshot().reset, resetBlock);

    const result = await state.useReset('fiveHour');
    assert.equal(result.ok, true);
    const post = mock.calls.find((call) => call.method === 'POST' && call.path.endsWith('/reset/use'));
    assert.ok(post !== undefined);
    const body = JSON.parse(post.body);
    assert.equal(body.resetType, 'fiveHour');
    assert.equal(typeof body.idempotencyKey, 'string');
    assert.ok(body.idempotencyKey.length > 8);

    const invalid = await state.useReset('');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'invalid_request');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state saveConfig and logout update the snapshot', async () => {
  const { state } = await freshState();
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': statusPayload({ inference: inferenceStatus() }),
    'POST /bigmodelcn-codingplan/api/config': ({ init }) => ok({ ...baseConfig, ...JSON.parse(init.body) }),
    'GET /bigmodelcn-codingplan/api/overview?force=1': ok({ generatedAt: 1, auth: loggedInAuth, error: null }),
    'POST /bigmodelcn-codingplan/api/logout': ok({ ok: true }),
  });
  try {
    await state.bootstrap();
    const saved = await state.saveConfig({ refreshMinutes: 5 });
    assert.equal(saved.ok, true);
    assert.equal(saved.config.refreshMinutes, 5);
    assert.equal(state.getSnapshot().config.refreshMinutes, 5);

    const failed = await state.saveConfig(null);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'invalid_request');

    const signedOut = await state.logout();
    assert.equal(signedOut.ok, true);
    assert.equal(state.getSnapshot().auth.loggedIn, false);
    assert.equal(state.getSnapshot().overview, null);
    assert.equal(state.getSnapshot().inference, null);
    assert.equal(state.getSnapshot().login.state, 'idle');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state saveConfig applies the returned config and refreshes a signed-in overview', async () => {
  const { state } = await freshState();
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': statusPayload(),
    'POST /bigmodelcn-codingplan/api/config': ({ init }) => ok({ ...baseConfig, ...JSON.parse(init.body) }),
    'GET /bigmodelcn-codingplan/api/overview?force=1': ok({ generatedAt: 1_700_000_000_123, auth: loggedInAuth, error: null }),
  });
  try {
    await state.bootstrap();
    const saved = await state.saveConfig({ family: 'zai' });
    assert.equal(saved.ok, true);
    assert.equal(saved.config.family, 'zai');
    assert.equal(state.getSnapshot().config.family, 'zai', 'returned config lands in the snapshot');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(mock.calls.filter((call) => call.path.endsWith('/overview')).length, 1, 'a signed-in save refreshes the overview');
    assert.equal(state.getSnapshot().overview.generatedAt, 1_700_000_000_123);
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state maps inference from every overview response and normalizes malformed fields', async () => {
  const { state } = await freshState();
  const overviews = [
    ok({
      generatedAt: 1_700_000_000_000,
      auth: loggedInAuth,
      inference: inferenceStatus({ ref: 'OVERVIEW_REF', family: 'zai', writtenAt: 11, expiresAt: 22, expiresInMs: 33 }),
      error: null,
    }),
    ok({
      generatedAt: 1_700_000_001_000,
      auth: loggedInAuth,
      inference: { enabled: 'yes', available: 1, ref: '', family: 7, writtenAt: 'x', expiresAt: Infinity, expiresInMs: null, error: { code: 'credential_write_failed', message: 'nope' } },
      error: null,
    }),
    ok({ generatedAt: 1_700_000_002_000, auth: loggedInAuth, error: null }),
  ];
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': statusPayload({ inference: inferenceStatus() }),
    'GET /bigmodelcn-codingplan/api/overview?force=1': () => overviews.shift(),
  });
  try {
    await state.bootstrap();
    await state.refreshOverview({ force: true });
    assert.deepEqual(state.getSnapshot().inference, {
      enabled: true,
      available: true,
      ref: 'OVERVIEW_REF',
      family: 'zai',
      writtenAt: 11,
      expiresAt: 22,
      expiresInMs: 33,
      error: null,
    }, 'overview replaces the status block');

    await state.refreshOverview({ force: true });
    assert.deepEqual(state.getSnapshot().inference, {
      enabled: false,
      available: false,
      ref: null,
      family: null,
      writtenAt: null,
      expiresAt: null,
      expiresInMs: null,
      error: 'credential_write_failed',
    }, 'malformed fields normalize instead of leaking through');

    await state.refreshOverview({ force: true });
    assert.equal(state.getSnapshot().inference, null, 'an overview without inference clears it');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state login ready refreshes inference from the post-login status and logout clears it', async () => {
  const { state } = await freshState();
  const statuses = [
    statusPayload({ inference: inferenceStatus({ ref: 'BEFORE_LOGIN_REF' }) }),
    statusPayload({ inference: inferenceStatus({ ref: 'POST_LOGIN_REF', writtenAt: 222 }) }),
  ];
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': () => (statuses.length > 0 ? statuses.shift() : statusPayload()),
    'POST /bigmodelcn-codingplan/api/login': ok({ authorizeUrl: 'https://zcode.z.ai/authorize', pollIntervalMs: 1000 }),
    'GET /bigmodelcn-codingplan/api/login/poll': ok({ state: 'ready' }),
    'GET /bigmodelcn-codingplan/api/overview?force=1': hostError(502, 'upstream_failed', 'flaky'),
    'POST /bigmodelcn-codingplan/api/logout': ok({ ok: true }),
  });
  try {
    await state.bootstrap();
    assert.equal(state.getSnapshot().inference.ref, 'BEFORE_LOGIN_REF');
    await state.startLogin();
    await state.pollLogin();
    assert.equal(state.getSnapshot().login.state, 'idle');
    assert.equal(state.getSnapshot().inference.ref, 'POST_LOGIN_REF', 'login-ready status refreshes inference');
    assert.equal(state.getSnapshot().inference.writtenAt, 222);

    const signedOut = await state.logout();
    assert.equal(signedOut.ok, true);
    assert.equal(state.getSnapshot().inference, null, 'logout clears inference');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state login flow starts, polls to ready, and refreshes status plus overview', async () => {
  const { state } = await freshState();
  const overview = { generatedAt: Date.now(), auth: loggedInAuth, error: null };
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': statusPayload(),
    'POST /bigmodelcn-codingplan/api/login': ok({ authorizeUrl: 'https://zcode.z.ai/authorize', expiresAt: Date.now() + 60_000, pollIntervalMs: 1000 }),
    'GET /bigmodelcn-codingplan/api/login/poll': ok({ state: 'ready', user: { name: 'Tester' } }),
    'GET /bigmodelcn-codingplan/api/overview?force=1': ok(overview),
  });
  try {
    await state.bootstrap();
    const authorizeUrl = await state.startLogin({ family: 'bigmodel' });
    assert.equal(authorizeUrl, 'https://zcode.z.ai/authorize');
    assert.equal(state.getSnapshot().login.state, 'pending');
    assert.equal(state.getSnapshot().login.authorizeUrl, 'https://zcode.z.ai/authorize');
    const loginCall = mock.calls.find((call) => call.method === 'POST' && call.path.endsWith('/login'));
    assert.deepEqual(JSON.parse(loginCall.body), { family: 'bigmodel' });

    await state.pollLogin();
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.login.state, 'idle', 'a consumed flow returns to idle');
    assert.equal(snapshot.auth.loggedIn, true);
    assert.equal(snapshot.overview.generatedAt, overview.generatedAt);
    const pollCall = mock.calls.find((call) => call.path.endsWith('/login/poll'));
    assert.ok(pollCall !== undefined);
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state login start failures surface a failed login block', async () => {
  const { state } = await freshState();
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': statusPayload(),
    'POST /bigmodelcn-codingplan/api/login': hostError(502, 'oauth_unavailable', 'unavailable'),
  });
  try {
    await state.bootstrap();
    await assert.rejects(() => state.startLogin(), (error) => error.code === 'oauth_unavailable');
    assert.equal(state.getSnapshot().login.state, 'failed');
    assert.equal(state.getSnapshot().error.code, 'oauth_unavailable');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state cancelLogin clears the pending flow without touching auth', async () => {
  const { state } = await freshState();
  const mock = installFetch({
    'GET /bigmodelcn-codingplan/api/status': statusPayload(),
    'POST /bigmodelcn-codingplan/api/login': ok({ authorizeUrl: 'https://zcode.z.ai/authorize', pollIntervalMs: 1000 }),
  });
  try {
    await state.bootstrap();
    await state.startLogin();
    state.cancelLogin();
    assert.equal(state.getSnapshot().login.state, 'idle');
    assert.equal(state.getSnapshot().auth.loggedIn, true);
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state.tick pauses in hidden documents and bootstraps a cold store', async () => {
  const { state } = await freshState();
  const mock = installFetch({ 'GET /bigmodelcn-codingplan/api/status': statusPayload() });
  const hadDocument = 'document' in globalThis;
  const originalDocument = globalThis.document;
  try {
    await state.bootstrap();
    assert.equal(mock.calls.length, 1);
    globalThis.document = { visibilityState: 'hidden' };
    await state.tick();
    assert.equal(mock.calls.length, 1, 'hidden documents skip auto-refresh');
  } finally {
    if (hadDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
    mock.restore();
    state.dispose();
  }
});
