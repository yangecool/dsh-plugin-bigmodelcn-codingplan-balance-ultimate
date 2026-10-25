/**
 * Client entry of dsh-plugin-bigmodelcn-codingplan-balance-ultimate.
 *
 * Registers one locale namespace, one stylesheet, and three UI contributions:
 *  - the sidebar icon of the dedicated usage page (`sidebar.panellist`),
 *  - the dedicated usage page itself (`main` keyed by PANEL_ID),
 *  - the composer remaining-quota trigger and popover (`conversation.input.right`).
 */
import { bindContext, bindReact } from './runtime.js';
import { setTranslate, state } from './state.js';
import { coreDicts } from './dicts-core.js';
import { CORE_CSS } from './ui.js';
import { BigModelUsagePage, PanelIcon, pageCss, pageDicts } from './page.js';
import { ComposerIndicator, indicatorCss, indicatorDicts } from './indicator.js';
import {
  ModelsAccountRow,
  ProviderCredentialNote,
  modelsRowCss,
  modelsRowDicts,
} from './models-row.js';

const PACKAGE_ID = 'dsh-plugin-bigmodelcn-codingplan-balance-ultimate';
const PANEL_ID = 'bigmodelcn-usage';
const LOCALE_NS = 'bigmodelcn-balance';
const STYLE_TAG_ID = `${PACKAGE_ID}-styles`;

/** Merge the per-module dictionaries into the two shipped locales. */
function mergeDicts() {
  return {
    zh: { ...coreDicts.zh, ...pageDicts.zh, ...indicatorDicts.zh, ...modelsRowDicts.zh },
    en: { ...coreDicts.en, ...pageDicts.en, ...indicatorDicts.en, ...modelsRowDicts.en },
  };
}

/**
 * Insert the plugin stylesheet once.
 * @returns disposer removing the style element.
 */
function insertStyles() {
  const existing = document.getElementById(STYLE_TAG_ID);
  if (existing !== null) {
    existing.remove();
  }
  const tag = document.createElement('style');
  tag.id = STYLE_TAG_ID;
  tag.dataset.plugin = PACKAGE_ID;
  tag.textContent = `${CORE_CSS}\n${pageCss}\n${indicatorCss}\n${modelsRowCss}`;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}

/**
 * Activate the Client half.
 * @param ctx - Client Cordis context.
 */
function apply(ctx) {
  bindContext(ctx);
  const translate = ctx.locale.bind(LOCALE_NS);
  setTranslate(translate);

  ctx.effect(() => ctx.locale.register(LOCALE_NS, mergeDicts()), 'bigmodelcn-balance: dictionaries');
  ctx.effect(() => insertStyles(), 'bigmodelcn-balance: stylesheet');
  ctx.effect(() => {
    void state.bootstrap().catch(() => {
      /* bootstrap failures surface through the store error state */
    });
    return () => {
      state.dispose();
    };
  }, 'bigmodelcn-balance: store bootstrap');
  ctx.effect(() => {
    const timer = setInterval(() => {
      state.tick();
    }, 30_000);
    return () => clearInterval(timer);
  }, 'bigmodelcn-balance: refresh ticker');

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => ctx.locale.bind(LOCALE_NS)('app.nav'),
  }, PanelIcon));
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: LOCALE_NS,
  }, BigModelUsagePage));
  // Second entry point: the same page is reachable from Settings, so the
  // feature is discoverable even when the sidebar rail is collapsed or hidden.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'bigmodelcn-usage',
    order: 12,
    label: () => ctx.locale.bind(LOCALE_NS)('app.nav'),
    locale: LOCALE_NS,
  }, BigModelUsagePage));
  // Models settings integration: the OAuth account row plus the per-provider
  // note that its API key is provisioned automatically. The keyed provider-card
  // seat is dispatched with the pi-ai settings namespace for every pi-ai route.
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'bigmodelcn-account',
    order: 10,
    locale: LOCALE_NS,
  }, ModelsAccountRow));
  // The pi-ai settings namespace is the Loader entry id; bundle-composed
  // profiles may expose it with the composition's `include:` prefix, so both
  // keys are registered. A key no card dispatches simply never renders.
  for (const providerCardKey of ['llm-pi-ai', 'include:llm-pi-ai']) {
    ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
      name: 'settings.models.provider-card',
      key: providerCardKey,
      locale: LOCALE_NS,
    }, ProviderCredentialNote));
  }
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'bigmodelcn-balance',
    order: 20,
    locale: LOCALE_NS,
  }, ComposerIndicator));
}

window.__ModuleLoader__.load({
  id: PACKAGE_ID,
  factory(require) {
    bindReact(require('react'));
    return {
      inject: ['locale', 'slots'],
      apply,
    };
  },
});
