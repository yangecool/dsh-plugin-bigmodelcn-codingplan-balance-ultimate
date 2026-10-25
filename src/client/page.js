/**
 * Dedicated BigModel usage page: the main panel behind the plugin's sidebar
 * icon.
 *
 * The page is a root-scope slot component. It renders without any session
 * binding, reads everything from the singleton store through the shared hooks,
 * and loads its own data once per login/range change. Every section is
 * defensive: a missing payload renders a state instead of throwing, so a
 * partially loaded account never blanks the panel.
 */
import { rt } from './runtime.js';
import { state } from './state.js';
import { useLocalized, useNow, useSnapshot } from './hooks.js';
import { Badge, Button, Icon, Notice } from './ui.js';
import { formatRelative } from './format.js';
import { InferenceCard, SettingsCard } from './page-settings.js';
import { LoginCard, PlanCard, QuotaSection, ResetCard } from './page-sections.js';
import { UsageSection } from './page-usage.js';
import {
  attempt,
  avatarOf,
  cls,
  displayNameOf,
  errorTextOf,
  familyId,
  initialsOf,
  isNumber,
  planStatusOf,
} from './page-helpers.js';

export { pageCss } from './page-css.js';
export { pageDicts } from './page-dicts.js';

/** Element factory routed through the runtime binding. */
function el(type, props, ...children) {
  const h = rt.h;
  return typeof h === 'function' ? h(type, props, ...children) : null;
}

/** Usage ranges accepted by the range switcher. */
const USAGE_RANGES = Object.freeze(['today', '7d', '30d']);

/**
 * Localized label of a service family.
 * @param t - translator.
 * @param family - family id.
 * @returns 'BigModel' or 'Z.AI' label.
 */
function familyLabel(t, family) {
  return familyId(family) === 'zai' ? t('page.familyZai') : t('page.familyBigModel');
}

/**
 * Plan status badge label of a subscription.
 * @param t - translator.
 * @param subscription - subscription payload.
 * @returns localized status label.
 */
function planStatusText(t, subscription) {
  const status = planStatusOf(subscription);
  if (status === 'active') return t('page.planStatusActive');
  if (status === 'expired') return t('page.planStatusExpired');
  return t('page.planStatusNoPlan');
}

/**
 * Account chip: avatar with initials fallback, display name, plan status, and
 * the service-family badge.
 * @param props - `t`, `auth`, `subscription`, `family`.
 * @returns the chip element.
 */
function AccountChip(props) {
  const { t, auth, subscription, family } = props ?? {};
  const user = auth !== null && auth !== undefined && typeof auth === 'object' ? auth.user : null;
  const account = auth !== null && auth !== undefined && typeof auth === 'object' ? auth.account : null;
  const name = displayNameOf(user, account);
  const avatar = avatarOf(user, account);
  return el('div', { className: 'bmc-page-account' },
    el('span', { className: 'bmc-page-avatar' },
      el('span', { className: 'bmc-page-avatar-initials' },
        name !== '' ? initialsOf(name) : el(Icon, { name: 'user', size: 13 })),
      avatar !== null
        ? el('img', {
          className: 'bmc-page-avatar-img',
          src: avatar,
          alt: '',
          loading: 'lazy',
          referrerPolicy: 'no-referrer',
          onError: (event) => {
            try {
              if (event !== null && event.currentTarget !== null) {
                event.currentTarget.style.display = 'none';
              }
            } catch {
              // A hidden broken avatar leaves the initials fallback visible.
            }
          },
        })
        : null),
    el('span', { className: 'bmc-page-account-text' },
      el('span', { className: 'bmc-page-account-name' }, name !== '' ? name : t('page.signedOut')),
      el('span', { className: 'bmc-page-account-meta' }, planStatusText(t, subscription))),
    el(Badge, { tone: 'brand' }, familyLabel(t, family)));
}

/**
 * Page header: title, subtitle, account chip, refresh action, and freshness.
 * @param props - `t`, `auth`, `subscription`, `family`, `lastUpdated`, `now`,
 *   `stale`, `busy`, `onRefresh`.
 * @returns the header element.
 */
function PageHeader(props) {
  const {
    t, auth, subscription, family, lastUpdated, now,
    stale = false, busy = false, onRefresh,
  } = props ?? {};
  const updated = isNumber(lastUpdated)
    ? attempt(() => formatRelative(lastUpdated, t, now), '')
    : '';
  const hasUpdated = typeof updated === 'string' && updated.length > 0;
  return el('header', { className: 'bmc-page-header' },
    el('div', { className: 'bmc-page-heading' },
      el('h1', { className: 'bmc-page-title' }, t('page.title')),
      el('p', { className: 'bmc-page-subtitle' }, t('page.subtitle'))),
    el('div', { className: 'bmc-page-header-side' },
      el(AccountChip, { t, auth, subscription, family }),
      el('div', { className: 'bmc-page-inline' },
        el(Button, {
          variant: 'ghost',
          size: 'sm',
          busy,
          onClick: typeof onRefresh === 'function' ? onRefresh : undefined,
          title: t('page.refreshAria'),
        }, el(Icon, { name: 'refresh', size: 14 }), t('page.refresh')),
        hasUpdated
          ? el('span', { className: 'bmc-page-meta' }, t('page.lastUpdated', { time: updated }))
          : null,
        stale === true
          ? el('span', { className: cls('bmc-page-meta', 'bmc-page-meta-warn') }, t('page.stale'))
          : null)));
}

