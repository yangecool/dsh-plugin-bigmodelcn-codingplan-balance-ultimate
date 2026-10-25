/**
 * Formatting adapter for the dedicated BigModel usage page.
 *
 * The page renders numbers, times, and countdowns exclusively through the
 * shared `format.js` helpers when they are present; each call is guarded so a
 * malformed payload or a helper mismatch degrades to a local Intl fallback
 * instead of throwing during render.
 */
import * as fmt from './format.js';
import {
  attempt,
  clampPercent,
  isNumber,
  num,
  toMs,
  tr,
  windowOf,
} from './page-helpers.js';

/** BCP 47 tags used by the Intl fallbacks. */
const LOCALE_TAGS = { zh: 'zh-CN', en: 'en-US' };

/**
 * BCP 47 tag of a plugin locale id.
 * @param locale - 'zh' | 'en' | other.
 * @returns BCP 47 tag.
 */
export function localeTag(locale) {
  return LOCALE_TAGS[locale] === 'zh' ? LOCALE_TAGS.zh : LOCALE_TAGS.en;
}

/**
 * Call one shared formatter, keeping extra arguments harmless.
 * @param name - format.js export name.
 * @param args - arguments passed to the helper.
 * @returns helper result, else null.
 */
function shared(name, ...args) {
  return attempt(() => {
    const helper = fmt[name];
    return typeof helper === 'function' ? helper(...args) : null;
  }, null);
}

/**
 * Format a number with grouping.
 * @param value - number or null.
 * @param locale - plugin locale id.
 * @returns formatted text, else an em dash placeholder.
 */
export function formatNumber(value, locale) {
  const numeric = num(value);
  if (numeric === null) {
    return '—';
  }
  const result = shared('formatNumber', numeric, locale);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  return attempt(() => new Intl.NumberFormat(localeTag(locale)).format(numeric), '—');
}

/**
 * Format a number compactly (1.2K / 3.4M).
 * @param value - number or null.
 * @param locale - plugin locale id.
 * @returns formatted text, else an em dash placeholder.
 */
