/**
 * Shared presentation primitives for the page and composer widget.
 *
 * Components are plain render functions without JSX: every element is built
 * with `rt.h`, which the runtime binds at plugin materialization time. All
 * colors come from `--dsw-alias-*` theme tokens or `color-mix()` around them,
 * so light and dark themes share one stylesheet. Every component tolerates
 * null/undefined props and renders nothing rather than empty chrome.
 */
import { rt } from './runtime.js';
import { Icon } from './icons.js';

export { Icon };

const BUTTON_VARIANTS = new Set(['primary', 'ghost', 'subtle']);
const BUTTON_SIZES = new Set(['sm', 'md']);
const TONES = new Set(['brand', 'success', 'warn', 'error', 'idle']);
const NOTICE_TONES = new Set(['info', 'warn', 'error']);
const BADGE_TONES = new Set(['neutral', 'brand', 'success', 'warn', 'error', 'idle']);

/** Join truthy class names. */
function cx(...names) {
  return names.filter((name) => typeof name === 'string' && name !== '').join(' ');
}

/** Element factory routed through the runtime binding; null before bindReact. */
function el(type, props, ...children) {
  return rt.h === null ? null : rt.h(type, props, ...children);
}

/** Whether a prop is worth rendering. */
function hasContent(value) {
  return value !== null && value !== undefined && value !== false && value !== '';
}

/** Clamp a percentage into 0..100; non-finite input becomes 0. */
function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

/** Pixel value for a size prop with a fallback and lower bound. */
function pixels(value, fallback, minimum) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, numeric) : fallback;
}

/**
 * Card container with an optional header row.
 * @param props - `title`, `subtitle`, `actions` (header nodes), `children`,
 *   `className` (extra classes).
 * @returns the card element.
 */
export function Card(props) {
  const { title, subtitle, actions, children, className } = props ?? {};
  const hasHead = hasContent(title) || hasContent(subtitle) || hasContent(actions);
  return el('section', { className: cx('bmc-card', className) },
    hasHead ? el('header', { className: 'bmc-card-head' },
      el('div', { className: 'bmc-card-headings' },
        hasContent(title) ? el('h2', { className: 'bmc-card-title' }, title) : null,
        hasContent(subtitle) ? el('p', { className: 'bmc-card-subtitle' }, subtitle) : null),
      hasContent(actions) ? el('div', { className: 'bmc-card-actions' }, actions) : null) : null,
    hasContent(children) ? el('div', { className: 'bmc-card-body' }, children) : null);
}

/**
 * Small section heading with an optional trailing action row.
 * @param props - `title`, `subtitle`, `actions`.
 * @returns the heading element, or null when every prop is empty.
 */
export function SectionHead(props) {
  const { title, subtitle, actions } = props ?? {};
  if (!hasContent(title) && !hasContent(subtitle) && !hasContent(actions)) return null;
  return el('div', { className: 'bmc-section-head' },
    el('div', { className: 'bmc-card-headings' },
      hasContent(title) ? el('h3', { className: 'bmc-section-title' }, title) : null,
      hasContent(subtitle) ? el('p', { className: 'bmc-section-subtitle' }, subtitle) : null),
    hasContent(actions) ? el('div', { className: 'bmc-card-actions' }, actions) : null);
}

/**
 * Button in the host's tonal style.
 * @param props - `variant` (`primary`|`ghost`|`subtle`, default ghost),
 *   `size` (`sm`|`md`, default md), `onClick`, `disabled`, `busy` (disables and
 *   shows a spinner), `children`, `title`, `type`, `className`.
 * @returns the button element.
 */
export function Button(props) {
  const {
    variant = 'ghost', size = 'md', onClick, disabled = false, busy = false,
    children, title, type = 'button', className,
  } = props ?? {};
  const safeVariant = BUTTON_VARIANTS.has(variant) ? variant : 'ghost';
  const safeSize = BUTTON_SIZES.has(size) ? size : 'md';
  return el('button', {
    type,
    className: cx('bmc-btn', `bmc-btn-${safeVariant}`, `bmc-btn-${safeSize}`, className),
    onClick,
    disabled: disabled === true || busy === true,
    'aria-busy': busy === true ? 'true' : undefined,
    title,
  }, busy === true ? el('span', { className: 'bmc-btn-busy' }, el(Spinner, { size: safeSize === 'sm' ? 12 : 14 })) : null, children);
}

