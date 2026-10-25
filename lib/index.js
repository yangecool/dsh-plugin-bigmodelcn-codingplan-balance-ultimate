/**
 * Host entry of dsh-plugin-bigmodelcn-codingplan-balance-ultimate.
 *
 * Wires the plugin's storage, HTTP, OAuth, account, upstream, and snapshot
 * modules into the Web server's same-origin routes. The Client half
 * (`./client`) renders the sidebar usage page and the composer popover.
 */
import { createAccount } from './host/account.js';
import { createHttp } from './host/http.js';
import { createOAuth } from './host/oauth.js';
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
  const snapshot = createSnapshot({ store, oauth, account, upstream, logger, now });

  ctx.effect(
    () => registerRoutes({ webServer: ctx.webServer, store, oauth, account, upstream, snapshot, logger }),
    'bigmodelcn-balance: host routes',
  );
}
