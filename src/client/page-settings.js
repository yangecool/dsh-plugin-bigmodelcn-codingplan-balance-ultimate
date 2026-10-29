/**
 * Configuration cards of the dedicated BigModel usage page: the plugin
 * settings card and the model-inference credential card.
 *
 * Both cards edit the plugin config through `state.saveConfig` and report the
 * save outcome inline; the inference card only displays the status object the
 * Host publishes, it never writes credentials itself.
 */
import { rt } from './runtime.js';
import { state } from './state.js';
import { Button, Card, Icon } from './ui.js';
import { formatCountdown, formatDateTime } from './page-format.js';
import {
  cls,
  familyId,
  joinProviderIds,
  parseRefreshMinutes,
  splitProviderIds,
  toMs,
} from './page-helpers.js';
import { openExternal, usageUrlFor } from './page-links.js';

/** Element factory routed through the runtime binding. */
function el(type, props, ...children) {
  const h = rt.h;
  return typeof h === 'function' ? h(type, props, ...children) : null;
}

/**
 * Refresh the overview once more after a short delay so the Host's
 * fire-and-forget inference sync is reflected by the status payload.
 * The timer only touches the singleton store, so no component state is updated
 * after unmount.
 * @returns nothing.
 */
function scheduleStatusRefresh() {
  try {
    setTimeout(() => {
      void state.refreshOverview({ force: true });
    }, 1500);
  } catch {
    // Environments without timers simply keep the first refresh result.
  }
}

/** Read the value of a DOM input event without assuming the event shape. */
function eventValue(event) {
  if (event !== null && typeof event === 'object' && event.target !== null && typeof event.target === 'object') {
    return typeof event.target.value === 'string' ? event.target.value : '';
  }
  return '';
}

/**
 * Plugin settings card: service family, refresh interval, provider gate, and a
 * shortcut to the website usage page.
 * @param props - `t`, `config`.
 * @returns the card element.
 */
