/**
 * Unit tests for lib/host/upstream.js.
 *
 * Every test is hermetic: the HTTP client and the account authorization probe
 * are injected fakes, the clock is fixed, and response payloads come from the
 * sanitized fixtures in tests/fixtures/.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { HostError } from '../../lib/host/http.js';
import { FAMILIES } from '../../lib/host/constants.js';
import {
  createUpstream,
  classifyLimitWindow,
  envelopeMessage,
  isNoCodingPlanMessage,
  isSuccessfulEnvelope,
  normalizeCreditActivity,
  normalizeCreditDetail,
  normalizeModelUsage,
  normalizePerformance,
  normalizeProjectToken,
  normalizeQuota,
  normalizeResetStatus,
  normalizeSubscription,
  normalizeToolUsage,
  parseBigModelDateTime,
  pickPrimaryLimit,
  remainingPercent,
  resolveUsageRange,
} from '../../lib/host/upstream.js';

/** Clock the upstream range tests resolve against. */
const FIXED_NOW = Date.parse('2026-07-02T10:00:00Z');

const silentLogger = { info() {}, warn() {}, debug() {} };

/** Load one sanitized upstream response fixture. */
function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

/** Stored auth document handed to the upstream methods in tests. */
const AUTH = Object.freeze({
  family: 'bigmodel',
  accessToken: 'access-token',
  zcodeJwtToken: 'zcode-jwt',
});

/** HTTP client mock keyed by URL pathname; records every call. */
function createHttpMock(routes) {
  const calls = [];
  return {
    calls,
    async request(url, init = {}) {
      const parsed = new URL(String(url));
      calls.push({ url: String(url), pathname: parsed.pathname, search: parsed.searchParams, init });
      const handler = routes[parsed.pathname];
      if (handler === undefined) throw new Error(`unexpected request ${parsed.pathname}`);
      return typeof handler === 'function' ? handler(parsed, init) : handler;
    },
  };
}

/** Account-module mock whose probe accepts the first candidate form. */
function createProbeAccount() {
  const probes = [];
  return {
    probes,
    async probeAuthorization({ family, auth, channel, request }) {
      probes.push({ family, auth, channel });
      const response = await request('probe-authorization');
      return { authorization: 'probe-authorization', response, kind: 'access-token' };
    },
  };
}

/** Build an upstream client over mocked HTTP and a mocked account probe. */
function createHarness(routes) {
  const http = createHttpMock(routes);
  const account = createProbeAccount();
  const upstream = createUpstream({ http, logger: silentLogger, now: () => FIXED_NOW });
  return { http, account, upstream };
}

/** Find the recorded call of one pathname. */
function callFor(http, pathname) {
  const call = http.calls.find((entry) => entry.pathname === pathname);
  assert.ok(call, `expected a request to ${pathname}`);
  return call;
}

describe('envelopes', () => {
  it('accepts the success codes of every family', () => {
    assert.equal(isSuccessfulEnvelope({ code: 200, data: {} }), true);
    assert.equal(isSuccessfulEnvelope({ code: 0, data: {} }), true);
    assert.equal(isSuccessfulEnvelope({ data: {} }), true);
    assert.equal(isSuccessfulEnvelope({ code: 200, success: true, data: [] }), true);
    assert.equal(isSuccessfulEnvelope({ code: 200, success: false }), false);
    assert.equal(isSuccessfulEnvelope({ code: 2007, msg: 'dependency failed' }), false);
    assert.equal(isSuccessfulEnvelope({ code: 401 }), false);
    assert.equal(isSuccessfulEnvelope(null), false);
    assert.equal(isSuccessfulEnvelope('ok'), false);
  });

  it('reads msg before message and tolerates missing messages', () => {
    assert.equal(envelopeMessage({ msg: ' 操作成功 ', message: 'ok' }), '操作成功');
    assert.equal(envelopeMessage({ message: 'token expired' }), 'token expired');
    assert.equal(envelopeMessage({}), '');
    assert.equal(envelopeMessage(undefined), '');
  });

  it('recognizes the no-plan wording in all observed spellings', () => {
    assert.equal(isNoCodingPlanMessage('当前用户不存在coding plan'), true);
    assert.equal(isNoCodingPlanMessage('当前用户不存在 coding plan'), true);
    assert.equal(isNoCodingPlanMessage('该账号没有资格开通'), true);
    assert.equal(isNoCodingPlanMessage('coding plan 不存在'), true);
    assert.equal(isNoCodingPlanMessage('未开通 Coding Plan'), true);
    assert.equal(isNoCodingPlanMessage('No coding plan found'), true);
    assert.equal(isNoCodingPlanMessage('操作成功'), false);
    assert.equal(isNoCodingPlanMessage(''), false);
    assert.equal(isNoCodingPlanMessage(undefined), false);
  });
});

