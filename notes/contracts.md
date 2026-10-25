# Plugin contracts and file ownership

Status: authoritative for this build. Everything runs in the DeepSeek Harness
(DSH) Web profile; the plugin is a Cordis bundle with a Host half and a Client
half. Read `notes/zcode-api-spec.md` (from zcode-recon) for the upstream
BigModel/ZCode protocol details.

## Layout

```
package.json          dsh.bundle.patch + dsh.client + exports (Lead)
cordis.patch.yml      one inserted row (Lead)
icon.svg              plugin artwork (Lead)
locale/{en,zh}.json   plugin metadata for Plugin Manager (Lead)
lib/index.js          Host entry: apply(ctx) wires store/http/oauth/account/upstream/snapshot/routes (Lead)
lib/host/constants.js protocol constants, families, defaults (Lead, done)
lib/host/http.js      HostError, sendJson/sendError, readJsonBody, createHttp (Lead, done)
lib/host/store.js     config + auth persistence (Lead, done)
lib/host/oauth.js     ZCode CLI OAuth start/poll state machine (host-core)
lib/host/account.js   customer info, API-key location, project access token, auth candidate probing (host-core)
lib/host/upstream.js  BigModel quota/subscription/monitor/reset requests + pure normalizers (host-core)
lib/host/snapshot.js  cached aggregations behind the routes (host-data)
lib/host/inference.js automatic model-inference sign-in: writes the Coding Plan project
                      token into the credential reference the pi-ai provider route resolves
                      (host-inference)
lib/host/routes.js    webServer route table (Lead, after host-core lands)
lib/client.js         BUILT artifact: committed, `node scripts/build-client.mjs` (Lead)
scripts/build-client.mjs  esbuild bundling of src/client -> lib/client.js (Lead)
src/client/entry.js   Client plugin entry: locale, styles, slot registrations (Lead)
src/client/runtime.js React binding + plugin context handle (Lead)
src/client/state.js   singleton client store, fetch, polling, login flow (Lead)
src/client/format.js  formatting helpers (Lead)
src/client/dicts-core.js  shared locale keys (Lead)
src/client/ui.js      shared primitives: Card/Button/Bar/Stat/Notice/Segmented/Spinner/Empty/Icon (Lead)
src/client/icons.js   SVG path data (Lead)
src/client/page.js    dedicated usage-statistics page + sidebar icon + its dicts/css (client-page)
src/client/indicator.js composer remaining-quota trigger + popover + its dicts/css (client-widget)
src/client/models-row.js Models settings page: BigModel account row (settings.models.footer) plus the
                      per-provider credential note (settings.models.provider-card keyed `llm-pi-ai`)
tests/host/*.test.mjs node:test unit tests with mocked fetch (host-core)
tests/client/*.mjs    pure helper tests (Lead/verifier)
notes/**              research notes (zcode-recon)
tests/fixtures/*.json sanitized upstream response samples (zcode-recon)
```

Rule: only the owner of a path writes it. `src/client/page.js` and
`src/client/indicator.js` may import extra sibling files they create
(`src/client/page-*.js`, `src/client/indicator-*.js`); nobody else writes those.

## Host conventions

- Plain ESM JavaScript, Node >= 24, no new runtime dependencies. Use `node:crypto` for tokens, `globalThis.fetch` via `lib/host/http.js`.
- Every module is created by a factory (`createX({ ... })`) and holds no module-level mutable state, so tests can instantiate several.
- Never log tokens, codes, or bodies. Log only endpoint origin+path, status, and a stable code (`lib/host/http.js#describeUrl`).
- Network calls always carry a timeout (`REQUEST_TIMEOUT_MS` unless stated).
- Upstream failures become `HostError` with a stable code; route handlers reuse the code. Do not leak upstream messages that may contain tokens.
- Test with `node --test tests/host/`; mock `fetchImpl` through `createHttp({ fetchImpl })`.

### `lib/host/oauth.js`

