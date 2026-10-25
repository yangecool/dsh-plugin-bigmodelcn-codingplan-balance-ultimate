/**
 * Models settings page integration for the BigModel account.
 *
 * Two contributions live here:
 *  - `ModelsAccountRow` in `settings.models.footer`: an account row that mirrors
 *    the host's own account row (identity, status dot, sign-in state, edit
 *    action) next to the provider rows;
 *  - `ProviderCredentialNote` in `settings.models.provider-card` (keyed by the
 *    pi-ai settings namespace): a short note inside a coding-plan provider card
 *    stating that the API key is provisioned by the OAuth sign-in, so nobody
 *    pastes a key that the plugin already manages.
 *
 * The plugin already writes the Coding Plan project token into the credential
 * reference the provider card resolves; this module only explains and manages
 * that state. It never touches the credential value.
 */
import { rt } from './runtime.js';
import { state } from './state.js';
import { useLocalized, useNow, useSnapshot } from './hooks.js';
import { Button, KeyValue, Notice, Spinner } from './ui.js';
import { countdown, formatDateTime } from './format.js';

/** Family id -> display label shown next to the account identity. */
const FAMILY_LABELS = Object.freeze({ bigmodel: 'BigModel', zai: 'Z.AI' });

/** createElement shorthand resolved at call time (React is bound after import). */
function el(type, props, ...children) {
  return rt.h(type, props, ...children);
}

/** True for a usable string. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Read a nested object safely. */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Status dot element with a tone class. */
function dot(tone) {
  return el('span', { className: `bmc-models-dot bmc-models-dot-${tone}`, 'aria-hidden': 'true' });
}

/** Open the account's dedicated usage page through the layout service. */
function openUsagePage() {
  try {
    const layout = rt.ctx?.get?.('layout');
    if (layout !== null && layout !== undefined && typeof layout.selectPanel === 'function') {
      layout.selectPanel('bigmodelcn-usage');
      return true;
    }
  } catch {
    /* the layout service is optional in unusual compositions */
  }
  return false;
}

/** Start the OAuth flow and open the relay authorize page in a new tab. */
function startSignIn(family, setError) {
  Promise.resolve(state.startLogin({ family }))
    .then((authorizeUrl) => {
      if (!text(authorizeUrl)) {
        setError('error');
        return;
      }
      let opened = null;
      try {
        opened = window.open(authorizeUrl, '_blank', 'noopener');
      } catch {
        opened = null;
      }
      // A blocked window keeps the waiting card's fallback link as the way out.
      if (opened === null) setError('popup');
    })
    .catch(() => {
      setError('error');
    });
}

/** Resolve the inference block from the snapshot (status payload first). */
function readInference(snap) {
  return record(snap?.inference) ?? record(record(snap?.overview)?.inference);
}

/** One localized inference status line. */
function inferenceCopy(t, inference, config, loggedIn) {
  const enabled = config?.inferenceEnabled !== false;
  if (!enabled) return { tone: 'idle', label: t('modelsRow.inferenceDisabled') };
  if (!loggedIn) return { tone: 'idle', label: t('modelsRow.inferenceNotLoggedIn') };
  if (inference === null) return { tone: 'idle', label: t('modelsRow.inferencePending') };
  if (inference.error === 'credentials_unavailable') {
    return { tone: 'warn', label: t('modelsRow.inferenceUnavailable') };
  }
  if (text(inference.error)) {
    return { tone: 'error', label: t('modelsRow.inferenceFailed') };
  }
  if (inference.expiresAt !== null && inference.expiresAt !== undefined) {
    return {
      tone: 'success',
      label: t('modelsRow.inferenceWritten', { ref: text(inference.ref) ? inference.ref : '' }),
      expiresAt: inference.expiresAt,
    };
  }
  return { tone: 'success', label: t('modelsRow.inferenceWritten', { ref: '' }) };
}

/**
 * Account row for the Models settings page.
 * @param props - `t` from the slot locale face.
 * @returns the account row card.
 */
