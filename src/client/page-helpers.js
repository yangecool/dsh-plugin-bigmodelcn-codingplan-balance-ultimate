/**
 * Pure defensive helpers for the dedicated BigModel usage page.
 *
 * Every Host payload field can be missing or malformed while caches are being
 * filled, so this module never throws on adversarial values: it coerces to
 * `null` instead. It has no imports and no side effects, which also makes it
 * directly unit-testable under plain Node.
 */

/** Epoch-millisecond lower bound used to tell seconds from milliseconds apart. */
const MS_THRESHOLD = 100_000_000_000; // ~1973 in milliseconds, ~5138 in seconds

/**
 * Whether a value is a usable finite number.
 * @param value - candidate.
 * @returns true when `value` is a finite number.
 */
export function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Coerce a value to a finite number.
 * @param value - number-like candidate (numbers only; strings are ignored so a
 *   locale-formatted text never becomes a number).
 * @returns the finite number, else null.
 */
export function num(value) {
  return isNumber(value) ? value : null;
}

/**
 * Coerce an upstream timestamp to epoch milliseconds.
 *
 * Host normalizers emit milliseconds, but raw payloads may carry seconds or an
 * ISO string; the threshold heuristic keeps both readable.
 * @param value - epoch seconds/milliseconds, Date, or ISO date string.
 * @returns epoch milliseconds, else null.
 */
export function toMs(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!isNumber(value) || value <= 0) {
    return null;
  }
  return value < MS_THRESHOLD ? value * 1000 : value;
}

/**
 * Clamp a percentage into 0..100.
 * @param value - numeric percentage candidate.
 * @returns clamped percentage, else null.
 */
export function clampPercent(value) {
  if (!isNumber(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, value));
}

/**
 * Run a producer, returning a fallback instead of throwing.
 * @param producer - zero-argument function.
 * @param fallback - value returned when the producer throws.
 * @returns the produced value or the fallback.
 */
export function attempt(producer, fallback = null) {
  try {
    return producer();
  } catch {
    // Render-path helpers must not blank the whole page; a bad field degrades to fallback.
    return fallback;
  }
}

/**
 * Text of a translated key, tolerating a broken or missing translator.
 * @param t - translator from slot props (may be absent).
 * @param key - dictionary key.
 * @param params - placeholder values.
 * @returns translated text, a placeholder-free translation, or the key itself.
 */
export function tr(t, key, params) {
  if (typeof t !== 'function') {
    return key;
  }
  const translated = attempt(() => t(key, params), null);
  if (typeof translated === 'string' && translated.length > 0) {
    return translated;
  }
  const bare = attempt(() => t(key), null);
  return typeof bare === 'string' && bare.length > 0 ? bare : key;
}

/**
 * Class-name joiner that drops empty entries.
 * @param names - class names, may be falsy.
 * @returns the space-joined class string.
 */
export function cls(...names) {
  return names.filter((name) => typeof name === 'string' && name.length > 0).join(' ');
}

/**
 * Normalize the quota window of a limit entry.
 *
 * The Host emits `window`, but the raw BigModel payload identifies windows by
 * `type`/`unit`, so both are accepted.
 * @param limit - quota limit entry.
 * @returns 'fiveHour' | 'week' | 'tool' | 'other'.
 */
export function windowOf(limit) {
  const raw = limit && typeof limit === 'object' ? limit.window : null;
  if (raw === 'fiveHour' || raw === 'week' || raw === 'tool') {
    return raw;
  }
  const type = limit && typeof limit === 'object' ? limit.type : null;
  if (typeof type === 'string' && type.toUpperCase() === 'TIME_LIMIT') {
    return 'tool';
  }
  const unit = limit && typeof limit === 'object' ? num(limit.unit) : null;
  if (unit === 3) {
    return 'fiveHour';
  }
  if (unit === 6) {
    return 'week';
  }
  return 'other';
}

/**
 * Window order used when rendering quota cards.
 * @param windowName - normalized window.
 * @returns sort weight.
 */
export function windowOrder(windowName) {
  if (windowName === 'fiveHour') return 0;
  if (windowName === 'week') return 1;
  if (windowName === 'tool') return 2;
  return 3;
}

/**
 * Remaining percentage derived from a limit entry without the shared helper.
 * @param limit - quota limit entry.
 * @returns 0..100, else null.
 */
export function fallbackRemainingPercent(limit) {
  if (!limit || typeof limit !== 'object') {
    return null;
  }
  const percentage = clampPercent(num(limit.percentage));
  if (percentage !== null) {
    return clampPercent(100 - percentage);
  }
  const remaining = num(limit.remaining);
  const total = num(limit.number);
  if (remaining !== null && total !== null && total > 0) {
    return clampPercent((remaining / total) * 100);
  }
  return null;
}

/**
 * Remaining amount derived from a limit entry.
 * @param limit - quota limit entry.
 * @returns remaining amount, else null.
 */
