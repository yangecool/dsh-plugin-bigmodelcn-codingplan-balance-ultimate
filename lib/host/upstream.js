/**
 * BigModel Coding Plan upstream requests and response normalizers.
 *
 * The plugin reads account entitlements from two upstream surfaces:
 *
 *  - BigModel/Z.AI business APIs (`/api/biz/...`) authorized with the OAuth
 *    access token or the project token; the account module probes which of the
 *    two the service accepts and caches the winning form per channel.
 *  - BigModel monitor APIs (`/api/monitor/...`) authorized with the same
 *    candidate through the `authorization` header.
 *
 * Coding Plan reset data is served by ZCode at {@link ZCODE_ORIGIN} and needs a
 * second credential pair: the ZCode login JWT (Bearer) plus the family access
 * token (`X-Bigmodel-Authorization`). Both are stored by the OAuth login.
 *
 * Every upstream failure becomes a {@link HostError} with a stable code so the
 * route layer can answer `{ error: { code, message } }`; upstream messages are
 * never propagated because they may embed credentials.
 *
 * The pure normalizers at the bottom are exported for unit tests and for the
 * reset endpoints; they accept either a full envelope or the bare `data` value.
 */
import { HostError, describeUrl } from './http.js';
import {
  CREDIT_ACTIVITY_PATH,
  CREDIT_DETAIL_PATH,
  FAMILIES,
  MODEL_PERFORMANCE_PATH,
  MODEL_USAGE_PATH,
  QUOTA_LIMIT_PATH,
  REQUEST_TIMEOUT_MS,
  RESET_HISTORY_READ_PATH,
  RESET_OPPORTUNITY_PATH,
  RESET_STATUS_PATH,
  RESET_USE_PATH,
  SUBSCRIPTION_LIST_PATH,
  TOOL_USAGE_PATH,
  USAGE_RANGES,
  ZCODE_ORIGIN,
} from './constants.js';

/** Reset types accepted by the ZCode Coding Plan reset API (`CodingPlanResetUseRequest`). */
export const RESET_TYPES = Object.freeze(['FIVE_HOUR', 'WEEK']);

/** Business code ZCode uses for "reset opportunity not granted, retry later". */
const RESET_OPPORTUNITY_DENIED_CODE = 3301;

/** `quota/limit` responses whose `usageDetails` rows are token buckets, not models. */
const CREDIT_BREAKDOWN_CODES = new Set([
  'cached_input',
  'cachedInput',
  'cache_input',
  'cacheInput',
  'uncached_input',
  'uncachedInput',
  'output',
  'output_tokens',
  'outputTokens',
]);

const CREDIT_BREAKDOWN_NAMES = new Set(['缓存', '未缓存', '输出']);

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

/** True for a non-null, non-array object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a finite number from a number or a numeric string; null otherwise. */
function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

/** Read a non-empty trimmed string; null otherwise. */
function stringValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Sum a possibly stringly numeric series, treating invalid entries as zero. */
function sumValues(values) {
  if (!Array.isArray(values)) return 0;
  return values.reduce((sum, value) => sum + (numberValue(value) ?? 0), 0);
}

/** Normalize a possibly sparse numeric series to finite numbers. */
function normalizeNumberSeries(values) {
  return Array.isArray(values) ? values.map((value) => numberValue(value) ?? 0) : [];
}

/** First non-empty numeric series out of the candidates, or null. */
function firstNonEmptySeries(candidates) {
  for (const series of candidates) {
    if (Array.isArray(series) && series.some((value) => (numberValue(value) ?? 0) > 0)) {
      return normalizeNumberSeries(series);
    }
  }
  return null;
}

/** Element-wise sum of the given numeric series; null when every series is empty. */
function sumSeries(candidates) {
  const length = Math.max(0, ...candidates.map((series) => (Array.isArray(series) ? series.length : 0)));
  if (length === 0) return null;
  return Array.from({ length }, (_, index) =>
    candidates.reduce((sum, series) => sum + (numberValue(series?.[index]) ?? 0), 0),
  );
}

