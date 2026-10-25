/**
 * External destinations of the dedicated usage page.
 *
 * The Host owns the origin constants; the Client only needs the human-facing
 * website URLs. A user-configured `config.usagePageUrl` wins when it is a valid
 * http(s) URL, otherwise the family default applies. Opening is guarded because
 * the page may render in environments without a browser window object.
 */
import { familyId } from './page-helpers.js';

/** Website usage pages per service family. */
export const FAMILY_USAGE_URLS = Object.freeze({
  bigmodel: 'https://bigmodel.cn/coding-plan/personal/usage',
  zai: 'https://z.ai/manage-apikey/coding-plan/personal/usage',
});

/** Coding Plan product pages per service family. */
export const FAMILY_PLAN_URLS = Object.freeze({
  bigmodel: 'https://bigmodel.cn/coding-plan',
  zai: 'https://z.ai/manage-apikey/coding-plan',
});

/**
 * Whether a value is a valid absolute http(s) URL.
 * @param value - candidate URL string.
 * @returns true when the value can be opened safely.
 */
export function isSafeUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    // Relative or malformed input is not an external destination.
    return false;
  }
}

/**
 * Website usage page of the configured family.
 * @param config - plugin config snapshot (may be null).
 * @returns absolute URL string.
 */
export function usageUrlFor(config) {
  const custom = config && typeof config === 'object' ? config.usagePageUrl : null;
  if (isSafeUrl(custom)) {
    return custom.trim();
  }
  return FAMILY_USAGE_URLS[familyId(config && config.family)];
}

/**
 * Coding Plan product page of a family.
 * @param family - 'bigmodel' | 'zai' | other.
 * @returns absolute URL string.
 */
export function planUrlFor(family) {
  return FAMILY_PLAN_URLS[familyId(family)];
}

/**
 * Open an external destination in a new tab, ignoring a missing window or a
 * blocked popup (callers also render a plain link when the URL is important).
 * @param url - absolute URL.
 * @returns nothing.
 */
export function openExternal(url) {
  if (!isSafeUrl(url)) {
    return;
  }
  try {
    if (typeof window === 'undefined' || window === null) {
      return;
    }
    window.open(url, '_blank', 'noopener');
  } catch {
    // A blocked popup is not an error the page can recover from; the visible
    // fallback link remains available next to the action.
  }
}
