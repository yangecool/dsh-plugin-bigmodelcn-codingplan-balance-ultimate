/**
 * Signed-in sections of the dedicated BigModel usage page: sign-in card, plan
 * card, quota cards, and reset chances.
 *
 * Each section owns only presentation state (inline confirm, action outcome);
 * every network call goes through the singleton `state` store, and every
 * payload access tolerates a missing or malformed field.
 */
import { rt } from './runtime.js';
import { state } from './state.js';
import { Badge, Bar, Button, Card, EmptyState, Icon, KeyValue, Notice, Spinner } from './ui.js';
import {
  billingCycleText,
  formatCompact,
  formatCountdown,
  formatDateTime,
  formatPercentValue,
  formatResetAt,
  labelOfLimit,
  remainingOfLimit,
  remainingPercentOf,
  totalOf,
  usedOf,
} from './page-format.js';
import {
  barTone,
  cls,
  displayNameOf,
  errorTextOf,
  familyId,
  planStatusOf,
  toMs,
  windowOf,
  windowOrder,
} from './page-helpers.js';
import { openExternal, planUrlFor } from './page-links.js';

/** Element factory routed through the runtime binding. */
function el(type, props, ...children) {
  const h = rt.h;
  return typeof h === 'function' ? h(type, props, ...children) : null;
}

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
 * Badge tone/label of a plan status.
 * @param t - translator.
 * @param status - 'active' | 'expired' | 'none'.
 * @returns `{ tone, label }`.
 */
function planBadge(t, status) {
  if (status === 'active') return { tone: 'success', label: t('page.planStatusActive') };
  if (status === 'expired') return { tone: 'error', label: t('page.planStatusExpired') };
  return { tone: 'idle', label: t('page.planStatusNoPlan') };
}

/**
 * Open an external page from a button.
 * @param url - absolute URL.
 * @returns nothing.
 */
function openUrl(url) {
  openExternal(url);
}

/**
 * Sign-in card for the logged-out, expired, pending, and failed states.
 * @param props - `t`, `auth`, `login`, `family`, `loadingLogin`.
 * @returns the card element.
 */