```js
createOAuth({ http, store, logger, now = () => Date.now() })
  -> {
    async start({ family })  // family: 'bigmodel' | 'zai'
      // POST ${ZCODE_ORIGIN}${OAUTH_INIT_PATH}, Authorization: Bearer <32-byte hex poll token>,
      // body { provider: family === 'zai' ? 'zai' : 'bigmodel' }
      // validates code === 0 + data.flow_id/authorize_url/expires_at/poll_interval_sec
      // remembers one pending flow in closure memory
      -> { authorizeUrl, expiresAt, pollIntervalMs, family }

    async poll()
      // Z.AI family only: after a ready poll, exchange the OAuth access token at
      // POST https://api.z.ai/api/auth/z/login body {"token": <oauth token>} (no auth header)
      // for a business JWT (data.access_token|data.accessToken, optional expires_in) and store
      // that as accessToken. Failure -> {state:'failed', error:'zai_business_login_failed'}.
      // BigModel family stores data.bigmodel.access_token raw.
      // no pending flow: store auth present ? {state:'ready'} : {state:'idle'}
      // now > pending.expiresAt: forget flow -> {state:'expired'}
      // now < pending.nextPollAt: {state:'pending'}
      // GET ${ZCODE_ORIGIN}${oauthPollPath(flowId)} Authorization: Bearer <poll token>
      // data.status 'pending' -> {state:'pending'}; 'failed' -> forget -> {state:'failed', error}
      // 'ready' -> validate data.token + data.<family>.access_token + data.user.user_id,
      //   store.writeAuth({ family, accessToken, zcodeJwtToken, refreshToken?,
      //     expiresAt: jwtExpiresAt(accessToken), loggedInAt: now(), user, account:{} keyLocation:null }),
      //   forget flow -> {state:'ready', user}
      // transport errors while polling: keep the flow, return {state:'pending'} (client retries)

    async cancel()   // forget pending flow
    pending()        // { family, authorizeUrl, expiresAt } | null
    async logout()   // cancel + store.clearAuth()
  }
```

`init` upstream errors: 5xx/unreachable -> `HostError('oauth_unavailable', 502)`;
invalid envelope -> `HostError('oauth_invalid_response', 502)`.
Token values never appear in errors or logs.

### `lib/host/account.js`

```js
createAccount({ http, store, logger, now = () => Date.now() })
  -> {
    async loadAccount({ family, accessToken, force })         // GET CUSTOMER_INFO_PATH
      -> { customerNumber?, customerName?, nickName?, avatar?,
           organizations: [{ organizationId, organizationName, projects: [{ projectId, projectName, projectType }] }] }
    pickPersonalProject(account)  // pure, exported: exclude projectType '2', prefer org name 默认机构,
                                  // then project name 默认项目, else first; null when none
    async ensureKeyLocation({ family, accessToken, force })   // GET apiKeysPath; reuse name API_KEY_NAME;
                                                              // create POST { name, usageScene: CODING_PLAN_USAGE_SCENE }
      -> { organizationId, projectId, apiKeyId }
    async issueProjectToken({ family, accessToken, keyLocation, force })
      // POST accessTokensPath, headers Authorization: Bearer <accessToken>, body
      // { clientType: ACCESS_TOKEN_CLIENT_TYPE, clientVersion: ACCESS_TOKEN_CLIENT_VERSION }
      -> { token, expiresAt }   // data.accessToken/data.access_token; min(data.expiresAt*1000, now+expiresIn*1000)
    async getProjectMaterial({ family, auth, force })
      // issueProjectToken over a cached keyLocation (ensureKeyLocation when missing), keeping one
      // in-memory material cache keyed by family + access token. Refreshes when less than
      // PROJECT_TOKEN_REFRESH_LEAD_MS remains. Returns { token, expiresAt, keyLocation }.
      // Never log or persist the token outside the auth document's bookkeeping.
    async probeAuthorization({ family, auth, channel, request })
      // channel: 'monitor' | 'business'
      // request(authorizationHeaderValue) -> { status, body }
      // Candidate order: raw project token (PAT), `Bearer <PAT>`, raw accessToken,
      // `Bearer <accessToken>`. ZCode proves monitor/quota/usage and personal subscription
      // reads are PAT-scoped (notes/zcode-api-spec.md §2.3/§2.4); the OAuth business token
      // is only for customerInfo/api_keys and the reset X-Bigmodel-Authorization header.
      // The project token is issued lazily (ensureKeyLocation + issueProjectToken) on the
      // first probe that needs it. Cache the winning candidate per `${family}:${channel}`
      // in memory. Return { authorization, response, kind }.
      // Any non-auth status (e.g. 200/409/400 business envelope) wins immediately.
      // If every candidate fails auth -> HostError('login_expired', 401).
    clearCache()
  }
```

