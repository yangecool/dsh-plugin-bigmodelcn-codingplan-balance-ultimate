/**
 * Small HTTP/JSON helpers shared by the Host modules of this plugin.
 *
 * The plugin talks to external services (BigModel, ZCode's OAuth relay) and to
 * the browser plugin UI. Upstream failures are represented as typed
 * {@link HostError}s so route handlers can answer with a stable error code.
 */

/** Typed failure with a stable machine-readable code and an HTTP status. */
export class HostError extends Error {
  /**
   * @param code - stable error code the Client maps to localized copy.
   * @param message - short English diagnostic (never contains credentials).
   * @param options - optional HTTP status and extra detail for logs.
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.status = options.status ?? 500;
    this.detail = options.detail;
  }
}

/** JSON response with no-store cache semantics. */
export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

/** Send a typed HostError response without leaking its detail. */
export function sendError(response, error) {
  const hostError = error instanceof HostError ? error : new HostError('internal_error', 'Unexpected plugin failure');
  sendJson(response, hostError.status, { error: { code: hostError.code, message: hostError.message } });
}

/**
 * Read one JSON request body with a size limit.
 * @param request - incoming HTTP request.
 * @param limit - maximum accepted byte size.
 * @returns the parsed JSON value (an object for every route of this plugin).
 * @throws {HostError} `invalid_request` for oversized, malformed, or non-object bodies.
 */
export function readJsonBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    /** Reject once and keep draining the request so the 413 response can be written. */
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
      // Destroying the socket here would make the documented 413 unreachable:
      // the handler still answers, but the peer sees ECONNRESET instead. Drain
      // the remaining body and let sendError deliver the status.
      request.resume();
    };
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HostError('invalid_request', 'Request body is too large', { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HostError('invalid_request', 'Request body must be a JSON object', { status: 400 }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new HostError('invalid_request', 'Request body is not valid JSON', { status: 400 }));
      }
    });
    request.on('error', () => fail(new HostError('invalid_request', 'Request body could not be read', { status: 400 })));
  });
}

/**
 * Build the HTTP client bound to one plugin instance.
 * @param options - optional fetch implementation and logger.
 * @returns request helpers used by OAuth, account, and upstream modules.
 */
export function createHttp(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger;

  /**
   * Perform one upstream request and read the whole body as text.
   *
   * HTTP error statuses are returned (never thrown) so callers decide whether a
   * status is an auth failure, a business failure, or a transport failure.
   * @param url - absolute URL.
   * @param init - method, headers, JSON body, timeout.
   * @returns status, headers, text, and the parsed JSON body when it parses.
   */
  async function request(url, init = {}) {
    const timeoutMs = init.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.json === undefined ? init.body : JSON.stringify(init.json),
        signal: controller.signal,
      });
      const text = await response.text();
      let body;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: response.status, ok: response.ok, headers: response.headers, text, body };
    } catch (error) {
      const aborted = controller.signal.aborted;
      logger?.warn?.(`upstream request failed: ${describeUrl(url)} (${aborted ? 'timeout' : String(error?.message ?? error)})`);
      throw new HostError(aborted ? 'upstream_timeout' : 'upstream_unreachable', 'Upstream request failed', {
        status: 502,
        detail: aborted ? 'timeout' : String(error?.message ?? error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return { request };
}

/** Strip query and fragment from a URL before putting it in a log line. */
export function describeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

/**
 * Decode the `exp` claim of a JWT without verifying it.
 * The value only tunes local refresh behavior; every request is still
 * authorized by the upstream service.
 * @param token - JWT-shaped token.
 * @returns expiry in epoch milliseconds, or null.
 */
export function jwtExpiresAt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Non-negative integer clamp helper for config values. */
export function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}