/**
 * Dedicated BigModel usage page.
 * @param props - slot props: `t` (locale translate) and the standard kit.
 * @returns the page element.
 */
export function BigModelUsagePage(props) {
  const { t: tProp } = props ?? {};
  const React = rt.React;
  const snapshot = useSnapshot();
  const localized = useLocalized();
  const now = useNow(30_000);
  const t = typeof tProp === 'function' ? tProp : localized.t;
  const locale = localized !== null && localized !== undefined && localized.locale === 'zh' ? 'zh' : 'en';

  const [usageRequested, setUsageRequested] = React.useState(false);
  const [optimisticResets, setOptimisticResets] = React.useState({});
  const loadKeyRef = React.useRef('');

  const snap = snapshot !== null && snapshot !== undefined && typeof snapshot === 'object' ? snapshot : {};
  const config = snap.config !== null && snap.config !== undefined ? snap.config : null;
  const overview = snap.overview !== null && snap.overview !== undefined ? snap.overview : null;
  const auth = snap.auth !== null && snap.auth !== undefined
    ? snap.auth
    : (overview !== null && overview.auth !== null && overview.auth !== undefined ? overview.auth : null);
  const subscription = overview !== null && overview.subscription !== null && overview.subscription !== undefined
    ? overview.subscription
    : null;
  const quota = overview !== null && overview.quota !== null && overview.quota !== undefined ? overview.quota : null;
  const inference = snap.inference !== null && snap.inference !== undefined
    ? snap.inference
    : (overview !== null && overview.inference !== null && overview.inference !== undefined ? overview.inference : null);
  const login = snap.login !== null && snap.login !== undefined && typeof snap.login === 'object'
    ? snap.login
    : { state: 'idle', authorizeUrl: null, error: null };
  const loading = snap.loading !== null && snap.loading !== undefined && typeof snap.loading === 'object'
    ? snap.loading
    : {};
  const usageRange = USAGE_RANGES.includes(snap.usageRange) ? snap.usageRange : 'today';
  const usage = snap.usage !== null && snap.usage !== undefined ? snap.usage : null;
  const loggedIn = auth !== null && auth.loggedIn === true && auth.loginExpired !== true;
  const family = familyId(auth !== null && auth.family !== null && auth.family !== undefined ? auth.family : config !== null ? config.family : null);
  const resetBlock = snap.reset !== null && snap.reset !== undefined
    ? snap.reset
    : (overview !== null && overview.reset !== null && overview.reset !== undefined ? overview.reset : null);
  const generatedAt = overview !== null && isNumber(overview.generatedAt) ? overview.generatedAt : null;
  const lastUpdated = isNumber(snap.lastUpdated) ? snap.lastUpdated : generatedAt;

  // Load what the page needs once per login/range change; the store caches and
  // shares in-flight requests, so repeated mounts never duplicate work.
  React.useEffect(() => {
    void state.refreshOverview({ force: false });
  }, []);

  React.useEffect(() => {
    if (loggedIn !== true) {
      loadKeyRef.current = '';
      setUsageRequested(false);
      return undefined;
    }
    const key = `${usageRange}`;
    if (loadKeyRef.current === key) {
      return undefined;
    }
    loadKeyRef.current = key;
    setUsageRequested(true);
    void state.loadUsage(usageRange);
    void state.loadReset({ force: false });
    return undefined;
  }, [loggedIn, usageRange]);

  // Refresh once when a sign-in completes while the page stays mounted.
  const loginReadyRef = React.useRef(false);
  React.useEffect(() => {
    const ready = login.state === 'ready' || (loggedIn === true && loginReadyRef.current !== true);
    loginReadyRef.current = loggedIn === true;
    if (ready !== true || loggedIn !== true) {
      return;
    }
    void state.refreshOverview({ force: true });
  }, [login.state, loggedIn]);

  // Drop optimistic reset overrides once a fresh overview has been generated.
  React.useEffect(() => {
    const windows = Object.keys(optimisticResets);
    if (windows.length === 0) {
      return;
    }
    if (generatedAt !== null && windows.every((windowName) => generatedAt >= optimisticResets[windowName])) {
      setOptimisticResets({});
    }
  }, [optimisticResets, generatedAt]);

  function refreshAll() {
    void state.refreshOverview({ force: true });
    if (loggedIn === true) {
      void state.loadUsage(usageRange, { force: true });
      void state.loadReset({ force: true });
    }
  }

  function changeRange(next) {
    if (!USAGE_RANGES.includes(next)) {
      return;
    }
    state.setUsageRange(next);
    void state.loadUsage(next);
  }

  function retryUsage() {
    setUsageRequested(true);
    void state.loadUsage(usageRange, { force: true });
  }

  function handleResetUsed(resetType) {
    const windowName = resetType === 'WEEK' ? 'week' : 'fiveHour';
    setOptimisticResets((previous) => ({ ...previous, [windowName]: Date.now() }));
  }

  const overrides = {};
  for (const windowName of Object.keys(optimisticResets)) {
    if (generatedAt === null || generatedAt < optimisticResets[windowName]) {
      overrides[windowName] = true;
    }
  }

  const columnChildren = [];
  columnChildren.push(el(PageHeader, {
    key: 'header',
    t,
    auth,
    subscription,
    family,
    lastUpdated,
    now,
    stale: overview !== null && overview.stale === true,
    busy: loading.overview === true || loading.usage === true,
    onRefresh: refreshAll,
  }));

  if (overview !== null && overview.error !== null && overview.error !== undefined && loggedIn === true) {
    columnChildren.push(el(Notice, {
      key: 'overview-error',
      tone: 'error',
      title: t('page.errorTitle'),
      children: el('span', null, errorTextOf(overview.error, t)),
      action: el(Button, {
        variant: 'ghost',
        size: 'sm',
        onClick: refreshAll,
      }, t('page.retry')),
    }));
  }

  if (loggedIn !== true) {
    columnChildren.push(el(LoginCard, {
      key: 'login',
      t,
      auth,
      login,
      family,
      loadingLogin: loading.login === true,
    }));
    columnChildren.push(el(InferenceCard, {
      key: 'inference',
      t,
      locale,
      now,
      auth,
      config,
      inference,
    }));
    columnChildren.push(el(SettingsCard, { key: 'settings', t, config }));
  } else {
    const sections = [];
    sections.push(el(PlanCard, {
      key: 'plan',
      t,
      locale,
      auth,
      subscription,
      family,
    }));
    sections.push(el(QuotaSection, {
      key: 'quota',
      t,
      locale,
      now,
      quota,
      family,
      overrides,
    }));
    if (resetBlock !== null) {
      sections.push(el(ResetCard, {
        key: 'reset',
        t,
        locale,
        now,
        reset: resetBlock,
        onUsed: handleResetUsed,
      }));
    }
    sections.push(el(UsageSection, {
      key: 'usage',
      t,
      locale,
      now,
      range: usageRange,
      usage,
      loading: loading.usage === true,
      error: snap.error !== null && snap.error !== undefined ? snap.error : null,
      requested: usageRequested,
      onRangeChange: changeRange,
      onRetry: retryUsage,
    }));
    sections.push(el(InferenceCard, {
      key: 'inference',
      t,
      locale,
      now,
      auth,
      config,
      inference,
    }));
    sections.push(el(SettingsCard, { key: 'settings', t, config }));
    columnChildren.push(el('div', { key: 'sections', className: 'bmc-page-sections' }, sections));
  }

  let column = null;
  try {
    column = el('div', { className: 'bmc-page-column' }, columnChildren);
  } catch {
    column = el('div', { className: 'bmc-page-column' },
      el(Notice, {
        tone: 'error',
        title: t('page.errorTitle'),
        children: el('span', null, t('page.errorUnknown')),
      }));
  }
  return el('div', { className: 'bmc-page' }, column);
}