export function SettingsCard(props) {
  const { t, config } = props ?? {};
  const React = rt.React;
  const [draftFamily, setDraftFamily] = React.useState('bigmodel');
  const [refreshText, setRefreshText] = React.useState('30');
  const [providersText, setProvidersText] = React.useState('');
  const [saveStatus, setSaveStatus] = React.useState('idle');
  const [refreshInvalid, setRefreshInvalid] = React.useState(false);

  React.useEffect(() => {
    if (config === null || config === undefined || typeof config !== 'object') {
      return;
    }
    setDraftFamily(config.family === 'zai' ? 'zai' : 'bigmodel');
    setRefreshText(String(config.refreshMinutes ?? 30));
    setProvidersText(joinProviderIds(config.providerIds));
  }, [config]);

  React.useEffect(() => {
    if (saveStatus !== 'saved' && saveStatus !== 'failed') {
      return undefined;
    }
    const timer = setTimeout(() => setSaveStatus('idle'), 2600);
    return () => clearTimeout(timer);
  }, [saveStatus]);

  async function save() {
    if (saveStatus === 'saving') return;
    const parsed = parseRefreshMinutes(refreshText);
    if (parsed.ok !== true) {
      setRefreshInvalid(true);
      return;
    }
    setRefreshInvalid(false);
    setSaveStatus('saving');
    try {
      const result = await state.saveConfig({
        family: draftFamily === 'zai' ? 'zai' : 'bigmodel',
        refreshMinutes: parsed.value,
        providerIds: splitProviderIds(providersText),
      });
      if (result !== null && typeof result === 'object' && result.ok === true) {
        setSaveStatus('saved');
        void state.refreshOverview({ force: true });
      } else {
        setSaveStatus('failed');
      }
    } catch {
      setSaveStatus('failed');
    }
  }

  if (config === null || config === undefined || typeof config !== 'object') {
    return el(Card, { className: 'bmc-page-card', title: t('settings.title') },
      el('div', { className: 'bmc-page-stack' },
        el('div', { className: 'bmc-page-skeleton bmc-page-skeleton-line' }),
        el('div', { className: 'bmc-page-skeleton bmc-page-skeleton-line is-short' }),
        el('span', { className: 'bmc-page-field-hint' }, t('settings.loading'))));
  }

  const providerIds = splitProviderIds(providersText);
  const currentProviderIds = Array.isArray(config.providerIds) ? config.providerIds : [];
  const providersEqual = providerIds.length === currentProviderIds.length
    && providerIds.every((id, index) => id === currentProviderIds[index]);
  const parsedRefresh = parseRefreshMinutes(refreshText);
  const dirty = draftFamily !== familyId(config.family)
    || parsedRefresh.ok !== true
    || parsedRefresh.value !== Number(config.refreshMinutes ?? 30)
    || providersEqual !== true;

  let feedback = null;
  let feedbackClass = 'bmc-page-save-feedback';
  if (saveStatus === 'saving') {
    feedback = t('settings.saving');
  } else if (saveStatus === 'saved') {
    feedback = t('settings.saved');
    feedbackClass = cls(feedbackClass, 'is-success');
  } else if (saveStatus === 'failed') {
    feedback = t('settings.saveFailed');
    feedbackClass = cls(feedbackClass, 'is-error');
  } else if (dirty) {
    feedback = t('settings.unsavedHint');
  }

  return el(Card, {
    className: 'bmc-page-card',
    title: t('settings.title'),
  }, el('div', { className: 'bmc-page-stack' },
    el('div', { className: 'bmc-page-field' },
      el('span', { className: 'bmc-page-field-label' }, t('settings.familyLabel')),
      el('div', { className: 'bmc-page-field-controls' },
        el('select', {
          className: 'bmc-page-select',
          value: draftFamily,
          'aria-label': t('settings.familyLabel'),
          onChange: (event) => {
            setDraftFamily(eventValue(event) === 'zai' ? 'zai' : 'bigmodel');
            setSaveStatus('idle');
          },
        },
        el('option', { value: 'bigmodel' }, t('settings.familyBigModel')),
        el('option', { value: 'zai' }, t('settings.familyZai')))),
      el('p', { className: 'bmc-page-field-hint' }, t('settings.familyHint'))),
    el('div', { className: 'bmc-page-field' },
      el('span', { className: 'bmc-page-field-label' }, t('settings.refreshLabel')),
      el('div', { className: 'bmc-page-field-controls' },
        el('input', {
          className: 'bmc-page-input is-narrow',
          type: 'number',
          min: 1,
          max: 1440,
          step: 1,
          value: refreshText,
          'aria-label': t('settings.refreshLabel'),
          onChange: (event) => {
            setRefreshText(eventValue(event));
            setRefreshInvalid(false);
            setSaveStatus('idle');
          },
        })),
      el('p', { className: 'bmc-page-field-hint' }, t('settings.refreshHint')),
      refreshInvalid === true
        ? el('p', { className: 'bmc-page-field-error' }, t('settings.invalidRefresh'))
        : null),
    el('div', { className: 'bmc-page-field' },
      el('span', { className: 'bmc-page-field-label' }, t('settings.providerLabel')),
      el('div', { className: 'bmc-page-field-controls' },
        el('input', {
          className: 'bmc-page-input',
          type: 'text',
          value: providersText,
          spellCheck: 'false',
          autoComplete: 'off',
          'aria-label': t('settings.providerLabel'),
          onChange: (event) => {
            setProvidersText(eventValue(event));
            setSaveStatus('idle');
          },
        })),
      el('p', { className: 'bmc-page-field-hint' }, t('settings.providerHint'))),
    el('div', { className: 'bmc-page-form-actions' },
      el(Button, { variant: 'primary', size: 'sm', onClick: save, busy: saveStatus === 'saving' },
        t('settings.save')),
      feedback !== null ? el('span', { className: feedbackClass }, feedback) : null,
      el('span', { className: 'bmc-page-spacer' }),
      el(Button, {
        variant: 'subtle',
        size: 'sm',
        onClick: () => openExternal(usageUrlFor(config)),
        title: t('settings.openUsagePageHint'),
      }, el(Icon, { name: 'external', size: 14 }), t('settings.openUsagePage')))));
}

/**
 * Model-inference credential card: toggle, credential reference, and the status
 * line the Host publishes after writing the Coding Plan token.
 * @param props - `t`, `locale`, `now`, `auth`, `config`, `inference`.
 * @returns the card element, or null while the config is still loading.
 */