/** Unwrap a `{ code, msg, data }` envelope; a bare payload is returned as-is. */
function unwrapData(payload) {
  if (!isRecord(payload)) return payload;
  if ('data' in payload || 'code' in payload || 'success' in payload || 'msg' in payload || 'message' in payload) {
    return payload.data;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Envelope contract
// ---------------------------------------------------------------------------

/**
 * Whether a BigModel/ZCode envelope reports success.
 *
 * The business API is inconsistent: some endpoints answer `code: 200`, some
 * `code: 0`, and some omit `code` entirely on success. Only an explicit
 * `success: false` or a different numeric code marks a failure.
 * @param payload - parsed response body.
 * @returns true when the envelope represents a successful operation.
 */
export function isSuccessfulEnvelope(payload) {
  if (!isRecord(payload)) return false;
  const code = payload.code;
  const codeAccepted = code === undefined || code === null || code === 0 || code === 200;
  return payload.success !== false && codeAccepted;
}

/**
 * Extract the human-readable message of an envelope without interpreting it.
 * @param payload - parsed response body.
 * @returns the trimmed `msg`/`message` field, or an empty string.
 */
export function envelopeMessage(payload) {
  if (!isRecord(payload)) return '';
  return stringValue(payload.msg) ?? stringValue(payload.message) ?? '';
}

/**
 * Whether a BigModel envelope message means "this account has no Coding Plan".
 *
 * The service words this several ways ("当前用户不存在coding plan",
 * "没有资格开通"), sometimes with a space between the Chinese text and
 * `coding plan`, so the message is compared after removing whitespace.
 * @param message - envelope message.
 * @returns true when the message is the definitive no-plan signal.
 */
export function isNoCodingPlanMessage(message) {
  if (typeof message !== 'string') return false;
  const text = message.toLowerCase().replace(/\s+/gu, '');
  if (text === '') return false;
  if (text.includes('不存在codingplan') || text.includes('没有资格')) return true;
  if (text.includes('不存在套餐')) return true;
  if (text.includes('未开通codingplan')) return true;
  if (text.includes('nocodingplan') || text.includes('no coding plan')) return true;
  // Word order varies ("coding plan 不存在"), so also match the pair in any order.
  return text.includes('codingplan') && (text.includes('不存在') || text.includes('未开通'));
}

// ---------------------------------------------------------------------------
// Pure normalizers
// ---------------------------------------------------------------------------

/**
 * Classify a quota limit into the window the Client renders.
 *
 * BigModel uses `TOKENS_LIMIT` with `unit: 3, number: 5` for the rolling
 * five-hour window and `unit: 6` for the weekly window; `TIME_LIMIT` is the
 * monthly tool-call allowance. Z.AI team plans use `CREDIT_LIMIT` for the same
 * token windows. Everything else is `other`.
 * @param limit - raw or normalized quota limit.
 * @returns one of `fiveHour`, `week`, `tool`, `other`.
 */
export function classifyLimitWindow(limit) {
  const type = stringValue(limit?.type);
  if (type === null) return 'other';
  const unit = numberValue(limit?.unit);
  const number = numberValue(limit?.number);
  const tokenLimit = type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT';
  // Weekly ignores `number`: the weekly window is the only token limit on unit 6.
  if (tokenLimit && unit === 6) return 'week';
  if (tokenLimit && unit === 3 && number === 5) return 'fiveHour';
  // Monthly tool-call allowance: unit 5 (month) × 1.
  if (type === 'TIME_LIMIT' && unit === 5 && number === 1) return 'tool';
  return 'other';
}

/** Read a monitor `granularity` value, tolerating the `hourly`/`daily` aliases. */
function readGranularity(value) {
  if (value === 'hour' || value === 'hourly') return 'hour';
  if (value === 'day' || value === 'daily') return 'day';
  return null;
}

/** Normalize one `usageDetails` row of a quota limit. */
function normalizeUsageDetails(details) {
  if (!Array.isArray(details)) return [];
  const rows = [];
  for (const detail of details) {
    if (!isRecord(detail)) continue;
    const modelCode = stringValue(detail.modelCode);
    if (modelCode === null) continue;
    const displayName = stringValue(detail.displayName);
    rows.push({
      modelCode,
      ...(displayName === null ? {} : { displayName }),
      usage: numberValue(detail.usage) ?? 0,
    });
  }
  return rows;
}

/** Normalize one raw quota limit from `quota/limit`. */
function normalizeLimit(raw) {
  if (!isRecord(raw)) return null;
  const type = stringValue(raw.type);
  if (type === null) return null;
  const limit = { type };
  for (const field of [
    'unit',
    'number',
    'usage',
    'currentValue',
    'remaining',
    'percentage',
    'nextResetTime',
  ]) {
    const value = numberValue(raw[field]);
    if (value !== null) limit[field] = value;
  }
  limit.usageDetails = normalizeUsageDetails(raw.usageDetails);
  limit.window = classifyLimitWindow(limit);
  return limit;
}

/**
 * Normalize a `quota/limit` response.
 *
 * `percentage` keeps the upstream meaning (the USED ratio); consumers invert
 * it with {@link remainingPercent}.
 * @param payload - full envelope or bare `data` payload.
 * @returns level, normalized limits, and envelope metadata.
 */
export function normalizeQuota(payload) {
  const data = unwrapData(payload);
  const source = isRecord(data) ? data : {};
  const limits = Array.isArray(source.limits)
    ? source.limits.map(normalizeLimit).filter((limit) => limit !== null)
    : [];
  return {
    level: stringValue(source.level),
    limits,
    envelope: { successful: isSuccessfulEnvelope(payload), message: envelopeMessage(payload) },
    status: null,
  };
}

/**
 * Pick the limit the compact remaining-quota display should use.
 *
 * Mirrors ZCode's ordering: `TIME_LIMIT` first, then the first limit with a
 * numeric remaining value, then the first limit.
 * @param limits - normalized quota limits.
 * @returns the chosen limit or null.
 */
export function pickPrimaryLimit(limits) {
  if (!Array.isArray(limits) || limits.length === 0) return null;
  return (
    limits.find((limit) => limit.type === 'TIME_LIMIT') ??
    limits.find((limit) => typeof limit.remaining === 'number') ??
    limits[0] ??
    null
  );
}

/**
 * Remaining share of a quota limit, in percent.
 *
 * BigModel's `percentage` is the USED ratio (31 means 31% consumed), so the
 * result is `100 - percentage` clamped to 0..100. When the service omits the
 * ratio it is derived from `currentValue`/`number` or `remaining`/`number`.
 * @param limit - normalized quota limit.
 * @returns remaining percentage 0..100, or null when the data is missing.
 */
export function remainingPercent(limit) {
  const usage = numberValue(limit?.percentage);
  if (usage === null) return null;
  return Math.max(0, Math.min(100, 100 - usage));
}

/**
 * Parse a BigModel business timestamp into epoch milliseconds.
 *
 * The subscription list returns local Beijing wall-clock strings
 * (`2026-06-01 12:00:00`) without an offset; interpreting them in the host's
 * local zone would shift the result on servers outside Asia/Shanghai, so the
 * offset is pinned. ISO strings with an explicit zone and numeric Unix values
 * (seconds or milliseconds) are also accepted.
 * @param value - upstream timestamp value.
 * @returns epoch milliseconds, or null.
 */
export function parseBigModelDateTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  const text = stringValue(value);
  if (text === null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    const date = new Date(`${text}T00:00:00+08:00`);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/u.test(text)) {
    const date = new Date(`${text.replace(' ', 'T')}+08:00`);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** Whether a subscription list entry describes a Coding Plan product. */
function isCodingPlanProduct(item) {
  if (!isRecord(item)) return false;
  return [item.productId, item.productName].some(
    (field) => typeof field === 'string' && field.toLowerCase().includes('coding'),
  );
}

/** Parse the end of the `valid: "start~end"` period of a subscription. */
function parseValidPeriodEnd(value) {
  const text = stringValue(value);
  if (text === null) return null;
  const matches = text.match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/gu);
  return matches === null ? null : parseBigModelDateTime(matches.at(-1));
}

/**
 * Normalize a `subscription/list` response.
 *
 * Only Coding Plan products are considered; the active one is the entry with
 * `status: "VALID"` inside its current period. Auto-renewing plans expose
 * `nextRenewTime` as the next charge (mapped to `renewTime`), while the final
 * entitlement end comes from the `valid` period; non-auto-renewing plans use
 * `nextRenewTime` as their expiry.
 * @param payload - full envelope or bare `data` payload.
 * @returns normalized subscription; `active` false when no Coding Plan entry exists.
 * @throws {HostError} `upstream_failed` when the payload is not a subscription list.
 */
export function normalizeSubscription(payload) {
  const data = unwrapData(payload);
  if (!Array.isArray(data)) {
    throw new HostError('upstream_failed', 'Upstream returned an unexpected response', { status: 502 });
  }
  const codingEntries = data.filter(isCodingPlanProduct);
  const activeEntry = codingEntries.find(
    (item) => item.status === 'VALID' && item.inCurrentPeriod === true,
  );
  const chosen = activeEntry ?? codingEntries[0] ?? null;
  if (chosen === null) {
    return {
      active: false,
      productId: null,
      productName: null,
      status: null,
      billingCycle: null,
      renewTime: null,
      expireAt: null,
      autoRenew: false,
      raw: null,
    };
  }
  const autoRenew = chosen.autoRenew === true || chosen.autoRenew === 1;
  const nextRenewTime = parseBigModelDateTime(chosen.nextRenewTime);
  const expireAt = autoRenew ? parseValidPeriodEnd(chosen.valid) : (nextRenewTime ?? parseValidPeriodEnd(chosen.valid));
  return {
    active: activeEntry !== undefined,
    productId: stringValue(chosen.productId),
    productName: stringValue(chosen.productName) ?? stringValue(chosen.productId),
    status: stringValue(chosen.status),
    billingCycle: stringValue(chosen.billingCycle),
    renewTime: autoRenew ? nextRenewTime : null,
    expireAt,
    autoRenew,
    raw: chosen,
  };
}

/** Render a date key (`YYYY-MM-DD`) in the given IANA time zone. */
function dateKeyInTimeZone(date, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
  } catch {
    throw new HostError('invalid_request', 'Unknown time zone', { status: 400 });
  }
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/** Add days to a date key, staying in date arithmetic (no time zone drift). */
function addDaysToDateKey(dateKey, days) {
  const [year = '1970', month = '01', day = '01'] = dateKey.split('-');
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Convert an epoch-ms value or a `now()` function into epoch milliseconds. */
function toNowMs(now) {
  if (typeof now === 'function') return now();
  const numeric = numberValue(now);
  return numeric ?? Date.now();
}

/**
 * Resolve the monitor query range of a usage request.
 *
 * `today` is an hourly window covering the current local date; `7d` and `30d`
 * are day windows ending today. The local date is resolved in `timeZone` with
 * `Intl.DateTimeFormat`, so a browser in Asia/Shanghai gets Beijing wall-clock
 * boundaries regardless of where the Host runs.
 * @param range - `today` | `7d` | `30d`.
 * @param now - epoch milliseconds or a clock function.
 * @param timeZone - optional IANA time zone.
 * @returns monitor start/end strings, granularity, and date keys.
 * @throws {HostError} `invalid_request` for an unknown range or time zone.
 */
export function resolveUsageRange(range, now = Date.now(), timeZone) {
  if (!USAGE_RANGES.includes(range)) {
    throw new HostError('invalid_request', `Unknown usage range "${range}"`, { status: 400 });
  }
  const endDateKey = dateKeyInTimeZone(new Date(toNowMs(now)), timeZone);
  if (range === 'today') {
    return {
      startTime: `${endDateKey} 00:00:00`,
      endTime: `${endDateKey} 23:59:59`,
      granularity: 'hour',
      startDateKey: endDateKey,
      endDateKey,
    };
  }
  const startDateKey = addDaysToDateKey(endDateKey, range === '7d' ? -6 : -29);
  return {
    startTime: `${startDateKey} 00:00:00`,
    endTime: `${endDateKey} 23:59:59`,
    granularity: 'day',
    startDateKey,
    endDateKey,
  };
}

/** Build one series point keyed by day or hour. */
function seriesPoint(label, granularity, values) {
  const point = granularity === 'hour' ? { time: label } : { date: label };
  return { ...point, tokens: values.tokens ?? 0, calls: values.calls ?? 0 };
}

/**
 * Normalize a legacy `model-usage` response.
 *
 * The monitor API returns parallel arrays (`x_time`, `tokensUsage`,
 * `modelCallCount`) plus a totals object and a per-model summary list.
 * @param payload - full envelope or bare `data` payload.
 * @returns granularity, axis, summary totals, series, and model rows.
 */
export function normalizeModelUsage(payload) {
  const data = unwrapData(payload);
  const source = isRecord(data) ? data : {};
  const xTime = Array.isArray(source.x_time) ? source.x_time.map((label) => String(label)) : [];
  const granularity = readGranularity(source.granularity);
  const tokens = normalizeNumberSeries(source.tokensUsage);
  const calls = normalizeNumberSeries(source.modelCallCount);
  const series = xTime.map((label, index) =>
    seriesPoint(label, granularity, { tokens: tokens[index] ?? 0, calls: calls[index] ?? 0 }),
  );
  const summaryList = Array.isArray(source.totalUsage?.modelSummaryList)
    ? source.totalUsage.modelSummaryList
    : Array.isArray(source.modelSummaryList)
      ? source.modelSummaryList
      : [];
  const models = summaryList
    .filter((item) => isRecord(item) && stringValue(item.modelName) !== null)
    .map((item) => ({
      modelCode: stringValue(item.modelName),
      modelName: stringValue(item.modelName),
      tokens: numberValue(item.totalTokens) ?? 0,
      calls: 0,
    }))
    .sort((left, right) => right.tokens - left.tokens);
  const totalTokens = numberValue(source.totalUsage?.totalTokensUsage) ?? sumValues(tokens);
  const totalCalls = numberValue(source.totalUsage?.totalModelCallCount) ?? sumValues(calls);
  return {
    granularity,
    xTime,
    summary: { tokens: totalTokens, calls: totalCalls, models },
    series,
    models,
  };
}

/** Legacy tool rows exposed by `tool-usage` when no tool summary list is present. */
const LEGACY_TOOLS = [
  {
    toolCode: 'network-search',
    toolName: 'Network search MCP',
    daily: 'networkSearchCount',
    total: 'totalNetworkSearchCount',
  },
  {
    toolCode: 'web-reader',
    toolName: 'Web reader MCP',
    daily: 'webReadMcpCount',
    total: 'totalWebReadMcpCount',
  },
  {
    toolCode: 'zread',
    toolName: 'Repository read MCP',
    daily: 'zreadMcpCount',
    total: 'totalZreadMcpCount',
  },
];

/**
 * Normalize a `tool-usage` response.
 *
 * Prefers the explicit `toolDataList`/`toolSummaryList` rows and falls back to
 * the legacy fixed tool counters of the monitor API.
 * @param payload - full envelope or bare `data` payload.
 * @returns granularity, axis, per-point call counts, tool rows, and totals.
 */
export function normalizeToolUsage(payload) {
  const data = unwrapData(payload);
  const source = isRecord(data) ? data : {};
  const xTime = Array.isArray(source.x_time) ? source.x_time.map((label) => String(label)) : [];
  const granularity = readGranularity(source.granularity);
  const totalUsage = isRecord(source.totalUsage) ? source.totalUsage : {};
  const toolDataList = Array.isArray(source.toolDataList) ? source.toolDataList.filter(isRecord) : [];
  const toolSummaryList = Array.isArray(source.toolSummaryList)
    ? source.toolSummaryList.filter(isRecord)
    : [];
  let tools = [];
  if (toolDataList.length > 0) {
    tools = toolDataList
      .map((item) => {
        const toolCode = stringValue(item.toolCode) ?? stringValue(item.toolName) ?? 'unknown';
        return {
          toolCode,
          toolName: stringValue(item.toolName) ?? toolCode,
          calls: numberValue(item.totalUsageCount) ?? sumValues(item.usageCount),
        };
      })
      .sort((left, right) => right.calls - left.calls);
  } else if (toolSummaryList.length > 0) {
    tools = toolSummaryList
      .map((item) => {
        const toolCode = stringValue(item.toolCode) ?? stringValue(item.toolName) ?? 'unknown';
        return {
          toolCode,
          toolName: stringValue(item.toolName) ?? toolCode,
          calls: numberValue(item.totalUsageCount) ?? 0,
        };
      })
      .sort((left, right) => right.calls - left.calls);
  } else {
    for (const definition of LEGACY_TOOLS) {
      const total = numberValue(totalUsage[definition.total]) ?? sumValues(source[definition.daily]);
      if (total > 0) {
        tools.push({ toolCode: definition.toolCode, toolName: definition.toolName, calls: total });
      }
    }
    const searchMcp = numberValue(totalUsage.totalSearchMcpCount) ?? 0;
    if (searchMcp > 0) {
      tools.push({ toolCode: 'search-mcp', toolName: 'Search MCP', calls: searchMcp });
    }
  }
  const pointCalls = xTime.map((_, index) => {
    if (toolDataList.length > 0) {
      return toolDataList.reduce((sum, item) => sum + (normalizeNumberSeries(item.usageCount)[index] ?? 0), 0);
    }
    return LEGACY_TOOLS.reduce(
      (sum, definition) => sum + (normalizeNumberSeries(source[definition.daily])[index] ?? 0),
      0,
    );
  });
  const series = xTime.map((label, index) =>
    seriesPoint(label, granularity, { tokens: 0, calls: pointCalls[index] ?? 0 }),
  );
  const totalCalls =
    toolDataList.length > 0 || toolSummaryList.length > 0
      ? tools.reduce((sum, tool) => sum + tool.calls, 0)
      : LEGACY_TOOLS.reduce((sum, definition) => sum + (numberValue(totalUsage[definition.total]) ?? 0), 0) +
        (numberValue(totalUsage.totalSearchMcpCount) ?? 0);
  return {
    granularity,
    xTime,
    series,
    tools,
    summary: { calls: totalCalls },
  };
}

/**
 * Normalize a `credit-usage/activity` response.
 *
 * The series is a daily token/call heatmap over the last year; invalid date
 * labels are dropped.
 * @param payload - full envelope or bare `data` payload.
 * @returns activity summary and daily series.
 */
export function normalizeCreditActivity(payload) {
  const data = unwrapData(payload);
  const source = isRecord(data) ? data : {};
  const rawSummary = isRecord(source.summary) ? source.summary : {};
  const series = Array.isArray(source.series)
    ? source.series
        .filter(isRecord)
        .map((item) => {
          const date = stringValue(item.date);
          if (date === null || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
          return {
            date,
            tokens: numberValue(item.totalTokens) ?? 0,
            calls: numberValue(item.modelCallCount) ?? 0,
            mcpCalls: numberValue(item.mcpCalls) ?? 0,
          };
        })
        .filter((item) => item !== null)
        .sort((left, right) => left.date.localeCompare(right.date))
    : [];
  return {
    summary: {
      totalTokens: numberValue(rawSummary.totalTokens) ?? 0,
      peakDailyTokens: numberValue(rawSummary.peakDailyTokens) ?? 0,
      peakDailyTokensDate: stringValue(rawSummary.peakDailyTokensDate),
      totalUsageDurationMs: numberValue(rawSummary.totalUsageDurationMs) ?? 0,
      currentStreakDays: numberValue(rawSummary.currentStreakDays) ?? 0,
      longestStreakDays: numberValue(rawSummary.longestStreakDays) ?? 0,
    },
    series,
  };
}

/** Whether a usage-detail row is a token bucket rather than a model row. */
function isCreditBreakdownRow(item) {
  const code = stringValue(item.modelCode);
  if (code !== null && CREDIT_BREAKDOWN_CODES.has(code)) return true;
  const name = stringValue(item.modelName);
  return name !== null && CREDIT_BREAKDOWN_NAMES.has(name);
}

/** Read the token count of one credit-usage model row. */
function readCreditRowTokens(item) {
  const series = firstNonEmptySeries([
    item.totalTokensUsage,
    item.tokensUsage,
    sumSeries([
      item.cachedInputTokensUsage,
      item.uncachedInputTokensUsage,
      item.outputTokensUsage,
    ]),
  ]);
  return numberValue(item.totalTokens) ?? (series === null ? 0 : sumValues(series));
}

/** Read the credit count of one credit-usage model row. */
function readCreditRowCredits(item) {
  const series = firstNonEmptySeries([
    item.totalCreditsUsage,
    sumSeries([
      item.cachedInputCreditsUsage,
      item.uncachedInputCreditsUsage,
      item.outputCreditsUsage,
    ]),
  ]);
  return numberValue(item.totalCredits) ?? (series === null ? 0 : sumValues(series));
}

/** Read a `{ value, trend }` metric bucket. */
function readMetric(metric) {
  const source = isRecord(metric) ? metric : {};
  return { value: numberValue(source.value), trend: numberValue(source.trend) };
}

/**
 * Normalize a `credit-usage/usage-detail` response.
 *
 * `usageType` selects the model dimension (`MODEL`) or the MCP tool dimension
 * (`MCP`). Token/credit breakdown rows ("缓存"/"未缓存"/"输出") are billing
 * components, not models, and are excluded whenever a real model row exists.
 * @param payload - full envelope or bare `data` payload.
 * @param usageType - `MODEL` or `MCP`.
 * @returns credits summary, axis, and the model or MCP rows.
 */
export function normalizeCreditDetail(payload, usageType) {
  const data = unwrapData(payload);
  const source = isRecord(data) ? data : {};
  const rawSummary = isRecord(source.summary) ? source.summary : {};
  const cacheHitRate = readMetric(rawSummary.cacheHitRate);
  const totalCredits = readMetric(rawSummary.totalCredits);
  const averageDailyCredits = readMetric(rawSummary.averageDailyCredits);
  const summary = {
    cacheHitRate: cacheHitRate.value,
    cacheHitRateTrend: cacheHitRate.trend,
    totalCredits: totalCredits.value,
    totalCreditsTrend: totalCredits.trend,
    averageDailyCredits: averageDailyCredits.value,
    averageDailyCreditsTrend: averageDailyCredits.trend,
  };
  if (usageType === 'MCP') {
    const mcpUsage = isRecord(source.mcpUsage) ? source.mcpUsage : {};
    const xTime = Array.isArray(mcpUsage.xTime) ? mcpUsage.xTime.map((label) => String(label)) : [];
    const rows = Array.isArray(mcpUsage.mcpDataList) ? mcpUsage.mcpDataList.filter(isRecord) : [];
    const mcp = rows
      .map((item, index) => {
        const toolCode =
          stringValue(item.mcpCode) ??
          stringValue(item.toolCode) ??
          stringValue(item.mcpName) ??
          'unknown';
        const callsSeries = firstNonEmptySeries([item.mcpCallCount, item.usageCount]);
        const creditsSeries = firstNonEmptySeries([item.creditsUsage]);
        return {
          toolCode,
          toolName: stringValue(item.mcpName) ?? stringValue(item.toolName) ?? toolCode,
          calls: numberValue(item.totalUsageCount) ?? (callsSeries === null ? 0 : sumValues(callsSeries)),
          credits: numberValue(item.totalCredits) ?? (creditsSeries === null ? 0 : sumValues(creditsSeries)),
          sortOrder: numberValue(item.sortOrder) ?? index,
        };
      })
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map(({ sortOrder, ...row }) => row);
    return { usageType: 'MCP', summary, xTime, models: [], mcp };
  }
  const modelUsage = isRecord(source.modelUsage) ? source.modelUsage : {};
  const xTime = Array.isArray(modelUsage.xTime) ? modelUsage.xTime.map((label) => String(label)) : [];
  const rows = Array.isArray(modelUsage.modelDataList)
    ? modelUsage.modelDataList.filter(isRecord)
    : [];
  const realRows = rows.filter((item) => !isCreditBreakdownRow(item));
  const effectiveRows = realRows.length > 0 ? realRows : rows;
  const models = effectiveRows
    .map((item, index) => {
      const modelCode = stringValue(item.modelCode) ?? stringValue(item.modelName);
      if (modelCode === null) return null;
      return {
        modelCode,
        modelName: stringValue(item.modelName) ?? modelCode,
        tokens: readCreditRowTokens(item),
        calls: 0,
        credits: readCreditRowCredits(item),
        sortOrder: numberValue(item.sortOrder) ?? index,
      };
    })
    .filter((row) => row !== null)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map(({ sortOrder, ...row }) => row);
  return { usageType: 'MODEL', summary, xTime, models, mcp: [] };
}

/** Read the reset opportunity list of `reset/status`. */
function readResetOpportunities(value) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const expireAt = numberValue(entry.expire_at) ?? numberValue(entry.expireAt);
    if (expireAt !== null && expireAt > 0) rows.push({ expireAt });
  }
  return rows;
}

/** Read a reset history timestamp of `reset/status`. */
function readResetHistory(value) {
  if (!isRecord(value)) return null;
  const usedAt = numberValue(value.used_at) ?? numberValue(value.usedAt);
  return usedAt === null || usedAt <= 0 ? null : { usedAt };
}

/**
 * Normalize a Coding Plan `reset/status` response.
 * @param payload - full envelope or bare `data` payload.
 * @returns available resets per window, latest history, and unread flag.
 * @throws {HostError} `upstream_failed` when the payload cannot be interpreted.
 */
export function normalizeResetStatus(payload) {
  const data = unwrapData(payload);
  if (!isRecord(data)) {
    throw new HostError('upstream_failed', 'Upstream returned an unexpected response', { status: 502 });
  }
  return {
    fiveHour: {
      available: readResetOpportunities(data.available_five_hour_resets ?? data.availableFiveHourResets),
      latest: readResetHistory(data.latest_five_hour_reset_history ?? data.latestFiveHourResetHistory),
    },
    week: {
      available: readResetOpportunities(data.available_week_resets ?? data.availableWeekResets),
      latest: readResetHistory(data.latest_week_reset_history ?? data.latestWeekResetHistory),
    },
    hasUnreadHistory: data.has_unread_history === true || data.hasUnreadHistory === true,
  };
}

/**
 * Normalize a project access-token issuance response.
 *
 * `expiresAt` is Unix seconds in the upstream response and the effective
 * expiry is the earlier of it and `now + expiresIn`, so a slow request never
 * extends the token lifetime.
 * @param payload - full envelope or bare `data` payload.
 * @param now - epoch milliseconds the request started at.
 * @returns the token and its epoch-ms expiry; nulls when no token was issued.
 */
export function normalizeProjectToken(payload, now = Date.now()) {
  const data = unwrapData(payload);
  const source = isRecord(data) ? data : {};
  const token = stringValue(source.accessToken) ?? stringValue(source.access_token);
  if (token === null) return { token: null, expiresAt: null };
  const explicit = numberValue(source.expiresAt) ?? numberValue(source.expires_at);
  const expiresIn = numberValue(source.expiresIn) ?? numberValue(source.expires_in);
  const startedAt = toNowMs(now);
  const candidates = [];
  if (explicit !== null && explicit > 0) {
    candidates.push(explicit > 1e12 ? explicit : explicit * 1000);
  }
  if (expiresIn !== null && expiresIn > 0) candidates.push(startedAt + expiresIn * 1000);
  return { token, expiresAt: candidates.length === 0 ? null : Math.min(...candidates) };
}

/**
 * Normalize a `model-performance-day` response (decode-speed health data).
 * @param payload - full envelope or bare `data` payload.
 * @returns axis labels and the decode-speed series.
 */
export function normalizePerformance(payload) {
  const data = unwrapData(payload);
  const source = isRecord(data) ? data : {};
  const axis = Array.isArray(source.x_time) ? source.x_time : Array.isArray(source.xTime) ? source.xTime : [];
  return {
    xTime: axis.map((label) => String(label)),
    proMaxDecodeSpeed: normalizeNumberSeries(source.proMaxDecodeSpeed),
    liteDecodeSpeed: normalizeNumberSeries(source.liteDecodeSpeed),
  };
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

/** Build a stable, credential-free log label for a failed request. */
function logUpstreamFailure(logger, label, url, response, code) {
  const status = response?.status ?? 0;
  const suffix = code === undefined ? '' : `, ${code}`;
  logger?.warn?.(`bigmodelcn-balance: ${label} request failed (${describeUrl(url)}, status ${status}${suffix})`);
}

/** Map a transport/HTTP/envelope failure into the plugin's stable error codes. */
function classifyEnvelope(response, url, label, logger) {
  const status = response.status;
  if (status === 401 || status === 403) {
    logUpstreamFailure(logger, label, url, response, 'login_expired');
    throw new HostError('login_expired', 'The login has expired', { status: 401 });
  }
  if (status === 429) {
    logUpstreamFailure(logger, label, url, response, 'rate_limited');
    throw new HostError('rate_limited', 'Too many requests to the upstream service', { status: 429 });
  }
  if (!(status >= 200 && status < 300)) {
    logUpstreamFailure(logger, label, url, response, 'upstream_failed');
    throw new HostError('upstream_failed', 'Upstream request failed', {
      status: 502,
      detail: `http ${status}`,
    });
  }
  const body = response.body;
  if (!isRecord(body)) {
    logUpstreamFailure(logger, label, url, response, 'invalid_body');
    throw new HostError('upstream_failed', 'Upstream returned an unexpected response', { status: 502 });
  }
  if (!isSuccessfulEnvelope(body)) {
    if (isNoCodingPlanMessage(envelopeMessage(body))) {
      logUpstreamFailure(logger, label, url, response, 'no_coding_plan');
      throw new HostError('no_coding_plan', 'The account has no active Coding Plan', { status: 409 });
    }
    logUpstreamFailure(logger, label, url, response, `code:${body.code ?? 'unknown'}`);
    throw new HostError('upstream_failed', 'Upstream request failed', { status: 502 });
  }
  return body;
}

/** Normalize an unexpected thrown value into a stable HostError. */
function unexpectedFailure(error) {
  if (error instanceof HostError) return error;
  return new HostError('upstream_failed', 'Upstream request failed', {
    status: 502,
    detail: String(error?.message ?? error),
  });
}

/** Build a family-scoped absolute URL with optional query parameters. */
function buildFamilyUrl(family, path, query) {
  const config = FAMILIES[family];
  if (config === undefined) {
    throw new HostError('invalid_request', `Unknown provider family "${family}"`, { status: 400 });
  }
  const url = new URL(path, config.origin);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(name, String(value));
  }
  return url.toString();
}

/** Validate and normalize a reset idempotency key. */
function readIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key === '' || key.length > 64) {
    throw new HostError('invalid_request', 'idempotencyKey must be 1-64 characters', { status: 400 });
  }
  return key;
}