/**
 * Square icon-only button; `label` is the required accessible name.
 * @param props - `label`, `onClick`, `icon` (icon name or node), `disabled`, `title`, `className`.
 * @returns the button element, or null when no label is given.
 */
export function IconButton(props) {
  const { label, onClick, icon, disabled = false, title, className } = props ?? {};
  if (!hasContent(label)) return null;
  return el('button', {
    type: 'button',
    className: cx('bmc-icon-btn', className),
    onClick,
    disabled: disabled === true,
    'aria-label': String(label),
    title: hasContent(title) ? String(title) : String(label),
  }, typeof icon === 'string' ? el(Icon, { name: icon, size: 16 }) : hasContent(icon) ? icon : null);
}

/**
 * Spinner; pass `label` to expose it as a status region, otherwise it is
 * decorative and the surrounding text must announce loading.
 * @param props - `size` in pixels, `label` (localized loading text), `className`.
 * @returns the spinner element.
 */
export function Spinner(props) {
  const { size = 16, label, className } = props ?? {};
  const dimension = pixels(size, 16, 8);
  const a11y = hasContent(label)
    ? { role: 'status', 'aria-label': String(label) }
    : { 'aria-hidden': 'true' };
  return el('span', { className: cx('bmc-spinner', className), style: { width: `${dimension}px`, height: `${dimension}px` }, ...a11y });
}

/**
 * Horizontal progress bar.
 * @param props - `percent` (0..100), `tone` (`brand`|`success`|`warn`|`error`|`idle`),
 *   `height` in pixels, `label` (localized, makes it a labeled progressbar), `className`.
 * @returns the bar element.
 */