export function formatCompact(value, locale) {
  const numeric = num(value);
  if (numeric === null) {
    return '—';
  }
  const result = shared('formatCompact', numeric, locale);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  return attempt(
    () =>
      new Intl.NumberFormat(localeTag(locale), {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(numeric),
    '—',
  );
}

/**
 * Format a credit amount.
 * @param value - number or null.
 * @param locale - plugin locale id.
 * @returns formatted text, else an em dash placeholder.
 */
export function formatCredits(value, locale) {
  const numeric = num(value);
  if (numeric === null) {
    return '—';
  }
  const result = shared('formatCredits', numeric, locale);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  return attempt(
    () =>
      new Intl.NumberFormat(localeTag(locale), {
        maximumFractionDigits: 2,
      }).format(numeric),
    '—',
  );
}

/**
 * Format an absolute date-time.
 * @param value - epoch milliseconds (or seconds/ISO string).
 * @param locale - plugin locale id.
 * @param options - `{ dateOnly }` to drop the time.
 * @returns formatted text, else an em dash placeholder.
 */
export function formatDateTime(value, locale, options = {}) {
  const ms = toMs(value);
  if (ms === null) {
    return '—';
  }
  const result = shared('formatDateTime', ms, locale);
  if (typeof result === 'string' && result.length > 0 && !options.dateOnly) {
    return result;
  }
  const intlOptions = options.dateOnly
    ? { month: '2-digit', day: '2-digit' }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
  return attempt(
    () => new Intl.DateTimeFormat(localeTag(locale), intlOptions).format(new Date(ms)),
    '—',
  );
}

/**
 * Format a reset timestamp.
 * @param value - epoch milliseconds.
 * @param locale - plugin locale id.
 * @param now - current epoch milliseconds.
 * @returns formatted text, else an em dash placeholder.
 */
export function formatResetAt(value, locale, now) {
  const ms = toMs(value);
  if (ms === null) {
    return '—';
  }
  const result = shared('formatResetAt', ms, locale, now);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  return formatDateTime(ms, locale);
}

/**
 * Countdown text for a duration in milliseconds.
 * @param msRemaining - milliseconds left.
 * @param t - translator.
 * @returns localized countdown, else an em dash placeholder.
 */
export function formatCountdown(msRemaining, t) {
  if (!isNumber(msRemaining)) {
    return '—';
  }
  const clamped = Math.max(0, msRemaining);
  const result = shared('countdown', clamped, t);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  const minutes = Math.floor(clamped / 60_000);
  if (minutes < 1) {
    return tr(t, 'time.lessThanMinute');
  }
  if (minutes < 60) {
    return tr(t, 'time.minutesShort', { n: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return tr(t, 'time.hoursShort', { n: hours });
  }
  return tr(t, 'time.daysShort', { n: Math.floor(hours / 24) });
}

/**
 * Percentage text such as `72%`.
 * @param percent - percentage 0..100 or null.
 * @param locale - plugin locale id.
 * @returns percentage text, else an em dash placeholder.
 */
export function formatPercentValue(percent, locale) {
  if (!isNumber(percent)) {
    return '—';
  }
  const clamped = clampPercent(percent);
  const result = shared('formatPercent', clamped, locale);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  return `${Math.round(clamped)}%`;
}

/**
 * Remaining percentage of a quota limit: shared helper first, local math after.
 * @param limit - quota limit entry.
 * @returns 0..100, else null.
 */
export function remainingPercentOf(limit) {
  const result = shared('remainingPercent', limit);
  if (isNumber(result) && Number.isFinite(result)) {
    return clampPercent(result);
  }
  return attempt(() => {
    if (!limit || typeof limit !== 'object') {
      return null;
    }
    const pct = clampPercent(num(limit.percentage));
    if (pct !== null) {
      return clampPercent(100 - pct);
    }
    const remaining = num(limit.remaining);
    const total = num(limit.number);
    return remaining !== null && total !== null && total > 0
      ? clampPercent((remaining / total) * 100)
      : null;
  }, null);
}

/**
 * Used amount of a quota limit.
 * @param limit - quota limit entry.
 * @returns used amount, else null.
 */
export function usedOf(limit) {
  const result = shared('limitUsed', limit);
  if (isNumber(result)) {
    return result;
  }
  return attempt(() => {
    if (!limit || typeof limit !== 'object') return null;
    if (isNumber(limit.currentValue)) return limit.currentValue;
    const total = num(limit.number);
    const remaining = num(limit.remaining);
    return total !== null && remaining !== null ? Math.max(0, total - remaining) : null;
  }, null);
}

/**
 * Total amount of a quota limit.
 * @param limit - quota limit entry.
 * @returns total amount, else null.
 */
export function totalOf(limit) {
  const result = shared('limitTotal', limit);
  if (isNumber(result)) {
    return result;
  }
  return limit && typeof limit === 'object' ? num(limit.number) : null;
}

/**
 * Remaining amount of a quota limit.
 * @param limit - quota limit entry.
 * @returns remaining amount, else null.
 */
export function remainingOfLimit(limit) {
  const result = shared('remainingOf', limit);
  if (isNumber(result)) {
    return result;
  }
  return attempt(() => {
    if (!limit || typeof limit !== 'object') return null;
    if (isNumber(limit.remaining)) return limit.remaining;
    const total = num(limit.number);
    const used = usedOf(limit);
    return total !== null && used !== null ? Math.max(0, total - used) : null;
  }, null);
}

/**
 * Window label of a quota limit.
 * @param limit - quota limit entry.
 * @param t - translator.
 * @returns localized window label.
 */
export function labelOfLimit(limit, t) {
  const windowName = windowOf(limit);
  if (windowName === 'fiveHour') return tr(t, 'quota.fiveHour');
  if (windowName === 'week') return tr(t, 'quota.week');
  if (windowName === 'tool') return tr(t, 'quota.tool');
  return tr(t, 'quota.other');
}

/**
 * Format a billing-cycle value for the plan card.
 * @param subscription - subscription payload.
 * @param t - translator.
 * @returns localized cycle text, else null.
 */
export function billingCycleText(subscription, t) {
  if (!subscription || typeof subscription !== 'object') {
    return null;
  }
  if (subscription.autoRenew === true) {
    return tr(t, 'page.planAutoRenew');
  }
  if (subscription.autoRenew === false) {
    return tr(t, 'page.planManualRenew');
  }
  if (typeof subscription.billingCycle === 'string' && subscription.billingCycle.trim().length > 0) {
    return subscription.billingCycle.trim();
  }
  return null;
}
