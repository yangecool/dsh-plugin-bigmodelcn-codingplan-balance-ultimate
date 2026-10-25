/**
 * Pure formatting helpers shared by the usage page and the composer widget.
 *
 * Locale arguments accept a dictionary locale id (`'zh'` | `'en'`), a BCP 47
 * tag (`'zh-CN'`), or nothing (English). Helpers never embed UI copy: numeric
 * helpers return `''` for missing values, and the time helpers only add
 * translated fragments supplied by the caller's `t`.
 */

/** Maximum number of fraction digits `formatPercent` accepts. */
const MAX_PERCENT_DIGITS = 3;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/**
 * Values at or above this threshold are absolute epoch milliseconds rather
 * than a direct duration: 1e12 ms is 2001-09-09, older than any real timestamp
 * this plugin handles and larger than any countdown it renders.
 */
const EPOCH_MS_THRESHOLD = 1e12;
const LOCALE_TAGS = Object.freeze({ zh: 'zh-CN', en: 'en-US' });
const numberFormats = new Map();

/** Map a dictionary locale id or BCP 47 tag to an Intl locale tag. */
function localeTag(locale) {
  if (typeof locale === 'string' && locale !== '') {
    const lower = locale.toLowerCase();
    if (lower === 'zh' || lower.startsWith('zh-')) return LOCALE_TAGS.zh;
    if (lower === 'en' || lower.startsWith('en-')) return LOCALE_TAGS.en;
    return locale;
  }
  return LOCALE_TAGS.en;
}

/** Read the dictionary locale id a formatter output is intended for. */
function dictionaryLocale(locale) {
  return localeTag(locale) === LOCALE_TAGS.zh ? 'zh' : 'en';
}

/** Cached Intl.NumberFormat factory; the option key bounds the cache. */
function numberFormat(locale, options) {
  const tag = localeTag(locale);
  const key = `${tag}:${options.notation ?? 'standard'}:${options.maximumFractionDigits ?? 0}`;
  let format = numberFormats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(tag, options);
    numberFormats.set(key, format);
  }
  return format;
}

/** Coerce a number or numeric string to a finite number, or null. */
function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

/** Clamp a number into [min, max]; non-finite input maps to min. */
function clamp(value, min, max) {
  const numeric = finiteNumber(value);
  if (numeric === null) return min;
  return Math.max(min, Math.min(max, numeric));
}