describe('quota normalization', () => {
  it('maps the three quota windows and keeps the used-ratio percentage', () => {
    const quota = normalizeQuota(fixture('quota-limit.json'));
    assert.equal(quota.level, 'pro');
    assert.equal(quota.envelope.successful, true);
    assert.equal(quota.limits.length, 3);
    assert.deepEqual(
      quota.limits.map((limit) => limit.window),
      ['fiveHour', 'week', 'tool'],
    );
    const [fiveHour, week, tool] = quota.limits;
    assert.equal(fiveHour.type, 'TOKENS_LIMIT');
    assert.equal(fiveHour.unit, 3);
    assert.equal(fiveHour.number, 5);
    assert.equal(fiveHour.percentage, 25);
    assert.equal(fiveHour.nextResetTime, 1782881400000);
    assert.deepEqual(fiveHour.usageDetails, []);
    assert.equal(tool.type, 'TIME_LIMIT');
    assert.equal(tool.usageDetails.length, 3);
    assert.deepEqual(tool.usageDetails[0], {
      modelCode: 'search-prime',
      displayName: '联网搜索 MCP',
      usage: 50,
    });
    assert.equal(week.window, 'week');
  });

  it('inverts the used percentage into a remaining percentage', () => {
    const [fiveHour, week, tool] = normalizeQuota(fixture('quota-limit.json')).limits;
    assert.equal(remainingPercent(fiveHour), 75);
    assert.equal(remainingPercent(week), 60);
    assert.equal(remainingPercent(tool), 88);
    assert.equal(remainingPercent({ type: 'TIME_LIMIT', percentage: 0 }), 100);
    assert.equal(remainingPercent({ type: 'TIME_LIMIT', percentage: 120 }), 0);
    assert.equal(remainingPercent({ type: 'TIME_LIMIT', percentage: -5 }), 100);
    assert.equal(remainingPercent({ type: 'TIME_LIMIT' }), null);
    assert.equal(remainingPercent(null), null);
  });

  it('classifies limit windows exactly like the ZCode UI predicates', () => {
    assert.equal(classifyLimitWindow({ type: 'TOKENS_LIMIT', unit: 3, number: 5 }), 'fiveHour');
    assert.equal(classifyLimitWindow({ type: 'CREDIT_LIMIT', unit: 3, number: 5 }), 'fiveHour');
    assert.equal(classifyLimitWindow({ type: 'TOKENS_LIMIT', unit: 6, number: 1 }), 'week');
    assert.equal(classifyLimitWindow({ type: 'CREDIT_LIMIT', unit: 6 }), 'week');
    assert.equal(classifyLimitWindow({ type: 'TIME_LIMIT', unit: 5, number: 1 }), 'tool');
    // Number mismatches are not the documented window.
    assert.equal(classifyLimitWindow({ type: 'TOKENS_LIMIT', unit: 3, number: 4 }), 'other');
    assert.equal(classifyLimitWindow({ type: 'TIME_LIMIT', unit: 5, number: 2 }), 'other');
    assert.equal(classifyLimitWindow({ type: 'MCP_USAGE_LIMIT', unit: 5, number: 1 }), 'other');
    assert.equal(classifyLimitWindow({}), 'other');
  });

  it('picks TIME_LIMIT first for the compact remaining block', () => {
    const limits = normalizeQuota(fixture('quota-limit.json')).limits;
    assert.equal(pickPrimaryLimit(limits).type, 'TIME_LIMIT');
    assert.equal(pickPrimaryLimit([]), null);
    assert.equal(
      pickPrimaryLimit([{ type: 'TOKENS_LIMIT' }, { type: 'TOKENS_LIMIT', remaining: 1 }]).remaining,
      1,
    );
  });

  it('reports failed envelopes without throwing', () => {
    const quota = normalizeQuota({ code: 2007, msg: 'dependency failed', data: null });
    assert.equal(quota.envelope.successful, false);
    assert.equal(quota.envelope.message, 'dependency failed');
    assert.equal(quota.level, null);
    assert.deepEqual(quota.limits, []);
    assert.equal(normalizeQuota(null).level, null);
  });
});

describe('subscription normalization', () => {
  it('maps the active Coding Plan and renew/expire timestamps to epoch ms', () => {
    const subscription = normalizeSubscription(fixture('subscription-list.json'));
    assert.equal(subscription.active, true);
    assert.equal(subscription.productId, 'glm-coding-pro');
    assert.equal(subscription.productName, 'GLM Coding Pro');
    assert.equal(subscription.status, 'VALID');
    assert.equal(subscription.billingCycle, 'quarterly');
    assert.equal(subscription.autoRenew, true);
    // Both renew and period end are 2026-08-01 10:00 Beijing time.
    assert.equal(subscription.renewTime, 1785549600000);
    assert.equal(subscription.expireAt, 1785549600000);
    assert.equal(subscription.raw.productId, 'glm-coding-pro');
  });

  it('uses nextRenewTime as expiry for a non-renewing plan', () => {
    const subscription = normalizeSubscription({
      code: 200,
      data: [
        {
          productId: 'glm-coding-lite',
          productName: 'GLM Coding Lite',
          status: 'VALID',
          inCurrentPeriod: true,
          autoRenew: false,
          nextRenewTime: '2026-09-01 00:00:00',
          valid: '2026-06-01 00:00:00 ~ 2026-09-01 00:00:00',
        },
      ],
    });
    assert.equal(subscription.active, true);
    assert.equal(subscription.autoRenew, false);
    assert.equal(subscription.renewTime, null);
    assert.equal(subscription.expireAt, 1788192000000);
  });

  it('reports an expired plan with its product instead of no-plan data', () => {
    const subscription = normalizeSubscription({
      code: 200,
      data: [
        {
          productId: 'glm-coding-pro',
          productName: 'GLM Coding Pro',
          status: 'EXPIRED',
          inCurrentPeriod: false,
          autoRenew: 0,
          nextRenewTime: '2026-06-01 00:00:00',
        },
      ],
    });
    assert.equal(subscription.active, false);
    assert.equal(subscription.productId, 'glm-coding-pro');
    assert.equal(subscription.status, 'EXPIRED');
  });

  it('reports no plan when the list has no Coding Plan entry', () => {
    const subscription = normalizeSubscription({ code: 200, data: [] });
    assert.equal(subscription.active, false);
    assert.equal(subscription.productId, null);
    assert.equal(subscription.raw, null);
    const unrelated = normalizeSubscription({
      code: 200,
      data: [{ productId: 'glm-token-package', status: 'VALID', inCurrentPeriod: true }],
    });
    assert.equal(unrelated.active, false);
  });

  it('parses BigModel local date strings with a pinned Beijing offset', () => {
    assert.equal(parseBigModelDateTime('2026-08-01 10:00:00'), 1785549600000);
    assert.equal(parseBigModelDateTime('2026-08-01T10:00:00'), 1785549600000);
    assert.equal(parseBigModelDateTime('2026-08-01T02:00:00Z'), 1785549600000);
    assert.equal(parseBigModelDateTime('2026-08-01T10:00:00+08:00'), 1785549600000);
    assert.equal(parseBigModelDateTime('2026-08-01'), 1785513600000);
    assert.equal(parseBigModelDateTime(1785549600), 1785549600000);
    assert.equal(parseBigModelDateTime(1785549600000), 1785549600000);
    assert.equal(parseBigModelDateTime('not-a-date'), null);
    assert.equal(parseBigModelDateTime(undefined), null);
  });
});