/** Validate the wire reset type of `CodingPlanResetUseRequest`. */
function readResetType(value) {
  if (!RESET_TYPES.includes(value)) {
    throw new HostError('invalid_request', 'resetType must be FIVE_HOUR or WEEK', { status: 400 });
  }
  return value;
}

/** Return `Bearer <token>` unless the token already carries the scheme. */
function ensureBearer(token) {
  return /^Bearer\s/iu.test(token) ? token : `Bearer ${token}`;
}

/** Resolve the two credentials the Coding Plan reset API requires. */
function readResetCredentials(auth) {
  const zcodeJwtToken = stringValue(auth?.zcodeJwtToken);
  if (zcodeJwtToken === null) {
    throw new HostError('reset_unavailable', 'Coding Plan reset requires a ZCode login', { status: 409 });
  }
  const accessToken = stringValue(auth?.accessToken);
  if (accessToken === null) {
    throw new HostError('login_expired', 'The login has expired', { status: 401 });
  }
  return { authorization: ensureBearer(zcodeJwtToken), accessToken };
}

/** Build the ZCode reset headers (target scope omitted for `history/read`). */
function buildResetHeaders(auth, includeTargetScope) {
  const credentials = readResetCredentials(auth);
  const headers = {
    Authorization: credentials.authorization,
    'X-Bigmodel-Authorization': credentials.accessToken,
  };
  if (includeTargetScope) headers['Bigmodel-Target-Type'] = 'PERSONAL';
  return headers;
}

