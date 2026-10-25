/**
 * React hooks shared by the page and composer widget.
 *
 * React is never imported here: every hook reads `rt.React`/`rt.ctx` at call
 * time, so importing this module before the plugin factory binds the runtime
 * is safe. Hooks must only be called from components rendered after binding.
 */
import { rt } from './runtime.js';
import { state } from './state.js';

/** Throw a diagnostic instead of a null dereference when hooks run unbound. */
function requireReact() {
  const React = rt.React;
  if (React === null || typeof React !== 'object') {
    throw new Error('bigmodelcn-balance: client runtime is not bound; call bindReact before rendering');
  }
  return React;
}

/**
 * Subscribe to the store through `useSyncExternalStore`, with a
 * `useState` + `useEffect` fallback for React versions without it.
 * @param React - bound React namespace.
 * @param subscribe - stable subscribe function.
 * @param getSnapshot - stable snapshot reader; must return the same reference until a change.
 * @returns the current snapshot.
 */
function useExternalSnapshot(React, subscribe, getSnapshot) {
  if (typeof React.useSyncExternalStore === 'function') {
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }
  const [value, setValue] = React.useState(getSnapshot);
  React.useEffect(() => {
    let active = true;
    const update = () => {
      if (active) setValue(getSnapshot());
    };
    update();
    const unsubscribe = subscribe(update);
    return () => {
      active = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [subscribe, getSnapshot]);
  return value;
}

/**
 * Subscribe to the singleton store.
 * @param selector - optional projection applied to the snapshot on every
 *   render. Omit it to read the whole snapshot. Return primitives or stable
 *   references to avoid unnecessary child re-renders.
 * @returns the selected value.
 */
export function useSnapshot(selector) {
  const React = requireReact();
  const snapshot = useExternalSnapshot(React, state.subscribe, state.getSnapshot);
  return typeof selector === 'function' ? selector(snapshot) : snapshot;
}

/**
 * Re-render on an interval so countdowns and relative timestamps stay fresh.
 * @param intervalMs - tick interval in milliseconds (minimum 1000, default 30000).
 * @returns the current epoch milliseconds sampled at each tick.
 */
export function useNow(intervalMs = 30_000) {
  const React = requireReact();
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const numeric = Number(intervalMs);
    const delay = Number.isFinite(numeric) ? Math.max(1000, numeric) : 30_000;
    const timer = setInterval(() => setNow(Date.now()), delay);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Read the locale service from the bound plugin context, when injected. */
function localeService() {
  try {
    const ctx = rt.ctx;
    return ctx === null || ctx === undefined ? null : ctx.locale ?? null;
  } catch {
    // The service is absent from this composition; components fall back to
    // the document language and the store's bound translate function.
    return null;
  }
}

/** Read the active language from the document for the no-service fallback. */
function documentLocale() {
  const doc = globalThis.document;
  const lang = doc?.documentElement?.lang;
  return typeof lang === 'string' && lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Map any active locale id to the dictionary locale ids this plugin ships. */
function toDictionaryLocale(active) {
  return typeof active === 'string' && active.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * Resolve the active dictionary locale and the store's translate function.
 * Subscribes to the locale service so a language switch re-renders format
 * output; the translate function itself reads the active dictionary at call
 * time, so no rebind is needed.
 * @returns `{ t, translate, locale }` where `locale` is `'zh'` or `'en'`.
 */
export function useLocalized() {
  const React = requireReact();
  const service = localeService();
  const subscribe = React.useCallback((listener) => {
    if (service === null || typeof service.subscribe !== 'function') return () => {};
    return service.subscribe(listener);
  }, [service]);
  const getSnapshot = React.useCallback(() => {
    if (service !== null && typeof service.getLocale === 'function') {
      const snapshot = service.getLocale();
      return snapshot !== null && typeof snapshot === 'object' ? snapshot.active : undefined;
    }
    return documentLocale();
  }, [service]);
  const active = useExternalSnapshot(React, subscribe, getSnapshot);
  const translate = state.translate;
  return { t: translate, translate, locale: toDictionaryLocale(active) };
}