describe('usage range resolution', () => {
  it('resolves today/7d/30d in the caller time zone', () => {
    const today = resolveUsageRange('today', FIXED_NOW, 'UTC');
    assert.equal(today.startTime, '2026-07-02 00:00:00');
    assert.equal(today.endTime, '2026-07-02 23:59:59');
    assert.equal(today.granularity, 'hour');

    const week = resolveUsageRange('7d', FIXED_NOW, 'UTC');
    assert.equal(week.startTime, '2026-06-26 00:00:00');
    assert.equal(week.endTime, '2026-07-02 23:59:59');
    assert.equal(week.granularity, 'day');
    assert.equal(week.startDateKey, '2026-06-26');
    assert.equal(week.endDateKey, '2026-07-02');

    const month = resolveUsageRange('30d', FIXED_NOW, 'UTC');
    assert.equal(month.startTime, '2026-06-03 00:00:00');
    assert.equal(month.endTime, '2026-07-02 23:59:59');
    assert.equal(month.granularity, 'day');
  });

  it('follows the client time zone across the date boundary', () => {
    // 18:30Z is already the next day in Beijing.
    const evening = Date.parse('2026-07-02T18:30:00Z');
    assert.equal(resolveUsageRange('today', evening, 'Asia/Shanghai').endDateKey, '2026-07-03');
    assert.equal(resolveUsageRange('today', evening, 'UTC').endDateKey, '2026-07-02');
    assert.equal(resolveUsageRange('7d', evening, 'Asia/Shanghai').startDateKey, '2026-06-27');
  });

  it('rejects unknown ranges and time zones with invalid_request', () => {
    assert.throws(() => resolveUsageRange('90d', FIXED_NOW, 'UTC'), (error) => {
      assert.equal(error instanceof HostError, true);
      assert.equal(error.code, 'invalid_request');
      assert.equal(error.status, 400);
      return true;
    });
    assert.throws(() => resolveUsageRange('7d', FIXED_NOW, 'Mars/Olympus'), (error) => {
      assert.equal(error.code, 'invalid_request');
      return true;
    });
  });
});