/** Build a ZCode absolute URL. */
function buildZcodeUrl(path) {
  return new URL(path, ZCODE_ORIGIN).toString();
}

/**
 * Read one Coding Plan reset response.
 *
 * Reset endpoints use their own contract: success is `code === 0` exactly, a
 * known business code may be accepted explicitly, and a bare HTTP 429 maps to
 * the reset-throttled error the Client retries with backoff.
 * @param response - http client response.
 * @param url - request URL for logging.
 * @param label - stable endpoint label for logging.
 * @param acceptedBusinessCodes - business codes the caller interprets itself.
 * @returns parsed envelope and the accepted business code when used.
 */
function readResetResponse(response, url, label, logger, acceptedBusinessCodes = []) {
  const status = response.status;
  if (status === 401 || status === 403) {
    logUpstreamFailure(logger, label, url, response, 'login_expired');
    throw new HostError('login_expired', 'The login has expired', { status: 401 });
  }
  if (status === 429) {
    logUpstreamFailure(logger, label, url, response, 'reset_throttled');
    throw new HostError('reset_throttled', 'The reset request was throttled; retry later', { status: 429 });
  }
  const body = response.body;
  const code = isRecord(body) ? numberValue(body.code) : null;
  if (code !== null && code !== 0) {
    if (acceptedBusinessCodes.includes(code)) return { body, acceptedCode: code };
    logUpstreamFailure(logger, label, url, response, `code:${code}`);
    throw new HostError('upstream_failed', 'Upstream request failed', {
      status: 502,
      detail: `business code ${code}`,
    });
  }
  if (!(status >= 200 && status < 300)) {
    logUpstreamFailure(logger, label, url, response, 'upstream_failed');
    throw new HostError('upstream_failed', 'Upstream request failed', { status: 502, detail: `http ${status}` });
  }
  if (code === null) {
    logUpstreamFailure(logger, label, url, response, 'invalid_envelope');
    throw new HostError('upstream_failed', 'Upstream returned an unexpected response', { status: 502 });
  }
  return { body, acceptedCode: null };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the upstream client bound to one plugin instance.
 *
 * `http` is the module from `lib/host/http.js`; every account/monitor request is
 * routed through the account module's `probeAuthorization` so the winning
 * authorization candidate is negotiated once per family/channel and cached
 * there. Reset requests use the ZCode credential pair directly.
 * @param options - http client, optional logger, and clock.
 * @returns upstream request methods.
 */
export function createUpstream(options = {}) {
  const { http, logger, now = () => Date.now() } = options;
  if (http === undefined || typeof http.request !== 'function') {
    throw new TypeError('bigmodelcn-balance: createUpstream requires an http client');
  }

  /**
   * Send one account/monitor request through the account module's candidate
   * probe. Transport failures are captured during the probe and re-thrown
   * afterwards so the caller keeps the `upstream_timeout`/`upstream_unreachable`
   * distinction.
   */
  async function probeRequest({ family, auth, account, channel, headerName, url, method = 'GET', json }) {
    if (account === undefined || typeof account.probeAuthorization !== 'function') {
      throw new HostError('internal_error', 'The account module is unavailable', { status: 500 });
    }
    let transportError = null;
    let result;
    try {
      result = await account.probeAuthorization({
        family,
        auth,
        channel,
        request: async (authorization) => {
          try {
            const response = await http.request(url, {
              method,
              timeoutMs: REQUEST_TIMEOUT_MS,
              headers: {
                ...(json === undefined ? {} : { 'content-type': 'application/json' }),
                [headerName]: authorization,
              },
              ...(json === undefined ? {} : { json }),
            });
            return { status: response.status, body: response.body };
          } catch (error) {
            transportError ??= unexpectedFailure(error);
            return { status: 0, body: undefined };
          }
        },
      });
    } catch (error) {
      throw unexpectedFailure(error);
    }
    if (!result || !isRecord(result.response)) {
      throw transportError ?? new HostError('upstream_failed', 'Upstream request failed', { status: 502 });
    }
    if (result.response.status === 0) {
      throw transportError ?? new HostError('upstream_failed', 'Upstream request failed', { status: 502 });
    }
    return result.response;
  }

  /** Probe, validate the envelope, and return the parsed body. */
  async function requestEnvelope({ family, auth, account, channel, headerName, url, method, json, label }) {
    const response = await probeRequest({ family, auth, account, channel, headerName, url, method, json });
    return { body: classifyEnvelope(response, url, label, logger), status: response.status };
  }

  /** Resolve the last-year activity range used by `credit-usage/activity`. */
  function resolveActivityRange(timeZone) {
    const today = dateKeyInTimeZone(new Date(toNowMs(now)), timeZone);
    return {
      startTime: `${addDaysToDateKey(today, -365)} 00:00:00`,
      endTime: `${today} 23:59:59`,
    };
  }

  /** Fetch the legacy model-usage monitor data. */
  function fetchModelUsage({ family, auth, account, startTime, endTime, label = 'model-usage' }) {
    return requestEnvelope({
      family,
      auth,
      account,
      channel: 'monitor',
      headerName: 'authorization',
      url: buildFamilyUrl(family, MODEL_USAGE_PATH, { startTime, endTime }),
      label,
    });
  }

  /** Fetch the legacy tool-usage monitor data. */
  function fetchToolUsage({ family, auth, account, startTime, endTime, label = 'tool-usage' }) {
    return requestEnvelope({
      family,
      auth,
      account,
      channel: 'monitor',
      headerName: 'authorization',
      url: buildFamilyUrl(family, TOOL_USAGE_PATH, { startTime, endTime }),
      label,
    });
  }

  /** Fetch the credit-usage activity summary. */
  function fetchCreditActivity({ family, auth, account, timeZone, label = 'credit-usage/activity' }) {
    const range = resolveActivityRange(timeZone);
    return requestEnvelope({
      family,
      auth,
      account,
      channel: 'monitor',
      headerName: 'authorization',
      url: buildFamilyUrl(family, CREDIT_ACTIVITY_PATH, {
        startTime: range.startTime,
        endTime: range.endTime,
        type: 1,
      }),
      label,
    });
  }

  /** Fetch one `credit-usage/usage-detail` dimension. */
  function fetchCreditDetail({ family, auth, account, startTime, endTime, usageType, label }) {
    return requestEnvelope({
      family,
      auth,
      account,
      channel: 'monitor',
      headerName: 'authorization',
      url: buildFamilyUrl(family, CREDIT_DETAIL_PATH, {
        startTime,
        endTime,
        usageType,
        type: 1,
      }),
      label,
    });
  }

  /** Degrade one optional data surface: auth failures propagate, the rest become `fallback`. */
  async function optional(label, request, fallback) {
    try {
      return await request;
    } catch (error) {
      const mapped = unexpectedFailure(error);
      if (mapped.code === 'login_expired' || mapped.code === 'no_coding_plan') throw mapped;
      logger?.warn?.(`bigmodelcn-balance: ${label} data is unavailable (${mapped.code})`);
      return fallback;
    }
  }

  /** Merge the model/tool/activity series into the usage page series. */
  function buildUsageSeries({ modelUsage, toolUsage, activity, granularity, rangeInfo }) {
    const keyOf = (label) => {
      const text = typeof label === 'string' ? label : '';
      if (granularity === 'hour') {
        const match = /(\d{2}):(\d{2})(?::(\d{2}))?/u.exec(text);
        return match === null ? text : `${match[1]}:${match[2]}:${match[3] ?? '00'}`;
      }
      const match = /(\d{4})-(\d{2})-(\d{2})/u.exec(text);
      return match === null ? text : `${match[1]}-${match[2]}-${match[3]}`;
    };
    const points = new Map();
    const ensurePoint = (label) => {
      const key = keyOf(label);
      let point = points.get(key);
      if (point === undefined) {
        point = { key, tokens: 0, calls: 0 };
        points.set(key, point);
      }
      return point;
    };
    for (const point of modelUsage.series) {
      const entry = ensurePoint(point.date ?? point.time);
      entry.tokens += point.tokens;
      entry.calls += point.calls;
    }
    const mcpByKey = new Map();
    if (toolUsage.series.length > 0) {
      for (const point of toolUsage.series) {
        const key = keyOf(point.date ?? point.time);
        mcpByKey.set(key, (mcpByKey.get(key) ?? 0) + point.calls);
      }
    } else if (granularity === 'day') {
      for (const point of activity?.series ?? []) {
        mcpByKey.set(keyOf(point.date), (mcpByKey.get(keyOf(point.date)) ?? 0) + point.mcpCalls);
      }
    }
    if (points.size === 0 && granularity === 'day') {
      for (const point of activity?.series ?? []) {
        if (point.date < rangeInfo.startDateKey || point.date > rangeInfo.endDateKey) continue;
        const entry = ensurePoint(point.date);
        entry.tokens += point.tokens;
        entry.calls += point.calls;
      }
    }
    return [...points.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((point) => {
        const row = granularity === 'hour' ? { time: point.key } : { date: point.key };
        row.tokens = point.tokens;
        row.calls = point.calls;
        const mcpCalls = mcpByKey.get(point.key);
        if (mcpCalls !== undefined) row.mcpCalls = mcpCalls;
        return row;
      });
  }

  /** Derive current/longest active-day streaks from a day series. */
  function deriveStreaks(series) {
    const toDayIndex = (dateKey) => {
      const [year = '1970', month = '01', day = '01'] = String(dateKey).split('-');
      return Math.floor(Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000);
    };
    let longest = 0;
    let running = 0;
    let previousDay = null;
    for (const point of series) {
      const day = toDayIndex(point.date);
      if (!Number.isFinite(day)) continue;
      const active = point.tokens > 0 || point.calls > 0;
      if (active) {
        running = previousDay !== null && day === previousDay + 1 ? running + 1 : 1;
        if (running > longest) longest = running;
      } else {
        running = 0;
      }
      previousDay = day;
    }
    let current = 0;
    for (let index = series.length - 1; index >= 0; index -= 1) {
      const point = series[index];
      if (point.tokens <= 0 && point.calls <= 0) break;
      current += 1;
    }
    return { current, longest };
  }

  /** Build the usage-page summary block. */
  function buildUsageSummary({ modelUsage, modelDetail, activity, series, granularity }) {
    const pointsWithUsage = series.filter((point) => point.tokens > 0 || point.calls > 0);
    const totalTokens = series.reduce((sum, point) => sum + point.tokens, 0);
    const totalCalls = series.reduce((sum, point) => sum + point.calls, 0);
    const summary = {
      totalTokens: series.length > 0 ? totalTokens : modelUsage.summary.tokens,
      totalCalls: series.length > 0 ? totalCalls : modelUsage.summary.calls,
      activeDays: granularity === 'hour' ? (pointsWithUsage.length > 0 ? 1 : 0) : pointsWithUsage.length,
    };
    const peak = series.reduce((best, point) => (best === null || point.tokens > best.tokens ? point : best), null);
    if (peak !== null && peak.tokens > 0) {
      summary.peakDailyTokens = peak.tokens;
      if (granularity === 'day' && peak.date !== undefined) summary.peakDailyTokensDate = peak.date;
    }
    const creditSummary = modelDetail?.summary ?? null;
    if (creditSummary !== null) {
      if (creditSummary.totalCredits !== null) summary.totalCredits = creditSummary.totalCredits;
      if (creditSummary.averageDailyCredits !== null) {
        summary.averageDailyCredits = creditSummary.averageDailyCredits;
      }
      if (creditSummary.cacheHitRate !== null) summary.cacheHitRate = creditSummary.cacheHitRate;
    }
    const derived = granularity === 'day' ? deriveStreaks(series) : { current: 0, longest: 0 };
    summary.currentStreakDays = numberValue(activity?.summary?.currentStreakDays) ?? derived.current;
    summary.longestStreakDays = numberValue(activity?.summary?.longestStreakDays) ?? derived.longest;
    return summary;
  }

  /** Build the model rows of the usage page. */
  function buildUsageModels(modelDetail, modelUsage) {
    if (modelDetail !== null && modelDetail.models.length > 0) {
      return modelDetail.models.map((row) => ({
        modelCode: row.modelCode,
        modelName: row.modelName,
        tokens: row.tokens,
        calls: row.calls,
        ...(typeof row.credits === 'number' ? { credits: row.credits } : {}),
      }));
    }
    return modelUsage.models.map((row) => ({
      modelCode: row.modelCode,
      modelName: row.modelName,
      tokens: row.tokens,
      calls: row.calls,
    }));
  }

  /** Build the MCP/tool rows of the usage page. */
  function buildUsageTools(mcpDetail, toolUsage) {
    if (mcpDetail !== null && mcpDetail.mcp.length > 0) {
      return mcpDetail.mcp.map((row) => ({
        toolCode: row.toolCode,
        toolName: row.toolName,
        calls: row.calls,
        ...(typeof row.credits === 'number' ? { credits: row.credits } : {}),
      }));
    }
    return toolUsage.tools.map((row) => ({
      toolCode: row.toolCode,
      toolName: row.toolName,
      calls: row.calls,
    }));
  }

  return {
    /**
     * Fetch and normalize the account quota limits.
     * @param request - family, stored auth document, and account module.
     * @returns normalized quota plus the HTTP status.
     */
    async quota({ family, auth, account }) {
      const url = buildFamilyUrl(family, QUOTA_LIMIT_PATH);
      const { body, status } = await requestEnvelope({
        family,
        auth,
        account,
        channel: 'monitor',
        headerName: 'authorization',
        url,
        label: 'quota/limit',
      });
      return { ...normalizeQuota(body), status };
    },

    /**
     * Fetch and normalize the subscription list.
     * @param request - family, stored auth document, and account module.
     * @returns normalized subscription.
     */
    async subscription({ family, auth, account }) {
      const url = buildFamilyUrl(family, SUBSCRIPTION_LIST_PATH);
      const { body } = await requestEnvelope({
        family,
        auth,
        account,
        channel: 'business',
        headerName: 'Authorization',
        url,
        label: 'subscription/list',
      });
      return normalizeSubscription(body);
    },

    /**
     * Fetch the aggregated usage statistics for the page.
     *
     * The model/tool monitor data is required; the credit-usage activity and
     * detail surfaces are optional and degrade to empty data, so one broken
     * detail endpoint cannot blank the whole page.
     * @param request - family, auth, account module, range, and time zone.
     * @returns usage page payload.
     */
    async usage({ family, auth, account, range = 'today', timeZone }) {
      const rangeInfo = resolveUsageRange(range, now, timeZone);
      const [modelResult, toolResult, activity, modelDetail, mcpDetail] = await Promise.all([
        fetchModelUsage({ family, auth, account, startTime: rangeInfo.startTime, endTime: rangeInfo.endTime }),
        fetchToolUsage({ family, auth, account, startTime: rangeInfo.startTime, endTime: rangeInfo.endTime }),
        optional(
          'credit-usage/activity',
          fetchCreditActivity({ family, auth, account, timeZone }),
          null,
        ),
        optional(
          'credit-usage/usage-detail MODEL',
          fetchCreditDetail({
            family,
            auth,
            account,
            startTime: rangeInfo.startTime,
            endTime: rangeInfo.endTime,
            usageType: 'MODEL',
            label: 'credit-usage/usage-detail',
          }),
          null,
        ),
        optional(
          'credit-usage/usage-detail MCP',
          fetchCreditDetail({
            family,
            auth,
            account,
            startTime: rangeInfo.startTime,
            endTime: rangeInfo.endTime,
            usageType: 'MCP',
            label: 'credit-usage/usage-detail',
          }),
          null,
        ),
      ]);
      // model-usage has no "empty success" contract: a success envelope without
      // data means the service could not report usage (ZCode treats it as an
      // error), while tool-usage legitimately omits data when nothing was called.
      if (!isRecord(modelResult.body) || !isRecord(modelResult.body.data)) {
        throw new HostError('upstream_failed', 'Upstream returned an unexpected response', { status: 502 });
      }
      const modelUsage = normalizeModelUsage(modelResult.body);
      const toolUsage = normalizeToolUsage(toolResult.body);
      const activityData = activity === null ? null : normalizeCreditActivity(activity.body);
      const modelDetailData = modelDetail === null ? null : normalizeCreditDetail(modelDetail.body, 'MODEL');
      const mcpDetailData = mcpDetail === null ? null : normalizeCreditDetail(mcpDetail.body, 'MCP');
      const series = buildUsageSeries({
        modelUsage,
        toolUsage,
        activity: activityData,
        granularity: rangeInfo.granularity,
        rangeInfo,
      });
      return {
        range,
        timeZone: timeZone ?? null,
        startTime: rangeInfo.startTime,
        endTime: rangeInfo.endTime,
        granularity: rangeInfo.granularity,
        summary: buildUsageSummary({
          modelUsage,
          modelDetail: modelDetailData,
          activity: activityData,
          series,
          granularity: rangeInfo.granularity,
        }),
        series,
        models: buildUsageModels(modelDetailData, modelUsage),
        tools: buildUsageTools(mcpDetailData, toolUsage),
      };
    },

    /**
     * Fetch the credit/tool usage detail used outside the main page (activity
     * summary plus per-model and per-MCP credit breakdown).
     * @param request - family, auth, account module, range, and time zone.
     * @returns credit summary, model rows, and MCP rows.
     */
    async credit({ family, auth, account, range = '30d', timeZone }) {
      const rangeInfo = resolveUsageRange(range, now, timeZone);
      const [activity, modelDetail, mcpDetail] = await Promise.all([
        optional(
          'credit-usage/activity',
          fetchCreditActivity({ family, auth, account, timeZone }),
          null,
        ),
        optional(
          'credit-usage/usage-detail MODEL',
          fetchCreditDetail({
            family,
            auth,
            account,
            startTime: rangeInfo.startTime,
            endTime: rangeInfo.endTime,
            usageType: 'MODEL',
            label: 'credit-usage/usage-detail',
          }),
          null,
        ),
        optional(
          'credit-usage/usage-detail MCP',
          fetchCreditDetail({
            family,
            auth,
            account,
            startTime: rangeInfo.startTime,
            endTime: rangeInfo.endTime,
            usageType: 'MCP',
            label: 'credit-usage/usage-detail',
          }),
          null,
        ),
      ]);
      const activityData = normalizeCreditActivity(activity?.body ?? null);
      const modelData = modelDetail === null ? null : normalizeCreditDetail(modelDetail.body, 'MODEL');
      const mcpData = mcpDetail === null ? null : normalizeCreditDetail(mcpDetail.body, 'MCP');
      const summary = {
        totalTokens: activityData.summary.totalTokens,
        peakDailyTokens: activityData.summary.peakDailyTokens,
        peakDailyTokensDate: activityData.summary.peakDailyTokensDate,
        currentStreakDays: activityData.summary.currentStreakDays,
        longestStreakDays: activityData.summary.longestStreakDays,
      };
      if (modelData !== null) {
        if (modelData.summary.totalCredits !== null) summary.totalCredits = modelData.summary.totalCredits;
        if (modelData.summary.averageDailyCredits !== null) {
          summary.averageDailyCredits = modelData.summary.averageDailyCredits;
        }
        if (modelData.summary.cacheHitRate !== null) summary.cacheHitRate = modelData.summary.cacheHitRate;
      }
      return {
        range,
        timeZone: timeZone ?? null,
        summary,
        models: modelData?.models ?? [],
        mcp: mcpData?.mcp ?? [],
      };
    },

    /**
     * Fetch the optional decode-speed health series. Failures (other than an
     * expired login) degrade to null so callers can hide the health section.
     * @param request - family, auth, account module, range, and time zone.
     * @returns performance series or null.
     */
    async performance({ family, auth, account, range, timeZone }) {
      // The caller may pass a range for symmetry, but the decode-speed health
      // series is always the last 7 days (and never carries a `type` query).
      void range;
      const rangeInfo = resolveUsageRange('7d', now, timeZone);
      try {
        const { body } = await requestEnvelope({
          family,
          auth,
          account,
          channel: 'monitor',
          headerName: 'authorization',
          url: buildFamilyUrl(family, MODEL_PERFORMANCE_PATH, {
            startTime: rangeInfo.startTime,
            endTime: rangeInfo.endTime,
          }),
          label: 'model-performance-day',
        });
        return normalizePerformance(body);
      } catch (error) {
        const mapped = unexpectedFailure(error);
        if (mapped.code === 'login_expired') throw mapped;
        logger?.warn?.(`bigmodelcn-balance: model-performance-day is unavailable (${mapped.code})`);
        return null;
      }
    },

    /**
     * Fetch the Coding Plan reset status from ZCode.
     * @param request - family and stored auth document.
     * @returns normalized reset status.
     */
    async resetStatus({ auth }) {
      const url = buildZcodeUrl(RESET_STATUS_PATH);
      const response = await http.request(url, {
        method: 'GET',
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: buildResetHeaders(auth, true),
      });
      const { body } = readResetResponse(response, url, 'coding-plan/reset/status', logger);
      return normalizeResetStatus(body);
    },

    /**
     * Consume one Coding Plan reset chance.
     * @param request - family, auth, wire reset type, and idempotency key.
     * @returns `{ used: true }`.
     */
    async useReset({ auth, resetType, idempotencyKey }) {
      const useType = readResetType(resetType);
      const key = readIdempotencyKey(idempotencyKey);
      const url = buildZcodeUrl(RESET_USE_PATH);
      const response = await http.request(url, {
        method: 'POST',
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: { ...buildResetHeaders(auth, true), 'content-type': 'application/json' },
        json: { idempotency_key: key, reset_type: useType },
      });
      const { body } = readResetResponse(response, url, 'coding-plan/reset/use', logger);
      const data = unwrapData(body);
      if (!isRecord(data) || data.used !== true) {
        throw new HostError('upstream_failed', 'Upstream returned an unexpected response', { status: 502 });
      }
      return { used: true };
    },

    /**
     * Request or confirm one Coding Plan reset opportunity.
     * @param request - family, auth, and idempotency key.
     * @returns granted flag and, when denied, the server retry boundary.
     */
    async requestResetOpportunity({ auth, idempotencyKey }) {
      const key = readIdempotencyKey(idempotencyKey);
      const url = buildZcodeUrl(RESET_OPPORTUNITY_PATH);
      const response = await http.request(url, {
        method: 'POST',
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: { ...buildResetHeaders(auth, true), 'content-type': 'application/json' },
        json: { idempotency_key: key },
      });
      const { body, acceptedCode } = readResetResponse(
        response,
        url,
        'coding-plan/reset/opportunity',
        logger,
        [RESET_OPPORTUNITY_DENIED_CODE],
      );
      const data = unwrapData(body);
      if (acceptedCode === RESET_OPPORTUNITY_DENIED_CODE || (isRecord(data) && data.granted === false)) {
        const nextTryAt = numberValue(data?.next_try_at) ?? numberValue(data?.nextTryAt);
        if (nextTryAt === null) {
          throw new HostError('upstream_failed', 'Upstream returned an unexpected response', { status: 502 });
        }
        return { granted: false, nextTryAt };
      }
      if (!isRecord(data) || data.granted !== true) {
        throw new HostError('upstream_failed', 'Upstream returned an unexpected response', { status: 502 });
      }
      return { granted: true, nextTryAt: null };
    },

    /**
     * Mark the Coding Plan reset history as read (no target scope header).
     * @param request - family and stored auth document.
     * @returns `{ ok: true }`.
     */
    async markResetHistoryRead({ auth }) {
      const url = buildZcodeUrl(RESET_HISTORY_READ_PATH);
      const response = await http.request(url, {
        method: 'POST',
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: buildResetHeaders(auth, false),
      });
      readResetResponse(response, url, 'coding-plan/reset/history/read', logger);
      return { ok: true };
    },
  };
}