export function fallbackRemainingOf(limit) {
  if (!limit || typeof limit !== 'object') {
    return null;
  }
  if (isNumber(limit.remaining)) {
    return limit.remaining;
  }
  const total = num(limit.number);
  const used = num(limit.currentValue);
  if (total !== null && used !== null) {
    return Math.max(0, total - used);
  }
  return null;
}

/**
 * Used amount derived from a limit entry.
 * @param limit - quota limit entry.
 * @returns used amount, else null.
 */
export function fallbackUsedOf(limit) {
  if (!limit || typeof limit !== 'object') {
    return null;
  }
  if (isNumber(limit.currentValue)) {
    return limit.currentValue;
  }
  const total = num(limit.number);
  const remaining = num(limit.remaining);
  if (total !== null && remaining !== null) {
    return Math.max(0, total - remaining);
  }
  return null;
}

/**
 * Total amount derived from a limit entry.
 * @param limit - quota limit entry.
 * @returns total amount, else null.
 */
export function fallbackTotalOf(limit) {
  return limit && typeof limit === 'object' ? num(limit.number) : null;
}

/**
 * Tone for a remaining percentage: quota turns warning/error only near the floor.
 * @param percent - remaining percentage 0..100.
 * @returns 'error' | 'warn' | 'success' | 'brand'.
 */
export function barTone(percent) {
  if (!isNumber(percent)) {
    return 'brand';
  }
  if (percent <= 5) return 'error';
  if (percent <= 20) return 'warn';
  return 'success';
}

/**
 * Share of a part in a total, clamped to 0..100.
 * @param part - partial value.
 * @param total - whole value.
 * @returns share percentage, else 0.
 */
export function shareOf(part, total) {
  const p = num(part);
  const whole = num(total);
  if (p === null || whole === null || whole <= 0) {
    return 0;
  }
  return clampPercent((p / whole) * 100) ?? 0;
}

/**
 * Family id of a config/auth object, defaulting to BigModel.
 * @param family - candidate id.
 * @returns 'bigmodel' | 'zai'.
 */
export function familyId(family) {
  return family === 'zai' ? 'zai' : 'bigmodel';
}

/**
 * Plan status of a subscription payload.
 * @param subscription - subscription object or null.
 * @returns 'active' | 'expired' | 'none'.
 */
export function planStatusOf(subscription) {
  if (!subscription || typeof subscription !== 'object') {
    return 'none';
  }
  if (subscription.active === true) {
    return 'active';
  }
  if (subscription.active === false) {
    return 'expired';
  }
  const status = typeof subscription.status === 'string' ? subscription.status.toLowerCase() : '';
  if (status === 'active' || status === 'enabled' || status === 'valid') {
    return 'active';
  }
  if (status.length > 0) {
    return 'expired';
  }
  return 'none';
}

/**
 * Display name of the signed-in user, preferring the richest available field.
 * @param user - OAuth user object.
 * @param account - BigModel account object.
 * @returns display name, else ''.
 */