/**
 * Sidebar glyph of the usage page: a rounded quota card with three bars and a
 * status dot. 16/18px target size, `currentColor` strokes, no external assets.
 * @param props - `size` in pixels (clamped 12..24), `active` selection flag.
 * @returns the sidebar icon element.
 */
export function PanelIcon(props) {
  const { size = 16, active = false } = props ?? {};
  const numeric = Number(size);
  const pixels = Number.isFinite(numeric) ? Math.max(12, Math.min(24, numeric)) : 16;
  const selected = active === true;
  return el('svg', {
    className: cls('bmc-page-icon', selected ? 'is-active' : null),
    width: pixels,
    height: pixels,
    viewBox: '0 0 16 16',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': 'true',
    focusable: 'false',
  },
  el('rect', {
    x: 1.6,
    y: 1.6,
    width: 12.8,
    height: 12.8,
    rx: 3.6,
    stroke: 'currentColor',
    strokeWidth: 1.3,
    opacity: selected ? 1 : 0.72,
  }),
  el('rect', { x: 4.1, y: 4.5, width: 7.8, height: 1.7, rx: 0.85, fill: 'currentColor' }),
  el('rect', { x: 4.1, y: 7.2, width: 5.8, height: 1.7, rx: 0.85, fill: 'currentColor', opacity: 0.78 }),
  el('rect', { x: 4.1, y: 9.9, width: 3.9, height: 1.7, rx: 0.85, fill: 'currentColor', opacity: 0.56 }),
  el('circle', {
    cx: 11.9,
    cy: 11.8,
    r: 2.2,
    fill: selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-success-primary)',
  }));
}
