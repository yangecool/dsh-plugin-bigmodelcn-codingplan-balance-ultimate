/**
 * Composer remaining-quota trigger and floating popover.
 *
 * The trigger lives in `conversation.input.right`, right beside the model
 * selector: two thin meters (5-hour window and weekly window) with their
 * remaining percentages, a "Sign in" chip while logged out, or a quiet warning
 * dot when the quota cannot be read. Clicking it opens a fixed-position
 * popover rendered inline in the trigger wrapper (never appended to
 * `document.body`), anchored above the trigger from its bounding rect and
 * clamped to the viewport. Countdowns re-render every 30 seconds.
 *
 * Everything here is written defensively: this component occupies a composer
 * slot, and a render-time exception would blank the composer row. All copy goes
 * through `t` from {@link indicatorDicts}; all colors go through
 * `--dsw-alias-*` theme tokens.
 */

import { rt } from './runtime.js';
import { state } from './state.js';
import { useLocalized, useNow, useSnapshot } from './hooks.js';
import {
  countdown, formatCompact, formatDateTime, formatPercent, formatRelative, limitTotal, remainingOf,
  remainingPercent, resolveWindow,
} from './format.js';
import { Bar, Button, EmptyState, Icon, IconButton, Notice, Spinner } from './ui.js';

/** Main panel key of the plugin's dedicated usage page (`main` slot). */
const PANEL_ID = 'bigmodelcn-usage';

/** Countdown / relative-time cadence; matches the store ticker in entry.js. */
const TICK_MS = 30_000;

/** Minimum distance between the popover and any viewport edge. */
const VIEWPORT_MARGIN = 8;

/** Vertical distance between the trigger and the popover. */
const POPOVER_GAP = 8;

/** Nominal popover width; the actual width shrinks on narrow viewports. */
const POPOVER_WIDTH = 352;

/** Upper bound for the popover height (contract: `min(70vh, 520px)`). */
const POPOVER_MAX_HEIGHT = 520;

/** Family-specific public usage pages, used when config overrides nothing. */
const FAMILY_USAGE_PAGES = Object.freeze({
  bigmodel: 'https://bigmodel.cn/coding-plan/personal/usage',
  zai: 'https://z.ai/manage-apikey/coding-plan/personal/usage',
});

/** @returns {import('react').ReactElement} element built through the bound runtime. */
function h(...args) {
  return rt.h(...args);
}

/** Identity translate used only if a slot ever omits `t`; keeps render total. */
function passthroughTranslate(key) {
  return key;
}

/** @returns {boolean} whether `value` is a non-array object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @returns {unknown[]} a defensive array view of `value`. */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** @returns {number|null} `value` when it is a finite number. */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @returns {number|null} `value` clamped to the 0..100 percentage range. */
function clampPercent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.min(100, number));
}