Unauthorized mapping: 401/403 from customer info or key APIs -> `HostError('login_expired', 401)`.
Missing project -> `HostError('no_project', 409)`. Project token disabled -> `HostError('no_coding_plan', 409)`.

### `lib/host/upstream.js`

```js
createUpstream({ http, logger, now = () => Date.now() })
  -> {
    async quota({ family, auth, account })        // probeAuthorization channel 'monitor', GET QUOTA_LIMIT_PATH
      -> normalized { level, limits, envelope, status }
    async subscription({ family, auth, account }) // channel 'business', GET SUBSCRIPTION_LIST_PATH
      -> normalized { active, productId, productName, status, billingCycle, renewTime, expireAt, autoRenew, raw }
    async usage({ family, auth, account, range, timeZone })
      -> { range, timeZone, startTime, endTime, granularity, summary, series, models, tools }
    async credit({ family, auth, account, range, timeZone })
      -> { range, summary, models, mcp }
    async performance({ family, auth, account, range, timeZone })  // optional/degradable
      -> { ... } | null
    async resetStatus({ family, auth })   // needs auth.zcodeJwtToken + accessToken
    async useReset({ family, auth, resetType, idempotencyKey })
    async requestResetOpportunity({ family, auth, idempotencyKey })
    async markResetHistoryRead({ family, auth })
  }

// Pure, exported, unit-tested normalizers:
isSuccessfulEnvelope(payload)            // code undefined/0/200 and success !== false
envelopeMessage(payload)
isNoCodingPlanMessage(message)           // ZCode wording, see zcode-api-spec.md
normalizeQuota(payload)                  // -> { level, limits:[{type,unit,number,usage,currentValue,remaining,percentage,nextResetTime,usageDetails}] }
pickPrimaryLimit(limits)                 // weekly? per ZCode: TIME_LIMIT first, then remaining, then first
remainingPercent(limit)                  // 100 - percentage, clamped 0..100 (percentage is USED ratio)
normalizeSubscription(payload)
resolveUsageRange(range, now, timeZone)  // -> { startTime:'YYYY-MM-DD HH:mm:ss', endTime, granularity:'hour'|'day' }
normalizeModelUsage(payload)             // -> { summary:{tokens, calls, models:[]}, series, models }
normalizeToolUsage(payload)
normalizeCreditActivity(payload)
normalizeCreditDetail(payload, usageType)
normalizeResetStatus(payload)
normalizeProjectToken(payload)
```

Usage page data model (exact keys the Client renders):