export function ModelsAccountRow(props) {
  const { t } = props ?? {};
  const snap = useSnapshot();
  const { locale } = useLocalized();
  const now = useNow(30_000);
  const [expanded, setExpanded] = rt.React.useState(false);
  const [confirmLogout, setConfirmLogout] = rt.React.useState(false);
  const [busy, setBusy] = rt.React.useState(false);
  const [failure, setFailure] = rt.React.useState(null);

  const config = record(snap?.config);
  if (config === null) return null;
  const auth = record(snap?.auth);
  const login = record(snap?.login);
  const loggedIn = auth?.loggedIn === true;
  const expired = auth?.loginExpired === true;
  const pending = login?.state === 'pending' || login?.state === 'starting';
  const family = text(auth?.family) ? auth.family : (text(config.family) ? config.family : 'bigmodel');
  const user = record(auth?.user);
  const inference = readInference(snap);
  const inferenceInfo = inferenceCopy(t, inference, config, loggedIn);
  const statusTone = loggedIn ? 'success' : expired ? 'error' : pending ? 'idle' : 'idle';
  const statusLabel = loggedIn
    ? t('modelsRow.statusSignedIn')
    : expired
      ? t('modelsRow.statusExpired')
      : pending
        ? t('modelsRow.statusPending')
        : t('modelsRow.statusSignedOut');

  /**
   * Run one async account action with the shared busy/failure state.
   * @param action - operation returning `{ ok, error }`.
   */
  const run = (action) => {
    setBusy(true);
    setFailure(null);
    Promise.resolve(action())
      .then((result) => {
        if (result !== null && result !== undefined && result.ok === false) setFailure('error');
      })
      .catch(() => setFailure('error'))
      .finally(() => setBusy(false));
  };

  const onSignIn = () => startSignIn(family, (kind) => setFailure(kind));
  const onLogout = () => run(async () => {
    const result = await state.logout();
    setExpanded(false);
    setConfirmLogout(false);
    return result;
  });
  const usageLink = () => {
    if (!openUsagePage()) setFailure('error');
  };

  /** Headline actions: edit for a signed-in account, sign-in otherwise. */
  const actions = loggedIn
    ? [
        el(Button, {
          key: 'edit',
          variant: 'subtle',
          size: 'sm',
          onClick: () => { setExpanded((value) => !value); setFailure(null); },
          'aria-expanded': expanded ? 'true' : 'false',
        }, t(expanded ? 'modelsRow.actionClose' : 'modelsRow.actionEdit')),
      ]
    : pending
      ? [
          el('span', { key: 'waiting', className: 'bmc-models-pending' }, el(Spinner, { size: 12 }), t('modelsRow.statusPending')),
          el(Button, {
            key: 'cancel',
            variant: 'subtle',
            size: 'sm',
            onClick: () => { state.cancelLogin(); setFailure(null); },
          }, t('modelsRow.actionCancel')),
        ]
      : [
          el(Button, { key: 'login', variant: 'primary', size: 'sm', busy, onClick: onSignIn }, t('modelsRow.actionLogin')),
        ];

  const detailRows = [];
  if (loggedIn) {
    if (text(user?.name)) detailRows.push({ label: t('modelsRow.labelAccount'), value: user.name });
    if (text(user?.email)) detailRows.push({ label: t('modelsRow.labelEmail'), value: user.email });
    detailRows.push({ label: t('modelsRow.labelFamily'), value: FAMILY_LABELS[family] ?? family });
    if (Number.isFinite(auth?.loggedInAt)) {
      detailRows.push({ label: t('modelsRow.labelSignedInAt'), value: formatDateTime(auth.loggedInAt, locale) });
    }
    detailRows.push({
      label: t('modelsRow.labelInference'),
      value: el('span', { className: `bmc-models-inference bmc-models-inference-${inferenceInfo.tone}` },
        dot(inferenceInfo.tone),
        inferenceInfo.label,
        Number.isFinite(inferenceInfo.expiresAt)
          ? el('span', { className: 'bmc-models-inference-expiry' }, countdown(inferenceInfo.expiresAt, t, now))
          : null),
    });
  }

  return el('div', { className: 'bmc-models-row' },
    el('div', { className: 'bmc-models-head' },
      el('span', { className: 'bmc-models-glyph', 'aria-hidden': 'true' }, renderGlyph()),
      el('span', { className: 'bmc-models-identity' },
        el('span', { className: 'bmc-models-name' }, t('modelsRow.title')),
        el('span', { className: 'bmc-models-tag' }, t('modelsRow.tag')),
        el('span', { className: `bmc-models-status bmc-models-status-${statusTone}` },
          dot(statusTone),
          statusLabel)),
      el('span', { className: 'bmc-models-actions' }, actions)),
    pending && text(login?.authorizeUrl)
      ? el('div', { className: 'bmc-models-waiting' },
          el('span', null, t('modelsRow.waitingHint')),
          el('a', {
            className: 'bmc-models-link',
            href: login.authorizeUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
          }, t('modelsRow.actionOpenAuthorization')))
      : null,
    failure !== null
      ? el(Notice, { tone: failure === 'popup' ? 'warn' : 'error' }, t(failure === 'popup' ? 'modelsRow.popupBlocked' : 'modelsRow.errorGeneric'))
      : null,
    expanded && loggedIn
      ? el('div', { className: 'bmc-models-details' },
          el(KeyValue, { rows: detailRows }),
          el('p', { className: 'bmc-models-hint' }, t('modelsRow.hintNoKey')),
          el('div', { className: 'bmc-models-detail-actions' },
            el(Button, { variant: 'subtle', size: 'sm', onClick: usageLink }, t('modelsRow.actionOpenUsage')),
            confirmLogout
              ? el('span', { className: 'bmc-models-confirm' },
                  el('span', null, t('modelsRow.logoutConfirm')),
                  el(Button, { variant: 'subtle', size: 'sm', busy, onClick: onLogout }, t('modelsRow.actionConfirmLogout')),
                  el(Button, { variant: 'ghost', size: 'sm', onClick: () => setConfirmLogout(false) }, t('modelsRow.actionCancel')))
              : el(Button, { variant: 'subtle', size: 'sm', onClick: () => setConfirmLogout(true) }, t('modelsRow.actionLogout'))),
          el('p', { className: 'bmc-models-hint bmc-models-hint-muted' }, t('modelsRow.hintLogout')))
      : null);
}