export function InferenceCard(props) {
  const { t, locale, now, auth, config, inference } = props ?? {};
  const React = rt.React;
  const [refText, setRefText] = React.useState('');
  const [refStatus, setRefStatus] = React.useState('idle');
  const [toggleBusy, setToggleBusy] = React.useState(false);

  React.useEffect(() => {
    const current = config !== null && config !== undefined && typeof config === 'object'
      ? config.inferenceCredentialRef
      : '';
    setRefText(typeof current === 'string' ? current : '');
  }, [config === null || config === undefined ? null : config.inferenceCredentialRef]);

  React.useEffect(() => {
    if (refStatus !== 'saved' && refStatus !== 'failed' && refStatus !== 'invalid') {
      return undefined;
    }
    const timer = setTimeout(() => setRefStatus('idle'), 2600);
    return () => clearTimeout(timer);
  }, [refStatus]);

  if (config === null || config === undefined || typeof config !== 'object') {
    return null;
  }
  // Older Hosts do not publish the inference contract at all; hiding the card
  // avoids claiming a pending credential that will never be written.
  if (inference === null || inference === undefined) {
    if (config.inferenceEnabled === undefined && config.inferenceCredentialRef === undefined) {
      return null;
    }
  }

  const enabled = config.inferenceEnabled !== false;
  const autoCreateProvider = config.autoCreateProvider !== false;
  const loggedIn = auth !== null && auth !== undefined && auth.loggedIn === true && auth.loginExpired !== true;
  const statusInfo = inference !== null && inference !== undefined && typeof inference === 'object'
    ? inference
    : null;
  const reference = statusInfo !== null && typeof statusInfo.ref === 'string' && statusInfo.ref.length > 0
    ? statusInfo.ref
    : (typeof config.inferenceCredentialRef === 'string' ? config.inferenceCredentialRef : '');

  let tone = 'idle';
  let statusLabel = t('page.inferenceStatusPending');
  if (enabled !== true) {
    tone = 'idle';
    statusLabel = t('page.inferenceStatusDisabled');
  } else if (loggedIn !== true) {
    tone = 'idle';
    statusLabel = t('page.inferenceStatusNotLoggedIn');
  } else if (statusInfo !== null && statusInfo.available !== true) {
    tone = 'warn';
    statusLabel = t('page.inferenceStatusUnavailable');
  } else if (statusInfo !== null && typeof statusInfo.error === 'string' && statusInfo.error.length > 0) {
    tone = 'error';
    statusLabel = t('page.inferenceStatusFailed');
  } else if (statusInfo !== null && (toMs(statusInfo.expiresAt) !== null || toMs(statusInfo.writtenAt) !== null)) {
    tone = 'success';
    statusLabel = t('page.inferenceStatusActive');
  } else if (statusInfo !== null) {
    tone = 'idle';
    statusLabel = t('page.inferenceStatusPending');
  }

  const details = [];
  if (reference !== '') {
    details.push(el('span', { key: 'ref', className: 'bmc-page-inference-ref' },
      t('page.inferenceRefCode', { ref: reference })));
  }
  if (statusInfo !== null) {
    const expiresAt = toMs(statusInfo.expiresAt);
    const expiresInMs = typeof statusInfo.expiresInMs === 'number' && Number.isFinite(statusInfo.expiresInMs)
      ? statusInfo.expiresInMs
      : null;
    if (expiresAt !== null) {
      details.push(el('span', { key: 'expires' },
        t('page.inferenceExpiresIn', { time: formatCountdown(expiresAt - now, t) })));
    } else if (expiresInMs !== null) {
      details.push(el('span', { key: 'expires' },
        t('page.inferenceExpiresIn', { time: formatCountdown(expiresInMs, t) })));
    }
    const writtenAt = toMs(statusInfo.writtenAt);
    if (writtenAt !== null) {
      details.push(el('span', { key: 'written' },
        t('page.inferenceWrittenAt', { time: formatDateTime(writtenAt, locale) })));
    }
  }

  async function saveReference() {
    const value = refText.trim();
    if (value === '') {
      setRefStatus('invalid');
      return;
    }
    setRefStatus('saving');
    try {
      const result = await state.saveConfig({ inferenceCredentialRef: value });
      if (result !== null && typeof result === 'object' && result.ok === true) {
        setRefStatus('saved');
        void state.refreshOverview({ force: true });
        scheduleStatusRefresh();
      } else {
        setRefStatus('failed');
      }
    } catch {
      setRefStatus('failed');
    }
  }

  async function toggleEnabled() {
    if (toggleBusy) return;
    setToggleBusy(true);
    try {
      const result = await state.saveConfig({ inferenceEnabled: enabled !== true });
      if (result !== null && typeof result === 'object' && result.ok === true) {
        void state.refreshOverview({ force: true });
        scheduleStatusRefresh();
      }
    } catch {
      // The toggle falls back to the persisted value on the next render.
    } finally {
      setToggleBusy(false);
    }
  }

  async function toggleAutoProvider() {
    if (toggleBusy) return;
    setToggleBusy(true);
    try {
      const result = await state.saveConfig({ autoCreateProvider: autoCreateProvider !== true });
      if (result !== null && typeof result === 'object' && result.ok === true) {
        void state.refreshOverview({ force: true });
      }
    } catch {
      // The switch falls back to the persisted value on the next render.
    } finally {
      setToggleBusy(false);
    }
  }

  let feedback = null;
  let feedbackClass = 'bmc-page-save-feedback';
  if (refStatus === 'saving') {
    feedback = t('page.inferenceSaving');
  } else if (refStatus === 'saved') {
    feedback = t('page.inferenceSaved');
    feedbackClass = cls(feedbackClass, 'is-success');
  } else if (refStatus === 'failed') {
    feedback = t('page.inferenceSaveFailed');
    feedbackClass = cls(feedbackClass, 'is-error');
  }

  const detailsLine = details.length > 0
    ? el('div', { className: 'bmc-page-inference-line' }, details)
    : null;

  return el(Card, {
    className: 'bmc-page-card',
    title: t('page.inferenceTitle'),
  }, el('div', { className: 'bmc-page-stack' },
    el('p', { className: 'bmc-page-auth-body' }, t('page.inferenceBody')),
    el('div', { className: 'bmc-page-field' },
      el('label', { className: 'bmc-page-switch' },
        el('input', {
          type: 'checkbox',
          checked: enabled,
          disabled: toggleBusy,
          onChange: toggleEnabled,
          'aria-label': t('page.inferenceToggle'),
        }),
        el('span', { className: 'bmc-page-switch-track' },
          el('span', { className: 'bmc-page-switch-thumb' })),
        el('span', null, t('page.inferenceToggle'))),
      el('p', { className: 'bmc-page-field-hint' }, t('page.inferenceHint'))),
    el('div', { className: 'bmc-page-field' },
      el('label', { className: 'bmc-page-switch' },
        el('input', {
          type: 'checkbox',
          checked: autoCreateProvider,
          disabled: toggleBusy,
          onChange: toggleAutoProvider,
          'aria-label': t('page.providerToggle'),
        }),
        el('span', { className: 'bmc-page-switch-track' },
          el('span', { className: 'bmc-page-switch-thumb' })),
        el('span', null, t('page.providerToggle'))),
      el('p', { className: 'bmc-page-field-hint' }, t('page.providerHint'))),
    el('div', { className: 'bmc-page-field' },
      el('span', { className: 'bmc-page-field-label' }, t('page.inferenceRefLabel')),
      el('div', { className: 'bmc-page-field-controls' },
        el('input', {
          className: 'bmc-page-input',
          type: 'text',
          value: refText,
          spellCheck: 'false',
          autoComplete: 'off',
          'aria-label': t('page.inferenceRefLabel'),
          onChange: (event) => {
            setRefText(eventValue(event));
            setRefStatus('idle');
          },
          onBlur: () => {
            const current = typeof config.inferenceCredentialRef === 'string' ? config.inferenceCredentialRef : '';
            if (refText.trim() !== current) {
              void saveReference();
            }
          },
        }),
        el(Button, {
          variant: 'ghost',
          size: 'sm',
          busy: refStatus === 'saving',
          onClick: saveReference,
        }, t('page.inferenceSave'))),
      el('p', { className: 'bmc-page-field-hint' }, t('page.inferenceRefHint')),
      refStatus === 'invalid'
        ? el('p', { className: 'bmc-page-field-error' }, t('page.inferenceRefEmpty'))
        : null),
    el('div', { className: 'bmc-page-field' },
      el('span', { className: 'bmc-page-field-label' }, t('page.inferenceStatusLabel')),
      el('div', { className: cls('bmc-page-status', `is-${tone}`) },
        el('span', { className: 'bmc-page-status-dot' }),
        el('span', null, statusLabel)),
      detailsLine,
      feedback !== null ? el('span', { className: feedbackClass }, feedback) : null)));
}