```js
overview = {
  family, generatedAt,
  auth: { loggedIn, loginExpired, user, account, keyLocation },
  subscription: null | { active, productId, productName, status, billingCycle, renewTime, expireAt, autoRenew },
  quota: null | { level, limits: [{ type, unit, number, usage, currentValue, remaining, percentage,
              nextResetTime, window: 'fiveHour'|'week'|'tool'|'other', usageDetails: [{ modelCode, displayName, usage }] }] },
  remaining: null | { percentage, nextResetTime },
  reset: null | { fiveHour: { available: [{expireAt}], latest: {usedAt}|null },
                  week: { available: [{expireAt}], latest: {usedAt}|null }, hasUnreadHistory },
  inference: { enabled, available, ref, writtenAt, expiresAt, expiresInMs, error },
  stale: boolean, error: {code,message}|null,
}

usage = { range, timeZone, generatedAt, granularity,
  summary: { totalTokens, totalCalls, activeDays?, peakDailyTokens?, peakDailyTokensDate?,
             totalCredits?, averageDailyCredits?, cacheHitRate?, currentStreakDays?, longestStreakDays? },
  series: [{ date|time, tokens, calls, mcpCalls? }],
  models: [{ modelCode, modelName, tokens, calls, credits? }],
  tools: [{ toolCode, toolName, calls, credits? }] }
```

### `lib/host/inference.js`

Automatic model-inference sign-in. DSH's `llm-pi-ai` provider route `zai-coding-cn`
points at `https://open.bigmodel.cn/api/coding/paas/v4` and resolves its key from the
credential reference `ZAI_CODING_CN_API_KEY` through `ctx.credentials.resolve(ref)`
on every call. The plugin therefore issues the Coding Plan project token after OAuth
login and writes it into that reference, so model inference works with no pasted key,
and refreshes it before expiry so the provider keeps working.

```js
createInference({ account, store, credentials, logger, now })
  -> {
    async sync({ force } = {})
      // 1. credentials service is optional: () => ctx.get('credentials'); undefined -> status
      //    {available:false, error:'credentials_unavailable'} and no writes.
      // 2. config = store.readConfig(); disabled -> unset a previously written reference and stop.
      // 3. auth = store.readAuth(); the reference is auth.inference.ref (bookkeeping in the
      //    auth document). A changed configured reference unsets the old one first; a recorded
      //    family different from auth.family means the token belongs to the other origin, so
      //    rewrite it (status.family exposes the recorded family).
      // 4. Skip upstream work when auth.inference.expiresAt - now > INFERENCE_REFRESH_LEAD_MS
      //    and the reference is unchanged; otherwise account.getProjectMaterial({family, auth, force}).
      // 5. credentials.set(ref, token) then store.writeAuth({ ...auth, keyLocation,
      //    inference: { ref, family, writtenAt: now(), expiresAt, previousSource } }) where
      //    previousSource is credentials.describe(ref).source before the first write
      //    (bookkeeping only, never a value).
      // 6. 401/403 -> HostError('login_expired', 401); other failures are recorded in
      //    status().error and logged without tokens, never thrown from the timer path.
      // A single in-flight promise per call; token values never logged.

    async clear()     // credentials.unset(auth.inference.ref) when present, drop auth.inference,
                      // used by logout and when the user disables the feature
    async status()    // { enabled, available, ref, writtenAt, expiresAt, expiresInMs, error }
    start()           // immediate sync + INFERENCE_SYNC_INTERVAL_MS timer; returns dispose
  }
```

### `lib/host/snapshot.js`

```js
createSnapshot({ store, oauth, account, upstream, logger, now })
  -> {
    async status()            // no upstream unless tokens need validation
    async overview({ force }) // 30s TTL; probes auth; returns the overview above; never throws for
                              // no-plan/upstream failures: reports { error } with last good data marked stale
    async usage({ range, timeZone, force })
    async reset({ force })
    async useReset({ resetType, idempotencyKey })
    async loginStatus()       // delegates to oauth.poll(); on state 'ready' call inference.sync()
    async logout()            // inference.clear() then oauth.logout(), then store.clearAuth()
  }
```

`status()` and `overview()` include `inference: await inference.status()`; `overview()` also
calls `inference.sync()` (fire-and-forget, never fails the overview) so a refreshed page or the
auto-refresh tick renews the inference credential. `logout()` unsets the credential the login
wrote and clears the auth document.