/** Resolve `ms` (epoch ms, Date, or date string) to a valid Date, or null. */
function toDate(ms) {
  if (ms instanceof Date) return Number.isNaN(ms.getTime()) ? null : ms;
  const numeric = finiteNumber(ms);
  if (numeric === null) return null;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Normalize the overloaded `formatPercent(value, locale|digits, digits|locale)`
 * call forms so callers can pass a locale, a digit count, or both in either
 * order without crashing.
 * @returns resolved locale and fraction digits.
 */
function percentArguments(localeOrDigits, digitsOrLocale) {
  let locale = 'en';
  let digits = 0;
  if (localeOrDigits !== null && typeof localeOrDigits === 'object') {
    locale = typeof localeOrDigits.locale === 'string' ? localeOrDigits.locale : locale;
    digits = finiteNumber(localeOrDigits.digits) ?? 0;
    return { locale, digits };
  }
  if (typeof localeOrDigits === 'number') {
    digits = localeOrDigits;
    if (typeof digitsOrLocale === 'string') locale = digitsOrLocale;
    return { locale, digits };
  }
  if (typeof localeOrDigits === 'string') locale = localeOrDigits;
  if (typeof digitsOrLocale === 'number') digits = digitsOrLocale;
  else if (digitsOrLocale !== null && typeof digitsOrLocale === 'object') digits = finiteNumber(digitsOrLocale.digits) ?? 0;
  return { locale, digits };
}

/**
 * Format a percentage in the 0..100 range.
 * @param value - percentage value; out-of-range values clamp, non-finite values render as ''.
 * @param localeOrDefault - locale id/tag, a fraction-digit count, or `{ locale, digits }`.
 * @param digitsOrLocale - the other operand of the overloaded call form.
 * @returns e.g. `'72%'` / `'72.5%'`; `''` when the value is not finite.
 */
export function formatPercent(value, localeOrDefault = 'en', digitsOrLocale = 0) {
  const numeric = finiteNumber(value);
  if (numeric === null) return '';
  const { locale, digits } = percentArguments(localeOrDefault, digitsOrLocale);
  const fractionDigits = Math.round(clamp(digits, 0, MAX_PERCENT_DIGITS));
  return `${numberFormat(locale, { maximumFractionDigits: fractionDigits }).format(clamp(numeric, 0, 100))}%`;
}

/**
 * Remaining percentage of a quota limit.
 * The upstream `percentage` field is the USED ratio, so it is inverted here.
 * @param limit - quota limit from the overview (`percentage` is used ratio).
 * @returns remaining percentage in 0..100; 0 when no usable field exists.
 */
export function remainingPercent(limit) {
  if (limit === null || typeof limit !== 'object') return 0;
  const usedPercentage = finiteNumber(limit.percentage);
  if (usedPercentage !== null) return clamp(100 - usedPercentage, 0, 100);
  const total = limitTotal(limit);
  if (total > 0) return clamp((remainingOf(limit) / total) * 100, 0, 100);
  return 0;
}

/**
 * Format an integer count with locale grouping.
 * @param value - number; non-finite values render as ''.
 * @param locale - locale id/tag.
 * @returns e.g. `'1,234'`.
 */
export function formatNumber(value, locale = 'en') {
  const numeric = finiteNumber(value);
  if (numeric === null) return '';
  return numberFormat(locale, { maximumFractionDigits: 0 }).format(numeric);
}

/**
 * Format a count with Intl compact notation.
 * @param value - number; non-finite values render as ''.
 * @param locale - locale id/tag.
 * @returns e.g. `'1.2K'` (en) or `'1.2万'` (zh).
 */
export function formatCompact(value, locale = 'en') {
  const numeric = finiteNumber(value);
  if (numeric === null) return '';
  return numberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(numeric);
}

/**
 * Format a credit amount with up to two fraction digits.
 * @param value - credit amount; non-finite values render as ''.
 * @param locale - locale id/tag.
 * @param unit - optional unit suffix supplied by the caller (e.g. `'credits'`).
 * @returns e.g. `'12.35'` or `'12.35 credits'`.
 */
export function formatCredits(value, locale = 'en', unit = '') {
  const numeric = finiteNumber(value);
  if (numeric === null) return '';
  const body = numberFormat(locale, { maximumFractionDigits: 2 }).format(numeric);
  return typeof unit === 'string' && unit !== '' ? `${body} ${unit}` : body;
}

/**
 * Format a full date and time.
 * @param ms - epoch milliseconds (or Date).
 * @param locale - locale id/tag.
 * @returns a locale date + time string; `''` when the value is not a date.
 */
export function formatDateTime(ms, locale = 'en') {
  const date = toDate(ms);
  if (date === null) return '';
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

/**
 * Format a quota reset moment.
 * Same-day resets render as time only (`HH:mm`); other days add the date, and
 * a different year adds the year. Callers prepend `t('time.today')` when they
 * want the relative day word.
 * @param ms - epoch milliseconds (or Date) of the reset.
 * @param locale - locale id/tag.
 * @param now - reference time in epoch milliseconds (defaults to `Date.now()`).
 * @returns a locale date/time string; `''` when the value is not a date.
 */
export function formatResetAt(ms, locale = 'en', now = Date.now()) {
  const date = toDate(ms);
  if (date === null) return '';
  const reference = toDate(now) ?? new Date();
  const sameDay = date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat(localeTag(locale), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  }
  const options = {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  };
  if (date.getFullYear() !== reference.getFullYear()) options.year = 'numeric';
  return new Intl.DateTimeFormat(localeTag(locale), options).format(date);
}

/**
 * Format the time until a reset.
 * Accepts either an absolute timestamp (`nextResetTime`) or a remaining
 * duration in milliseconds; values below {@link EPOCH_MS_THRESHOLD} are read
 * as durations. The caller supplies `t` so every fragment is localized.
 * @param target - absolute epoch ms or remaining duration ms.
 * @param t - translate function returning `time.*` fragments.
 * @param now - reference time in epoch milliseconds (defaults to `Date.now()`).
 * @returns e.g. `'2 hr 30 min'`, or the `time.resetDue` fragment when due.
 */
export function countdown(target, t, now = Date.now()) {
  const translate = typeof t === 'function' ? t : (key) => key;
  const numeric = finiteNumber(target);
  if (numeric === null) return '';
  const reference = finiteNumber(now) ?? Date.now();
  const remaining = numeric >= EPOCH_MS_THRESHOLD ? numeric - reference : numeric;
  if (remaining <= 0) return translate('time.resetDue');
  const days = Math.floor(remaining / DAY_MS);
  const hours = Math.floor((remaining % DAY_MS) / HOUR_MS);
  const minutes = Math.ceil((remaining % HOUR_MS) / MINUTE_MS);
  if (days > 0) {
    const parts = [translate('time.daysShort', { n: days })];
    if (hours > 0) parts.push(translate('time.hoursShort', { n: hours }));
    return parts.join(' ');
  }
  if (hours > 0) {
    const parts = [translate('time.hoursShort', { n: hours })];
    const rest = Math.min(minutes, 59);
    if (rest > 0) parts.push(translate('time.minutesShort', { n: rest }));
    return parts.join(' ');
  }
  return translate('time.minutesShort', { n: Math.max(1, minutes) });
}

/** Candidate dictionary keys for one quota window, most specific first. */
const WINDOW_KEY_CANDIDATES = Object.freeze({
  fiveHour: ['time.windowFiveHour', 'quota.windowFiveHour', 'page.windowFiveHour', 'widget.windowFiveHour'],
  week: ['time.windowWeek', 'quota.windowWeek', 'page.windowWeek', 'widget.windowWeek'],
  tool: ['time.windowTool', 'quota.windowTool', 'page.windowTool', 'widget.windowTool'],
  other: ['time.windowOther', 'quota.windowOther', 'page.windowOther', 'widget.windowOther'],
});

/**
 * Classify a quota limit into a display window.
 * The Host normalizer sets `window`; type/unit fallbacks keep older payloads
 * and the ZCode vocabulary (`TIME_LIMIT` tool quota, unit 3 five-hour,
 * unit 6 weekly) readable.
 * @returns `'fiveHour' | 'week' | 'tool' | 'other'`.
 */
export function resolveWindow(limit) {
  if (limit === null || typeof limit !== 'object') return 'other';
  const window = typeof limit.window === 'string' ? limit.window : '';
  if (window === 'fiveHour' || window === 'week' || window === 'tool') return window;
  if (window === 'other') return 'other';
  const type = typeof limit.type === 'string' ? limit.type.toUpperCase() : '';
  if (type === 'TIME_LIMIT') return 'tool';
  const unit = finiteNumber(limit.unit);
  if (unit === 3) return 'fiveHour';
  if (unit === 6) return 'week';
  return 'other';
}

/**
 * Localized label of a quota window.
 * @param limit - quota limit from the overview.
 * @param t - translate function covering the core `time.window*` keys.
 * @returns the first dictionary value that is not an unresolved key echo.
 */
export function windowLabel(limit, t) {
  const translate = typeof t === 'function' ? t : (key) => key;
  const candidates = WINDOW_KEY_CANDIDATES[resolveWindow(limit)] ?? WINDOW_KEY_CANDIDATES.other;
  for (const key of candidates) {
    const value = translate(key);
    if (typeof value === 'string' && value !== '' && value !== key) return value;
  }
  return translate(candidates[0]);
}

/**
 * Used amount of a quota limit, preferring the upstream total/remaining pair.
 * @param limit - quota limit from the overview.
 * @returns used amount (0 when no usable field exists).
 */
export function limitUsed(limit) {
  if (limit === null || typeof limit !== 'object') return 0;
  const total = finiteNumber(limit.number);
  const remaining = finiteNumber(limit.remaining);
  if (total !== null && remaining !== null) return Math.max(0, total - remaining);
  const usage = finiteNumber(limit.usage);
  if (usage !== null) return Math.max(0, usage);
  const percentage = finiteNumber(limit.percentage);
  if (total !== null && percentage !== null) return Math.max(0, (total * percentage) / 100);
  const current = finiteNumber(limit.currentValue);
  return current !== null ? Math.max(0, current) : 0;
}

/**
 * Total amount of a quota limit (`number`, or used + remaining).
 * @param limit - quota limit from the overview.
 * @returns total amount (0 when no usable field exists).
 */
export function limitTotal(limit) {
  if (limit === null || typeof limit !== 'object') return 0;
  const total = finiteNumber(limit.number);
  if (total !== null) return total;
  const used = finiteNumber(limit.usage) ?? finiteNumber(limit.currentValue);
  const remaining = finiteNumber(limit.remaining);
  return used !== null && remaining !== null ? used + remaining : 0;
}

/**
 * Remaining amount of a quota limit (`remaining`, else total - used).
 * @param limit - quota limit from the overview.
 * @returns remaining amount (0 when no usable field exists).
 */
export function remainingOf(limit) {
  if (limit === null || typeof limit !== 'object') return 0;
  const remaining = finiteNumber(limit.remaining);
  if (remaining !== null) return Math.max(0, remaining);
  const total = limitTotal(limit);
  if (total > 0) return Math.max(0, total - limitUsed(limit));
  return 0;
}

/**
 * Convert a millisecond duration to whole minutes.
 * @param ms - duration in milliseconds.
 * @returns rounded-up minutes; 0 for non-positive or non-finite input.
 */
export function durationMinutes(ms) {
  const numeric = finiteNumber(ms);
  if (numeric === null || numeric <= 0) return 0;
  return Math.max(1, Math.round(numeric / MINUTE_MS));
}

/**
 * Format how long ago a moment was.
 * @param ms - past epoch milliseconds (or Date).
 * @param t - translate function covering `state.justNow`/`state.*Ago`.
 * @param now - reference time in epoch milliseconds (defaults to `Date.now()`).
 * @returns a localized relative string; `''` when the input is not a date.
 */
export function formatRelative(ms, t, now = Date.now()) {
  const date = toDate(ms);
  const translate = typeof t === 'function' ? t : (key) => key;
  if (date === null) return '';
  const reference = finiteNumber(now) ?? Date.now();
  const elapsed = Math.max(0, reference - date.getTime());
  if (elapsed < MINUTE_MS) return translate('state.justNow');
  const minutes = Math.round(elapsed / MINUTE_MS);
  if (minutes < 60) return translate('state.minutesAgo', { n: minutes });
  const hours = Math.round(elapsed / HOUR_MS);
  if (hours < 24) return translate('state.hoursAgo', { n: hours });
  return translate('state.daysAgo', { n: Math.max(1, Math.round(elapsed / DAY_MS)) });
}

/**
 * Dictionary locale id a formatter should use for a given locale argument.
 * @param locale - locale id/tag or nothing.
 * @returns `'zh'` or `'en'`.
 */
export function formatLocaleId(locale) {
  return dictionaryLocale(locale);
}