export function LoginCard(props) {
  const { t, auth, login, family, loadingLogin = false } = props ?? {};
  const React = rt.React;
  const [starting, setStarting] = React.useState(false);
  const [failure, setFailure] = React.useState(null);
  const loginState = login && typeof login === 'object' ? login.state : 'idle';
  const authorizeUrl = login && typeof login.authorizeUrl === 'string' && login.authorizeUrl.length > 0
    ? login.authorizeUrl
    : null;
  const expired = (auth !== null && auth !== undefined && auth.loginExpired === true) || loginState === 'expired';
  const busy = starting === true || loadingLogin === true;
  const pending = busy || loginState === 'starting' || loginState === 'pending';
  const failed = pending !== true && (failure !== null || loginState === 'failed');

  async function requestLogin() {
    if (busy) return;
    setStarting(true);
    setFailure(null);
    try {
      const url = await state.startLogin({ family: familyId(family) });
      if (typeof url === 'string' && url.length > 0) {
        try {
          if (typeof window !== 'undefined' && window !== null) {
            window.open(url, '_blank', 'noopener');
          }
        } catch {
          // A blocked popup keeps the waiting card visible, which renders the
          // authorize URL as an explicit link for the user.
        }
      }
    } catch (error) {
      setFailure(error);
    } finally {
      setStarting(false);
    }
  }

  function cancelLogin() {
    try {
      state.cancelLogin();
    } catch {
      // Cancelling an already-finished flow is harmless.
    }
    setFailure(null);
    setStarting(false);
  }

  if (pending) {
    return el(Card, { className: 'bmc-page-card' },
      el('div', { className: 'bmc-page-auth' },
        el('h3', { className: 'bmc-page-auth-title' }, t('page.loginWaitingTitle')),
        el('div', { className: 'bmc-page-waiting' },
          el(Spinner, { size: 16 }),
          el('span', null, loginState === 'pending' ? t('page.loginPending') : t('page.loginStarting'))),
        el('p', { className: 'bmc-page-auth-body' }, t('page.loginWaitingBody')),
        authorizeUrl !== null
          ? el('div', { className: 'bmc-page-linkbox' },
            el('a', {
              className: 'bmc-page-link',
              href: authorizeUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
            }, t('page.loginOpenLink')),
            el('span', { className: 'bmc-page-link-hint' }, t('page.loginLinkHint')))
          : null,
        el('div', { className: 'bmc-page-auth-actions' },
          el(Button, { variant: 'subtle', size: 'sm', onClick: cancelLogin }, t('page.cancel')))));
  }

  if (failed) {
    return el(Card, { className: 'bmc-page-card' },
      el('div', { className: 'bmc-page-auth' },
        el('h3', { className: 'bmc-page-auth-title' }, t('page.loginFailedTitle')),
        el(Notice, {
          tone: 'error',
          children: el('span', null, failure !== null ? errorTextOf(failure, t) : t('page.loginFailedBody')),
        }),
        el('div', { className: 'bmc-page-auth-actions' },
          el(Button, { variant: 'primary', busy: busy, onClick: requestLogin }, t('page.loginRetry')),
          el(Button, { variant: 'subtle', size: 'sm', onClick: cancelLogin }, t('page.cancel')))));
  }

  return el(Card, { className: 'bmc-page-card' },
    el('div', { className: 'bmc-page-auth' },
      el('h3', { className: 'bmc-page-auth-title' }, expired ? t('page.loginExpiredTitle') : t('page.loginTitle')),
      expired
        ? el(Notice, { tone: 'warn', children: el('span', null, t('page.loginExpiredBody')) })
        : null,
      el('p', { className: 'bmc-page-auth-body' }, t('page.loginBody')),
      el('p', { className: 'bmc-page-field-hint' }, t('page.loginInferenceHint')),
      el('div', { className: 'bmc-page-auth-actions' },
        el(Button, { variant: 'primary', busy: busy, onClick: requestLogin },
          el(Icon, { name: 'login', size: 14 }),
          expired ? t('page.loginExpiredAction') : t('page.loginButton'))),
      el('span', { className: 'bmc-page-field-hint' },
        t('page.loginSiteHint', { family: familyLabel(t, family) }))));
}

/**
 * Plan card: product, status, billing cycle, renew/expire times, account, and
 * the inline-confirm sign-out action.
 * @param props - `t`, `locale`, `auth`, `subscription`, `family`.
 * @returns the card element.
 */