/** Inline BigModel marks used by the account row (currentColor for the body). */
function renderGlyph() {
  return el('svg', { viewBox: '0 0 20 20', width: 18, height: 18, fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    el('rect', { x: 1.2, y: 1.2, width: 17.6, height: 17.6, rx: 4.4, stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.75 }),
    el('rect', { x: 5, y: 5.4, width: 10, height: 2.2, rx: 1.1, fill: 'currentColor' }),
    el('rect', { x: 5, y: 8.9, width: 7.4, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.78 }),
    el('rect', { x: 5, y: 12.4, width: 5, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.56 }),
    el('circle', { cx: 15.5, cy: 15.2, r: 2.5, fill: 'var(--dsw-alias-state-success-primary)' }));
}

/**
 * Credential note rendered inside one pi-ai provider card.
 * @param props - `t`, plus the slot's owner props `provider`, `configured`, `keyConfigured`.
 * @returns the note element, or null when the card is not a coding-plan route.
 */
export function ProviderCredentialNote(props) {
  const { t, provider } = props ?? {};
  const snap = useSnapshot();
  const [failure, setFailure] = rt.React.useState(null);
  const config = record(snap?.config);
  if (config === null) return null;
  const entry = record(provider);
  const providerId = text(entry?.provider) ? entry.provider : text(entry?.id) ? entry.id : '';
  if (providerId === '') return null;
  // Gate on the route's own identity, never on the composer widget's
  // `providerIds` list: that list configures the widget only, and an empty one
  // must not claim that every provider's API key is BigModel-provisioned.
  const routeDefaultBase = text(entry?.defaultBaseURL) ? entry.defaultBaseURL : '';
  const codingPlanRoute = providerId === 'zai-coding-cn'
    || providerId === 'zai'
    || routeDefaultBase.includes('open.bigmodel.cn/api/coding')
    || routeDefaultBase.includes('api.z.ai/api/coding');
  if (!codingPlanRoute) return null;

  const auth = record(snap?.auth);
  const loggedIn = auth?.loggedIn === true;
  const login = record(snap?.login);
  const pending = login?.state === 'pending' || login?.state === 'starting';
  const inference = readInference(snap);
  const written = loggedIn && inference !== null && !text(inference.error);

  if (written) {
    return el('p', { className: 'bmc-models-note' },
      dot('success'),
      el('span', null, t('modelsRow.noteManaged', { ref: text(inference.ref) ? inference.ref : '' })));
  }
  if (pending) {
    return el('p', { className: 'bmc-models-note' }, dot('idle'), el('span', null, t('modelsRow.notePending')));
  }
  return el('p', { className: 'bmc-models-note' },
    dot(loggedIn ? 'warn' : 'idle'),
    el('span', null, t('modelsRow.noteSignIn')),
    el('button', {
      type: 'button',
      className: 'bmc-models-inline-action',
      onClick: () => startSignIn(text(config.family) ? config.family : 'bigmodel', setFailure),
    }, t('modelsRow.actionLogin')),
    failure !== null
      ? el('span', { className: 'bmc-models-note-error' }, t(failure === 'popup' ? 'modelsRow.popupBlocked' : 'modelsRow.errorGeneric'))
      : null);
}

/** zh dictionary of the Models-page integration. */
const zh = {
  'modelsRow.title': 'BigModel 账号',
  'modelsRow.tag': 'OAuth',
  'modelsRow.statusSignedIn': '已登录',
  'modelsRow.statusSignedOut': '未登录',
  'modelsRow.statusExpired': '登录已过期',
  'modelsRow.statusPending': '等待浏览器授权…',
  'modelsRow.actionEdit': '编辑',
  'modelsRow.actionClose': '收起',
  'modelsRow.actionLogin': '登录 BigModel',
  'modelsRow.actionCancel': '取消',
  'modelsRow.actionOpenUsage': '打开用量统计',
  'modelsRow.actionLogout': '退出登录',
  'modelsRow.actionConfirmLogout': '确认退出',
  'modelsRow.actionOpenAuthorization': '打开授权页面',
  'modelsRow.labelAccount': '账号',
  'modelsRow.labelEmail': '邮箱',
  'modelsRow.labelFamily': '服务族',
  'modelsRow.labelSignedInAt': '登录时间',
  'modelsRow.labelInference': '模型推理凭证',
  'modelsRow.inferenceWritten': '已自动配置{ref}',
  'modelsRow.inferenceDisabled': '未启用',
  'modelsRow.inferenceNotLoggedIn': '等待登录',
  'modelsRow.inferencePending': '正在获取',
  'modelsRow.inferenceUnavailable': '凭证服务不可用',
  'modelsRow.inferenceFailed': '自动配置失败',
  'modelsRow.waitingHint': '请在新标签页完成 BigModel 授权；成功后会自动写入模型推理凭证。',
  'modelsRow.logoutConfirm': '退出登录会删除插件写入的模型推理凭证，确定？',
  'modelsRow.hintNoKey': '该供应商的 API 密钥由 BigModel OAuth 登录自动提供，无需手动粘贴。',
  'modelsRow.hintLogout': '退出登录会删除插件写入的凭证；如果配置过环境变量回退，它会重新生效。',
  'modelsRow.noteManaged': '模型推理凭证由 BigModel OAuth 自动提供{ref}',
  'modelsRow.notePending': '正在等待浏览器授权，完成后自动写入凭证。',
  'modelsRow.noteSignIn': '登录 BigModel 后自动提供模型推理凭证，无需粘贴密钥。',
  'modelsRow.popupBlocked': '浏览器拦截了授权窗口，请使用上方授权链接或允许弹窗后重试。',
  'modelsRow.errorGeneric': '操作失败，请稍后重试。',
};

/** en dictionary of the Models-page integration. */
const en = {
  'modelsRow.title': 'BigModel account',
  'modelsRow.tag': 'OAuth',
  'modelsRow.statusSignedIn': 'Signed in',
  'modelsRow.statusSignedOut': 'Not signed in',
  'modelsRow.statusExpired': 'Sign-in expired',
  'modelsRow.statusPending': 'Waiting for browser sign-in…',
  'modelsRow.actionEdit': 'Edit',
  'modelsRow.actionClose': 'Close',
  'modelsRow.actionLogin': 'Sign in to BigModel',
  'modelsRow.actionCancel': 'Cancel',
  'modelsRow.actionOpenUsage': 'Open usage statistics',
  'modelsRow.actionLogout': 'Sign out',
  'modelsRow.actionConfirmLogout': 'Confirm sign out',
  'modelsRow.actionOpenAuthorization': 'Open authorization page',
  'modelsRow.labelAccount': 'Account',
  'modelsRow.labelEmail': 'Email',
  'modelsRow.labelFamily': 'Provider family',
  'modelsRow.labelSignedInAt': 'Signed in',
  'modelsRow.labelInference': 'Model inference credential',
  'modelsRow.inferenceWritten': 'Provisioned automatically{ref}',
  'modelsRow.inferenceDisabled': 'Disabled',
  'modelsRow.inferenceNotLoggedIn': 'Waiting for sign-in',
  'modelsRow.inferencePending': 'Fetching',
  'modelsRow.inferenceUnavailable': 'Credential service unavailable',
  'modelsRow.inferenceFailed': 'Automatic setup failed',
  'modelsRow.waitingHint': 'Finish the BigModel authorization in the new tab; the model-inference credential is written automatically afterwards.',
  'modelsRow.logoutConfirm': 'Signing out removes the model-inference credential this plugin wrote. Continue?',
  'modelsRow.hintNoKey': "This provider's API key is provisioned automatically by the BigModel OAuth sign-in; no manual key is needed.",
  'modelsRow.hintLogout': 'Signing out removes the credential this plugin wrote; an environment-variable fallback becomes effective again if one is configured.',
  'modelsRow.noteManaged': 'Model inference credential is provisioned automatically by the BigModel OAuth sign-in{ref}',
  'modelsRow.notePending': 'Waiting for the browser sign-in; the credential is written automatically afterwards.',
  'modelsRow.noteSignIn': 'Sign in to BigModel to provision the model-inference credential automatically; no key paste is needed.',
  'modelsRow.popupBlocked': 'The browser blocked the authorization window; use the authorization link above or allow pop-ups and retry.',
  'modelsRow.errorGeneric': 'The action failed; try again later.',
};

/** Dictionaries merged into the plugin locale namespace. */
export const modelsRowDicts = Object.freeze({ zh, en });

/** Stylesheet for the Models-page integration (theme tokens only). */
export const modelsRowCss = `
.bmc-models-row{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;margin-top:8px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1))}
.bmc-models-head{display:flex;align-items:center;gap:10px;min-width:0}
.bmc-models-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.bmc-models-identity{display:inline-flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.bmc-models-name{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.bmc-models-tag{flex:none;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xs,4px);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.bmc-models-status{display:inline-flex;flex:none;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.bmc-models-status-success{color:var(--dsw-alias-state-success-primary)}
.bmc-models-status-error{color:var(--dsw-alias-state-error-primary)}
.bmc-models-status-idle{color:var(--dsw-alias-label-secondary)}
.bmc-models-dot{box-sizing:border-box;display:inline-block;flex:none;width:8px;height:8px;border-radius:50%}
.bmc-models-dot-success{background:var(--dsw-alias-state-success-primary)}
.bmc-models-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.bmc-models-dot-error{background:var(--dsw-alias-state-error-primary)}
.bmc-models-dot-idle{background:var(--dsw-alias-state-idle-primary)}
.bmc-models-actions{display:inline-flex;align-items:center;gap:8px;margin-left:auto;flex:none}
.bmc-models-pending{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.bmc-models-waiting{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.bmc-models-link{color:var(--dsw-alias-link);text-decoration:none}
.bmc-models-link:hover{text-decoration:underline}
.bmc-models-details{display:flex;flex-direction:column;gap:10px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1)}
.bmc-models-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.bmc-models-hint-muted{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.bmc-models-detail-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.bmc-models-confirm{display:inline-flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-state-error-primary)}
.bmc-models-inference{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px}
.bmc-models-inference-success{color:var(--dsw-alias-state-success-primary)}
.bmc-models-inference-warn{color:var(--dsw-alias-state-warn-primary)}
.bmc-models-inference-error{color:var(--dsw-alias-state-error-primary)}
.bmc-models-inference-idle{color:var(--dsw-alias-label-secondary)}
.bmc-models-inference-expiry{color:var(--dsw-alias-label-secondary);font-size:12px}
.bmc-models-note{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0;padding-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.bmc-models-inline-action{padding:0;border:none;background:none;font:inherit;font-size:12px;color:var(--dsw-alias-link);cursor:pointer}
.bmc-models-inline-action:hover{text-decoration:underline}
.bmc-models-note-error{flex-basis:100%;color:var(--dsw-alias-state-error-primary)}
@media (max-width:560px){
  .bmc-models-row{padding:10px 12px}
  .bmc-models-head{flex-wrap:wrap}
  .bmc-models-actions{margin-left:0;flex-basis:100%;justify-content:flex-end}
}
`;
