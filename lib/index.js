/**
 * Host entry of dsh-plugin-bigmodelcn-codingplan-balance-ultimate.
 *
 * Wires the plugin's storage, HTTP, OAuth, account, upstream, snapshot, and
 * provider-provisioning modules into the Web server's same-origin routes. The
 * Client half (`./client`) renders the sidebar usage page and the composer
 * popover.
 */
import { createAccount } from './host/account.js';
import { createHttp } from './host/http.js';
import { createInference } from './host/inference.js';
import { createOAuth } from './host/oauth.js';
import { createProvider } from './host/provider.js';
import { registerRoutes } from './host/routes.js';
import { createSnapshot } from './host/snapshot.js';
import { createStore } from './host/store.js';
import { createUpstream } from './host/upstream.js';

/** The plugin cannot serve its browser routes without the Web server. */
export const inject = ['webServer'];

/**
 * Activate the Host half.
 * @param ctx - Host Cordis context with the `webServer` service.
 */
export function apply(ctx) {
  const logger = {
    info: (message) => ctx.logger?.info?.(`bigmodelcn-balance: ${message}`),
    warn: (message) => ctx.logger?.warn?.(`bigmodelcn-balance: ${message}`),
    debug: (message) => ctx.logger?.debug?.(`bigmodelcn-balance: ${message}`),
  };
  const now = () => Date.now();
  const store = createStore({ logger });
  const http = createHttp({ logger });
  const oauth = createOAuth({ http, store, logger, now });
  const account = createAccount({ http, store, logger, now });
  const upstream = createUpstream({ http, logger, now });
  const inference = createInference({
    store,
    account,
    logger,
    now,
    // Optional service: the Host may compose without the credentials seam.
    credentials: () => ctx.get('credentials'),
  });
  const provider = createProvider({
    store,
    logger,
    now,
    // Optional service: profiles are provisioned only while the settings seam
    // (the same one the Models page writes through) is mounted.
    resolveSettings: () => ctx.get('settings'),
  });
  const snapshot = createSnapshot({ store, oauth, account, upstream, inference, provider, logger, now });

  ctx.effect(() => inference.start(), 'bigmodelcn-balance: inference credential');
  // A stored login that predates this process must still get its provider row:
  // re-ensure once the settings service arrives (or immediately when it already
  // exists). The ensure re-reads config and settings, so a missing or disabled
  // state safely resolves to a typed skip.
  ctx.inject(['settings'], () => {
    void provider.ensure({ family: store.readAuth()?.family });
  });
  ctx.effect(
    () => registerRoutes({
      webServer: ctx.webServer,
      store,
      oauth,
      account,
      upstream,
      snapshot,
      inference,
      provider,
      logger,
      // Optional: the Web profile provides it; without it the routes serve
      // composition that no browser reaches.
      connection: () => ctx.get('connection'),
    }),
    'bigmodelcn-balance: host routes',
  );
}