export function Bar(props) {
  const { percent, tone = 'brand', height = 8, label, className } = props ?? {};
  const value = Math.round(clampPercent(percent) * 10) / 10;
  const safeTone = TONES.has(tone) ? tone : 'brand';
  const a11y = hasContent(label)
    ? { role: 'progressbar', 'aria-label': String(label), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': value }
    : { 'aria-hidden': 'true' };
  return el('div', { className: cx('bmc-bar', className), style: { height: `${pixels(height, 8, 2)}px` }, ...a11y },
    el('div', { className: cx('bmc-bar-fill', `bmc-bar-fill-${safeTone}`), style: { width: `${value}%` } }));
}

/**
 * Metric tile: caption, prominent value, optional hint.
 * @param props - `label`, `value`, `hint`, `tone` (colors the value).
 * @returns the stat element, or null when every prop is empty.
 */
export function Stat(props) {
  const { label, value, hint, tone } = props ?? {};
  if (!hasContent(label) && !hasContent(value) && !hasContent(hint)) return null;
  const safeTone = TONES.has(tone) ? tone : null;
  return el('div', { className: 'bmc-stat' },
    hasContent(label) ? el('span', { className: 'bmc-stat-label' }, label) : null,
    hasContent(value) ? el('span', { className: cx('bmc-stat-value', safeTone ? `bmc-stat-value-${safeTone}` : null) }, value) : null,
    hasContent(hint) ? el('span', { className: 'bmc-stat-hint' }, hint) : null);
}

/**
 * Segmented toggle group.
 * @param props - `value` (selected id), `options` (`[{ value, label }]` or strings),
 *   `onChange(value)` called on every click, `label` (group accessible name).
 * @returns the group element, or null when no option is given.
 */
export function Segmented(props) {
  const { value, options, onChange, label } = props ?? {};
  if (!Array.isArray(options) || options.length === 0) return null;
  const items = options.map((option, index) => {
    const optionValue = typeof option === 'string' ? option : option?.value;
    const optionLabel = typeof option === 'string' ? option : option?.label ?? option?.value;
    if (!hasContent(optionValue)) return null;
    return el('button', {
      key: String(optionValue),
      type: 'button',
      className: 'bmc-segmented-item',
      'aria-pressed': optionValue === value ? 'true' : 'false',
      onClick: () => {
        if (typeof onChange === 'function') onChange(optionValue);
      },
    }, optionLabel);
  });
  if (items.every((item) => item === null)) return null;
  return el('div', { className: 'bmc-segmented', role: 'group', 'aria-label': hasContent(label) ? String(label) : undefined }, items);
}

/**
 * Inline notice.
 * @param props - `tone` (`info`|`warn`|`error`), `title`, `children`, `action` (node row).
 * @returns the notice element, or null when every prop is empty.
 */
export function Notice(props) {
  const { tone = 'info', title, children, action } = props ?? {};
  if (!hasContent(title) && !hasContent(children) && !hasContent(action)) return null;
  const safeTone = NOTICE_TONES.has(tone) ? tone : 'info';
  const icon = safeTone === 'info' ? null : 'warning';
  return el('div', {
    className: cx('bmc-notice', `bmc-notice-${safeTone}`),
    role: safeTone === 'error' ? 'alert' : 'status',
  },
  (icon !== null || hasContent(title)) ? el('div', { className: 'bmc-notice-head' },
    icon !== null ? el(Icon, { name: icon, size: 14 }) : null,
    hasContent(title) ? el('p', { className: 'bmc-notice-title' }, title) : null) : null,
  hasContent(children) ? el('div', { className: 'bmc-notice-body' }, children) : null,
  hasContent(action) ? el('div', { className: 'bmc-notice-action' }, action) : null);
}

/**
 * Centered empty/error state.
 * @param props - `icon` (icon name or node), `title`, `body`, `action` (node row).
 * @returns the state element, or null when every prop is empty.
 */
export function EmptyState(props) {
  const { icon, title, body, action } = props ?? {};
  if (!hasContent(icon) && !hasContent(title) && !hasContent(body) && !hasContent(action)) return null;
  return el('div', { className: 'bmc-empty' },
    hasContent(icon) ? el('span', { className: 'bmc-empty-icon' }, typeof icon === 'string' ? el(Icon, { name: icon, size: 24 }) : icon) : null,
    hasContent(title) ? el('h3', { className: 'bmc-empty-title' }, title) : null,
    hasContent(body) ? el('p', { className: 'bmc-empty-body' }, body) : null,
    hasContent(action) ? el('div', { className: 'bmc-empty-action' }, action) : null);
}

/**
 * Label/value list; rows with an empty value are dropped.
 * @param props - `rows` array of `{ label, value }`.
 * @returns the description list, or null when no row is displayable.
 */
export function KeyValue(props) {
  const { rows } = props ?? {};
  if (!Array.isArray(rows)) return null;
  const visible = rows.filter((row) => row !== null && typeof row === 'object' && hasContent(row.label) && hasContent(row.value));
  if (visible.length === 0) return null;
  return el('dl', { className: 'bmc-kv' }, visible.map((row, index) => el('div', {
    className: 'bmc-kv-row',
    key: String(row.label) + String(index),
  },
  el('dt', { className: 'bmc-kv-label' }, row.label),
  el('dd', { className: 'bmc-kv-value' }, row.value))));
}

/**
 * Small status pill.
 * @param props - `tone` (`neutral`|`brand`|`success`|`warn`|`error`|`idle`), `children`.
 * @returns the badge element, or null when there is no content.
 */
export function Badge(props) {
  const { tone = 'neutral', children } = props ?? {};
  if (!hasContent(children)) return null;
  const safeTone = BADGE_TONES.has(tone) ? tone : 'neutral';
  return el('span', { className: cx('bmc-badge', `bmc-badge-${safeTone}`) }, children);
}

/**
 * Stylesheet for every `.bmc-` class rendered by this module.
 * Colors use only `--dsw-alias-*` tokens and `color-mix()` around them.
 */
export const CORE_CSS = `
.bmc-card{display:flex;flex-direction:column;gap:12px;padding:16px 20px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;min-width:0}
.bmc-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}
.bmc-card-headings{display:flex;flex-direction:column;gap:2px;min-width:0}
.bmc-card-title{margin:0;font-size:14px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.bmc-card-subtitle{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.bmc-card-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}
.bmc-card-body{display:flex;flex-direction:column;gap:12px;min-width:0}
.bmc-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.bmc-section-title{margin:0;font-size:13px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.bmc-section-subtitle{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.bmc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 14px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease}
.bmc-btn:disabled{opacity:.55;cursor:not-allowed}
.bmc-btn:focus-visible,.bmc-icon-btn:focus-visible,.bmc-segmented-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.bmc-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.bmc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.bmc-btn-ghost{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.bmc-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.bmc-btn-subtle{color:var(--dsw-alias-label-secondary)}
.bmc-btn-subtle:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.bmc-btn-sm{padding:5px 10px;border-radius:6px;font-size:12px}
.bmc-btn-md{padding:8px 14px}
.bmc-btn-busy{display:inline-flex;align-items:center}
.bmc-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .15s ease,color .15s ease,opacity .15s ease}
.bmc-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.bmc-icon-btn:disabled{opacity:.55;cursor:not-allowed}
.bmc-spinner{display:inline-block;flex:none;border:2px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,var(--dsw-alias-bg-layer-1));border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:bmc-spin .8s linear infinite}
.bmc-icon{display:block;flex:none}
@keyframes bmc-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.bmc-spinner{animation-duration:2.4s}.bmc-bar-fill{transition:none}}
.bmc-bar{position:relative;width:100%;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}
.bmc-bar-fill{height:100%;border-radius:inherit;transition:width .3s ease}
.bmc-bar-fill-brand{background:var(--dsw-alias-state-business-primary,var(--dsw-alias-link))}
.bmc-bar-fill-success{background:var(--dsw-alias-state-success-primary)}
.bmc-bar-fill-warn{background:var(--dsw-alias-state-warn-primary)}
.bmc-bar-fill-error{background:var(--dsw-alias-state-error-primary)}
.bmc-bar-fill-idle{background:var(--dsw-alias-state-idle-primary)}
.bmc-stat{display:flex;flex-direction:column;gap:2px;min-width:0}
.bmc-stat-label{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.bmc-stat-value{font-size:20px;font-weight:600;line-height:1.2;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.bmc-stat-value-brand{color:var(--dsw-alias-brand-primary)}
.bmc-stat-value-success{color:var(--dsw-alias-state-success-primary)}
.bmc-stat-value-warn{color:var(--dsw-alias-state-warn-primary)}
.bmc-stat-value-error{color:var(--dsw-alias-state-error-primary)}
.bmc-stat-value-idle{color:var(--dsw-alias-state-idle-primary)}
.bmc-stat-hint{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.bmc-segmented{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.bmc-segmented-item{padding:4px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.4;cursor:pointer}
.bmc-segmented-item:hover{color:var(--dsw-alias-label-primary)}
.bmc-segmented-item[aria-pressed="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary);font-weight:600}
.bmc-notice{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5}
.bmc-notice-info{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,var(--dsw-alias-border-l1))}
.bmc-notice-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,var(--dsw-alias-border-l1))}
.bmc-notice-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l1))}
.bmc-notice-head{display:flex;align-items:center;gap:6px;min-width:0}
.bmc-notice-title{margin:0;font-size:12px;font-weight:600;line-height:1.5}
.bmc-notice-body{min-width:0}
.bmc-notice-action{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
.bmc-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 12px;text-align:center;color:var(--dsw-alias-label-secondary)}
.bmc-empty-icon{display:inline-flex;color:var(--dsw-alias-label-secondary)}
.bmc-empty-title{margin:0;font-size:13px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.bmc-empty-body{margin:0;max-width:42ch;font-size:12px;line-height:1.6}
.bmc-empty-action{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:6px}
.bmc-kv{display:flex;flex-direction:column;gap:6px;margin:0}
.bmc-kv-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0}
.bmc-kv-label{margin:0;flex:none;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.bmc-kv-value{margin:0;min-width:0;font-size:12px;line-height:1.5;text-align:right;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.bmc-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;line-height:1.6;white-space:nowrap}
.bmc-badge-brand{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary)}
.bmc-badge-success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-success-primary)}
.bmc-badge-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-warn-primary)}
.bmc-badge-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-error-primary)}
.bmc-badge-idle{border-color:color-mix(in srgb,var(--dsw-alias-state-idle-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-idle-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-idle-primary)}
.bmc-scroll{overflow:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) var(--dsw-alias-bg-layer-1)}
.bmc-scroll::-webkit-scrollbar{width:6px;height:6px}
.bmc-scroll::-webkit-scrollbar-track{background:var(--dsw-alias-bg-layer-1)}
.bmc-scroll::-webkit-scrollbar-thumb{border-radius:999px;background:var(--dsw-alias-border-l2)}
.bmc-row{display:flex;align-items:center;gap:8px;min-width:0}
.bmc-stack{display:flex;flex-direction:column;gap:12px;min-width:0}
.bmc-muted{color:var(--dsw-alias-label-secondary)}
.bmc-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
`;