/**
 * Convert an upstream timestamp (epoch ms, epoch seconds, or an ISO/date
 * string) to epoch milliseconds.
 * @returns {number|null} epoch milliseconds, or null when unparseable.
 */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return toMs(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Compact a quantity for the narrow popover cells.
 * @returns {string|null} compact number text, or null when not a finite number.
 */
function compactNumber(value, locale) {
  if (finiteNumber(value) === null) return null;
  const text = formatCompact(value, locale);
  return typeof text === 'string' && text !== '' ? text : null;
}

/** @returns {string} remaining-percentage text (`72%`, `<1%`, or the dash placeholder). */
function percentText(percent, locale, t) {
  const value = clampPercent(percent);
  if (value === null) return t('widget.value.dash');
  if (value > 0 && value < 1) return t('widget.value.underOnePercent');
  return formatPercent(value, locale, 0);
}

/** @returns {'brand'|'warn'|'error'|'idle'} shared `Bar` tone for a remaining percentage. */
function toneOf(percent) {
  const value = clampPercent(percent);
  if (value === null) return 'idle';
  if (value < 5) return 'error';
  if (value < 20) return 'warn';
  return 'brand';
}

/** @returns {string} text color class for a remaining percentage. */
function textToneClass(percent) {
  const tone = toneOf(percent);
  if (tone === 'error') return ' bmc-widget-text-error';
  if (tone === 'warn') return ' bmc-widget-text-warn';
  return '';
}

/**
 * Remaining percentage of one normalized quota limit; null when the limit is
 * absent so the widget can show its unknown state.
 * @returns {number|null} remaining percent, or null when the limit is unknown.
 */
function remainingPercentOf(limit) {
  if (!isRecord(limit)) return null;
  const value = remainingPercent(limit);
  return Number.isFinite(value) ? value : null;
}

/**
 * Group the overview's quota limits into the windows the widget renders.
 * Unclassified limits still surface as compact rows instead of disappearing.
 * @returns {{fiveHour: object|null, week: object|null, extras: object[]}} limits by window.
 */
function limitsOf(overview) {
  const quota = isRecord(overview) && isRecord(overview.quota) ? overview.quota : null;
  const limits = quota === null ? [] : asArray(quota.limits);
  const grouped = { fiveHour: null, week: null, extras: [] };
  for (const limit of limits) {
    if (!isRecord(limit)) continue;
    const bucket = resolveWindow(limit);
    if (bucket === 'fiveHour' && grouped.fiveHour === null) grouped.fiveHour = limit;
    else if (bucket === 'week' && grouped.week === null) grouped.week = limit;
    else grouped.extras.push({ limit, bucket });
  }
  return grouped;
}

/** @returns {string} localized label of a limit window. */
function windowLabelOf(bucket, t) {
  if (bucket === 'fiveHour') return t('widget.window.fiveHour');
  if (bucket === 'week') return t('widget.window.week');
  if (bucket === 'tool') return t('widget.window.tool');
  return t('widget.window.other');
}

/**
 * Reset countdown of one limit, rendered against the ticking `now`.
 * @returns {string} localized reset copy.
 */
function resetTextOf(limit, now, t) {
  const resetAt = toMs(isRecord(limit) ? limit.nextResetTime : null);
  if (resetAt === null) return t('widget.reset.unknown');
  const remainingMs = resetAt - now;
  if (remainingMs <= 0) return t('widget.reset.soon');
  const relative = countdown(resetAt, t, now);
  if (typeof relative !== 'string' || relative === '') return t('widget.reset.unknown');
  return t('widget.reset.in', { time: relative });
}

/** @returns {string|null} the soonest reset countdown among the primary limits. */
function nearestResetTextOf(limits, now, t) {
  let soonest = null;
  for (const limit of [limits.fiveHour, limits.week]) {
    const resetAt = toMs(isRecord(limit) ? limit.nextResetTime : null);
    if (resetAt !== null && (soonest === null || resetAt < soonest.at)) soonest = { at: resetAt, limit };
  }
  return soonest === null ? null : resetTextOf(soonest.limit, now, t);
}

/**
 * Plan title shown in the popover header.
 * @returns {string} plan level, product name, or the localized fallback.
 */
function planNameOf(overview, t) {
  const subscription = isRecord(overview) && isRecord(overview.subscription) ? overview.subscription : null;
  const productName = subscription !== null && typeof subscription.productName === 'string'
    ? subscription.productName.trim()
    : '';
  if (productName !== '') return productName;
  const quota = isRecord(overview) && isRecord(overview.quota) ? overview.quota : null;
  const level = quota === null || typeof quota.level !== 'string' ? '' : quota.level.trim();
  if (level !== '') {
    return t('widget.plan.level', { level: level.charAt(0).toUpperCase() + level.slice(1) });
  }
  return t('widget.plan.fallback');
}

/** @returns {string} family id, preferring the live overview. */
function familyIdOf(snapshot, overview) {
  const candidates = [
    isRecord(overview) ? overview.family : null,
    isRecord(snapshot) && isRecord(snapshot.auth) ? snapshot.auth.family : null,
    isRecord(snapshot) && isRecord(snapshot.config) ? snapshot.config.family : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return 'bigmodel';
}

/** @returns {string} localized family label. */
function familyLabelOf(family, t) {
  if (family === 'bigmodel') return t('widget.family.bigmodel');
  if (family === 'zai') return t('widget.family.zai');
  return t('widget.family.other');
}

/** @returns {string} validated external usage page URL. */
function usagePageUrlOf(snapshot, overview) {
  const config = isRecord(snapshot) && isRecord(snapshot.config) ? snapshot.config : null;
  const override = config !== null && typeof config.usagePageUrl === 'string' ? config.usagePageUrl.trim() : '';
  if (/^https?:\/\//i.test(override)) return override;
  const family = familyIdOf(snapshot, overview);
  if (family === 'zai') return FAMILY_USAGE_PAGES.zai;
  return FAMILY_USAGE_PAGES.bigmodel;
}

/** @returns {number|null} available reset chances of one bucket, or null when unknown. */
function resetAvailableOf(reset, bucket) {
  if (!isRecord(reset)) return null;
  const entry = reset[bucket];
  if (!isRecord(entry) || !Array.isArray(entry.available)) return null;
  // Only chances whose expiry is still in the future are redeemable; expired
  // entries can linger in a cached payload and must not inflate the count.
  const now = Date.now();
  let count = 0;
  for (const chance of entry.available) {
    const expireAt = isRecord(chance) && typeof chance.expireAt === 'number' ? chance.expireAt : null;
    if (expireAt !== null && expireAt > now) count += 1;
  }
  return count;
}

/** @returns {number|null} epoch ms of the most recent successful refresh. */
function lastUpdatedMsOf(snapshot, overview) {
  const candidates = [
    isRecord(snapshot) ? snapshot.lastUpdated : null,
    isRecord(overview) ? overview.generatedAt : null,
  ];
  for (const candidate of candidates) {
    const ms = toMs(candidate);
    if (ms !== null) return ms;
  }
  return null;
}

/** @returns {string} localized "last updated" copy. */
function relativeUpdatedTextOf(lastUpdated, now, t) {
  if (lastUpdated === null) return t('widget.updated.never');
  const elapsed = Math.max(0, now - lastUpdated);
  if (elapsed < 60_000) return t('widget.updated.justNow');
  const relative = formatRelative(lastUpdated, t, now);
  if (typeof relative !== 'string' || relative === '') return t('widget.updated.never');
  return t('widget.updated', { time: relative });
}

/**
 * Call one store action without letting a missing method or a rejected promise
 * escape into the component tree.
 * @returns {Promise<unknown>} settled promise of the action result.
 */
function callState(method, ...args) {
  try {
    const target = state;
    const fn = target !== null && typeof target === 'object' && typeof target[method] === 'function'
      ? target[method]
      : null;
    if (fn === null) return Promise.resolve(undefined);
    return Promise.resolve(fn.apply(target, args)).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

/** Open an external URL in a new tab, tolerating blocked popups. */
function openExternal(url) {
  if (typeof url !== 'string' || url === '') return;
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* popup blocked: the caller keeps its other action available */
  }
}

/**
 * Start the OAuth flow through the store, then open the authorize URL.
 * @param family - configured family id passed to the store login start.
 */
function requestSignIn(family) {
  try {
    const result = typeof state.startLogin === 'function'
      ? state.startLogin({ family: typeof family === 'string' ? family : undefined })
      : null;
    Promise.resolve(result).then((authorizeUrl) => {
      if (typeof authorizeUrl === 'string' && authorizeUrl !== '') {
        openExternal(authorizeUrl);
      }
    }).catch(() => undefined);
  } catch {
    /* the store surfaces login failures through its own error state */
  }
}

/**
 * Panel-change subscription so the popover closes when the central panel
 * changes. Returns a no-op disposer when the layout service is unavailable.
 * @param onChange - callback invoked after a panel change is observed.
 * @returns {() => void} disposer.
 */
function subscribePanelChange(onChange) {
  let cleanup = null;
  try {
    const ctx = rt.ctx;
    const layout = ctx !== null && typeof ctx?.get === 'function' ? ctx.get('layout') : undefined;
    const observable = isRecord(layout) && layout.panelInfo !== null && typeof layout.panelInfo === 'object'
      ? layout.panelInfo
      : null;
    if (observable !== null && typeof observable.subscribe === 'function') {
      const read = () => {
        try {
          const info = typeof observable.getSnapshot === 'function' ? observable.getSnapshot() : null;
          return isRecord(info) ? (info.activePanelId ?? null) : null;
        } catch {
          return null;
        }
      };
      let last = read();
      const listener = () => {
        const next = read();
        if (next === last) return;
        last = next;
        onChange();
      };
      const unsubscribe = observable.subscribe(listener);
      cleanup = typeof unsubscribe === 'function' ? unsubscribe : null;
    }
  } catch {
    cleanup = null;
  }
  return () => {
    if (cleanup === null) return;
    try {
      cleanup();
    } catch {
      /* the layout service is already disposed */
    }
  };
}

/**
 * Track the current session's provider through the model directory service.
 * `available:false` means the service or session scope is unavailable, in which
 * case the provider gate must let the widget render.
 * @param sessionId - branded session id from the slot props.
 * @returns {{available: boolean, provider: string|null}} provider gate state.
 */
function useProviderGate(sessionId) {
  const React = rt.React;
  const [gate, setGate] = React.useState({ available: false, provider: null });
  React.useEffect(() => {
    let active = true;
    let unsubscribe = null;
    let store = null;
    try {
      const ctx = rt.ctx;
      const models = ctx !== null && typeof ctx?.get === 'function' ? ctx.get('modelDirectories') : undefined;
      const directory = isRecord(models) && typeof models.directoryFor === 'function' && sessionId !== undefined
        ? models.directoryFor(sessionId)
        : null;
      store = isRecord(directory) && isRecord(directory.store) ? directory.store : null;
    } catch {
      store = null;
    }
    if (store !== null && typeof store.getSnapshot === 'function') {
      const read = () => {
        if (!active) return;
        let provider = null;
        try {
          const directoryState = store.getSnapshot();
          if (isRecord(directoryState) && isRecord(directoryState.current)
            && typeof directoryState.current.provider === 'string') {
            provider = directoryState.current.provider;
          }
        } catch {
          provider = null;
        }
        setGate({ available: true, provider });
      };
      try {
        read();
        if (typeof store.subscribe === 'function') {
          const result = store.subscribe(read);
          unsubscribe = typeof result === 'function' ? result : null;
        }
      } catch {
        setGate({ available: false, provider: null });
      }
    } else {
      setGate({ available: false, provider: null });
    }
    return () => {
      active = false;
      if (unsubscribe === null) return;
      try {
        unsubscribe();
      } catch {
        /* the per-session directory is already disposed */
      }
    };
  }, [sessionId]);
  return gate;
}

/**
 * Apply the configured provider allow-list to the live provider.
 * @returns {boolean} whether the widget may render for this session.
 */
function providerAllowed(config, gate) {
  if (!isRecord(gate) || gate.available !== true) return true;
  if (typeof gate.provider !== 'string' || gate.provider === '') return true;
  const allowed = asArray(isRecord(config) ? config.providerIds : null)
    .filter((id) => typeof id === 'string' && id !== '');
  if (allowed.length === 0) return true;
  return allowed.includes(gate.provider);
}

/* ------------------------------------------------------------------ */
/* Widget sections that compose the shared primitives and add the      */
/* composer-specific layout (trigger rows, limit rows, stat cells).    */
/* ------------------------------------------------------------------ */

/** @returns {import('react').ReactElement} warning dot used for quiet error affordances. */
function WarningDot() {
  return h('span', { className: 'bmc-widget-dot', 'aria-hidden': 'true' });
}

/** @returns {import('react').ReactElement} loading placeholder lines. */
function Skeleton({ lines = 3 }) {
  const children = [];
  for (let index = 0; index < lines; index += 1) {
    children.push(h('span', { key: index, className: 'bmc-widget-skeleton-line' }));
  }
  return h('div', { className: 'bmc-widget-skeleton', 'aria-hidden': 'true' }, children);
}

/** @returns {import('react').ReactElement} inline error notice with its retry action. */
function ErrorNotice({ t, onRetry, stale }) {
  return h(Notice, {
    tone: 'error',
    title: t('widget.state.error'),
    action: h(Button, { size: 'sm', variant: 'subtle', onClick: onRetry }, t('widget.action.retry')),
  }, stale ? t('widget.state.stale') : null);
}

/** @returns {import('react').ReactElement} inline stale-data hint. */
function StaleHint({ t }) {
  return h('div', { className: 'bmc-widget-stale', role: 'status' },
    h(Icon, { name: 'warning', size: 12 }),
    h('span', null, t('widget.state.stale')),
  );
}

/** @returns {import('react').ReactElement} sign-in notice for logged-out and expired sessions. */
function SignInNotice({ t, loginExpired, login, onSignIn }) {
  const stateName = isRecord(login) && typeof login.state === 'string' ? login.state : 'idle';
  const pending = !loginExpired && (stateName === 'starting' || stateName === 'pending');
  const failed = !loginExpired && stateName === 'failed';
  const authorizeUrl = isRecord(login) && typeof login.authorizeUrl === 'string' ? login.authorizeUrl : '';
  const message = loginExpired
    ? t('widget.login.expired')
    : pending
      ? t('widget.login.pending')
      : failed
        ? t('widget.login.failed')
        : t('widget.login.loggedOut');
  let action = null;
  if (pending && authorizeUrl !== '') {
    action = h(Button, {
      size: 'sm',
      variant: 'ghost',
      onClick: () => openExternal(authorizeUrl),
    }, t('widget.action.openAuthorize'));
  } else if (!pending) {
    action = h(Button, {
      size: 'sm',
      variant: 'primary',
      onClick: onSignIn,
    }, loginExpired || failed ? t('widget.action.relogin') : t('widget.action.signIn'));
  }
  return h(Notice, {
    tone: loginExpired || failed ? 'warn' : 'info',
    title: message,
    action,
  });
}

/** @returns {import('react').ReactElement} empty state when the account has no Coding Plan. */
function NoPlanNotice({ t, usagePageUrl }) {
  return h(EmptyState, {
    icon: 'gauge',
    title: t('widget.state.noPlan'),
    body: t('widget.state.noPlanHint'),
    action: h('a', {
      className: 'bmc-widget-link',
      href: usagePageUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
    },
    t('widget.action.openUsagePage'),
    h(Icon, { name: 'external', size: 12 })),
  });
}

/** @returns {string} compact amount text, or null when the amount is unusable. */
function amountText(value, locale) {
  if (finiteNumber(value) === null || value <= 0) return null;
  return compactNumber(value, locale);
}

/** @returns {import('react').ReactElement} one primary limit bar with values and countdown. */
function LimitRow({ t, limit, bucket, now, locale }) {
  const percent = remainingPercentOf(limit);
  const total = isRecord(limit) ? limitTotal(limit) : 0;
  const totalText = amountText(total, locale);
  const remainingText = totalText === null ? null : compactNumber(remainingOf(limit), locale);
  const values = remainingText !== null && totalText !== null
    ? t('widget.limit.remainingOf', { remaining: remainingText, total: totalText })
    : t('widget.limit.unknown');
  return h('div', { className: 'bmc-widget-limit' },
    h('div', { className: 'bmc-widget-limit-head' },
      h('span', { className: 'bmc-widget-limit-label' }, windowLabelOf(bucket, t)),
      h('span', { className: `bmc-widget-limit-pct${textToneClass(percent)}` }, percentText(percent, locale, t)),
    ),
    h(Bar, { percent: percent ?? 0, tone: toneOf(percent), height: 6 }),
    h('div', { className: 'bmc-widget-limit-meta' },
      h('span', null, values),
      h('span', null, resetTextOf(limit, now, t)),
    ),
  );
}

/** @returns {string} display name of a tool/MCP or unclassified limit. */
function toolNameOf(limit, bucket, t) {
  if (bucket === 'tool') {
    const details = isRecord(limit) ? asArray(limit.usageDetails) : [];
    for (const detail of details) {
      if (isRecord(detail) && typeof detail.displayName === 'string' && detail.displayName.trim() !== '') {
        return detail.displayName.trim();
      }
    }
  }
  return windowLabelOf(bucket, t);
}

/** @returns {import('react').ReactElement} compact secondary limit row. */
function ToolRow({ t, limit, bucket, locale }) {
  const percent = remainingPercentOf(limit);
  const name = toolNameOf(limit, bucket, t);
  return h('div', { className: 'bmc-widget-tool-row' },
    h('span', { className: 'bmc-widget-tool-label', title: name }, name),
    h(Bar, { percent: percent ?? 0, tone: toneOf(percent), height: 4 }),
    h('span', { className: 'bmc-widget-tool-pct' }, percentText(percent, locale, t)),
  );
}

/** @returns {import('react').ReactElement} primary limits section. */
function LimitsSection({ t, limits, now, locale }) {
  if (limits.fiveHour === null && limits.week === null && limits.extras.length === 0) {
    return h('div', { className: 'bmc-widget-empty' },
      h('span', { className: 'bmc-widget-empty-hint' }, t('widget.limit.none')),
    );
  }
  const rows = [];
  if (limits.fiveHour !== null) {
    rows.push(h(LimitRow, { key: 'fiveHour', t, limit: limits.fiveHour, bucket: 'fiveHour', now, locale }));
  }
  if (limits.week !== null) {
    rows.push(h(LimitRow, { key: 'week', t, limit: limits.week, bucket: 'week', now, locale }));
  }
  const extraRows = limits.extras.slice(0, 3).map(({ limit, bucket }, index) => h(ToolRow, {
    key: `extra-${index}`,
    t,
    limit,
    bucket,
    locale,
  }));
  return h('div', { className: 'bmc-widget-section' },
    h('div', { className: 'bmc-widget-limits' }, rows),
    extraRows.length === 0 ? null : h('div', { className: 'bmc-widget-tools' }, extraRows),
  );
}

/** @returns {import('react').ReactElement} one quick-stat cell. */
function StatCell({ label, value }) {
  return h('div', { className: 'bmc-widget-stat' },
    h('span', { className: 'bmc-stat-label' }, label),
    h('span', { className: 'bmc-stat-value bmc-widget-stat-value' }, value),
  );
}

/** @returns {string|null} formatted date/time, or null when the value is unusable. */
function dateTimeText(value, locale) {
  const ms = toMs(value);
  if (ms === null) return null;
  const text = formatDateTime(ms, locale);
  return typeof text === 'string' && text !== '' ? text : null;
}

/** @returns {string|null} plan renewal/expiry line, or null when the plan has no date. */
function planLineOf(subscription, t, locale) {
  if (!isRecord(subscription)) return null;
  const renew = dateTimeText(subscription.renewTime, locale);
  const expire = dateTimeText(subscription.expireAt, locale);
  const autoRenew = subscription.autoRenew !== false;
  if (renew !== null && autoRenew) return t('widget.plan.renews', { date: renew });
  if (expire !== null) return t('widget.plan.expires', { date: expire });
  if (renew !== null) return t('widget.plan.renews', { date: renew });
  return null;
}

/** @returns {import('react').ReactElement} quick stats grid with today's usage and reset chances. */
function StatsSection({ t, snapshot, overview, locale }) {
  const usage = isRecord(snapshot) && isRecord(snapshot.usage) ? snapshot.usage : null;
  const summary = usage !== null && isRecord(usage.summary) ? usage.summary : null;
  const loading = isRecord(snapshot) && isRecord(snapshot.loading) ? snapshot.loading : {};
  const loadingUsage = loading.usage === true;
  const reset = isRecord(snapshot) && isRecord(snapshot.reset)
    ? snapshot.reset
    : (isRecord(overview) && isRecord(overview.reset) ? overview.reset : null);
  const tokens = summary === null ? null : amountText(summary.totalTokens, locale);
  const calls = summary === null ? null : amountText(summary.totalCalls, locale);
  const fiveResets = resetAvailableOf(reset, 'fiveHour');
  const weekResets = resetAvailableOf(reset, 'week');
  const fallbackValue = loadingUsage ? t('widget.value.loading') : t('widget.value.unavailable');
  const planLine = isRecord(overview) ? planLineOf(overview.subscription, t, locale) : null;
  return h('div', { className: 'bmc-widget-section' },
    h('div', { className: 'bmc-widget-stats' },
      h(StatCell, { key: 'tokens', label: t('widget.stats.todayTokens'), value: tokens ?? fallbackValue }),
      h(StatCell, { key: 'calls', label: t('widget.stats.todayCalls'), value: calls ?? fallbackValue }),
      h(StatCell, {
        key: 'resets-5h',
        label: t('widget.stats.fiveHourResets'),
        value: fiveResets === null ? t('widget.value.unavailable') : String(fiveResets),
      }),
      h(StatCell, {
        key: 'resets-week',
        label: t('widget.stats.weekResets'),
        value: weekResets === null ? t('widget.value.unavailable') : String(weekResets),
      }),
    ),
    planLine === null ? null : h('div', { className: 'bmc-widget-plan-line' }, planLine),
  );
}

/** @returns {import('react').ReactElement} popover header with the plan title and controls. */
function PopoverHeader({ t, planName, familyLabel, busy, onRefresh, onClose }) {
  return h('div', { className: 'bmc-widget-pop-head' },
    h('div', { className: 'bmc-widget-pop-titles' },
      h('span', { className: 'bmc-widget-plan', title: planName }, planName),
      h('span', { className: 'bmc-widget-sub' }, familyLabel),
    ),
    h('div', { className: 'bmc-widget-pop-actions' },
      h(IconButton, {
        label: t('widget.action.refresh'),
        onClick: onRefresh,
        disabled: busy === true,
        icon: h(Icon, { name: 'refresh', size: 16, className: busy === true ? 'bmc-widget-spin' : undefined }),
      }),
      h(IconButton, {
        label: t('widget.action.close'),
        onClick: onClose,
        icon: h(Icon, { name: 'close', size: 16 }),
      }),
    ),
  );
}

/** @returns {import('react').ReactElement} popover footer with freshness and navigation. */
function PopoverFooter({ t, now, lastUpdated, onViewStats, usagePageUrl }) {
  return h('div', { className: 'bmc-widget-pop-foot' },
    h('span', { className: 'bmc-widget-updated' }, relativeUpdatedTextOf(lastUpdated, now, t)),
    h('div', { className: 'bmc-widget-foot-row' },
      h(Button, { size: 'sm', variant: 'subtle', onClick: onViewStats }, t('widget.action.viewStats')),
      h('a', {
        className: 'bmc-widget-link',
        href: usagePageUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      t('widget.action.openUsagePage'),
      h(Icon, { name: 'external', size: 12 })),
    ),
  );
}

/**
 * Compute the fixed-position placement of the popover from the trigger rect.
 * Opens above the trigger, flipping below only when there is no usable space
 * above, and clamps every edge to the viewport margin.
 * @param trigger - the trigger button element.
 * @returns {object|null} inline `position: fixed` style, or null when unmeasurable.
 */
function measurePosition(trigger) {
  try {
    if (!trigger || typeof trigger.getBoundingClientRect !== 'function') return null;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth > 0
      ? window.innerWidth
      : 1024;
    const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' && window.innerHeight > 0
      ? window.innerHeight
      : 768;
    const width = Math.max(280, Math.min(POPOVER_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2));
    let left = rect.right - width;
    left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN));
    const aboveSpace = rect.top - POPOVER_GAP - VIEWPORT_MARGIN;
    const belowSpace = viewportHeight - rect.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
    const openUp = aboveSpace >= 200 || aboveSpace >= belowSpace;
    const available = Math.max(0, openUp ? aboveSpace : belowSpace);
    const maxHeight = Math.max(120, Math.min(viewportHeight * 0.7, POPOVER_MAX_HEIGHT, available));
    const maxEdge = Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN);
    if (openUp) {
      const bottom = Math.min(Math.max(viewportHeight - rect.top + POPOVER_GAP, VIEWPORT_MARGIN), maxEdge);
      return { left, width, maxHeight, bottom };
    }
    const top = Math.min(Math.max(rect.bottom + POPOVER_GAP, VIEWPORT_MARGIN), maxEdge);
    return { left, width, maxHeight, top };
  } catch {
    return null;
  }
}

/**
 * Compare two measured placements so scroll-driven updates only re-render on a
 * real change.
 * @returns {boolean} whether both placements describe the same box.
 */
function samePosition(previous, next) {
  if (previous === null || next === null) return previous === next;
  return previous.left === next.left
    && previous.width === next.width
    && previous.maxHeight === next.maxHeight
    && previous.bottom === next.bottom
    && previous.top === next.top;
}

/**
 * Floating remaining-quota popover. Mounted only while open; every listener and
 * observer it adds is removed on unmount.
 * @param props - `t`, store `snapshot`, trigger/root refs, close callback.
 * @returns {import('react').ReactElement} the fixed-position popover.
 */
function WidgetPopover({ t, snapshot, triggerRef, rootRef, onClose, locale }) {
  const React = rt.React;
  // Measured in a layout effect: during the first render the trigger ref is not
  // attached yet, and a render-time measurement would paint at the fallback
  // placement and jump once the observer fires.
  const [position, setPosition] = React.useState(null);
  const useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;
  const nowValue = useNow(TICK_MS);
  const now = typeof nowValue === 'number' && Number.isFinite(nowValue) ? nowValue : Date.now();

  useLayoutEffect(() => {
    const update = () => {
      const next = measurePosition(triggerRef.current);
      setPosition((previous) => (samePosition(previous, next) ? previous : next));
    };
    update();
    try {
      window.addEventListener('resize', update);
      window.addEventListener('scroll', update, true);
    } catch {
      /* non-browser host */
    }
    let observer = null;
    try {
      if (typeof ResizeObserver === 'function' && triggerRef.current) {
        observer = new ResizeObserver(update);
        observer.observe(triggerRef.current);
      }
    } catch {
      observer = null;
    }
    return () => {
      try {
        window.removeEventListener('resize', update);
        window.removeEventListener('scroll', update, true);
      } catch {
        /* non-browser host */
      }
      try {
        if (observer !== null) observer.disconnect();
      } catch {
        /* observer already detached */
      }
    };
  }, [triggerRef]);

  React.useEffect(() => {
    const handlePointerDown = (event) => {
      let inside = false;
      try {
        inside = typeof rootRef?.current?.contains === 'function' && rootRef.current.contains(event.target);
      } catch {
        inside = false;
      }
      if (!inside) onClose();
    };
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape' && event.key !== 'Esc') return;
      try {
        event.stopPropagation();
      } catch {
        /* ignore */
      }
      try {
        const trigger = triggerRef.current;
        if (trigger && typeof trigger.focus === 'function') trigger.focus({ preventScroll: true });
      } catch {
        /* focus restore is best effort */
      }
      onClose();
    };
    try {
      document.addEventListener('pointerdown', handlePointerDown, true);
      document.addEventListener('keydown', handleKeyDown, true);
    } catch {
      return undefined;
    }
    return () => {
      try {
        document.removeEventListener('pointerdown', handlePointerDown, true);
        document.removeEventListener('keydown', handleKeyDown, true);
      } catch {
        /* the document is already gone with the host page */
      }
    };
  }, [onClose, rootRef, triggerRef]);

  const overview = isRecord(snapshot.overview) ? snapshot.overview : null;
  const auth = isRecord(snapshot.auth) ? snapshot.auth : null;
  const login = isRecord(snapshot.login) ? snapshot.login : {};
  const loading = isRecord(snapshot.loading) ? snapshot.loading : {};
  const loggedIn = auth !== null && auth.loggedIn === true;
  const loginExpired = auth !== null && auth.loginExpired === true;
  const busy = loading.overview === true;
  const limits = limitsOf(overview);
  const planName = planNameOf(overview, t);
  const familyLabel = familyLabelOf(familyIdOf(snapshot, overview), t);
  const usagePageUrl = usagePageUrlOf(snapshot, overview);
  const lastUpdated = lastUpdatedMsOf(snapshot, overview);
  const errorRecord = isRecord(snapshot.error) ? snapshot.error : (overview !== null && isRecord(overview.error) ? overview.error : null);
  const errorCode = errorRecord !== null && typeof errorRecord.code === 'string' ? errorRecord.code : '';
  const subscription = overview !== null && isRecord(overview.subscription) ? overview.subscription : null;
  const hasQuota = overview !== null && (isRecord(overview.quota) || isRecord(overview.subscription));
  const inactiveSubscription = subscription !== null
    && subscription.active === false
    && (overview === null || !isRecord(overview.quota));
  const noPlan = errorCode === 'no_coding_plan' || (overview !== null && !hasQuota) || inactiveSubscription;
  const stale = overview !== null && overview.stale === true;

  const refresh = () => {
    void callState('refreshOverview', { force: true });
  };
  const viewStats = () => {
    try {
      const ctx = rt.ctx;
      const layout = ctx !== null && typeof ctx?.get === 'function' ? ctx.get('layout') : undefined;
      if (isRecord(layout) && typeof layout.selectPanel === 'function') {
        layout.selectPanel(PANEL_ID);
        onClose();
        return;
      }
    } catch {
      /* fall through to the external page */
    }
    openExternal(usagePageUrl);
  };
  const signIn = () => {
    const config = isRecord(snapshot.config) ? snapshot.config : null;
    requestSignIn(config !== null && typeof config.family === 'string' ? config.family : undefined);
  };

  const body = [];
  if (!loggedIn || loginExpired) {
    body.push(h(SignInNotice, {
      key: 'sign-in',
      t,
      loginExpired,
      login,
      onSignIn: signIn,
    }));
  } else if (busy && overview === null) {
    body.push(h(Skeleton, { key: 'skeleton', lines: 5 }));
  } else if (errorRecord !== null && overview === null) {
    body.push(h(ErrorNotice, { key: 'error', t, onRetry: refresh, stale: false }));
  } else if (noPlan) {
    body.push(h(NoPlanNotice, { key: 'no-plan', t, usagePageUrl }));
  } else if (overview === null) {
    body.push(h(Skeleton, { key: 'skeleton', lines: 5 }));
  } else {
    if (errorRecord !== null) {
      body.push(h(ErrorNotice, { key: 'error', t, onRetry: refresh, stale }));
    } else if (stale) {
      body.push(h(StaleHint, { key: 'stale', t }));
    }
    body.push(h(LimitsSection, { key: 'limits', t, limits, now, locale }));
    body.push(h(StatsSection, { key: 'stats', t, snapshot, overview, locale }));
  }

  // No placement yet (first layout effect has not run): render nothing rather
  // than flash the popover at a fallback position.
  if (position === null) return null;
  const style = position;
  return h('div', {
    className: 'bmc-widget-popover',
    style,
    role: 'dialog',
    'aria-label': t('widget.dialog.label'),
    'data-bmc-widget': 'popover',
  },
  h(PopoverHeader, {
    t,
    planName,
    familyLabel,
    busy,
    onRefresh: refresh,
    onClose,
  }),
  h('div', { className: 'bmc-widget-pop-body' }, body),
  h(PopoverFooter, {
    t,
    now,
    lastUpdated,
    onViewStats: viewStats,
    usagePageUrl,
  }),
  );
}

/**
 * Compact remaining-quota trigger for the composer tool row plus its popover.
 * @param props - slot props: localized `t` and the branded `sessionId`.
 * @returns {import('react').ReactElement|null} the trigger, or null when gated out.
 */
export function ComposerIndicator({ t: translate, sessionId }) {
  const React = rt.React;
  const t = typeof translate === 'function' ? translate : passthroughTranslate;
  const snapValue = useSnapshot();
  const snapshot = isRecord(snapValue) ? snapValue : {};
  const { locale } = useLocalized();
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const gate = useProviderGate(sessionId);

  const config = isRecord(snapshot.config) ? snapshot.config : null;
  const auth = isRecord(snapshot.auth) ? snapshot.auth : null;
  const loggedIn = auth !== null && auth.loggedIn === true;
  const loginExpired = auth !== null && auth.loginExpired === true;
  const showWhenLoggedOut = config !== null && config.showIndicatorWhenLoggedOut === true;
  const visible = config !== null
    && (loggedIn || loginExpired || showWhenLoggedOut)
    && providerAllowed(config, gate);

  const close = React.useCallback(() => {
    setOpen(false);
  }, []);
  const toggle = React.useCallback(() => {
    setOpen((value) => !value);
  }, []);

  const bootedRef = React.useRef(false);
  React.useEffect(() => {
    if (!visible || bootedRef.current) return;
    bootedRef.current = true;
    void callState('refreshOverview', { force: false });
  }, [visible]);

  React.useEffect(() => {
    setOpen(false);
  }, [sessionId]);

  React.useEffect(() => {
    if (visible) return;
    setOpen(false);
  }, [visible]);

  React.useEffect(() => {
    if (!open) return undefined;
    void callState('loadUsage', 'today');
    void callState('loadReset', { force: false });
    return subscribePanelChange(close);
  }, [open, close]);

  const nowValue = useNow(TICK_MS);
  const now = typeof nowValue === 'number' && Number.isFinite(nowValue) ? nowValue : Date.now();

  if (!visible) return null;

  const overview = isRecord(snapshot.overview) ? snapshot.overview : null;
  const loading = isRecord(snapshot.loading) ? snapshot.loading : {};
  const title = triggerTitleOf({ t, snapshot, overview, loggedIn, loginExpired, now, locale });
  const ariaLabel = loginExpired
    ? t('widget.trigger.expiredTooltip')
    : loggedIn
      ? t('widget.trigger.aria')
      : t('widget.trigger.loginTooltip');

  let content;
  if (!loggedIn || loginExpired) {
    content = h('span', { className: 'bmc-widget-login-content' },
      loginExpired ? h(WarningDot, null) : null,
      h('span', { className: 'bmc-widget-login-label' }, t('widget.trigger.login')),
    );
  } else if (loading.overview === true && overview === null) {
    content = h(Spinner, { size: 12 });
  } else {
    const limits = limitsOf(overview);
    const fiveHour = remainingPercentOf(limits.fiveHour);
    const week = remainingPercentOf(limits.week);
    if (fiveHour === null && week === null) {
      content = h('span', { className: 'bmc-widget-unavailable' },
        h(WarningDot, null),
        h('span', { className: 'bmc-widget-dash' }, t('widget.value.dash')),
      );
    } else {
      // Two independent rings (5-hour, then weekly — the popover's order):
      // side-by-side keeps both windows readable, and each ring keeps its own
      // fixed hue so the pair stays distinguishable in light and dark themes.
      content = h('span', { className: 'bmc-widget-rings' },
        triggerRing(fiveHour, 'fiveHour'),
        triggerRing(week, 'week'),
      );
    }
  }

  return h('div', { className: 'bmc-widget-root', ref: rootRef },
    h('button', {
      type: 'button',
      ref: triggerRef,
      className: 'bmc-widget-trigger',
      title,
      'aria-label': ariaLabel,
      'aria-haspopup': 'dialog',
      'aria-expanded': open ? 'true' : 'false',
      onClick: toggle,
      onMouseDown: (event) => {
        event.preventDefault();
      },
    }, content),
    open ? h(WidgetPopover, {
      t,
      snapshot,
      triggerRef,
      rootRef,
      onClose: close,
      locale,
    }) : null,
  );
}

/**
 * One trigger progress ring: a 16x16 inline SVG whose arc length is the
 * remaining fraction of one quota window. The composer trigger is a
 * `<button>`, so the glyph stays phrasing content; a window without data
 * renders its track only, keeping the pair visually balanced.
 * @param percent - remaining percentage of the window, or null when unknown.
 * @param key - stable element key (`fiveHour` | `week`).
 * @returns {import('react').ReactElement} trigger ring glyph.
 */
function triggerRing(percent, key) {
  const value = clampPercent(percent);
  const radius = 9.25;
  const circumference = 2 * Math.PI * radius;
  const fraction = value === null ? 0 : Math.min(100, Math.max(0, value)) / 100;
  // MUI CircularProgressWithLabel pattern: the rounded percentage sits centered
  // inside the ring; a window without data keeps the glyph balanced with a dash.
  const label = value === null ? '\u2013' : String(Math.round(value));
  return h('svg', {
    key,
    className: 'bmc-widget-ring',
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    focusable: 'false',
  },
    h('circle', { className: 'bmc-widget-ring-track', cx: 12, cy: 12, r: radius }),
    h('circle', {
      className: `bmc-widget-ring-arc bmc-widget-ring-arc-${key}`,
      cx: 12,
      cy: 12,
      r: radius,
      transform: 'rotate(-90 12 12)',
      strokeDasharray: `${(circumference * fraction).toFixed(2)} ${circumference.toFixed(2)}`,
    }),
    h('text', {
      className: 'bmc-widget-ring-text',
      x: 12,
      y: 12,
      textAnchor: 'middle',
      dominantBaseline: 'central',
    }, label));
}

/** @returns {string} localized tooltip/aria-label for the trigger. */
function triggerTitleOf({ t, snapshot, overview, loggedIn, loginExpired, now, locale }) {
  if (loginExpired) return t('widget.trigger.expiredTooltip');
  if (!loggedIn) return t('widget.trigger.loginTooltip');
  const loading = isRecord(snapshot.loading) ? snapshot.loading : {};
  if (loading.overview === true && overview === null) return t('widget.trigger.loading');
  const limits = limitsOf(overview);
  const fiveHour = remainingPercentOf(limits.fiveHour);
  const week = remainingPercentOf(limits.week);
  if (fiveHour === null && week === null) return t('widget.trigger.unavailable');
  const plan = planNameOf(overview, t);
  const fiveHourText = percentText(fiveHour, locale, t);
  const weekText = percentText(week, locale, t);
  const nearestReset = nearestResetTextOf(limits, now, t);
  if (nearestReset === null) {
    return t('widget.trigger.tooltipNoReset', { plan, fiveHour: fiveHourText, week: weekText });
  }
  return t('widget.trigger.tooltip', { plan, fiveHour: fiveHourText, week: weekText, reset: nearestReset });
}

/** Locale dictionaries owned by this module. Flat keys, `widget.` prefix. */
export const indicatorDicts = {
  zh: {
    'widget.trigger.aria': '查看编程套餐剩余额度',
    'widget.trigger.tooltip': '{plan}：5 小时窗口剩余 {fiveHour}，每周窗口剩余 {week}。{reset}',
    'widget.trigger.tooltipNoReset': '{plan}：5 小时窗口剩余 {fiveHour}，每周窗口剩余 {week}',
    'widget.trigger.loading': '正在获取编程套餐额度…',
    'widget.trigger.unavailable': '暂时无法获取额度信息',
    'widget.trigger.login': '登录',
    'widget.trigger.loginTooltip': '登录 BigModel 查看编程套餐剩余额度',
    'widget.trigger.expiredTooltip': '登录已过期，重新登录后可查看额度',
    'widget.dialog.label': '编程套餐剩余额度',
    'widget.plan.fallback': 'GLM 编程套餐',
    'widget.plan.level': 'GLM 编程套餐 {level}',
    'widget.family.bigmodel': 'BigModel',
    'widget.family.zai': 'Z.AI',
    'widget.family.other': '编程套餐',
    'widget.action.refresh': '刷新',
    'widget.action.close': '关闭',
    'widget.action.retry': '重试',
    'widget.action.viewStats': '查看完整统计',
    'widget.action.openUsagePage': '打开用量页面',
    'widget.action.signIn': '登录',
    'widget.action.relogin': '重新登录',
    'widget.action.openAuthorize': '打开授权页面',
    'widget.window.fiveHour': '5 小时窗口',
    'widget.window.week': '每周窗口',
    'widget.window.tool': 'MCP 工具',
    'widget.window.other': '其他额度',
    'widget.limit.remainingOf': '剩余 {remaining} / {total}',
    'widget.limit.unknown': '额度未知',
    'widget.limit.none': '暂无额度数据',
    'widget.reset.in': '{time}后重置',
    'widget.reset.soon': '即将重置',
    'widget.reset.unknown': '重置时间未知',
    'widget.stats.todayTokens': '今日 Token',
    'widget.stats.todayCalls': '今日调用',
    'widget.stats.fiveHourResets': '5 小时重置机会',
    'widget.stats.weekResets': '每周重置机会',
    'widget.value.unavailable': '—',
    'widget.value.loading': '…',
    'widget.value.dash': '--',
    'widget.value.underOnePercent': '<1%',
    'widget.plan.renews': '续费于 {date}',
    'widget.plan.expires': '到期于 {date}',
    'widget.updated': '更新于 {time}',
    'widget.updated.justNow': '刚刚更新',
    'widget.updated.never': '尚未更新',
    'widget.state.error': '加载失败，请稍后重试',
    'widget.state.stale': '数据可能不是最新',
    'widget.state.noPlan': '该账号暂无编程套餐',
    'widget.state.noPlanHint': '登录已开通编程套餐的 BigModel 账号后即可查看剩余额度。',
    'widget.login.loggedOut': '登录 BigModel 后可查看编程套餐剩余额度',
    'widget.login.expired': '登录已过期，请重新登录',
    'widget.login.pending': '在浏览器中完成授权…',
    'widget.login.failed': '登录失败，请重试',
  },
  en: {
    'widget.trigger.aria': 'View Coding Plan remaining quota',
    'widget.trigger.tooltip': '{plan}: {fiveHour} left in the 5-hour window, {week} left weekly. {reset}',
    'widget.trigger.tooltipNoReset': '{plan}: {fiveHour} left in the 5-hour window, {week} left weekly',
    'widget.trigger.loading': 'Loading Coding Plan quota…',
    'widget.trigger.unavailable': 'Quota unavailable right now',
    'widget.trigger.login': 'Sign in',
    'widget.trigger.loginTooltip': 'Sign in to view your Coding Plan remaining quota',
    'widget.trigger.expiredTooltip': 'Sign-in expired. Sign in again to see your quota.',
    'widget.dialog.label': 'Coding Plan remaining quota',
    'widget.plan.fallback': 'GLM Coding Plan',
    'widget.plan.level': 'GLM Coding Plan {level}',
    'widget.family.bigmodel': 'BigModel',
    'widget.family.zai': 'Z.AI',
    'widget.family.other': 'Coding Plan',
    'widget.action.refresh': 'Refresh',
    'widget.action.close': 'Close',
    'widget.action.retry': 'Retry',
    'widget.action.viewStats': 'View full statistics',
    'widget.action.openUsagePage': 'Open usage page',
    'widget.action.signIn': 'Sign in',
    'widget.action.relogin': 'Sign in again',
    'widget.action.openAuthorize': 'Open authorization page',
    'widget.window.fiveHour': '5-hour window',
    'widget.window.week': 'Weekly window',
    'widget.window.tool': 'MCP tools',
    'widget.window.other': 'Other quota',
    'widget.limit.remainingOf': '{remaining} of {total} left',
    'widget.limit.unknown': 'Quota unavailable',
    'widget.limit.none': 'No quota data',
    'widget.reset.in': 'Resets in {time}',
    'widget.reset.soon': 'Resetting soon',
    'widget.reset.unknown': 'Reset time unavailable',
    'widget.stats.todayTokens': "Today's tokens",
    'widget.stats.todayCalls': "Today's calls",
    'widget.stats.fiveHourResets': '5-hour reset chances',
    'widget.stats.weekResets': 'Weekly reset chances',
    'widget.value.unavailable': '—',
    'widget.value.loading': '…',
    'widget.value.dash': '--',
    'widget.value.underOnePercent': '<1%',
    'widget.plan.renews': 'Renews {date}',
    'widget.plan.expires': 'Expires {date}',
    'widget.updated': 'Updated {time}',
    'widget.updated.justNow': 'Updated just now',
    'widget.updated.never': 'Not updated yet',
    'widget.state.error': "Couldn't load data. Try again.",
    'widget.state.stale': 'Data may be out of date',
    'widget.state.noPlan': 'No Coding Plan found for this account',
    'widget.state.noPlanHint': 'Sign in with a BigModel account that has an active Coding Plan to see the remaining quota.',
    'widget.login.loggedOut': 'Sign in to BigModel to see your Coding Plan remaining quota',
    'widget.login.expired': 'Your sign-in expired. Sign in again.',
    'widget.login.pending': 'Finish signing in in your browser…',
    'widget.login.failed': 'Sign-in failed. Try again.',
  },
};

/** Stylesheet owned by this module; entry.js concatenates it into the plugin style tag. */
export const indicatorCss = `
.bmc-widget-root {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.bmc-widget-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 24px;
  margin: 0;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

@media (hover: hover) {
  .bmc-widget-trigger:hover {
    background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent);
    color: var(--dsw-alias-label-primary);
  }
}

.bmc-widget-trigger[aria-expanded='true'] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent);
  color: var(--dsw-alias-label-primary);
}

.bmc-widget-trigger:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

.bmc-widget-rings {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 1px;
}

.bmc-widget-ring {
  display: block;
  width: 24px;
  height: 24px;
}

.bmc-widget-ring-track {
  fill: none;
  stroke: color-mix(in srgb, var(--dsw-alias-label-secondary) 26%, transparent);
  stroke-width: 2.5px;
}

.bmc-widget-ring-arc {
  fill: none;
  stroke-width: 2.5px;
  stroke-linecap: round;
}

/* One fixed hue per window, mirroring the usage page's series palette:
   --dsw-alias-brand-primary is the monochrome button color, never a data hue. */
.bmc-widget-ring-arc-fiveHour {
  stroke: var(--dsw-alias-state-business-primary, var(--dsw-alias-link));
}

.bmc-widget-ring-arc-week {
  stroke: var(--dsw-alias-state-success-primary);
}

.bmc-widget-ring-text {
  fill: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 7.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.bmc-widget-login-content {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 2px;
}

.bmc-widget-login-label {
  font-size: 12px;
  line-height: 12px;
}

.bmc-widget-unavailable {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.bmc-widget-dash {
  font-size: 10px;
  line-height: 10px;
  letter-spacing: 0.04em;
}

.bmc-widget-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-state-warn-primary);
}

.bmc-widget-spin {
  animation: bmc-widget-spin 900ms linear infinite;
}

@keyframes bmc-widget-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .bmc-widget-spin { animation-duration: 3s; }
}

.bmc-widget-popover {
  position: fixed;
  z-index: 2000;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 352px;
  max-width: calc(100vw - 16px);
  max-height: min(70vh, 520px);
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.45;
  box-shadow: 0 12px 32px rgb(0 0 0 / 18%);
  animation: bmc-widget-pop-in 120ms ease-out;
}

@keyframes bmc-widget-pop-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .bmc-widget-popover { animation: none; }
}

.bmc-widget-pop-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 8px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.bmc-widget-pop-titles {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.bmc-widget-plan {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bmc-widget-sub {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}

.bmc-widget-pop-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}

.bmc-widget-pop-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 12px 14px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.bmc-widget-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bmc-widget-limits,
.bmc-widget-tools {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bmc-widget-limit {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.bmc-widget-limit-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.bmc-widget-limit-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

.bmc-widget-limit-pct {
  font-size: 13px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.bmc-widget-text-warn {
  color: var(--dsw-alias-state-warn-primary);
}

.bmc-widget-text-error {
  color: var(--dsw-alias-state-error-primary);
}

.bmc-widget-limit-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.bmc-widget-limit-meta span {
  white-space: nowrap;
}

.bmc-widget-tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

.bmc-widget-tool-row .bmc-bar {
  flex: 1;
}

.bmc-widget-tool-label {
  flex: none;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bmc-widget-tool-pct {
  flex: none;
  min-width: 34px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.bmc-widget-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.bmc-widget-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.bmc-widget-stat .bmc-stat-label {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bmc-widget-stat-value {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
  font-variant-numeric: tabular-nums;
}

.bmc-widget-plan-line {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.bmc-widget-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--dsw-alias-brand-primary);
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
}

.bmc-widget-link:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
  border-radius: 4px;
}

@media (hover: hover) {
  .bmc-widget-link:hover {
    text-decoration: underline;
  }
}

.bmc-widget-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 0;
}

.bmc-widget-empty-hint {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

.bmc-widget-stale {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.bmc-widget-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 2px 0;
}

.bmc-widget-skeleton-line {
  display: block;
  height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent);
  animation: bmc-widget-pulse 1.4s ease-in-out infinite;
}

.bmc-widget-skeleton-line:nth-child(2) { width: 78%; }
.bmc-widget-skeleton-line:nth-child(3) { width: 58%; }
.bmc-widget-skeleton-line:nth-child(4) { width: 84%; }
.bmc-widget-skeleton-line:nth-child(5) { width: 46%; }

@keyframes bmc-widget-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

@media (prefers-reduced-motion: reduce) {
  .bmc-widget-skeleton-line { animation: none; }
}

.bmc-widget-pop-foot {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

.bmc-widget-updated {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.bmc-widget-foot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
`;