export function PlanCard(props) {
  const { t, locale, auth, subscription, family } = props ?? {};
  const React = rt.React;
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const status = planStatusOf(subscription);
  const badge = planBadge(t, status);
  const productName = subscription && typeof subscription.productName === 'string' && subscription.productName.length > 0
    ? subscription.productName
    : undefined;

  const rows = [];
  const cycle = billingCycleText(subscription, t);
  if (typeof cycle === 'string' && cycle.length > 0) {
    rows.push({ label: t('page.planBillingCycle'), value: cycle });
  }
  const renewTime = formatDateTime(subscription && subscription.renewTime, locale);
  if (renewTime !== '—') {
    rows.push({ label: t('page.planRenewTime'), value: renewTime });
  }
  const expireAt = formatDateTime(subscription && subscription.expireAt, locale);
  if (expireAt !== '—') {
    rows.push({ label: t('page.planExpireTime'), value: expireAt });
  }
  const accountName = displayNameOf(auth && auth.user, auth && auth.account);
  if (accountName !== '') {
    rows.push({ label: t('page.account'), value: accountName });
  }
  rows.push({ label: t('page.familyLabel'), value: familyLabel(t, family) });

  async function logout() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const result = await state.logout();
      if (result !== null && typeof result === 'object' && result.ok === false) {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const body = [
    el(KeyValue, { key: 'kv', rows }),
  ];
  if (status === 'none') {
    body.push(el('p', { key: 'noplan', className: 'bmc-page-auth-body' }, t('page.planNoPlanBody')));
    body.push(el('div', { key: 'noplan-action', className: 'bmc-page-auth-actions' },
      el(Button, {
        variant: 'ghost',
        size: 'sm',
        onClick: () => openUrl(planUrlFor(family)),
      }, el(Icon, { name: 'external', size: 14 }), t('page.planOpen'))));
  }
  body.push(confirming === true
    ? el('div', { key: 'logout-confirm', className: 'bmc-page-confirm' },
      el('span', { className: 'bmc-page-confirm-text' }, t('page.logoutConfirm')),
      el(Button, { variant: 'primary', size: 'sm', busy: busy, onClick: logout }, t('page.logoutConfirmAction')),
      el(Button, {
        variant: 'subtle',
        size: 'sm',
        disabled: busy,
        onClick: () => setConfirming(false),
      }, t('page.cancel')))
    : el('div', { key: 'logout', className: 'bmc-page-inline' },
      failed === true ? el('span', { className: 'bmc-page-field-error' }, t('page.logoutFailed')) : null,
      el('span', { className: 'bmc-page-spacer' }),
      el(Button, {
        variant: 'subtle',
        size: 'sm',
        onClick: () => {
          setFailed(false);
          setConfirming(true);
        },
      }, el(Icon, { name: 'logout', size: 14 }), t('page.logout'))));

  return el(Card, {
    className: 'bmc-page-card',
    title: t('page.planTitle'),
    subtitle: productName,
    actions: el(Badge, { tone: badge.tone }, badge.label),
  }, el('div', { className: 'bmc-page-stack' }, body));
}

/**
 * One quota-window card.
 * @param props - `t`, `locale`, `now`, `limit`, `fullOverride`.
 * @returns the card element.
 */
export function QuotaCard(props) {
  const { t, locale, now, limit, fullOverride = false } = props ?? {};
  const windowName = windowOf(limit);
  const total = totalOf(limit);
  const remaining = fullOverride === true ? total : remainingOfLimit(limit);
  const used = fullOverride === true ? 0 : usedOf(limit);
  const percent = fullOverride === true ? 100 : remainingPercentOf(limit);
  const tone = barTone(percent);
  const resetMs = toMs(limit && limit.nextResetTime);
  const details = limit && Array.isArray(limit.usageDetails)
    ? limit.usageDetails.filter((detail) => detail !== null && typeof detail === 'object').slice(0, 6)
    : [];

  const facts = [];
  if (used !== null && total !== null) {
    facts.push(el('span', {
      key: 'used',
    }, t('quota.usedOfTotal', {
      used: formatCompact(used, locale),
      total: formatCompact(total, locale),
    })));
  }
  if (remaining !== null) {
    facts.push(el('span', { key: 'remaining' }, t('quota.remainingValue', {
      remaining: formatCompact(remaining, locale),
    })));
  }

  const children = [
    el('div', { key: 'value', className: 'bmc-page-quota-value-row' },
      el('span', { className: 'bmc-page-quota-value' }, formatPercentValue(percent, locale)),
      el('span', { className: 'bmc-page-quota-unit' }, t('quota.remaining'))),
    el('div', { key: 'bar', className: 'bmc-page-quota-bar' },
      el(Bar, {
        percent: percent === null ? 0 : percent,
        tone,
        height: 8,
        label: t('quota.remainingPercent', { percent: formatPercentValue(percent, locale) }),
      })),
  ];
  if (facts.length > 0) {
    children.push(el('div', { key: 'facts', className: 'bmc-page-quota-facts' }, facts));
  }
  if (resetMs !== null) {
    children.push(el('div', { key: 'reset', className: 'bmc-page-quota-reset' },
      el('span', null, t('quota.resetIn', { time: formatCountdown(resetMs - now, t) })),
      el('span', { className: 'bmc-page-quota-reset-at' },
        t('quota.resetAt', { time: formatResetAt(resetMs, locale, now) }))));
  }
  if (details.length > 0) {
    children.push(el('div', { key: 'models', className: 'bmc-page-model-list' },
      el('p', { className: 'bmc-page-model-list-title' }, t('quota.modelUsage')),
      details.map((detail, index) => {
        const name = typeof detail.displayName === 'string' && detail.displayName.length > 0
          ? detail.displayName
          : (typeof detail.modelCode === 'string' && detail.modelCode.length > 0 ? detail.modelCode : '—');
        return el('div', {
          key: `model-${typeof detail.modelCode === 'string' ? detail.modelCode : index}`,
          className: 'bmc-page-model-row',
        },
        el('span', { className: 'bmc-page-model-name', title: name }, name),
        el('span', { className: 'bmc-page-model-value' }, formatCompact(detail.usage, locale)));
      })));
  }

  return el(Card, {
    className: cls('bmc-page-card', 'bmc-page-quota-card'),
    title: labelOfLimit(limit, t),
  }, el('div', { className: 'bmc-page-stack' }, children));
}

/**
 * Quota section: one card per quota window, or the no-plan empty card.
 * @param props - `t`, `locale`, `now`, `quota`, `family`, `overrides` (window id
 *   to boolean map of optimistic post-reset windows).
 * @returns the section element.
 */
export function QuotaSection(props) {
  const { t, locale, now, quota, family, overrides = null } = props ?? {};
  const limits = quota && Array.isArray(quota.limits)
    ? quota.limits.filter((limit) => limit !== null && typeof limit === 'object')
    : [];
  limits.sort((left, right) => windowOrder(windowOf(left)) - windowOrder(windowOf(right)));

  if (limits.length === 0) {
    return el(Card, { className: 'bmc-page-card' },
      el(EmptyState, {
        icon: 'gauge',
        title: t('quota.noPlanTitle'),
        body: t('quota.noPlanBody'),
        action: el(Button, {
          variant: 'ghost',
          size: 'sm',
          onClick: () => openUrl(planUrlFor(family)),
        }, el(Icon, { name: 'external', size: 14 }), t('quota.noPlanAction')),
      }));
  }

  return el('section', { className: 'bmc-page-stack' },
    el('div', { className: 'bmc-page-section-head' },
      el('h2', { className: 'bmc-page-section-title' }, t('page.sectionQuota')),
      quota && (typeof quota.level === 'string' || typeof quota.level === 'number')
        ? el(Badge, { tone: 'neutral' }, String(quota.level))
        : null),
    el('div', { className: 'bmc-page-quota-grid' },
      limits.map((limit, index) => {
        const windowName = windowOf(limit);
        return el(QuotaCard, {
          key: `quota-${windowName}-${index}`,
          t,
          locale,
          now,
          limit,
          fullOverride: overrides !== null && overrides[windowName] === true,
        });
      })));
}

/** Reset kinds with their Host resetType and dictionary keys. */
const RESET_KINDS = Object.freeze([
  {
    resetType: 'FIVE_HOUR',
    key: 'fiveHour',
    titleKey: 'reset.fiveHour',
    kindKey: 'reset.kindsFiveHour',
  },
  {
    resetType: 'WEEK',
    key: 'week',
    titleKey: 'reset.week',
    kindKey: 'reset.kindsWeek',
  },
]);

/**
 * Localized error text of a failed reset attempt.
 * @param t - translator.
 * @param error - store error payload.
 * @returns localized message.
 */
function resetErrorText(t, error) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  if (code === 'reset_throttled' || code === 'rate_limited') {
    return t('reset.throttled');
  }
  if (code === 'reset_unavailable') {
    return t('reset.unavailable');
  }
  return errorTextOf(error, t);
}