Snapshot rules:
- `store.readAuth()` is the only login source. Absent -> `{loggedIn:false}`.
- If `expiresAt` is in the past -> treat as `loginExpired`, keep the user name for display, clear stored tokens.
- Customer info is cached in memory (and written back to auth.account/keyLocation) for 1h; `force` re-reads.
- Quota/subscription fetches run in parallel; a failed quota does not hide a good subscription and vice versa.
- 401/403 -> `loginExpired` + stored tokens cleared. 409/no-plan -> `noCodingPlan`. Network/timeout -> `upstream_failed`, keep the last good payload with `stale:true`.
- Every successful response records `generatedAt`. No request loops; one in-flight promise per cache key.

## Host route contract

All routes are under `/bigmodelcn-codingplan` on the same origin as the Web GUI.
They require an authenticated browser session: `registerRoutes` calls
`ctx.get('connection')?.requestRejection(request)` first and answers 401/403 for
untrusted peers (the raw Web server bypasses the connection carrier's gate, so the
plugin restores it). If the optional `connection` service is absent, routes serve.
Success: HTTP 200 `{ "data": <payload> }`. Failure: HTTP 4xx/5xx
`{ "error": { "code": string, "message": string } }`.

| Method + path | Body | Data |
| --- | --- | --- |
| `GET /api/status` | – | `{ config, auth: {loggedIn, loginExpired, user, account, family}, login: {state, authorizeUrl?, expiresAt?}, inference }` |
| `POST /api/login` | `{ family? }` | `{ authorizeUrl, expiresAt, pollIntervalMs }` |
| `GET /api/login/poll` | – | `{ state: 'idle'\|'pending'\|'ready'\|'failed'\|'expired', user?, error? }` |
| `POST /api/logout` | – | `{ ok: true }` |
| `POST /api/config` | partial config | full sanitized config |
| `GET /api/overview?force=1` | – | overview (above) |
| `GET /api/usage?range=today\|7d\|30d&tz=<IANA>&force=1` | – | usage (above) |
| `GET /api/reset?force=1` | – | reset block |
| `POST /api/reset/use` | `{ resetType: 'FIVE_HOUR'|'WEEK', idempotencyKey }` | `{ used: true }` |

Error codes: `invalid_request` 400, `not_logged_in` 409, `login_expired` 401,
`login_pending` 409, `login_not_started` 409, `no_coding_plan` 409,
`no_project` 409, `reset_unavailable` 409, `reset_throttled` 429,
`upstream_failed` 502, `upstream_timeout` 504, `internal_error` 500.

## Client half

The Client half is authored as ESM under `src/client/` and bundled by
`scripts/build-client.mjs` (esbuild, IIFE) into `lib/client.js`, which ends with
`window.__ModuleLoader__.load({ id: PACKAGE_ID, factory(require) { ... return { inject, apply } } })`.
`lib/client.js` is committed: end users never build. The factory receives React
through `require('react')` and binds it with `bindReact(React)`.

`entry.js` registers, all through `ctx.effect` / `ctx.slots.inject`:

1. locale dictionaries: `ctx.locale.register(LOCALE_NS, { zh, en })`;
2. one `<style data-plugin>` tag with the concatenated CSS of every module;
3. `sidebar.panellist` list entry `id: PANEL_ID`, `order: 20`, `label: () => translate('app.nav')`, component `PanelIcon`;
4. `main` keyed entry `key: PANEL_ID`, `locale: LOCALE_NS`, component `BigModelUsagePage`;
5. `conversation.input.right` list entry `id: 'bigmodelcn-balance'`, `order: 20`, `locale: LOCALE_NS`, component `ComposerIndicator`;
6. a 30-second ticker calling `state.tick()` (auto refresh + countdown notifications);
7. `settings.models.footer` list entry `id: 'bigmodelcn-account'`, `order: 10`, component `ModelsAccountRow`;
8. `settings.models.provider-card` keyed entries under `llm-pi-ai` (and the composition-prefixed
   `include:llm-pi-ai` alias) rendering `ProviderCredentialNote` inside every pi-ai provider card.