describe('usage value normalization', () => {
  it('normalizes the legacy model-usage payload', () => {
    const usage = normalizeModelUsage(fixture('usage-model.json'));
    assert.equal(usage.granularity, 'day');
    assert.deepEqual(usage.series, [
      { date: '2026-07-01', tokens: 1230, calls: 3 },
      { date: '2026-07-02', tokens: 800, calls: 2 },
    ]);
    assert.equal(usage.summary.tokens, 2030);
    assert.equal(usage.summary.calls, 5);
    assert.deepEqual(
      usage.models.map((model) => [model.modelCode, model.tokens]),
      [
        ['glm-4.6', 1400],
        ['glm-4.5-air', 630],
      ],
    );
  });

  it('normalizes the legacy tool-usage payload', () => {
    const usage = normalizeToolUsage(fixture('usage-tool.json'));
    assert.equal(usage.granularity, 'day');
    assert.deepEqual(
      usage.series.map((point) => point.calls),
      [3, 4],
    );
    assert.deepEqual(
      usage.tools.map((tool) => [tool.toolCode, tool.calls]),
      [
        ['network-search', 3],
        ['zread', 3],
        ['web-reader', 1],
      ],
    );
    assert.equal(usage.summary.calls, 7);
  });

  it('normalizes the credit activity summary and heatmap series', () => {
    const activity = normalizeCreditActivity(fixture('credit-activity.json'));
    assert.equal(activity.summary.totalTokens, 350720);
    assert.equal(activity.summary.peakDailyTokens, 120000);
    assert.equal(activity.summary.peakDailyTokensDate, '2026-07-02');
    assert.equal(activity.summary.currentStreakDays, 2);
    assert.equal(activity.summary.longestStreakDays, 4);
    assert.equal(activity.series.length, 3);
    assert.deepEqual(activity.series[0], {
      date: '2026-06-30',
      tokens: 82000,
      calls: 3,
      mcpCalls: 1,
    });
  });

  it('normalizes the MODEL credit detail rows and metrics', () => {
    const detail = normalizeCreditDetail(fixture('credit-detail-model.json'), 'MODEL');
    assert.equal(detail.usageType, 'MODEL');
    assert.equal(detail.summary.cacheHitRate, 0.893);
    assert.equal(detail.summary.cacheHitRateTrend, 0.12);
    assert.equal(detail.summary.totalCredits, 28.95);
    assert.equal(detail.summary.totalCreditsTrend, -0.2);
    assert.equal(detail.summary.averageDailyCredits, 4.13);
    assert.deepEqual(
      detail.models.map((model) => [model.modelCode, model.tokens, model.credits]),
      [
        ['glm-4.6', 220000, 18.5],
        ['glm-4.5-air', 130720, 10.45],
      ],
    );
    assert.deepEqual(detail.mcp, []);
  });

  it('normalizes the MCP credit detail rows', () => {
    const detail = normalizeCreditDetail(fixture('credit-detail-mcp.json'), 'MCP');
    assert.equal(detail.usageType, 'MCP');
    assert.deepEqual(
      detail.mcp.map((row) => [row.toolCode, row.calls, row.credits]),
      [
        ['search-prime', 3, 0.6],
        ['zread', 2, 0.4],
      ],
    );
    assert.deepEqual(detail.models, []);
    assert.equal(detail.summary.totalCredits, 1);
  });

  it('filters token breakdown buckets out of the model rows', () => {
    const detail = normalizeCreditDetail(
      {
        code: 200,
        data: {
          summary: {},
          modelUsage: {
            xTime: [],
            modelDataList: [
              { modelCode: 'glm-4.6', modelName: 'glm-4.6', totalTokens: 100, totalCredits: 5 },
              { modelCode: 'cached_input', modelName: '缓存', totalTokens: 100, totalCredits: 2 },
              { modelCode: 'output', modelName: '输出', totalTokens: 10, totalCredits: 1 },
            ],
          },
        },
      },
      'MODEL',
    );
    assert.deepEqual(
      detail.models.map((model) => model.modelCode),
      ['glm-4.6'],
    );
    // With only bucket rows, the buckets are the fallback model rows.
    const bucketsOnly = normalizeCreditDetail(
      {
        data: {
          modelUsage: {
            modelDataList: [
              { modelCode: 'cached_input', totalTokens: 100 },
              { modelCode: 'output', totalTokens: 10 },
            ],
          },
        },
      },
      'MODEL',
    );
    assert.equal(bucketsOnly.models.length, 2);
  });

  it('normalizes the reset status snake_case payload', () => {
    const reset = normalizeResetStatus(fixture('reset-status.json'));
    assert.deepEqual(reset.fiveHour.available, [{ expireAt: 1786000000000 }]);
    assert.deepEqual(reset.week.available, [
      { expireAt: 1787000000000 },
      { expireAt: 1787500000000 },
    ]);
    assert.deepEqual(reset.fiveHour.latest, { usedAt: 1785990000000 });
    assert.equal(reset.week.latest, null);
    assert.equal(reset.hasUnreadHistory, true);
    assert.throws(() => normalizeResetStatus(null), (error) => {
      assert.equal(error instanceof HostError, true);
      assert.equal(error.code, 'upstream_failed');
      return true;
    });
  });

  it('normalizes a project token issuance with the earlier expiry', () => {
    const token = normalizeProjectToken(
      {
        code: 0,
        data: {
          enable: true,
          accessToken: 'project-token',
          tokenType: 'Bearer',
          expiresIn: 600,
          expiresAt: 1785549600,
        },
      },
      1_000_000,
    );
    assert.equal(token.token, 'project-token');
    // min(expiresAt * 1000, startedAt + expiresIn * 1000)
    assert.equal(token.expiresAt, 1_600_000);
    assert.deepEqual(normalizeProjectToken({ code: 0, data: { enable: false } }), {
      token: null,
      expiresAt: null,
    });
    assert.equal(
      normalizeProjectToken({ data: { access_token: 'snake', expires_in: 60 } }, 0).expiresAt,
      60_000,
    );
  });

  it('normalizes the decode-speed performance series', () => {
    const performance = normalizePerformance(fixture('model-performance-day.json'));
    assert.equal(performance.xTime.length, 7);
    assert.equal(performance.proMaxDecodeSpeed.at(-1), 124.9);
    assert.equal(performance.liteDecodeSpeed.at(-1), 53.9);
    assert.deepEqual(normalizePerformance({ data: { xTime: [], proMaxDecodeSpeed: [] } }), {
      xTime: [],
      proMaxDecodeSpeed: [],
      liteDecodeSpeed: [],
    });
  });
});