/**
 * Reset-chances card.
 *
 * The store generates the idempotency key and forces the reset/overview
 * refresh after a successful use, so the card only owns the inline confirm and
 * the per-attempt outcome.
 * @param props - `t`, `locale`, `now`, `reset`, `onUsed(resetType)`.
 * @returns the card element, or null when the payload has no window data.
 */
export function ResetCard(props) {
  const { t, locale, now, reset, onUsed } = props ?? {};
  const React = rt.React;
  const [confirmKind, setConfirmKind] = React.useState(null);
  const [busyKind, setBusyKind] = React.useState(null);
  const [outcome, setOutcome] = React.useState(null);
  if (reset === null || reset === undefined || typeof reset !== 'object') {
    return null;
  }
  const kinds = RESET_KINDS.filter((kind) => reset[kind.key] !== null && typeof reset[kind.key] === 'object');
  if (kinds.length === 0) {
    return null;
  }

  async function useReset(kind) {
    setConfirmKind(null);
    setBusyKind(kind.resetType);
    setOutcome(null);
    try {
      const result = await state.useReset(kind.resetType);
      if (result !== null && typeof result === 'object' && result.ok === true) {
        setOutcome({ status: 'success', kind: kind.kindKey });
        if (typeof onUsed === 'function') {
          onUsed(kind.resetType);
        }
      } else {
        const error = result !== null && typeof result === 'object' ? result.error : null;
        const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
        setOutcome({
          status: code === 'reset_throttled' || code === 'rate_limited' ? 'throttled' : 'error',
          error,
        });
      }
    } catch (error) {
      setOutcome({ status: 'error', error });
    } finally {
      setBusyKind(null);
    }
  }

  const notices = [];
  if (outcome !== null && outcome.status === 'success') {
    notices.push(el(Notice, { key: 'success', tone: 'info', children: el('span', null, t('reset.success')) }));
  } else if (outcome !== null && outcome.status === 'throttled') {
    notices.push(el(Notice, { key: 'throttled', tone: 'warn', children: el('span', null, t('reset.throttled')) }));
  } else if (outcome !== null && outcome.status === 'error') {
    notices.push(el(Notice, {
      key: 'error',
      tone: 'error',
      children: el('span', null, resetErrorText(t, outcome.error)),
    }));
  }

  const rows = [];
  for (const kind of kinds) {
    const data = reset[kind.key];
    const available = Array.isArray(data.available)
      ? data.available.filter((entry) => entry !== null && typeof entry === 'object')
      : [];
    const count = available.length;
    const expiries = available
      .map((entry) => toMs(entry.expireAt))
      .filter((value) => value !== null);
    const earliestExpiry = expiries.length > 0 ? Math.min(...expiries) : null;
    const latestUsed = data.latest !== null && typeof data.latest === 'object' ? toMs(data.latest.usedAt) : null;
    const kindLabel = t(kind.kindKey);
    const busy = busyKind === kind.resetType;
    const confirming = confirmKind === kind.resetType;

    rows.push(el('div', { key: `row-${kind.key}`, className: 'bmc-page-reset-row' },
      el('div', { className: 'bmc-page-reset-main' },
        el('span', { className: 'bmc-page-reset-title' }, t(kind.titleKey)),
        el('div', { className: 'bmc-page-reset-meta' },
          el('span', null, t('reset.availableCount', { count })),
          earliestExpiry !== null
            ? el('span', null, t('reset.expiresAt', { time: formatResetAt(earliestExpiry, locale, now) }))
            : null,
          latestUsed !== null
            ? el('span', null, t('reset.latestUsed', { time: formatResetAt(latestUsed, locale, now) }))
            : el('span', null, t('reset.neverUsed')))),
      el('div', { className: 'bmc-page-inline' },
        el('span', { className: 'bmc-page-reset-count' }, t('reset.availableCount', { count })),
        el(Button, {
          variant: count > 0 ? 'ghost' : 'subtle',
          size: 'sm',
          disabled: count === 0 || busy,
          busy,
          onClick: () => setConfirmKind(kind.resetType),
          title: count === 0 ? t('reset.none') : t('reset.useAria', { kind: kindLabel }),
        }, t('reset.use')))));

    if (confirming) {
      rows.push(el('div', { key: `confirm-${kind.key}`, className: 'bmc-page-confirm' },
        el('span', { className: 'bmc-page-confirm-text' }, t('reset.confirmUse', { kind: kindLabel })),
        el(Button, {
          variant: 'primary',
          size: 'sm',
          busy,
          onClick: () => useReset(kind),
        }, t('reset.confirmAction')),
        el(Button, {
          variant: 'subtle',
          size: 'sm',
          disabled: busy,
          onClick: () => setConfirmKind(null),
        }, t('page.cancel')),
        el('span', { className: 'bmc-page-field-hint' }, t('reset.confirmHint'))));
    }
  }

  return el(Card, {
    className: 'bmc-page-card',
    title: t('page.sectionReset'),
    actions: reset.hasUnreadHistory === true
      ? el(Badge, { tone: 'brand' }, t('reset.unreadHistory'))
      : null,
  }, el('div', { className: 'bmc-page-stack' }, [...notices, ...rows]));
}
