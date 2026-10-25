/**
 * Same-origin HTTP routes of the plugin's Host half.
 *
 * The Client bundle calls these routes with `fetch`; every route answers
 * `{ data }` on success and `{ error: { code, message } }` with a non-2xx status
 * on failure. Upstream credentials never leave the Host process.
 */
import { HostError, readJsonBody, sendError, sendJson } from './http.js';
import { FAMILIES, FAMILY_IDS, ROUTE_PREFIX, USAGE_RANGES } from './constants.js';

/** True when the request method equals `expected`. */
function isMethod(request, expected) {
  return (request.method ?? 'GET').toUpperCase() === expected;
}

/** Answer 405 with the allowed method set. */
function methodNotAllowed(response, allowed) {
  response.writeHead(405, { allow: allowed.join(', ') });
  response.end();
}

/** Read an optional boolean query flag (`1`/`true`). */
function queryFlag(url, name) {
  const value = url.searchParams.get(name);
  return value === '1' || value === 'true';
}

/** Validate a requested usage range. */
function readRange(url) {
  const range = url.searchParams.get('range') ?? 'today';
  if (!USAGE_RANGES.includes(range)) {
    throw new HostError('invalid_request', `Unknown usage range "${range}"`, { status: 400 });
  }
  return range;
}

/** Validate an IANA time-zone string without leaking parser errors. */
function readTimeZone(url) {
  const timeZone = url.searchParams.get('tz') ?? '';
  if (timeZone === '') return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    throw new HostError('invalid_request', 'Unknown time zone', { status: 400 });
  }
}

/** Validate a login request body. */
function readFamily(body, fallback) {
  const family = typeof body.family === 'string' && body.family.trim() !== '' ? body.family.trim() : fallback;
  if (!FAMILY_IDS.includes(family)) {
    throw new HostError('invalid_request', `Unknown provider family "${family}"`, { status: 400 });
  }
  return family;
}

/** Validate the reset-use request body. */
function readResetUse(body) {
  const resetType = typeof body.resetType === 'string' ? body.resetType.trim() : '';
  if (!['FIVE_HOUR', 'WEEK'].includes(resetType)) {
    throw new HostError('invalid_request', 'resetType must be FIVE_HOUR or WEEK', { status: 400 });
  }
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (idempotencyKey === '' || idempotencyKey.length > 64) {
    throw new HostError('invalid_request', 'idempotencyKey must be 1-64 characters', { status: 400 });
  }
  return { resetType, idempotencyKey };
}

/**
 * Wrap one async route handler: reject unknown methods, map HostError to its
 * response, and log unexpected failures without response details.
 * @param handler - async (request, response) implementer.
 * @returns the webServer route handler.
 */
function routeHandler(handler) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      if (!(error instanceof HostError)) {
        console.error('bigmodelcn-balance: unexpected route failure', error);
      }
      sendError(response, error);
    }
  };
}

/**
 * Register the plugin's routes on the Web server.
 * @param options - webServer service, plugin state modules, and logger.
 * @returns disposer removing every route.
 */
export function registerRoutes(options) {
  const { webServer, store, oauth, snapshot } = options;
  const disposers = [];
  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}${path}`, handler: routeHandler(handler) }));
  };

  route('/api/status', async (request, response) => {
    if (!isMethod(request, 'GET')) return methodNotAllowed(response, ['GET']);
    sendJson(response, 200, { data: await snapshot.status() });
  });

  route('/api/login', async (request, response) => {
    if (!isMethod(request, 'POST')) return methodNotAllowed(response, ['POST']);
    const body = await readJsonBody(request);
    const config = store.readConfig();
    const family = readFamily(body, config.family);
    sendJson(response, 200, { data: await oauth.start({ family }) });
  });

  route('/api/login/poll', async (request, response) => {
    if (!isMethod(request, 'GET')) return methodNotAllowed(response, ['GET']);
    sendJson(response, 200, { data: await snapshot.loginStatus() });
  });

  route('/api/logout', async (request, response) => {
    if (!isMethod(request, 'POST')) return methodNotAllowed(response, ['POST']);
    await snapshot.logout();
    sendJson(response, 200, { data: { ok: true } });
  });

  route('/api/config', async (request, response) => {
    if (!isMethod(request, 'POST')) return methodNotAllowed(response, ['POST']);
    const body = await readJsonBody(request);
    sendJson(response, 200, { data: store.writeConfig(body) });
  });

  route('/api/overview', async (request, response) => {
    if (!isMethod(request, 'GET')) return methodNotAllowed(response, ['GET']);
    sendJson(response, 200, { data: await snapshot.overview({ force: queryFlag(request.url ? new URL(request.url, 'http://localhost') : undefined, 'force') }) });
  });

  route('/api/usage', async (request, response) => {
    if (!isMethod(request, 'GET')) return methodNotAllowed(response, ['GET']);
    const url = new URL(request.url ?? '/', 'http://localhost');
    sendJson(response, 200, {
      data: await snapshot.usage({ range: readRange(url), timeZone: readTimeZone(url), force: queryFlag(url, 'force') }),
    });
  });

  route('/api/reset', async (request, response) => {
    if (!isMethod(request, 'GET')) return methodNotAllowed(response, ['GET']);
    sendJson(response, 200, { data: await snapshot.reset({ force: queryFlag(new URL(request.url ?? '/', 'http://localhost'), 'force') }) });
  });

  route('/api/reset/use', async (request, response) => {
    if (!isMethod(request, 'POST')) return methodNotAllowed(response, ['POST']);
    const body = await readJsonBody(request);
    sendJson(response, 200, { data: await snapshot.useReset(readResetUse(body)) });
  });

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

/** Re-export the family table for route-level logging/tests. */
export { FAMILIES };