describe('upstream requests', () => {
  it('reads the quota through the monitor authorization probe', async () => {
    const { http, account, upstream } = createHarness({
      '/api/monitor/usage/quota/limit': { status: 200, body: fixture('quota-limit.json') },
    });
    const quota = await upstream.quota({ family: 'bigmodel', auth: AUTH, account });
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0].url, `${FAMILIES.bigmodel.origin}/api/monitor/usage/quota/limit`);
    assert.equal(http.calls[0].init.method, 'GET');
    assert.equal(http.calls[0].init.headers.authorization, 'probe-authorization');
    assert.equal(http.calls[0].init.timeoutMs > 0, true);
    assert.equal(account.probes[0].channel, 'monitor');
    assert.equal(account.probes[0].family, 'bigmodel');
    assert.equal(quota.status, 200);
    assert.equal(quota.level, 'pro');
    assert.equal(quota.limits.length, 3);
  });

  it('uses the Z.AI origin for the zai family', async () => {
    const { http, account, upstream } = createHarness({
      '/api/monitor/usage/quota/limit': { status: 200, body: fixture('quota-limit.json') },
    });
    await upstream.quota({ family: 'zai', auth: { ...AUTH, family: 'zai' }, account });
    assert.equal(http.calls[0].url, `${FAMILIES.zai.origin}/api/monitor/usage/quota/limit`);
  });

  it('reads the subscription list through the business probe', async () => {
    const { http, account, upstream } = createHarness({
      '/api/biz/subscription/list': { status: 200, body: fixture('subscription-list.json') },
    });
    const subscription = await upstream.subscription({ family: 'bigmodel', auth: AUTH, account });
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0].url, `${FAMILIES.bigmodel.origin}/api/biz/subscription/list`);
    assert.equal(http.calls[0].init.headers.Authorization, 'probe-authorization');
    assert.equal(account.probes[0].channel, 'business');
    assert.equal(subscription.active, true);
  });

  it('maps HTTP and envelope failures to stable error codes', async () => {
    const cases = [
      [{ status: 401, body: { code: 401, msg: 'token expired' } }, 'login_expired', 401],
      [{ status: 403, body: { msg: 'forbidden' } }, 'login_expired', 401],
      [{ status: 429, body: { message: 'too fast' } }, 'rate_limited', 429],
      [{ status: 500, body: { } }, 'upstream_failed', 502],
      [{ status: 200, body: { code: 2007, msg: 'dependency failed' } }, 'upstream_failed', 502],
      [{ status: 200, body: null }, 'upstream_failed', 502],
      [{ status: 200, body: { code: 2007, msg: '当前用户不存在 coding plan' } }, 'no_coding_plan', 409],
    ];
    for (const [response, code, status] of cases) {
      const { account, upstream } = createHarness({
        '/api/monitor/usage/quota/limit': response,
      });
      await assert.rejects(
        upstream.quota({ family: 'bigmodel', auth: AUTH, account }),
        (error) => {
          assert.equal(error instanceof HostError, true);
          assert.equal(error.code, code);
          assert.equal(error.status, status);
          return true;
        },
      );
    }
  });

  it('keeps the timeout/unreachable distinction for transport failures', async () => {
    const { account, upstream } = createHarness({
      '/api/monitor/usage/quota/limit': () => {
        throw new HostError('upstream_timeout', 'Upstream request timed out', { status: 502 });
      },
    });
    await assert.rejects(upstream.quota({ family: 'bigmodel', auth: AUTH, account }), (error) => {
      assert.equal(error.code, 'upstream_timeout');
      return true;
    });
  });

  it('propagates the account probe login_expired failure', async () => {
    const { upstream } = createHarness({
      '/api/monitor/usage/quota/limit': { status: 200, body: fixture('quota-limit.json') },
    });
    const account = {
      async probeAuthorization() {
        throw new HostError('login_expired', 'The login has expired', { status: 401 });
      },
    };
    await assert.rejects(upstream.quota({ family: 'bigmodel', auth: AUTH, account }), (error) => {
      assert.equal(error.code, 'login_expired');
      return true;
    });
  });

  it('requires an account module to probe with', async () => {
    const { upstream } = createHarness({});
    await assert.rejects(upstream.quota({ family: 'bigmodel', auth: AUTH, account: undefined }), (error) => {
      assert.equal(error.code, 'internal_error');
      return true;
    });
  });

  it('builds the usage payload from the monitor and credit endpoints', async () => {
    const { http, account, upstream } = createHarness({
      '/api/monitor/usage/model-usage': { status: 200, body: fixture('usage-model.json') },
      '/api/monitor/usage/tool-usage': { status: 200, body: fixture('usage-tool.json') },
      '/api/monitor/credit-usage/activity': { status: 200, body: fixture('credit-activity.json') },
      '/api/monitor/credit-usage/usage-detail': (url) => ({
        status: 200,
        body: fixture(url.searchParams.get('usageType') === 'MCP' ? 'credit-detail-mcp.json' : 'credit-detail-model.json'),
      }),
    });
    const usage = await upstream.usage({ family: 'bigmodel', auth: AUTH, account, range: '7d', timeZone: 'UTC' });
    assert.equal(http.calls.length, 5);

    const modelUrl = callFor(http, '/api/monitor/usage/model-usage').search;
    assert.equal(modelUrl.get('startTime'), '2026-06-26 00:00:00');
    assert.equal(modelUrl.get('endTime'), '2026-07-02 23:59:59');
    assert.equal(modelUrl.has('type'), false);
    assert.equal(modelUrl.has('granularity'), false);
    const toolUrl = callFor(http, '/api/monitor/usage/tool-usage').search;
    assert.equal(toolUrl.get('startTime'), '2026-06-26 00:00:00');
    const activityUrl = callFor(http, '/api/monitor/credit-usage/activity').search;
    assert.equal(activityUrl.get('type'), '1');
    assert.equal(activityUrl.get('startTime'), '2025-07-02 00:00:00');
    assert.equal(activityUrl.get('endTime'), '2026-07-02 23:59:59');
    const detailCalls = http.calls.filter((call) => call.pathname === '/api/monitor/credit-usage/usage-detail');
    assert.deepEqual(
      detailCalls.map((call) => call.search.get('usageType')).sort(),
      ['MCP', 'MODEL'],
    );
    for (const call of detailCalls) {
      assert.equal(call.search.get('type'), '1');
      assert.equal(call.search.get('startTime'), '2026-06-26 00:00:00');
      assert.equal(call.search.get('endTime'), '2026-07-02 23:59:59');
      assert.equal(call.search.has('granularity'), false);
    }

    assert.equal(usage.range, '7d');
    assert.equal(usage.timeZone, 'UTC');
    assert.equal(usage.granularity, 'day');
    assert.deepEqual(usage.series, [
      { date: '2026-07-01', tokens: 1230, calls: 3, mcpCalls: 3 },
      { date: '2026-07-02', tokens: 800, calls: 2, mcpCalls: 4 },
    ]);
    assert.deepEqual(usage.summary, {
      totalTokens: 2030,
      totalCalls: 5,
      activeDays: 2,
      peakDailyTokens: 1230,
      peakDailyTokensDate: '2026-07-01',
      totalCredits: 28.95,
      averageDailyCredits: 4.13,
      cacheHitRate: 0.893,
      currentStreakDays: 2,
      longestStreakDays: 4,
    });
    assert.deepEqual(usage.models, [
      { modelCode: 'glm-4.6', modelName: 'glm-4.6', tokens: 220000, calls: 0, credits: 18.5 },
      { modelCode: 'glm-4.5-air', modelName: 'glm-4.5-air', tokens: 130720, calls: 0, credits: 10.45 },
    ]);
    assert.deepEqual(usage.tools, [
      { toolCode: 'search-prime', toolName: '联网搜索 MCP', calls: 3, credits: 0.6 },
      { toolCode: 'zread', toolName: '开源仓库 MCP', calls: 2, credits: 0.4 },
    ]);
  });

  it('degrades optional usage surfaces instead of failing the payload', async () => {
    const { account, upstream } = createHarness({
      '/api/monitor/usage/model-usage': { status: 200, body: fixture('usage-model.json') },
      '/api/monitor/usage/tool-usage': { status: 200, body: fixture('usage-tool.json') },
      '/api/monitor/credit-usage/activity': { status: 500, body: {} },
      '/api/monitor/credit-usage/usage-detail': { status: 500, body: {} },
    });
    const usage = await upstream.usage({ family: 'bigmodel', auth: AUTH, account, range: '7d', timeZone: 'UTC' });
    assert.equal(usage.series.length, 2);
    assert.equal(usage.summary.totalTokens, 2030);
    assert.equal(usage.summary.totalCalls, 5);
    assert.equal(usage.summary.currentStreakDays, 2);
    assert.equal(usage.summary.longestStreakDays, 2);
    assert.equal('totalCredits' in usage.summary, false);
    assert.equal('cacheHitRate' in usage.summary, false);
    // Model rows fall back to the legacy monitor summary; tools to the tool-usage rows.
    assert.deepEqual(
      usage.models.map((model) => model.modelCode),
      ['glm-4.6', 'glm-4.5-air'],
    );
    assert.equal(usage.tools.length, 3);
  });

  it('fails the usage payload when the mandatory model-usage read fails', async () => {
    const { account, upstream } = createHarness({
      '/api/monitor/usage/model-usage': { status: 500, body: {} },
      '/api/monitor/usage/tool-usage': { status: 200, body: fixture('usage-tool.json') },
      '/api/monitor/credit-usage/activity': { status: 200, body: fixture('credit-activity.json') },
      '/api/monitor/credit-usage/usage-detail': { status: 200, body: fixture('credit-detail-model.json') },
    });
    await assert.rejects(
      upstream.usage({ family: 'bigmodel', auth: AUTH, account, range: '7d', timeZone: 'UTC' }),
      (error) => {
        assert.equal(error.code, 'upstream_failed');
        return true;
      },
    );
  });

  it('accepts a tool-usage envelope without data but rejects a model-usage one', async () => {
    const toolWithoutData = createHarness({
      '/api/monitor/usage/model-usage': { status: 200, body: fixture('usage-model.json') },
      '/api/monitor/usage/tool-usage': { status: 200, body: { code: 200, msg: '操作成功' } },
      '/api/monitor/credit-usage/activity': { status: 200, body: fixture('credit-activity.json') },
      '/api/monitor/credit-usage/usage-detail': { status: 200, body: fixture('credit-detail-model.json') },
    });
    const usage = await toolWithoutData.upstream.usage({
      family: 'bigmodel',
      auth: AUTH,
      account: toolWithoutData.account,
      range: '7d',
      timeZone: 'UTC',
    });
    assert.deepEqual(usage.tools, []);
    assert.equal(usage.series.length, 2);

    const modelWithoutData = createHarness({
      '/api/monitor/usage/model-usage': { status: 200, body: { code: 200, msg: '操作成功' } },
      '/api/monitor/usage/tool-usage': { status: 200, body: fixture('usage-tool.json') },
      '/api/monitor/credit-usage/activity': { status: 200, body: fixture('credit-activity.json') },
      '/api/monitor/credit-usage/usage-detail': { status: 200, body: fixture('credit-detail-model.json') },
    });
    await assert.rejects(
      modelWithoutData.upstream.usage({
        family: 'bigmodel',
        auth: AUTH,
        account: modelWithoutData.account,
        range: '7d',
        timeZone: 'UTC',
      }),
      (error) => {
        assert.equal(error.code, 'upstream_failed');
        return true;
      },
    );
  });

  it('builds the credit payload and degrades optional detail', async () => {
    const routes = {
      '/api/monitor/credit-usage/activity': { status: 200, body: fixture('credit-activity.json') },
      '/api/monitor/credit-usage/usage-detail': (url) => ({
        status: 200,
        body: fixture(url.searchParams.get('usageType') === 'MCP' ? 'credit-detail-mcp.json' : 'credit-detail-model.json'),
      }),
    };
    const ok = createHarness(routes);
    const credit = await ok.upstream.credit({ family: 'bigmodel', auth: AUTH, account: ok.account, range: '30d', timeZone: 'UTC' });
    assert.equal(credit.summary.totalTokens, 350720);
    assert.equal(credit.summary.totalCredits, 28.95);
    assert.equal(credit.summary.cacheHitRate, 0.893);
    assert.equal(credit.models.length, 2);
    assert.equal(credit.mcp.length, 2);

    const degraded = createHarness({
      '/api/monitor/credit-usage/activity': { status: 500, body: {} },
      '/api/monitor/credit-usage/usage-detail': { status: 500, body: {} },
    });
    const partial = await degraded.upstream.credit({
      family: 'bigmodel',
      auth: AUTH,
      account: degraded.account,
      range: '30d',
      timeZone: 'UTC',
    });
    assert.equal(partial.summary.totalTokens, 0);
    assert.deepEqual(partial.models, []);
    assert.deepEqual(partial.mcp, []);
  });

  it('reads the optional performance series for a fixed 7-day window', async () => {
    const { http, account, upstream } = createHarness({
      '/api/monitor/usage/model-performance-day': {
        status: 200,
        body: fixture('model-performance-day.json'),
      },
    });
    const performance = await upstream.performance({
      family: 'bigmodel',
      auth: AUTH,
      account,
      range: '30d',
      timeZone: 'UTC',
    });
    const search = http.calls[0].search;
    assert.equal(search.get('startTime'), '2026-06-26 00:00:00');
    assert.equal(search.get('endTime'), '2026-07-02 23:59:59');
    assert.equal(search.has('type'), false);
    assert.equal(performance.xTime.length, 7);

    const failed = createHarness({
      '/api/monitor/usage/model-performance-day': { status: 500, body: {} },
    });
    assert.equal(
      await failed.upstream.performance({
        family: 'bigmodel',
        auth: AUTH,
        account: failed.account,
        range: '7d',
        timeZone: 'UTC',
      }),
      null,
    );
    const expired = createHarness({
      '/api/monitor/usage/model-performance-day': { status: 401, body: {} },
    });
    await assert.rejects(
      expired.upstream.performance({
        family: 'bigmodel',
        auth: AUTH,
        account: expired.account,
        range: '7d',
        timeZone: 'UTC',
      }),
      (error) => {
        assert.equal(error.code, 'login_expired');
        return true;
      },
    );
  });
});