Slot component props available to write:
- `main`/page: `t` (from `locale`), no session binding; use `state`/hooks.
- `conversation.input.right`: `t`, `sessionId` (branded string), plus standard kit. Read the
  current provider through `rt.ctx.get('modelDirectories')` when present:
  `models.directoryFor(sessionId).store.getSnapshot().current?.provider`;
  hide when `config.providerIds.length > 0` and the provider is not listed; when
  `modelDirectories` is absent, show the widget.

Locale dicts: `{ zh: { 'key': '文本' }, en: { 'key': 'Text' } }`; keys are
flat, dot-separated, prefixed per owner (`app.*`, `auth.*`, `quota.*`, `page.*`,
`widget.*`, `action.*`, `state.*`). English copy uses sentence case.
Placeholders: `{name}`.

CSS: plain classes with the `.bmc-` prefix. Only `--dsw-alias-*` theme tokens
(plus `color-mix(in srgb, ...)` around them) may be used for colors; space,
radius, font-size may be literal. Cards: `background: var(--dsw-alias-bg-layer-1)`,
borders `var(--dsw-alias-border-l1)`, secondary text
`var(--dsw-alias-label-secondary)`, accent `var(--dsw-alias-brand-primary)`,
success `--dsw-alias-state-success-primary`, warning `--dsw-alias-state-warn-primary`,
error `--dsw-alias-state-error-primary`. Popovers use `--dsw-alias-bg-overlay`
with `box-shadow: 0 12px 32px rgb(0 0 0 / 18%)`. Never hardcode colors, never
import Harness client packages.

Available theme tokens: `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`,
`--dsw-alias-bg-layer-2`, `--dsw-alias-bg-overlay`, `--dsw-alias-border-l1`,
`--dsw-alias-border-l2`, `--dsw-alias-brand-primary`,
`--dsw-alias-label-primary`, `--dsw-alias-label-secondary`,
`--dsw-alias-state-error-primary`, `--dsw-alias-state-idle-primary`,
`--dsw-alias-state-success-primary`, `--dsw-alias-state-warn-primary`,
`--dsw-specific-sidebar-fill`.

### Shared client modules (Lead)

`runtime.js`: `rt = { React, h, ctx }`, `bindReact(React)`, `bindContext(ctx)`.

`state.js`: singleton store. Snapshot:

```js
{
  config: null | { family, refreshMinutes, providerIds, showIndicatorWhenLoggedOut, usagePageUrl,
                   inferenceEnabled, inferenceCredentialRef },
  auth: null | { loggedIn, loginExpired, user, account, family },
  overview: null | (overview from GET /api/overview),
  usage: null | (usage from GET /api/usage),
  usageRange: 'today' | '7d' | '30d',
  reset: null | (reset block),
  login: { state: 'idle'|'starting'|'pending'|'ready'|'failed'|'expired', authorizeUrl: null|string, error: null|string },
  loading: { overview: bool, usage: bool, reset: bool, login: bool },
  error: null | { code, message },
  lastUpdated: null | number,
}
```

Methods: `subscribe(fn)`, `getSnapshot()`, `bootstrap()` (config + status once),
`refreshOverview({force})`, `loadUsage(range, {force})`, `loadReset({force})`,
`useReset(resetType)`, `startLogin({family})` (returns authorizeUrl),
`cancelLogin()`, `logout()`, `saveConfig(patch)`, `setUsageRange(range)`,
`tick()`, `dismissError()`, `translate(key, params)` (bound after locale registration).

`hooks.js`: `useSnapshot(selector?)`, `useNow(intervalMs)`.

`format.js`: `formatPercent`, `remainingPercent(limit)`, `formatNumber`,
`formatCompact`, `formatCredits`, `formatResetAt(ms, locale, now)`,
`formatDateTime`, `countdown(ms, t)`, `windowLabel(limit, t)`,
`limitUsed(limit)`, `limitTotal(limit)`, `remainingOf(limit)`.