export function displayNameOf(user, account) {
  const candidates = [
    user && user.displayName,
    user && user.name,
    user && user.nickName,
    user && user.username,
    user && user.userName,
    user && user.email,
    account && account.customerName,
    account && account.nickName,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return '';
}

/**
 * Avatar URL of the signed-in user.
 * @param user - OAuth user object.
 * @param account - BigModel account object.
 * @returns URL string, else null.
 */
export function avatarOf(user, account) {
  const candidates = [
    user && user.avatar,
    user && user.avatarUrl,
    user && user.avatar_url,
    user && user.picture,
    account && account.avatar,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^(https?:)?\/\//.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Initials for the avatar fallback. One character for CJK names, two for Latin.
 * @param name - display name.
 * @returns 1-2 uppercase characters, else '?'.
 */
export function initialsOf(name) {
  if (typeof name !== 'string') {
    return '?';
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return '?';
  }
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(trimmed)) {
    return trimmed.slice(0, 1);
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Point label of a usage series entry.
 * @param point - series point with `date` or `time`.
 * @param granularity - 'hour' | 'day' | other.
 * @returns short axis label, else ''.
 */
export function pointLabel(point, granularity) {
  if (!point || typeof point !== 'object') {
    return '';
  }
  const raw = [point.date, point.time, point.label, point.startTime].find(
    (candidate) => typeof candidate === 'string' && candidate.length > 0,
  );
  if (typeof raw !== 'string') {
    return '';
  }
  const dayMatch = /^\d{4}-\d{2}-\d{2}/.exec(raw);
  if (dayMatch && granularity !== 'hour') {
    return raw.slice(5, 10);
  }
  const timePart = raw.includes(' ') ? raw.split(' ')[1] : raw;
  if (typeof timePart === 'string' && /^\d{1,2}:\d{2}/.test(timePart)) {
    return timePart.slice(0, 5);
  }
  return dayMatch ? raw.slice(5, 10) : raw.slice(0, 10);
}

/**
 * Token value of a usage series entry.
 * @param point - series point.
 * @returns finite token count, else 0.
 */
export function tokensOf(point) {
  if (!point || typeof point !== 'object') {
    return 0;
  }
  const value = num(point.tokens);
  return value !== null && value > 0 ? value : 0;
}

/**
 * Indices of the axis labels to render under the chart.
 * @param count - number of data points.
 * @param maxLabels - maximum number of labels.
 * @returns ascending unique indices.
 */
export function labelIndices(count, maxLabels = 6) {
  if (!isNumber(count) || count <= 0) {
    return [];
  }
  const total = Math.floor(count);
  const wanted = Math.max(1, Math.min(Math.floor(maxLabels), total));
  if (wanted === 1) {
    return [0];
  }
  const indices = new Set();
  for (let step = 0; step < wanted; step += 1) {
    indices.add(Math.round((step * (total - 1)) / (wanted - 1)));
  }
  return [...indices].sort((a, b) => a - b);
}

/**
 * Slice the series to the most recent points the chart can show usefully.
 * @param series - usage series array.
 * @param maxPoints - cap, defaults to 40.
 * @returns point array (may be empty).
 */
export function seriesPoints(series, maxPoints = 40) {
  if (!Array.isArray(series)) {
    return [];
  }
  const points = series.filter((point) => point && typeof point === 'object');
  return points.length > maxPoints ? points.slice(points.length - maxPoints) : points;
}

/**
 * Layout of a bar chart drawn in a 0..100 × 0..100 SVG view box.
 *
 * The SVG stretches with `preserveAspectRatio="none"`; keeping coordinates in
 * percent avoids measuring the container in JavaScript.
 * @param points - usage series points (already sliced).
 * @returns `{ max, bars }` where each bar has x/width/height/value/index.
 */
export function chartGeometry(points) {
  const count = points.length;
  if (count === 0) {
    return { max: 0, bars: [] };
  }
  const values = points.map(tokensOf);
  const max = Math.max(...values);
  const slot = 100 / count;
  const width = Math.max(slot * 0.62, Math.min(slot * 0.9, slot - 0.4));
  const bars = values.map((value, index) => {
    const ratio = max > 0 ? value / max : 0;
    const height = ratio * 96; // 4 units of headroom above the tallest bar
    return {
      index,
      value,
      x: index * slot + (slot - width) / 2,
      y: 100 - height,
      width,
      height,
    };
  });
  return { max, bars };
}

/**
 * Parse the provider-gate text field into provider ids.
 * @param text - comma-separated input.
 * @returns trimmed unique ids.
 */
export function splitProviderIds(text) {
  if (typeof text !== 'string') {
    return [];
  }
  const seen = new Set();
  for (const part of text.split(',')) {
    const id = part.trim();
    if (id.length > 0) {
      seen.add(id);
    }
  }
  return [...seen];
}

/**
 * Join provider ids for the text field.
 * @param ids - provider id array.
 * @returns comma-and-space joined text.
 */
export function joinProviderIds(ids) {
  if (!Array.isArray(ids)) {
    return '';
  }
  return ids.filter((id) => typeof id === 'string' && id.trim().length > 0).join(', ');
}

/**
 * Validate the refresh-interval field.
 * @param text - input value.
 * @returns `{ ok, value }` with minutes 1..1440 when valid.
 */
export function parseRefreshMinutes(text) {
  const raw = typeof text === 'number' ? String(text) : text;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, value: null };
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, value: null };
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    return { ok: false, value: null };
  }
  return { ok: true, value };
}

/**
 * Normalize a usage range id to one of the supported values.
 * @param range - candidate range id.
 * @param supported - supported ids.
 * @param fallback - id returned when unsupported.
 * @returns supported range id.
 */
export function normalizeRange(range, supported = ['today', '7d', '30d'], fallback = 'today') {
  return supported.includes(range) ? range : fallback;
}

/**
 * Map a Host error code to a page dictionary key.
 * @param code - stable Host error code.
 * @returns dictionary key.
 */
export function errorDictKey(code) {
  switch (code) {
    case 'not_logged_in':
      return 'page.errorNotLoggedIn';
    case 'login_expired':
      return 'page.errorLoginExpired';
    case 'no_coding_plan':
      return 'page.errorNoPlan';
    case 'no_project':
      return 'page.errorNoProject';
    case 'upstream_failed':
      return 'page.errorUpstream';
    case 'upstream_timeout':
      return 'page.errorTimeout';
    case 'network_error':
      return 'page.errorNetwork';
    case 'rate_limited':
      return 'page.errorUpstream';
    default:
      return 'page.errorUnknown';
  }
}

/**
 * Error code of a rejected store action.
 * @param error - thrown value.
 * @returns stable code string, else ''.
 */
export function errorCodeOf(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    return error.code;
  }
  return '';
}

/**
 * Format an error payload for a Notice body.
 * @param error - `{ code, message }` style payload.
 * @param t - translator.
 * @returns localized message.
 */
export function errorTextOf(error, t) {
  const code = errorCodeOf(error) || (error && typeof error === 'object' ? error.code : '');
  return tr(t, code ? errorDictKey(code) : 'page.errorUnknown');
}