describe('coding plan reset requests', () => {
  const resetAuth = { accessToken: 'maas-access-token', zcodeJwtToken: 'zcode-jwt' };

  const resetRoutes = (overrides = {}) => ({
    '/api/v1/coding-plan/reset/status': { status: 200, body: fixture('reset-status.json') },
    '/api/v1/coding-plan/reset/use': { status: 200, body: { code: 0, data: { used: true } } },
    '/api/v1/coding-plan/reset/opportunity': {
      status: 200,
      body: { code: 0, data: { granted: true } },
    },
    '/api/v1/coding-plan/reset/history/read': { status: 200, body: { code: 0 } },
    ...overrides,
  });

  it('reads the reset status with the ZCode credential pair and target scope', async () => {
    const { http, upstream } = createHarness(resetRoutes());
    const status = await upstream.resetStatus({ family: 'bigmodel', auth: resetAuth });
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0].url, 'https://zcode.z.ai/api/v1/coding-plan/reset/status');
    assert.equal(http.calls[0].init.method, 'GET');
    assert.deepEqual(http.calls[0].init.headers, {
      Authorization: 'Bearer zcode-jwt',
      'X-Bigmodel-Authorization': 'maas-access-token',
      'Bigmodel-Target-Type': 'PERSONAL',
    });
    assert.deepEqual(status.fiveHour.available, [{ expireAt: 1786000000000 }]);
  });

  it('does not double-prefix a Bearer ZCode token', async () => {
    const { http, upstream } = createHarness(resetRoutes());
    await upstream.resetStatus({
      family: 'bigmodel',
      auth: { ...resetAuth, zcodeJwtToken: 'Bearer already-prefixed' },
    });
    assert.equal(http.calls[0].init.headers.Authorization, 'Bearer already-prefixed');
  });

  it('refuses reset requests without the ZCode login credential', async () => {
    const { http, upstream } = createHarness(resetRoutes());
    await assert.rejects(
      upstream.resetStatus({ family: 'bigmodel', auth: { accessToken: 'only-access' } }),
      (error) => {
        assert.equal(error.code, 'reset_unavailable');
        assert.equal(error.status, 409);
        return true;
      },
    );
    assert.equal(http.calls.length, 0);
  });

  it('consumes a reset with the wire enum and idempotency key', async () => {
    const { http, upstream } = createHarness(resetRoutes());
    const result = await upstream.useReset({
      family: 'bigmodel',
      auth: resetAuth,
      resetType: 'FIVE_HOUR',
      idempotencyKey: 'key-1',
    });
    assert.deepEqual(result, { used: true });
    const call = callFor(http, '/api/v1/coding-plan/reset/use');
    assert.equal(call.url, 'https://zcode.z.ai/api/v1/coding-plan/reset/use');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['content-type'], 'application/json');
    assert.equal(call.init.headers['Bigmodel-Target-Type'], 'PERSONAL');
    assert.deepEqual(call.init.json, { idempotency_key: 'key-1', reset_type: 'FIVE_HOUR' });
  });

  it('rejects invalid reset types and idempotency keys before sending', async () => {
    for (const request of [
      { resetType: 'five_hour', idempotencyKey: 'key-1' },
      { resetType: 'WEEK', idempotencyKey: '   ' },
      { resetType: 'WEEK', idempotencyKey: 'x'.repeat(65) },
    ]) {
      const { http, upstream } = createHarness(resetRoutes());
      await assert.rejects(
        upstream.useReset({ family: 'bigmodel', auth: resetAuth, ...request }),
        (error) => {
          assert.equal(error.code, 'invalid_request');
          assert.equal(error.status, 400);
          return true;
        },
      );
      assert.equal(http.calls.length, 0);
    }
  });

  it('maps a bare 429 on the reset endpoints to reset_throttled', async () => {
    const routes = resetRoutes({
      '/api/v1/coding-plan/reset/use': { status: 429, body: { message: '请求过快或发卡锁被占用' } },
      '/api/v1/coding-plan/reset/status': { status: 429, body: { message: 'slow down' } },
    });
    const { upstream } = createHarness(routes);
    await assert.rejects(
      upstream.useReset({
        family: 'bigmodel',
        auth: resetAuth,
        resetType: 'WEEK',
        idempotencyKey: 'key-2',
      }),
      (error) => {
        assert.equal(error.code, 'reset_throttled');
        assert.equal(error.status, 429);
        return true;
      },
    );
    await assert.rejects(upstream.resetStatus({ family: 'bigmodel', auth: resetAuth }), (error) => {
      assert.equal(error.code, 'reset_throttled');
      return true;
    });
  });

  it('maps reset 401 and business failures to stable codes', async () => {
    const unauthorized = createHarness(
      resetRoutes({
        '/api/v1/coding-plan/reset/status': { status: 401, body: { code: 0 } },
      }),
    );
    await assert.rejects(
      unauthorized.upstream.resetStatus({ family: 'bigmodel', auth: resetAuth }),
      (error) => {
        assert.equal(error.code, 'login_expired');
        assert.equal(error.status, 401);
        return true;
      },
    );

    const business = createHarness(
      resetRoutes({
        '/api/v1/coding-plan/reset/status': { status: 200, body: { code: 2007, msg: 'dependency' } },
      }),
    );
    await assert.rejects(
      business.upstream.resetStatus({ family: 'bigmodel', auth: resetAuth }),
      (error) => {
        assert.equal(error.code, 'reset_upstream_busy');
        return true;
      },
    );

    const invalid = createHarness(
      resetRoutes({ '/api/v1/coding-plan/reset/status': { status: 200, body: { msg: 'no code' } } }),
    );
    await assert.rejects(
      invalid.upstream.resetStatus({ family: 'bigmodel', auth: resetAuth }),
      (error) => {
        assert.equal(error.code, 'upstream_failed');
        return true;
      },
    );
  });

  it('maps the 500/code-2007 dependency envelope of a chanceless /use to reset_upstream_busy', async () => {
    // Observed live: a /use without a live opportunity answers HTTP 500 with
    // business code 2007; ZCode surfaces it as a transient retry-later state.
    const busy = createHarness(
      resetRoutes({
        '/api/v1/coding-plan/reset/use': { status: 500, body: { code: 2007, msg: 'http error' } },
      }),
    );
    await assert.rejects(
      busy.upstream.useReset({
        family: 'bigmodel',
        auth: resetAuth,
        resetType: 'FIVE_HOUR',
        idempotencyKey: 'key-3',
      }),
      (error) => {
        assert.equal(error.code, 'reset_upstream_busy');
        assert.equal(error.status, 502);
        return true;
      },
    );
  });

  it('requests a reset opportunity and maps business code 3301 as a normal denial', async () => {
    const granted = createHarness(resetRoutes());
    assert.deepEqual(
      await granted.upstream.requestResetOpportunity({
        family: 'bigmodel',
        auth: resetAuth,
        idempotencyKey: 'opportunity-1',
      }),
      { granted: true, nextTryAt: null },
    );
    const grantedCall = callFor(granted.http, '/api/v1/coding-plan/reset/opportunity');
    assert.equal(grantedCall.url, 'https://zcode.z.ai/api/v1/coding-plan/reset/opportunity');
    assert.deepEqual(grantedCall.init.json, { idempotency_key: 'opportunity-1' });

    const denied = createHarness(
      resetRoutes({
        '/api/v1/coding-plan/reset/opportunity': {
          status: 200,
          body: { code: 3301, msg: 'not eligible', data: { granted: false, next_try_at: 1786377600000 } },
        },
      }),
    );
    assert.deepEqual(
      await denied.upstream.requestResetOpportunity({
        family: 'bigmodel',
        auth: resetAuth,
        idempotencyKey: 'opportunity-2',
      }),
      { granted: false, nextTryAt: 1786377600000 },
    );

    const malformed = createHarness(
      resetRoutes({
        '/api/v1/coding-plan/reset/opportunity': {
          status: 200,
          body: { code: 3301, data: { granted: false } },
        },
      }),
    );
    await assert.rejects(
      malformed.upstream.requestResetOpportunity({
        family: 'bigmodel',
        auth: resetAuth,
        idempotencyKey: 'opportunity-3',
      }),
      (error) => {
        assert.equal(error.code, 'upstream_failed');
        return true;
      },
    );
  });

  it('maps opportunity HTTP 429 and business failures', async () => {
    const throttled = createHarness(
      resetRoutes({
        '/api/v1/coding-plan/reset/opportunity': { status: 429, body: { message: 'too fast' } },
      }),
    );
    await assert.rejects(
      throttled.upstream.requestResetOpportunity({
        family: 'bigmodel',
        auth: resetAuth,
        idempotencyKey: 'opportunity-4',
      }),
      (error) => {
        assert.equal(error.code, 'reset_throttled');
        assert.equal(error.status, 429);
        return true;
      },
    );

    const failed = createHarness(
      resetRoutes({
        '/api/v1/coding-plan/reset/opportunity': { status: 200, body: { code: 2007, msg: 'dependency' } },
      }),
    );
    await assert.rejects(
      failed.upstream.requestResetOpportunity({
        family: 'bigmodel',
        auth: resetAuth,
        idempotencyKey: 'opportunity-5',
      }),
      (error) => {
        assert.equal(error.code, 'reset_upstream_busy');
        return true;
      },
    );
  });

  it('marks the reset history read without the target scope header', async () => {
    const { http, upstream } = createHarness(resetRoutes());
    assert.deepEqual(await upstream.markResetHistoryRead({ family: 'bigmodel', auth: resetAuth }), {
      ok: true,
    });
    const call = callFor(http, '/api/v1/coding-plan/reset/history/read');
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(call.init.headers, {
      Authorization: 'Bearer zcode-jwt',
      'X-Bigmodel-Authorization': 'maas-access-token',
    });
    assert.equal(call.init.json, undefined);
  });
});