`ui.js`: `Card`, `SectionHead`, `Button`, `IconButton`, `Spinner`, `Bar`,
`Stat`, `Segmented`, `Notice`, `EmptyState`, `KeyValue`, `Badge`, `Icon`
(from `icons.js`). These render host-consistent markup and only use `.bmc-`
classes defined in `ui.js`'s exported `CORE_CSS` (entry concatenates).

`dicts-core.js`: shared keys every component may use (`action.*`, `state.*`,
`auth.*`, `app.*`, `time.*`).

### Page module (`src/client/page.js`)

Exports `BigModelUsagePage`, `PanelIcon`, `pageDicts`, `pageCss`.

`BigModelUsagePage({ t })`: root-scope page, scrollable column, max-width ~840px:
- Header: title, account chip (avatar or initial, name, family badge), refresh button, last-updated.
- Logged-out / expired state: intro card explaining the OAuth login, `登录 BigModel` primary button;
  while pending: spinner + "在浏览器中完成授权…" + authorize link + cancel.
- Logged-in:
  1. Plan card: product name, status badge, billing cycle, renew/expire time, family, logout.
  2. Quota cards: one card per limit window (5-hour, weekly, tool) with remaining % bar,
     used/limit numbers, reset countdown; model breakdown rows when `usageDetails` exist;
     "no plan" empty state when the subscription is unavailable.
  3. Reset chances card: available 5h/week reset counts with expiry, latest history,
     use button (confirm inline, disabled when none), throttled/error notices.
  4. Usage statistics: range switcher (today/7d/30d), metric tiles (tokens, calls, credits,
     cache hit rate, streak days, peak day), a daily/hour trend chart (inline SVG bars/area,
     no chart dependency), model table (top 8 with share %), MCP/tool section when present.
     Loading skeleton, inline error with retry, empty state.
  5. Settings card: family select (bigmodel/zai), refresh interval (1..1440 minutes),
     provider gate list (comma-separated provider ids, empty = show always),
     open the BigModel usage page button.
- All copy from `t`; all data from `state`/hooks; no page-level network code.

`PanelIcon({ size, active })`: 16/18px SVG using `currentColor`; a compact quota
glyph (rounded square + three bars + dot). Must be recognizable at 16px.

### Composer widget module (`src/client/indicator.js`)

Exports `ComposerIndicator`, `indicatorDicts`, `indicatorCss`.

`ComposerIndicator({ t, sessionId })`:
- Gate: config loaded + auth logged in (or `showIndicatorWhenLoggedOut`) + provider gate.
  Hidden when logged out and the gate is off. While config is loading render nothing.
- Compact trigger in the composer tool row: two thin bars (5h/week) + remaining %,
  or a single "未登录" chip when `showIndicatorWhenLoggedOut` is on and logged out.
  Error/expired state shows a small warning dot; click opens the popover.
- Click toggles a floating popover anchored to the trigger (fixed positioning derived
  from `getBoundingClientRect`, opens upward, 300–340px wide, viewport-clamped,
  closes on outside pointerdown / Escape / route change):
  - header: plan level/product + family, refresh icon-button, close icon-button;
  - 5-hour and weekly bars with remaining %, used/total, reset countdown;
  - tool/MCP limit row when present;
  - quick stats: today's tokens and calls, reset chances available;
  - footer: last-updated + "打开用量页面" button (selects PANEL_ID through
    `rt.ctx.layout.selectPanel(PANEL_ID)`) + external usage page link.
- Hover tooltip via `title` attribute on the trigger; `aria-label` localized.
- Countdowns re-render every 30s through `useNow`.

## Commands

```sh
cd <plugin dir>
npm install --no-audit --no-fund            # esbuild only (dev)
node scripts/build-client.mjs               # src/client -> lib/client.js
node --test tests/host/*.test.mjs tests/client/*.test.mjs   # unit tests
node -e "import('./lib/index.js').then(m=>console.log(typeof m.apply))"
```

Install into the running Web profile is done by the Lead through the
`plugin_manager` tool (`install_bundle`, target = this directory).
