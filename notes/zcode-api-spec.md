# ZCode BigModel Coding Plan — API & UI recon spec

Status: reverse-engineered recon for the DSH plugin `dsh-plugin-bigmodelcn-codingplan-balance-ultimate`.
Source of truth: ZCode checkout `/home/yangecool/WorkSpace/Code/non-git-workspaces/harness-dev/ZCode` at
`3c5b227649371507ddc4eb46ac5133afe6db1cab` (2026-10-20, "chore: sync ZCode source"). Not modified.

Method: read/grep only. Every claim cites a ZCode source path (paths below are relative to the ZCode checkout root).
ZCode has **no public API contract** for these endpoints; contracts are interior to ZCode. Items that ZCode does not
prove are marked **[unverified]** or **[assumption]**. ZCode's own design notes are cited as `docs/...`; they are
first-party but were written for ZCode's internal consumers.

Fixtures: `tests/fixtures/*.json` in the plugin workspace, shapes taken from the ZCode sources cited in §11.

---

## 0. Cross-cutting conventions

### 0.1 Response envelopes and success codes

Different endpoint families use different envelopes. Do not share one parser.

| Family | Envelope | Success predicate | Evidence |
|---|---|---|---|
| OAuth CLI init/poll (`zcode.z.ai/api/v1/oauth/cli/*`) | `{ code: number, msg?: string, data?: unknown }` | `code === 0` exactly; non-2xx HTTP is an error before parsing | `apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts:131-170`, `:151-163` |
| BigModel biz + PAT management (`/api/biz/...`) | `{ code: number\|string, data: unknown }` (bigmodel also sends `msg`, `success`) | `code` ∈ `{0, 200, "0", "200"}` | `packages/shared/src/project-access-token-response.ts:3-9`, `packages/shared/src/project-access-token-client.ts:34-37` |
| Monitor quota/usage (`/api/monitor/...`) | `{ code?: number, msg?: string, message?: string, success?: boolean, data?: T \| null }` | `success !== false && (code === undefined \|\| code === null \|\| code === 0 \|\| code === 200)` | `packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts:1249-1260` |
| Coding Plan reset (`/api/v1/coding-plan/reset/*`) | `{ code: number, msg?: string, data?: unknown }` | `code === 0`; business code is read before HTTP status (`code !== 0` → `coding_plan_reset_api_error:<code>`) | `packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts:86-90`, `:1034-1077` |
| Subscription list (`/api/biz/subscription/list`) | `{ code?: number, success?: boolean, msg?: string, data?: item[] }` | `success !== false && (code === undefined \|\| code === 0 \|\| code === 200)` | `packages/services/src/bigmodel/codingPlanEntitlement.ts:58-69` |

ZCode accepts both `msg` and `message` for monitor errors (`bigmodelUsageQuotaProvider.ts:1235-1237`).

### 0.2 Time units (easy to get wrong)

| Value | Unit | Evidence |
|---|---|---|
| OAuth `expires_at` | **Unix seconds** | `apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts:20-25` (type) and `:172-198` (parse); `packages/services/src/oauth/oauthService.ts:671` multiplies by 1000 |
| OAuth `poll_interval_sec` | seconds (min 1s enforced) | `cli-oauth.ts:181-183`; `apps/zcode-cli/packages/bootstrap/src/auth-login-polling.ts:10,25` |
| PAT `expiresAt`, `expiresIn` | **Unix seconds** / seconds | `packages/shared/src/project-access-token.ts:143-156` multiplies `expiresAt` by 1000; fixture `apps/zcode-cli/packages/adapters/tests/auth.test.ts:400-410` uses `Math.floor(Date.now()/1000)+600` |
| Quota `nextResetTime` | **Unix milliseconds** | `docs/bigmodel-coding-plan-usage-quota.md` (`1778753640304`); typed as `number` ms in `packages/shared/src/usage-quota.ts:31`; rendered by `new Date(value)` in `packages/ui/src/lib/codingPlanQuotaPresentation.ts:112-167` |
| Reset `expire_at`, `used_at`, `next_try_at` | **Unix milliseconds** | `packages/services/test/codingPlanResetProvider.test.ts:161,283` (`1_786_090_230_000`); `docs/coding-plan-quota-reset-ui.md` "Unix 毫秒" |
| Zai business token `expires_in` | seconds | `packages/services/src/providers/zaiBusinessTokenResolver.ts:92-97` |
| Monitor `startTime`/`endTime` | `YYYY-MM-DD HH:mm:ss` literal (no TZ suffix) | `packages/services/src/usage-stats/providers/bigmodelUsageMonitorRange.ts:104-110` |

### 0.3 HTTP header casing

HTTP headers are case-insensitive, but ZCode's source spells them differently per endpoint. Record the exact spelling
when writing fixtures/tests, because DSH tests may compare raw header maps:

- Monitor quota/usage: lowercase `authorization`, and team scope `bigmodel-organization`, `bigmodel-project`
  (`bigmodelUsageQuotaProvider.ts:1151-1164`).
- Subscription list (personal): `Authorization` (`codingPlanEntitlement.ts:78-82`).
- PAT management: `Authorization` plus `bigmodel-organization`, `bigmodel-project` for team
  (`packages/shared/src/project-access-token-client.ts:305-316`, `packages/services/src/bigmodel/teamPlanApiKey.ts:51-61`).
- Coding Plan reset: `Authorization`, `X-Bigmodel-Authorization`, `Bigmodel-Target-Type`, `Bigmodel-Organization`,
  `Bigmodel-Project` (`bigmodelUsageQuotaProvider.ts:982-999`) — note the capitalized `Bigmodel-*` names here, unlike monitor.

---

## 1. Origins and environment split

Canonical constants: `packages/shared/src/zcodeEndpoint.ts` (`DEFAULT_ZCODE_ENDPOINT_ORIGIN`,
`DEFAULT_BIGMODEL_API_ORIGIN`, `DEFAULT_ZAI_OAUTH_ORIGIN`, `DEFAULT_ZAI_BUSINESS_BASE_URL`,
`DEFAULT_ZAI_OAUTH_CLIENT_ID`).

| Role | Production origin | Path prefix | Notes |
|---|---|---|---|
| ZCode backend (OAuth CLI flow, reset, billing) | `https://zcode.z.ai` | `/api/v1/...` | `buildZCodeEndpointUrls(...).apiBaseUrl = <origin>/api/v1`; reset base is built with `buildRuntimeZCodeApiUrl` |
| BigModel business API | `https://bigmodel.cn` | `/api/biz/...`, `/api/monitor/...` | payment endpoints are `/api/pay/...`; `buildBigModelApiUrl` |
| Z.AI OAuth origin | `https://chat.z.ai` | `/api/oauth/authorize`, `/api/oauth/userinfo` | `zaiProviderConfig.ts:21-23` |
| Z.AI business API | `https://api.z.ai` | `/api/biz/...`, `/api/monitor/...`, `/api/auth/z/login` | `zaiProviderConfig.ts:24`, `coding-plan-api-key.ts:19` |

Environment overrides (ZCode): `ZCODE_ENV=test|production`, `ZCODE_BASE_URL`/`ZCODE_ENDPOINT_ORIGIN`,
`BIGMODEL_API_BASE_URL` (plus test/production variants), `ZAI_BUSINESS_BASE_URL`, `ZAI_OAUTH_ORIGIN`,
`ZAI_OAUTH_CLIENT_ID`, and per-feature overrides `ZCODE_BIGMODEL_USAGE_API_KEY`/`BIGMODEL_USAGE_API_KEY`,
`ZCODE_BIGMODEL_USAGE_QUOTA_URL`/`BIGMODEL_USAGE_QUOTA_URL` (`bigmodelUsageQuotaProvider.ts:842-856`, `:1661-1663`).
ZCode's test fallbacks are identical to production for BigModel/ZCode origins and `api.z.ai` for Z.AI
(`zcodeEndpoint.ts` `TEST_*` constants) — i.e. there is no separate sandbox host for these calls.

**bigmodel vs zai origin split (verified):** the same path strings are requested on different origins per provider
family. Z.AI family calls `buildRuntimeZaiBusinessUrl(env, "/api/monitor/usage/quota/limit")` (`bigmodelUsageQuotaProvider.ts:1687-1690`),
BigModel family calls `buildBigModelApiUrl(env, "/api/monitor/usage/quota/limit")` (`:1683-1685`). Reset always uses the
ZCode origin regardless of family (`:529`, `:562`, `:592`, `:638`). Subscription list keeps the quota URL's origin
(`bigmodelSubscriptionProvider.ts:24`).

---

## 2. Credential model and the per-endpoint auth matrix

### 2.1 The credentials

| Key (ZCode credential store) | Meaning | Evidence |
|---|---|---|
| `zcodejwttoken` | ZCode backend login JWT, from OAuth poll `data.token` / token exchange `data.token`; shared by both platforms | `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts:15-23`, `docs/analysis/credentials-json-code-audit.md:183` |
| `oauth:bigmodel:access_token` | BigModel **business token / MaaS login JWT** (from poll `data.bigmodel.access_token`) | same refs, `:184-185` |
| `oauth:zai:access_token` | Z.AI **business JWT**, i.e. result of `/api/auth/z/login` (raw Z.AI OAuth token is exchanged) | `:184`, `zaiProviderAdapter.ts:298-306` |
| `oauth:bigmodel:refresh_token` | optional BigModel refresh token | `:186` |
| Project Access Token (PAT) | short-lived token minted from an API-key **ID** via `access_tokens` | `docs/model-provider-project-access-token.md`, `packages/shared/src/project-access-token.ts:10-31` |

### 2.2 Derivation chain (OAuth → usable API credential)

```
OAuth CLI poll ready
  data.token                    -> zcode JWT                         (Authorization: Bearer <jwt> for zcode.z.ai)
  data.bigmodel.access_token    -> BigModel business token           (raw Authorization for bigmodel.cn /api/biz/*)
  data.zai.access_token         -> Z.AI OAuth token
                                     | POST https://api.z.ai/api/auth/z/login {token}
                                     v
                                   Z.AI business JWT                  (raw Authorization for api.z.ai /api/biz/*)

BigModel business token
  GET  <bigmodel.cn>/api/biz/customer/getCustomerInfo   (Authorization: <business token> raw)
  GET  <bigmodel.cn>/api/biz/v1/organization/{org}/projects/{proj}/api_keys
  POST .../api_keys/{apiKeyId}/access_tokens            (Authorization: Bearer <business token>)
  -> PAT (Authorization: <PAT> raw for /api/monitor/*; Authorization: <PAT> for /api/biz/subscription/list)
```

Evidence: `packages/shared/src/project-access-token-client.ts:98-247` and `:249-346`;
`apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts:112-171`; `docs/model-provider-project-access-token.md`
("登录态 / 稳定账号身份 → 既有账号鉴权 owner → 有效 Token → 单次 HTTP attempt").

### 2.3 Which credential for which endpoint (verified in ZCode request code)

| Endpoint | Credential | Header (exact) | Evidence |
|---|---|---|---|
| `GET /api/biz/customer/getCustomerInfo` | BigModel business token / Z.AI business JWT (raw, **no Bearer**) | `Authorization: <token>` | `project-access-token-client.ts:255-267`; `docs/analysis/...:184-185` |
| `GET/POST /api/biz/v1/organization/{org}/projects/{proj}/api_keys` (personal, BigModel family) | BigModel business token raw | `Authorization: <token>` | `project-access-token-client.ts:312-316` |
| same (personal, Z.AI family) | Z.AI business JWT with Bearer | `Authorization: Bearer <token>` | `project-access-token-client.ts:315` |
| same (team, both families) | business token raw + scope headers | `Authorization: <token>`, `bigmodel-organization`, `bigmodel-project` | `project-access-token-client.ts:305-311` |
| `POST .../api_keys/{apiKeyId}/access_tokens` | business token | `Authorization: Bearer <token>` | `project-access-token-client.ts:128-131`, `:207-218` |
| `GET /api/monitor/usage/quota/limit` | **PAT** (Coding Plan project token), raw, no Bearer | `authorization: <PAT>` (+ team `bigmodel-organization`/`bigmodel-project`, `?type=2`) | `bigmodelUsageQuotaProvider.ts:1151-1176`; `docs/model-provider-project-access-token.md` table U01 |
| `GET /api/monitor/usage/*` (model/tool/credit/performance) | **PAT**, raw | `authorization: <PAT>` (+ team params) | `bigmodelUsageQuotaProvider.ts:899-979`, `:1564-1612`; doc table U02–U06 |
| `GET /api/biz/subscription/list` (personal) | **PAT**, raw | `Authorization: <PAT>` | `codingPlanEntitlement.ts:71-96`; `bigmodelSubscriptionProvider.ts:53-56` |
| `GET /api/biz/team/subscribe/product/querySubscribeDetail` (team) | family business token | `Authorization: Bearer <token>` for zai, raw for bigmodel; plus org/project headers | `bigmodelSubscriptionProvider.ts:27-46`; `codingPlanEntitlement.ts:98-131` |
| `GET/POST /api/v1/coding-plan/reset/*` | two credentials | `Authorization: Bearer <zcodejwttoken>`; `X-Bigmodel-Authorization: <family business token, raw>`; `Bigmodel-Target-Type`, `Bigmodel-Organization`, `Bigmodel-Project` | `bigmodelUsageQuotaProvider.ts:649-678`, `:982-999` |
| `POST https://api.z.ai/api/auth/z/login` | Z.AI OAuth access token (no auth header) | body `{"token": "<zai oauth token>"}` | `coding-plan-api-key.ts:126-131`; `zaiBusinessTokenResolver.ts:73-80` |
| `GET /api/v1/zcode-plan/billing/balance?app_version=<v>` (Start Plan, out of scope) | `zcodejwttoken` | `Authorization: Bearer <jwt>` | `docs/model-provider-coding-plan-availability.md` |

Team scope for quota/usage: `?type=2` and lowercase scope headers (`bigmodelUsageQuotaProvider.ts:1157-1176`,
`:1572-1579`); for credit-usage: `?type=3` (`:1590-1598`); `model-performance-day` takes no `type` (`:1602-1612`).

### 2.4 What this means for a plugin that only has OAuth tokens

Every personal quota/usage/subscription read in ZCode is performed with a **PAT**, not with the OAuth business token
(§2.3). The PAT must be minted first. ZCode's own design notes confirm the same for monitor endpoints
(`docs/model-provider-project-access-token.md` rows U01–U06, "Project Token"). Team-plan requests use the
family business token for the team subscription probe and a team project PAT for quota/usage. See §10 risk R1.

---

## 3. OAuth login via the ZCode CLI polling flow

Implementation: `apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts` (client), `apps/zcode-cli/packages/bootstrap/src/auth-login-polling.ts`
(poll loop), `apps/zcode-cli/packages/bootstrap/src/auth-login.ts` (orchestration). Desktop/Web equivalent:
`packages/services/src/oauth/oauthService.ts:629-853`.

Default base URL: `https://zcode.z.ai/api/v1` (`cli-oauth.ts:4`).

### 3.1 Init

```
POST https://zcode.z.ai/api/v1/oauth/cli/init
Authorization: Bearer <poll_token>
Content-Type: application/json

{"provider":"bigmodel"}      // or {"provider":"zai"}
```

- `poll_token`: client-generated, 32 random bytes hex = 64 chars (`cli-oauth.ts:6,123-125`).
- The request has **no** app id/secret/client registration; the poll token is the only client-supplied value.
- Response envelope (`cli-oauth.ts:131-170`): HTTP must be 2xx, JSON object with numeric `code`; `code !== 0` is a
  business error (`CliOAuthError.businessCode`), missing/non-numeric `code` is "Invalid OAuth response envelope".
- Success `data` (`cli-oauth.ts:172-198`):

```json
{
  "flow_id": "flow_01J8ZCODE0000000000000000",
  "poll_token": "3f2a...",              // echoed by the backend in tests; client ignores it and uses its own
  "authorize_url": "https://bigmodel.cn/login?appId=zcode&redirect=...&state=...",
  "expires_at": 1783000000,             // Unix seconds
  "poll_interval_sec": 2                // >= 1
}
```

- Validation that the client performs: `flow_id`, `authorize_url` non-empty strings, `expires_at` finite number,
  `poll_interval_sec` finite and `>= 1`, and `authorize_url` protocol must be `https:` (`cli-oauth.ts:172-198`).
- Error codes observed in tests: business code `3004` with `msg: "invalid_flow"` on init (`apps/zcode-cli/packages/adapters/tests/auth.test.ts:379-388`).

### 3.2 Poll

```
GET https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}
Authorization: Bearer <poll_token>
```

- `{flow_id}` is URL-encoded (`cli-oauth.ts:105`). No body, no content-type header.
- Response `data.status` is the discriminator (`cli-oauth.ts:200-212`): `"pending"`, `"failed"`, `"ready"`. Any other
  value/invalid shape is a parse error.

### 3.3 Ready payload

`cli-oauth.ts:214-239`:

```json
{
  "status": "ready",
  "token": "<zcode JWT>",
  "user": { "user_id": "u_1", "email": "a@b.c", "name": "Alice", "avatar": "https://..." },
  "bigmodel": { "access_token": "<bigmodel business token>", "refresh_token": "<optional>" }
  // or for provider=zai: "zai": { "access_token": "<zai oauth token>" }
}
```

- Required: non-empty `data.token`, object `data.user` with non-empty `user_id`, and a non-empty access token in the
  **requested provider's** block: `data[providerId].access_token`, fallback camelCase `accessToken`
  (`cli-oauth.ts:218-224`). `avatar`/`email`/`name` only copied when string.
- Refresh token: `data.bigmodel.refresh_token` or `data.bigmodel.refreshToken`; only the BigModel block
  (`packages/services/src/oauth/oauthService.ts:834-838`, `cli-oauth.ts:221`). **Z.AI has no refresh-token field**
  (`docs/analysis/credentials-json-code-audit.md:186-187`).
- A desktop poll response for `provider=bigmodel` only needs the `bigmodel` block; `parseReadyData` reads only
  `data[providerId]` and ignores unknown siblings (the fixture includes both blocks for documentation).

### 3.4 Poll loop rules

`apps/zcode-cli/packages/bootstrap/src/auth-login-polling.ts:12-68`:

- Deadline = `min(now + timeoutMs, expires_at * 1000)`; default `timeoutMs = 5 min`
  (`auth-login.ts:46`; desktop `OAUTH_TIMEOUT_MS = 5 * 60 * 1000`, `oauthService.ts:41`).
- Poll interval = `max(1000 ms, poll_interval_sec * 1000)`; sleep is clamped to the remaining deadline.
- Retry (do not abort) on: non-`CliOAuthError` failures (network), and `CliOAuthError` with `httpStatus` 408, 429, or
  `>= 500`. Abort immediately on other HTTP/business errors (`auth-login-polling.ts:41-49`). Desktop does the same for
  4xx except 408/429 and retries on network/5xx (`oauthService.ts:755-787`).
- `status === "ready"` → return; `"failed"` → error `auth_failed`; loop exhaustion → `auth_timeout`.
- Desktop additionally requires the `authorize_url` to contain a `state` query param, requires
  `poll_interval_sec >= 1s && < remaining lifetime`, and rewrites the callback param on the authorize URL:
  BigModel `?redirect=<desktop redirect uri>`, Z.AI `?redirect_uri=<desktop redirect uri>` (`oauthService.ts:674-711`).
  DSH plugin can skip this rewrite if it displays the URL for the user to open in a browser.

### 3.5 Desktop/Web variant: callback → token exchange (for completeness)

- Authorize URL base: BigModel `https://bigmodel.cn/login?redirect=<redirectUri>&appId=zcode&state=<state>`
  (`bigmodelProviderAdapter.ts` `buildAuthorizeUrl`; config `packages/services/src/oauth/providers/bigmodelProviderConfig.ts:18-21`).
- Callback params for BigModel accept `authCode` **or** `code` plus `state` (`bigmodelProviderAdapter.ts:92-115`).
- Exchange:

```
POST https://zcode.z.ai/api/v1/oauth/token
Content-Type: application/json

{"provider":"bigmodel"|"zai","code":"<code>","redirect_uri":"<uri>","state":"<state>"}
```

Response (`data`): `token` (zcode JWT), `bigmodel.access_token`/`accessToken`, `bigmodel.refresh_token`/`refreshToken`,
or `zai.access_token`; BigModel has fallbacks `data.access_token`/`data.accessToken` for older responses
(`bigmodelProviderAdapter.ts:129-221`, `:301-309`; `zaiProviderAdapter.ts:308-390`).
- Z.AI: the returned `data.zai.access_token` is a raw Z.AI OAuth token and is **exchanged** through
  `POST https://api.z.ai/api/auth/z/login` `{"token":"..."}` to obtain the business JWT before persistence
  (`zaiProviderAdapter.ts:298-306`; `packages/services/src/providers/zaiBusinessTokenResolver.ts:73-104`).
- BigModel: `data.bigmodel.access_token` is already the business token; no second exchange
  (`bigmodelProviderAdapter.ts:184-204`; `docs/oauth/oauth-multi-provider-implementation.md:§4`).
- Does **not** apply to the polling flow, which returns the ready payload directly.

### 3.6 Legacy BigModel `tokenByAuthCode` (do not build on it)

`apps/zcode-cli/packages/adapters/src/auth/bigmodel-oauth.ts:5-7,47-84`:
`POST https://bigmodel.cn/api/auth/tokenByAuthCode` with `{"appId":"zcode","appSecret":"<secret>","authCode":"<code>"}`,
response `{data:{accessToken,refreshToken}}`, requires an appSecret. ZCode removed this path from desktop login
(`docs/oauth/oauth-multi-provider-implementation.md:§2.5`; `bigmodelProviderAdapter.ts:166-168` comment). Not needed
for polling-based login.

---

## 4. BigModel business auth and Project Access Tokens

Primary sources: `packages/shared/src/project-access-token-client.ts`, `packages/shared/src/project-access-token.ts`,
`docs/model-provider-project-access-token.md`, `apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts`.

Terminology: the `apiKey` returned by the api_keys API is a **key ID**, not a secret; it is the path parameter for
`access_tokens`. The PAT response is the actual bearer material. ZCode deleted the old `api_keys/copy/{id}` secret path
for first-party OAuth (`docs/model-provider-project-access-token.md` T03).

### 4.1 `GET /api/biz/customer/getCustomerInfo`

```
GET https://bigmodel.cn/api/biz/customer/getCustomerInfo
Authorization: <bigmodel business token>          // raw, no "Bearer"
Content-Type: application/json
```

Z.AI family: `https://api.z.ai/api/biz/customer/getCustomerInfo` with the Z.AI business JWT raw
(`packages/services/src/oauth/oauthUnauthorizedRequest.ts:96-104`).

Validation (`packages/shared/src/project-access-token-client.ts:10-28,34-37,249-268`):

```json
{
  "code": 200,
  "data": {
    "customerNumber": "10000000001",
    "customerName": "Alice",
    "nickName": "alice",
    "avatar": "https://...",
    "organizations": [
      {
        "organizationId": "org-1",
        "organizationName": "默认机构",
        "projects": [
          { "projectId": "project-1", "projectName": "默认项目", "projectType": 1 }
        ]
      }
    ]
  }
}
```

- `code` must be one of `0/200/"0"/"200"`; `data.organizations` is an array (default `[]`); each org requires
  `organizationId: string`, optional `organizationName`; each project requires `projectId: string`, optional
  `projectName`, `projectType: string|number`.
- `customerNumber/customerName/nickName/avatar` are consumed by ZCode's BigModel userinfo adapter
  (`bigmodelProviderAdapter.ts:223-275`), not by the PAT client.
- BigModel returns a **zero-byte 200** for customer-info after account cancellation; ZCode treats empty body as
  "invalid credential" only for BigModel (`packages/services/src/oauth/oauthUnauthorizedRequest.ts:102-112`).

### 4.2 Personal organization/project selection rule

Desktop/service (`packages/services/src/model-provider/accountProviderApiKeyResolver.ts:18-56`):

1. Keep only orgs that have `organizationId` and at least one project.
2. Drop projects whose `projectType`, trimmed as a string, equals `"2"` ( **`projectType=2` means team project**;
   `1` is a personal project — fixtures `packages/desktop/wdio.conf.ts` use `projectType: 1/2`).
3. Prefer the org whose `organizationName` includes `默认机构` (`DEFAULT_ORG_NAME`), else the first remaining org.
4. Prefer the project whose `projectName` includes `默认项目` (`DEFAULT_PROJECT_NAME`), else the first project.
5. If nothing remains → `project_token_project_unavailable`.

CLI/Standalone passes `personalProjectSelection: "default"` and therefore **does not filter team projects**; it only
applies the default-name preference if available (`apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts:152`,
`packages/shared/src/project-access-token-client.ts:280-302`). Team selection (`input.team` given) validates that the
org+project pair exists in customerInfo and does not apply name preference
(`project-access-token-client.ts:270-280`).

### 4.3 API keys list/create

Base URL: `<origin>/api/biz/v1/organization/{organizationId}/projects/{projectId}/api_keys`
(`project-access-token-client.ts:349-354`).

```
GET  .../api_keys
Authorization: <bigmodel business token>            // personal BigModel: raw
Authorization: Bearer <zai business JWT>            // personal Z.AI
Authorization: <business token>                     // team (both families, raw)
bigmodel-organization: <orgId>                      // team only
bigmodel-project: <projId>                          // team only

POST .../api_keys
{"name":"zcode-api-key","usageScene":1}                                   // personal
{"name":"zcode-team-api-key","keyType":2,"usageScene":1}                  // team
```

- `usageScene` values: `1 = CODING_PLAN`, `2 = STANDARD`; `3` and `-1` are legacy/cache sentinels and are not valid
  for creation (`packages/shared/src/api-key-usage-scene.ts:1-8`).
- `keyType: 2` is the BigModel **team** key type (`packages/services/src/bigmodel/teamPlanApiKey.ts:4-5`, `:66-77`).
- Name conventions: personal `zcode-api-key`; team `zcode-team-api-key` (`project-access-token-client.ts:304`).
- List response data is an **array** of `{apiKey: string, name?: string, keyType?: number}` (`project-access-token-client.ts:29-33`);
  create response data is a single such object (`:331-345`).
- Selection: personal reuses the first entry whose `name` matches (no `keyType` filter; a matching entry without a
  usable ID fails rather than duplicating); team only reuses an entry with matching name **and** `keyType === 2`
  and a non-empty `apiKey` (`project-access-token-client.ts:317-328`).
- `usageScene` is **not** used as a list filter (`docs/model-provider-project-access-token.md` K02).

### 4.4 Project Access Token issuance

```
POST <origin>/api/biz/v1/organization/{org}/projects/{proj}/api_keys/{apiKeyId}/access_tokens
Authorization: Bearer <business token>
Content-Type: application/json

{"clientType":"zcode","clientVersion":"<ZCODE_VERSION>"}
```

- `clientType` must be the literal `"zcode"`; `clientVersion` is ZCode's build version (`packages/shared/src/version.ts`,
  injected at bundle time, `"0.0.0-dev"` outside builds). E2E mock server rejects with
  `{"code":400,"msg":"invalid_token_request"}` when `clientType !== "zcode"` or Authorization lacks `Bearer `
  (`packages/desktop/test/e2e/helpers/coding-plan-upgrade-mock-server.ts:562-580`).
- Success response (`packages/shared/src/project-access-token.ts:10-31`):

```json
{
  "code": 200,
  "data": {
    "enable": true,
    "accessToken": "<PAT>",
    "tokenType": "Bearer",
    "expiresIn": 600,
    "expiresAt": 1783000600
  }
}
```

- `enable` may be **omitted**; the preprocessor treats omission as `enable: true` and still validates token fields
  (`project-access-token.ts:10-31`). Explicit `enable: false` → `project_token_disabled`.
- `tokenType` must literally be `"Bearer"`; `expiresIn`/`expiresAt` must be finite positive numbers
  (`project-access-token.ts:21-30`).
- Non-2xx behavior in the issuing client (`apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts:69-105`):
  - `404` → returns `{code:404}` sentinel, callers drop the cached key location and re-resolve next time.
  - `429` or `5xx` → `ProjectAccessTokenTransientError` (may degrade to current unexpired PAT).
  - other non-2xx → hard `project_token_request_failed`.
  - no redirects/fallbacks to old long-lived keys (removed by design).

### 4.5 PAT caching and refresh (`packages/shared/src/project-access-token.ts`)

- Cache scope key includes: `origin, family, accountId, organizationId, projectId, apiKeyId, usageScene, loginGeneration`
  (`:100-190`, `scopeKey` at file end).
- Effective expiry = `min(expiresAt * 1000, startedAt + expiresIn * 1000)`; `startedAt` is when the issuance request was
  sent, so network latency never extends life (`:143-149`).
- Refresh lead = 120 s + 0–60 s random jitter (`:6-7`, `:159-160`).
- A still-valid PAT is reused when the network/HTTP error is transient (network, timeout, 429, 5xx); a 5 s retry
  backoff is set and a `project_token_refresh_deferred` event is emitted (`:6-8`, `:168-183`).
- Hard failures (401/403/404, `enable=false`, malformed body, cancellation) clear the cache entry and throw
  (`:184-195`).
- Model-request 401 recovery: caller passes SHA-256 fingerprint of the rejected PAT; only a matching generation is
  evicted (`packages/shared/src/project-access-token.ts` `resolve(..., rejectedFingerprint)`;
  `projectAccessTokenFingerprint`; see `docs/model-provider-project-access-token.md` "模型 PAT 恢复验收").
- Persistent state: only `{organizationId, projectId, apiKeyId}` is stored, under key
  `project-key-location:v1:<encodeURIComponent(JSON.stringify([origin,family,accountId,team,usageScene,selection]))>`
  (`project-access-token-client.ts:141`); PAT and login tokens never persist.

### 4.6 Team plan context

- Team detection comes from account access `planKind === "team-coding-plan"` and carries
  `{organizationId, projectId, family}` (`bigmodelUsageQuotaProvider.ts:1104-1112`).
- Team monitor/quota requests add lowercase scope headers and `?type=2` (`:1157-1176`, `:1572-1579`).
- Team credit-usage requests use `?type=3` instead of `2`; ZCode comments that reusing `type=2` triggers
  "仅企业主账号可查询企业汇总数据" (`:1590-1598`).
- Team subscription probe: `GET <host>/api/biz/team/subscribe/product/querySubscribeDetail` with
  `hasSubscription:boolean`, `status:"EXPIRED"|"EFFECTIVE"|...`, `memberGrantStatus:"VALID"|"UNASSIGNED"|...`,
  `productId`, `productName`, `subscribeEndTime`, `subscribePeriod` (`codingPlanEntitlement.ts:21-29,98-131`).
  State machine: `hasSubscription=false` → unavailable; `status=EXPIRED` → unavailable(reason expired);
  `status=EFFECTIVE & memberGrantStatus=UNASSIGNED` → unavailable(reason unassigned);
  `status=EFFECTIVE & memberGrantStatus=VALID` → available; any unrecognized enum → unknown (never treated as no-plan).
- Team API-key creation is also available through `ensureBigModelTeamPlanProjectApiKeyWithStatus`
  (`packages/services/src/bigmodel/teamPlanApiKey.ts:98-...`), same endpoints/headers as §4.3 team path.

---

## 5. Quota: `GET /api/monitor/usage/quota/limit`

Sources: `packages/services/src/usage-stats/providers/bigmodelUsageQuotaMapper.ts` (payload + mapping),
`packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts` (request),
`docs/coding-plan-quota-remaining-api.md`, `docs/bigmodel-coding-plan-usage-quota.md`.

```
GET https://bigmodel.cn/api/monitor/usage/quota/limit          (BigModel family; ?type=2 for team)
GET https://api.z.ai/api/monitor/usage/quota/limit             (Z.AI family; ?type=2 for team)
authorization: <PAT>                                           (raw; no Bearer)
bigmodel-organization / bigmodel-project                       (team only)
```

Envelope and payload (`bigmodelUsageQuotaMapper.ts:24-50`):

```json
{
  "code": 200,
  "msg": "操作成功",
  "success": true,
  "data": {
    "level": "lite|pro|max|team",
    "limits": [
      {
        "type": "TOKENS_LIMIT | CREDIT_LIMIT | TIME_LIMIT",
        "unit": 3,
        "number": 5,
        "usage": 600,
        "currentValue": 150,
        "remaining": 450,
        "percentage": 25,
        "nextResetTime": 1782881400000,
        "usageDetails": [
          { "modelCode": "search-prime", "displayName": "联网搜索 MCP", "usage": 50 }
        ]
      }
    ]
  }
}
```

Field semantics (docs + mapper normalization `bigmodelUsageQuotaMapper.ts:52-70`):

| Field | Meaning |
|---|---|
| `data.level` | plan tier (`lite`/`pro`/`max`; team responses use `team`). ZCode `formatPlanName` would render `GLM Coding <Level>` (`:81-84`) but it is currently unused; `level` is only trimmed and stored |
| `type` | `TOKENS_LIMIT` (BigModel) / `CREDIT_LIMIT` (Z.AI team; semantically identical) / `TIME_LIMIT` (tool calls) |
| `unit` | `3` = hour window, `5` = month window, `6` = week window |
| `number` | count of `unit`s: `unit=3,number=5` = 5-hour window; `unit=6` = weekly; `unit=5,number=1` = monthly tool quota |
| `usage` | total capacity (tokens/credits/calls), when returned |
| `currentValue` | used amount, when returned |
| `remaining` | server-computed remaining |
| `percentage` | **USED ratio in percent (0–100)** — must be inverted for "remaining" |
| `nextResetTime` | next reset, Unix ms; optional — hide the reset label when absent, do not use it for validity |
| `usageDetails[]` | per-model/tool usage (`modelCode`, optional `displayName`, `usage`) |

Limits the UI consumes (`packages/ui/src/lib/codingPlanQuotaPresentation.ts:39-52`,
`packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx:350-356`):

| UI card | Match predicate |
|---|---|
| 5-hour remaining | `isSameLimitCategory(type,"TOKENS_LIMIT") && unit===3 && number===5` |
| Weekly remaining | `isSameLimitCategory(type,"TOKENS_LIMIT") && unit===6` (number ignored) |
| Tool calls (monthly MCP) | `isSameLimitCategory(type,"TIME_LIMIT") && unit===5 && number===1` |
| ZCode MCP (server MCP quota) | separate field `UsageEntitlementSnapshot.mcpQuota.aggregate` — **not** in `limits[]`; returns `null` when unavailable |

`isSameLimitCategory` treats `CREDIT_LIMIT` as equivalent to `TOKENS_LIMIT` because Z.AI team plan returns
`CREDIT_LIMIT`; `TIME_LIMIT` has no equivalents (`codingPlanQuotaPresentation.ts:14-37`).

Normalization drops any limit whose `type` is not a non-empty string, and only copies numeric optional fields
(`bigmodelUsageQuotaMapper.ts:52-70`). Primary limit for the "remaining" snapshot:
first `TIME_LIMIT`, else first with numeric `remaining`, else first limit (`:72-79`).

**Semantics that bite:** `percentage` is used-ratio. ZCode's remaining projection is
`getQuotaRemainingPercentage(limit) = clamp(0,100, 100 - percentage)` and is `null` when `percentage` is missing
(`codingPlanQuotaPresentation.ts:74-82`). After a successful reset ZCode optimistically rewrites `percentage` to `0`
(i.e. 100 % remaining) until the next entitlement refresh (`packages/ui/src/lib/codingPlanQuotaResetUi.ts:368-394`).

No-plan / error behavior:
- Business failure on quota during entitlement fetch → `quota: null`, entitlement still published
  (`bigmodelUsageQuotaProvider.ts:267-312`).
- Business failure during the Coding Plan usage page → whole snapshot fails (quota is mandatory)
  (`:696-730`).
- The UI treats `quota.level` + limits presence as "has entitlement data" for the remaining panel
  (`packages/ui/src/CodingPlanUsageRemainingPanel.tsx:257-303,350-420`).
- `formatPlanName`/`isNoPlanMessage` helpers exist (`bigmodelUsageQuotaMapper.ts:81-88`) but are currently unreferenced
  outside the mapper; "no plan" is determined structurally (subscription predicate), not by message text.

---

## 6. Subscription list: `GET /api/biz/subscription/list`

Sources: `packages/services/src/usage-stats/providers/bigmodelSubscriptionProvider.ts`,
`packages/services/src/bigmodel/codingPlanEntitlement.ts`,
`packages/services/src/usage-stats/providers/bigmodelUsageQuotaMapper.ts:90-158`.

```
GET <origin>/api/biz/subscription/list
Authorization: <PAT>          (raw; the same project token used for quota)
```

- Origin: same as the quota origin (`bigmodelSubscriptionProvider.ts:23-25`) — `https://bigmodel.cn` for BigModel,
  `https://api.z.ai` for Z.AI.
- Envelope (`bigmodelUsageQuotaMapper.ts:4-9`, `codingPlanEntitlement.ts:6-10,58-69`): `{ code?, msg?, success?, data? }`;
  `data` is an array or `null`. Success: `success !== false && code ∈ {undefined, 0, 200}`.
- Item fields (`bigmodelUsageQuotaMapper.ts:11-22`):

```json
{
  "productId": "glm-coding-pro",
  "productName": "GLM Coding Pro",
  "status": "VALID",
  "inCurrentPeriod": true,
  "purchaseTime": "2026-05-01 10:00:00",
  "valid": "2026-05-01 10:00:00 ~ 2026-08-01 10:00:00",
  "autoRenew": 1,
  "currentRenewTime": "2026-07-01 10:00:00",
  "nextRenewTime": "2026-08-01 10:00:00",
  "billingCycle": "quarterly"
}
```

- `autoRenew` is `number | boolean` (`0/1` or `true/false`).
- `status`/`inCurrentPeriod` are **required** for an item to be considered (`codingPlanEntitlement.ts:11-20`).

**Active personal Coding Plan predicate** (`codingPlanEntitlement.ts:37-56`):

```
isCodingPlanProduct = (productId ?? "").toLowerCase().includes("coding")
                   || (productName ?? "").toLowerCase().includes("coding")
isActivePersonalCodingPlan = isCodingPlanProduct && status === "VALID" && inCurrentPeriod === true
```

- Items are heterogeneous: ZCode strictly validates only the accepted Coding item; an unrelated malformed item does not
  shadow a valid one. If a *suspected* Coding item is malformed, the result is `unknown`, not "no plan"
  (`codingPlanEntitlement.ts:83-95`).
- `billingCycle` trimmed; empty → `null` (`bigmodelUsageQuotaMapper.ts:108-114`).

**Renew vs expire time selection** (`bigmodelUsageQuotaMapper.ts:117-146`):

- `renewTime` = parsed `nextRenewTime` **iff** `autoRenew` is `true` or `1`; otherwise `null`.
- `expireTime` = parsed `nextRenewTime` when `autoRenew` is not truthy; when auto-renew is on, `nextRenewTime` means the
  next charge, so it must NOT be shown as expiry — instead the last `YYYY-MM-DD[ HH:mm:ss]` match inside `valid`
  (the period end) is used.
- Date parsing: trim; replace the first space with `T` if no `T`; `new Date(normalized)`; invalid → `null`;
  output ISO string via `toISOString()` (`:148-158`).

"No plan" semantics:

- `kind: "unavailable"` (no active item) surfaces as `unavailableReason: "no_plan"` in the entitlement snapshot
  (`bigmodelUsageQuotaProvider.ts:285-295`); UI shows "No active Coding Plan"/"Not subscribed" and the billing banner
  instead of quota cards.
- Provider-availability validation also uses this endpoint as its *only* signal for whether an OAuth/API-key Coding Plan
  provider stays enabled (`packages/services/src/model-provider/codingPlanProviderAvailability.ts:34-48`,
  `docs/model-provider-coding-plan-availability.md`).
- Team probe replaces this endpoint with `querySubscribeDetail` (§4.6).

---

## 7. Usage statistics endpoints (`/api/monitor/...`)

Sources: `packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts` (requests),
`packages/services/src/usage-stats/providers/bigmodelUsageMonitorMapper.ts` (mapping),
`packages/services/src/usage-stats/providers/bigmodelUsageMonitorRange.ts` (time ranges),
`docs/bigmodel-coding-plan-usage-quota.md`.

All requests use `authorization: <PAT>` (raw), plus team scope headers when team, and are issued only for a Coding Plan
provider (`requirePreferredProvider: true`, `allowEnvApiKey: false`) — otherwise error
`bigmodel_coding_plan_api_key_required` / `zai_coding_plan_api_key_required`
(`bigmodelUsageQuotaProvider.ts:683-693`, `:1665-1670`).

The Coding Plan usage page issues exactly **5** requests in parallel (`:699-722`): `quota/limit` (mandatory) plus
`credit-usage/activity`, `credit-usage/usage-detail?usageType=MODEL`, `credit-usage/usage-detail?usageType=MCP`,
`usage/model-performance-day` (all best-effort). The legacy `model-usage`/`tool-usage` pair is only used by the older
`getUsageStatsSnapshot` path and is no longer the Coding Plan page's data source
(`docs/bigmodel-coding-plan-usage-quota.md`; `usageStatsService.ts:95-166`).

### 7.1 Endpoint summary

| Endpoint | Query | Purpose |
|---|---|---|
| `GET .../api/monitor/usage/quota/limit` | `type=2` team | quota cards (§5) |
| `GET .../api/monitor/usage/model-usage` | `startTime`, `endTime`, `type=2` team | legacy per-day token/model calls |
| `GET .../api/monitor/usage/tool-usage` | `startTime`, `endTime`, `type=2` team | legacy per-day tool calls |
| `GET .../api/monitor/credit-usage/activity` | `type=1` personal / `type=3` team, `startTime`, `endTime` | 365-day activity summary + heatmap |
| `GET .../api/monitor/credit-usage/usage-detail` | `type=1`/`3`, `startTime`, `endTime`, `usageType=MODEL\|MCP` | credits/tokens/calls detail + KPI |
| `GET .../api/monitor/usage/model-performance-day` | `startTime`, `endTime` (no `type`) | decode-speed series (TPS/health) |

Path construction: `buildUsageMonitorUrl` replaces `/quota/limit` with `/{endpoint}`; credit-usage replaces
`/usage/quota/limit` with `/credit-usage/{activity|usage-detail}`; performance replaces `/quota/limit` with
`/model-performance-day`. Team `type=2` is appended for quota/model-usage/tool-usage; credit-usage always sets
`type=1|3`; performance sets no `type` (`bigmodelUsageQuotaProvider.ts:1564-1612`).

### 7.2 `model-usage` (legacy)

Response (`bigmodelUsageMonitorMapper.ts:30-55`):

```json
{
  "code": 200,
  "success": true,
  "data": {
    "x_time": ["2026-07-01","2026-07-02"],
    "granularity": "daily",
    "modelCallCount": [3,2],
    "tokensUsage": [1230,800],
    "totalUsage": {
      "totalModelCallCount": 5,
      "totalTokensUsage": 2030,
      "modelSummaryList": [{"modelName":"glm-4.6","totalTokens":1400,"sortOrder":1}]
    },
    "modelDataList": [{"modelName":"glm-4.6","sortOrder":1,"tokensUsage":[900,500],"totalTokens":1400}],
    "modelSummaryList": [{"modelName":"glm-4.6","totalTokens":1400,"sortOrder":1}]
  }
}
```

Mapping to `UsageStatsSnapshot` (`:218-319`): daily rows keyed by `x_time[i]` with
`totalEstimatedTokens=tokensUsage[i]`, `messageCount=modelCallCount[i]`, `totalCharacters=tokens*3`
(`ESTIMATED_TOKEN_CHAR_DIVISOR = 3`, `packages/shared/src/usage-stats.ts:9`); summary totals from `totalUsage`;
models from `totalUsage.modelSummaryList ?? modelSummaryList`, sorted desc by tokens, `share = tokens/total`;
favorite model = first; `totalSessions`/`totalMessages` = `totalModelCallCount`. Missing `tokensUsage` buckets are
tolerated (0).

### 7.3 `tool-usage` (legacy)

Response (`:57-72`): `x_time`, `granularity`, `networkSearchCount[]`, `webReadMcpCount[]`, `zreadMcpCount[]`,
`totalUsage.{totalNetworkSearchCount,totalWebReadMcpCount,totalZreadMcpCount,totalSearchMcpCount,toolSummaryList}`,
`toolDataList[]` (`toolCode`,`toolName`,`sortOrder`,`usageCount[]`,`totalUsageCount`), `toolSummaryList[]`.

Mapping (`:845-902`): fixed rows `network-search`="联网搜索 MCP", `web-reader`="网页读取 MCP", `zread`="开源仓库 MCP";
`search-mcp`="Search MCP" appended only when `totalSearchMcpCount > 0` (no daily series). Missing `data` with explicit
success (`code=200`/`0`, `msg="操作成功"`) is treated as empty stats, not an error (`:1178-1233`).

### 7.4 `credit-usage/activity`

Fixed last **365 natural days** regardless of the selected range (`resolveCreditUsageActivityTimeRange`,
`bigmodelUsageQuotaProvider.ts:1614-1624`). Response (`bigmodelUsageMonitorMapper.ts:79-98`):

```json
{
  "code": 200,
  "data": {
    "summary": {
      "totalTokens": 350720,
      "peakDailyTokens": 120000,
      "peakDailyTokensDate": "2026-07-02",
      "totalUsageDurationMs": 5400000,
      "currentStreakDays": 2,
      "longestStreakDays": 4
    },
    "series": [
      {"date":"2026-07-01","totalTokens":148720,"modelCallCount":4,"mcpCalls":2}
    ]
  }
}
```

Mapping (`:385-431`): activity summary fields (`totalTokens`, `peakDailyTokens`, `peakDailyTokensDate`,
`totalUsageDurationMs`, `currentStreakDays`, `longestStreakDays`) drive the "Activity" KPI row; `series` becomes the
heatmap with `totalTokens`, `turnCount=modelCallCount`, `toolCallCount=mcpCalls`; heatmap level = ceil(value/max*4)
clamped 1..4 (`:475-478`). The UI also injects `favoriteModelName` from the model summary list
(`:361-364`). Dates not matching `^\d{4}-\d{2}-\d{2}$` are dropped (`:403-423`).

### 7.5 `credit-usage/usage-detail?usageType=MODEL|MCP`

Response (`bigmodelUsageMonitorMapper.ts:74-159`):

```json
{
  "code": 200,
  "data": {
    "summary": {
      "cacheHitRate": {"value": 0.893, "trend": 0.12},
      "totalCredits": {"value": 28.95, "trend": -0.2},
      "averageDailyCredits": {"value": 4.13, "trend": 0}
    },
    "modelUsage": {
      "xTime": ["2026-07-01","2026-07-02"],
      "modelDataList": [
        {
          "modelName": "glm-4.6", "modelCode": "glm-4.6", "sortOrder": 1,
          "totalTokens": 220000, "totalCredits": 18.5,
          "totalCreditsUsage": [11.2,7.3],
          "cachedInputCreditsUsage": [7.68,4.2],
          "uncachedInputCreditsUsage": [2.63,2.1],
          "outputCreditsUsage": [0.89,1.0],
          "tokensUsage": [130000,90000],
          "totalTokensUsage": [130000,90000],
          "cachedInputTokensUsage": [90000,60000],
          "uncachedInputTokensUsage": [30000,20000],
          "outputTokensUsage": [10000,10000]
        }
      ]
    }
  }
}
```

MCP variant uses `mcpUsage.xTime` + `mcpUsage.mcpDataList[]` with
`mcpCode/mcpName/toolCode/toolName/sortOrder/totalCredits/totalUsageCount/creditsUsage[]/mcpCallCount[]/usageCount[]`
(`:117-128`). `summary` metric values may be `number|string|null` (parsed with `Number`), missing → `null`
(`:765-773`).

Mapping (`:480-511`, `:529-652`, `:682-763`):

- `detail.model` / `detail.tool` KPI = `{cacheHitRate,cacheHitRateTrend,totalCredits,totalCreditsTrend,
  averageDailyCredits,averageDailyCreditsTrend}` from each usage-detail `summary`.
- Model rows: token series preferred `totalTokensUsage` → `tokensUsage` → sum(cached/uncached/output tokens); credit
  series `totalCreditsUsage` → sum(cached/uncached/output credits); `totalTokens`/`totalCredits` fall back to series
  sums.
- "Breakdown buckets" (`modelCode` in `cached_input/cachedInput/cache_input/...`, `uncached_input/...`, `output/...`,
  or `modelName` literally `缓存`/`未缓存`/`输出`) are filtered out of model rows; the total-token calculation excludes
  them when real model rows exist, otherwise falls back to summing buckets (`:614-652`). This avoids ~2× double counting.
- MCP rows: usage series `mcpCallCount` → `usageCount`; credit series `creditsUsage`.
- Series alignment: source series is re-indexed onto the requested `xTime` axis by normalized bucket key
  (`hour` → `HH:mm:ss`, `day` → `YYYY-MM-DD`); missing buckets become 0 (`:802-843`).
- `granularity` for summary-only computation is inferred from `xTime` containing `\d{2}:\d{2}` → hour, else day
  (`:667-680`, `:749-763`).

### 7.6 `model-performance-day`

Response (`:161-166`):

```json
{
  "code": 200,
  "data": {
    "x_time": ["2026-06-26","..."],
    "proMaxDecodeSpeed": [118.2, 121.5, 125.4, 119.8, 130.1, 127.6, 124.9],
    "liteDecodeSpeed": [48.3, 51.7, 55.2, 52.4, 58.8, 56.1, 53.9]
  }
}
```

- `x_time` (snake) or `xTime` (camel) accepted; both speed series default to `[]` (`:503-511`).
- Health chart uses the values verbatim; y-axis unit is tokens/s (`docs/bigmodel-coding-plan-usage-quota.md`).
- TPS convenience value = **last strictly-positive** `proMaxDecodeSpeed` entry (`findLast(v => v>0)`)
  (`bigmodelUsageQuotaProvider.ts:807-815`); the service caches it for 5 minutes
  (`packages/services/src/usage-stats/usageStatsService.ts:51`). It feeds the "Highspeed" (加速卡) UI, not the
  balance/usage panel.

### 7.7 Time ranges, granularity, timezone

`packages/services/src/usage-stats/providers/bigmodelUsageMonitorRange.ts` and
`bigmodelUsageQuotaProvider.ts:1614-1639`:

| Range | `startTime` | `endTime` | `granularity` | `xTime` axis |
|---|---|---|---|---|
| `today` | `<today> 00:00:00` | `<today> 23:59:59` | `hour` | 24 entries `00:00:00`…`23:00:00` |
| `7d` | `<today-6> 00:00:00` | `<today> 23:59:59` | `day` | 7 consecutive `YYYY-MM-DD` |
| `30d` | `<today-29> 00:00:00` | `<today> 23:59:59` | `day` | 30 consecutive `YYYY-MM-DD` |
| `custom` | `<start> 00:00:00` | `<end> 23:59:59` | `day` | inclusive consecutive dates |

- Range resolution `:39-102`: `today`/`7d`/`30d`/`custom`. Custom dates must match `^\d{4}-\d{2}-\d{2}$`
  (`:142-148`); order must be start <= end (`coding_plan_usage_custom_range_invalid_order`); length <= 30 days
  (`coding_plan_usage_custom_range_too_long`).
- "Today" is computed **in the caller's `timeZone`**, not the host timezone: `formatDateInTimeZone` uses
  `Intl.DateTimeFormat("en-CA",{timeZone})` and reads year/month/day (`:122-133`). DSH must pass the UI timezone;
  the ZCode hook uses `Intl.DateTimeFormat().resolvedOptions().timeZone`
  (`packages/ui/src/hooks/useUsageStats.ts:313`).
- Activity range is fixed 365 days ending today (`bigmodelUsageQuotaProvider.ts:1614-1624`); health range is 7 days by
  default (`:1626-1639`, called with `"7d"` at `:718`).
- Legacy `resolveUsageTimeRange` (7d/30d, default 30) uses the **local** clock
  (`new Date().setHours(23,59,59,0)`) and formats without timezone offset (`bigmodelUsageMonitorRange.ts:11-37`).
- No `granularity` query param is sent; granularity is decided client-side. ZCode tests assert the query never contains
  `granularity` (`packages/services/test/usageStatsService.test.ts` around line 670).
- Daily series returned by the server are re-aligned to the requested axis; gaps become 0.

### 7.8 Failure semantics

`bigmodelUsageQuotaProvider.ts:1178-1233`:

- Envelope success is required even for empty data. `code=200 msg="操作成功"` with no `data` is accepted **only** for
  the optional endpoints (`allowMissingData`), producing empty sections.
- Quota: transport failure (non-2xx/timeout/network) fails the whole snapshot. Business failure (HTTP 200, code != 0)
  yields `quota: null` in entitlement paths, and fails the Coding Plan usage snapshot (quota is mandatory there).
- The four credit/perf endpoints are best-effort on **transport** failure: the section is cleared and a warn is logged;
  a business-envelope failure (e.g. expired token) still throws, deliberately, so auth failures are not disguised as
  empty usage.
- Non-2xx HTTP is thrown by `readApiJson` with `ApiError` carrying `status` and diagnostic headers `x-request-id`,
  `x-trace-id`, `x-span-id` (`packages/services/src/providers/api/apiJson.ts`).

### 7.9 How ZCode maps endpoints to UI metrics

| UI metric | Source | Mapping |
|---|---|---|
| Total tokens | activity.summary.totalTokens; credits detail token sums | direct |
| Model calls | activity.series.modelCallCount, model-usage totalModelCallCount | direct |
| Tool calls | credit usage-detail MCP `mcpCallCount`/`usageCount`; legacy tool-usage totals | direct |
| Cache hit rate | usage-detail MODEL `summary.cacheHitRate.value` (+trend) | direct, fraction (0–1) rendered as percent |
| Total credits | usage-detail MODEL `summary.totalCredits.value` | direct |
| Average daily credits | usage-detail MODEL `summary.averageDailyCredits.value` | direct |
| Daily series | credits detail `modelUsage.xTime` + per-model series; heatmap from activity.series | aligned to requested axis |
| Model breakdown | credits detail `modelUsage.modelDataList` (or legacy `modelSummaryList`) | sort by `sortOrder`; filter bucket rows |
| Streak days | activity.summary.currentStreakDays / longestStreakDays | direct |
| Peak day | activity.summary.peakDailyTokens / peakDailyTokensDate | direct |
| TPS | model-performance-day proMaxDecodeSpeed last positive value | TPS chip only |
| Range totals | computed client-side from visible series | sum of `values[]` |

KPI cards (usage page) render only when credits data is positive; cache-hit-rate/total-credits/average-daily-credits
(`docs/bigmodel-coding-plan-usage-quota.md`; `packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx:900-970`).

---

## 8. Coding Plan reset APIs

Base: `/api/v1/coding-plan/reset` on the **ZCode origin** (`https://zcode.z.ai`), built with
`buildRuntimeZCodeApiUrl` so it follows `ZCODE_ENV`/`ZCODE_BASE_URL` (`bigmodelUsageQuotaProvider.ts:74`, `:529,562,592,638`).

| Method | Path | Auth scope headers |
|---|---|---|
| GET | `/status` | full target scope |
| POST | `/use` | full target scope |
| POST | `/opportunity` | full target scope |
| POST | `/history/read` | **no** target scope (only the two credentials) |

### 8.1 Headers

`bigmodelUsageQuotaProvider.ts:982-999`:

```
Authorization: Bearer <zcodejwttoken>          // "Bearer " added if not already present
X-Bigmodel-Authorization: <business token>     // raw, NO "Bearer"; family-matched
Bigmodel-Target-Type: PERSONAL | TEAM          // omitted for /history/read
Bigmodel-Organization: <orgId>                 // TEAM only
Bigmodel-Project: <projectId>                  // TEAM only
content-type: application/json                 // POST bodies only
```

Credential selection (`:649-678`): `zcodejwttoken` required; business token = `oauth:zai:access_token` when the account
family is `zai`, `oauth:bigmodel:access_token` when `bigmodel`; **no cross-family fallback** (a missing family token
fails with `coding_plan_reset_maas_jwt_required`, tested at
`packages/services/test/codingPlanResetProvider.test.ts:128-170`). Account access and current provider identity are
asserted before the request (`:652-659`).

### 8.2 `GET /status`

Response `data` (schema `bigmodelUsageQuotaProvider.ts:86-103`):

```json
{
  "available_five_hour_resets": [{ "expire_at": 1786000000000 }],
  "available_week_resets": [{ "expire_at": 1787000000000 }],
  "latest_five_hour_reset_history": { "used_at": 1785990000000 },
  "latest_week_reset_history": null,
  "has_unread_history": true
}
```

Mapped to `CodingPlanResetStatusSnapshot` (`packages/shared/src/coding-plan-reset.ts:17-24`;
mapping `bigmodelUsageQuotaProvider.ts:536-552`): `availableFiveHourResets[{expireAt}]`,
`availableWeekResets[{expireAt}]`, `latestFiveHourResetHistory{usedAt}|null`, `latestWeekResetHistory{usedAt}|null`,
`hasUnreadHistory`. All timestamps are Unix ms. Validation is strict zod (`expire_at`/`used_at` finite positive numbers,
arrays required); malformed → `coding_plan_reset_invalid_response`.

### 8.3 `POST /opportunity` (eligibility judgment; NOT a user action)

Body: `{"idempotency_key":"<uuid>"}` (`:600`). Response:
- granted: `{code:0, data:{granted:true}}` → `{granted:true, nextTryAt:null}`.
- denied/throttled: business code **3301** with `data:{granted:false, next_try_at:<ms>}` → `{granted:false, nextTryAt}`
  (`:614-631`). 3301 is an accepted business code (`acceptedBusinessCodes: [3301]`, `:602`), so it does not throw.
- bare HTTP **429** (no envelope) → error string `coding_plan_reset_opportunity_throttled` (`:604-613`); only
  `/opportunity` performs this mapping, other reset endpoints keep `ApiError`.
- Other business codes: `coding_plan_reset_api_error:<code>` (+ ` (x-request-id:<id>)` when header present)
  (`:1052-1059`, `:1029-1032`).

### 8.4 `POST /use`

Body: `{"idempotency_key":"<uuid>","reset_type":"FIVE_HOUR"|"WEEK"}` (`:570-573`).
Response: `{code:0, data:{used:true}}` → `{used:true}` (`:104-106`, `:576-577`).

### 8.5 `POST /history/read`

No body; headers only `Authorization` + `X-Bigmodel-Authorization`; envelope `code=0` with any `data`
(`:634-647`, `:1079-1102`). Shared read cursor is per user, hence no target scope.

### 8.6 Idempotency rules

ZCode enforces in service + UI (`bigmodelUsageQuotaProvider.ts:555-585`; `docs/coding-plan-quota-reset-ui.md`
"opportunity 判断与幂等"/"use 幂等"):

- `idempotency_key` must be non-empty and `<= 64` chars; otherwise
  `coding_plan_reset_invalid_idempotency_key` and no request is sent.
- New judgment/new reset attempt → new UUID; retry of the same failed request → reuse the same key.
  Generated with `crypto.randomUUID()` with hex fallbacks (`packages/ui/src/hooks/useCodingPlanQuotaResetUi.ts:300-318`,
  `packages/ui/src/lib/codingPlanQuotaResetCoordinator.ts:57-72`).
- Single-flight: concurrent evaluations for the same service+scope share one key/request.
- After a definitive business response the key is cleared; 3301 stores `next_try_at` and only polls `/status` until then.

### 8.7 Client retry/cooldown policy (UI coordinator)

`packages/ui/src/lib/codingPlanQuotaResetCoordinator.ts:5-9,118-122`:

- `/status` polling every **5 min** while document visible; also refreshed on user access.
- `granted=false` with `next_try_at` → next check = `max(next_try_at, now + 5 min)`; no `next_try_at` → `now + 10 min`.
- `granted=true` → next evaluation after 10 min.
- bare 429 throttle → 10 min cooldown with a new key; transient business `2007`/network/timeout → 5 min retry reusing
  the failed key; stable auth/business/protocol errors → 10 min with a new key.
- The UI intentionally does not locally decide eligibility; it always defers to `/opportunity`
  (`docs/coding-plan-quota-reset-ui.md` §background).

### 8.8 UI state semantics around reset

- `has_unread_history` is a single shared cursor for both reset types; `latest_{five_hour,week}_reset_history` are
  independent. A type "owns" the unread flag only if its `used_at` is the newest of the two
  (`docs/coding-plan-quota-reset-ui.md`, COMPLETED rules).
- Completion uses the server `used_at`, never local `Date.now()` for business meaning; `observed_at` is only the first
  local observation timestamp for display.
- On completion the UI optimistically sets the corresponding limit to `percentage: 0` (100 % remaining) and
  `next_reset_at = used_at + 5h` / `used_at + 7d`, and forces an entitlement/quota refresh
  (`packages/ui/src/lib/codingPlanQuotaResetUi.ts:368-394`).
- Reset dialog countdown format is adaptive: `{d}d {h}h` / `{d}d` / `{h}h {m}m` / `{h}h` / `{m}m {s}s`
  (`packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.tsx:51-75`;
  i18n `packages/ui/src/i18n/locales/en-US.ts:4505-4518`).
- Error codes the client distinguishes: envelope `code` 3101 (403 auth/business), 3001 (400 scope), 3002 (429),
  2001/2002/2007 (5xx-ish dependency), 3301 (opportunity denied) — `docs/coding-plan-quota-reset-ui.md` error table.

---

## 9. ZCode UI reference (what to port)

### 9.1 Usage page (Settings → Usage stats → Coding Plan)

Entry: `packages/ui/src/settings/UsageStatsSection.tsx` chooses `AppUsagePanel` for tab `app`, otherwise
`CodingPlanUsagePanel`. Tabs are `settings.usage.tab.appUsage` = "App usage" and `settings.usage.tab.codingPlan` =
"Individual Plan" plus per-team-source tabs (`packages/ui/src/i18n/locales/en-US.ts:4465-4466`;
`packages/ui/src/settings/UsageStatsSection.tsx:1-33`).

`CodingPlanUsagePanel` (`packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx`):

1. Empty states before any data:
   - loading sources → `UsageEmptyState` title "Computing usage" (`settings.usage.loadingTitle`, line 221-226);
   - no connected source → `settings.usage.codingPlanCurrentConnectionTitle/Description` (line 231-238);
   - error → `UsageStatsErrorNotice` above content (line 254); loading without snapshot → loading empty state.
2. **Quota remaining** section (header `settings.usage.quotaTitle` = "Quota remaining", line 444-473):
   - header row: title, optional reset-opportunity badge (`CodingPlanQuotaResetOpportunity`), last-refreshed text
     (`settings.usage.lastRefreshTime`, formatted `YYYY/MM/DD HH:mm`), refresh icon button.
   - card list, in order: `fiveHour` → `weekly` → `monthlyTool` → `serverMcp`, labels
     "5-hour remaining", "Weekly remaining", "Tool calls", "ZCode MCP" (lines 372-405, 4536-4539); cards without a
     matching limit are omitted (never render fixed empty cards). Layout `flex flex-col gap-3 lg:flex-row`
     (vertical on narrow screens, horizontal from `lg`) — lines 440, 477.
   - each card: label (truncate), optional reset action button, big remaining percentage
     (`formatQuotaRemainingPercentage`; >=10 → 0 decimals, <10 → 1 decimal, clamped 0–100, `--` when unknown — lines
     84-95 in presentation lib), reset time via `formatUsageStatsQuotaResetTime` = **`month short day + HH:mm`**
     ("Jul 10, 08:30"; zh "9月16日 23:00"), progress bar width = remaining percentage with per-card color
     (`--color-usage-chart-1..3,5`) — lines 505-548.
3. **Activity** section (lines 582-657): title `settings.usage.activityTitle`; KPI row with 5 items —
   Total tokens, Peak tokens (with info tooltip for the date), Total usage duration, Current streak, Longest streak
   (labels `settings.usage.lifetimeTotalTokens/lifetimePeakTokens/totalUsageDuration/currentStreak/longestStreak`);
   then a heatmap (`UsageHeatmap`, 52-week grid, daily/weekly/cumulative modes, `countMetric="tools"`) only when
   activity weeks exist.
4. **Usage trends** section (lines 556-580): title `settings.usage.trendsTitle` + range selector
   (7d/30d only — `settings.usage.codingPlanRange.7d/30d`); inside:
   - **detail charts**: KPI cards (cache hit rate / credits total / average daily credits each with trend % and
     red-down/green-up coloring; only when credits data exists), metric tabs (Credits/Usage) + subject tabs
     (Models/Tools), chart series legend with "Total" summary and per-model/tool toggles (max 3 visible by default,
     cannot hide the last one), bar chart over `xTime` (bars, not lines; model bars stack cached/uncached/output).
   - **System health** (lines 976-...): title `settings.usage.healthTitle`, 7d label, two lines
     Max&Pro / Lite peak average decode speed in tokens/s.
5. Error/empty states: `UsageEmptyState` dashed-border block (title + description,
   `packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx:151-164`); "No usage data yet" empty title/description
   for empty chart range; errors are inline `UsageStatsErrorNotice` with credential/team-business variants and a
   "Check account" link (`packages/ui/src/settings/usage-stats/UsageStatsErrorNotice.tsx:14-57`).

### 9.2 Remaining-quota panel (sidebar + composer popover)

Shared state derivation: `packages/ui/src/CodingPlanUsageRemainingPanel.tsx:140-229`
(`resolveCodingPlanUsageRemainingState`, `hasActiveCodingPlanSnapshot`). A snapshot counts as active when
`snapshot.provider.id === providerId && unavailableReason !== "no_plan" && subscription.details.length > 0`
(lines 130-138). Panel is hidden when no provider has an active plan.

Panel layout (`:240-434`):

- Header: "Coding Plan" + audience pill "Individual"/"Team" + "More" link + provider tabs (Z.AI/BigModel icons),
  header (`sidebar.usage.plan.codingPlanTitle`, `audienceIndividual/audienceTeam`, `open`).
- Rows in order: 5 hours, Weekly, Tool calls, ZCode MCP (`sidebar.usage.plan.fiveHour/weekly/toolCalls/mcp`), each
  `UsageLimitRow`: label left; right-aligned **remaining percentage** + reset time (`:62-80`).
- Percentage: same `getQuotaRemainingPercentage` inversion + `formatQuotaRemainingPercentage` rounding.
- Reset time formats:
  - 5-hour: `formatQuotaResetTime({format:"dateTime", compactToday:true})` → **today: `HH:mm`; another day: date +
    `HH:mm`** (e.g. "Jul 3, 08:30");
  - Weekly / Tool calls / ZCode MCP: `format:"date"` → **date only** ("Jul 10") (lines 265-303).
- Empty/unavailable text (`sidebar.usage.plan.notConfigured|loginRequired|noPlan|unavailable`): "No connected Coding
  Plan account found." / "Login to view plan usage." / "No active Coding Plan" / "No available entitlement data yet."
- `remaining.isShow === false` → footer "Provider marked this balance as hidden"
  (`sidebar.usage.plan.hidden`).
- Loading row "Syncing…"; error row renders the error string in a destructive box (`:330-350`).

Composer context panel (`packages/ui/src/chat-input-toolbar/CodingPlanContextUsage.tsx`):

- Header `sidebar.usage.plan.title` + reset badge; meters (`ChatCodingPlanUsageMeter`, lines 97-190): label row
  (with optional reset action), value row `font-mono` remaining percentage + `" · " + reset` (reset hidden when the row
  is too narrow — `shouldShowContextQuotaResetTime` compares content width to available width, lines 56-62, 120-145),
  and a slim 1.5-height progress bar (`bg-surface-hover`) whose width = remaining percentage.
- Meter order: 5-hour → weekly → tool calls (only rows with a matching limit), then ZCode MCP meter with an info
  tooltip (`ChatCodingPlanMcpUsageMeter`), lines 227-450.
- Reset formats in the composer are its own rules, not the shared ones:
  - 5-hour uses `formatContextFiveHourResetTime` = `HH:mm` only (no date), so `08:30` for a next-day reset
    (lines 80-95; test `packages/ui/test/chatContextUsageBreakdown.test.ts:1049-1103` asserts `" · 08:30"` and no
    `"Jan 3"`).
  - Weekly / tool / MCP use `format:"date"` (date only) (lines 248-266).

### 9.3 Presentation helper rules (`packages/ui/src/lib/codingPlanQuotaPresentation.ts`)

| Helper | Rule |
|---|---|
| `isSameLimitCategory(limitType, queryType)` | `TOKENS_LIMIT`↔`CREDIT_LIMIT` equivalent; `TIME_LIMIT` only matches itself (L22-37) |
| `findCodingPlanQuotaLimit(limits, type, unit, number?)` | category + exact `unit` + optional exact `number` (L39-52) |
| `resolveMcpQuotaLimit(snapshot)` | `snapshot.mcpQuota.aggregate` only (L61-63) |
| `normalizeQuotaPercentage` | clamp 0–100, non-finite → 0 (L67-72) |
| `getQuotaRemainingPercentage(limit)` | `100 - percentage` clamped; `null` when `percentage` not finite (L74-82) |
| `formatQuotaRemainingPercentage(locale, limit)` | `--` when null; `Intl.NumberFormat` max fraction digits = 0 if >=10 else 1 (L84-95) |
| `formatStartPlanBucketResetTime` | alias for `formatQuotaResetTime(..., "adaptive")` (L105-110) |
| `formatQuotaResetTime({format})` | `date` → month short + day; `dateTime` → month/day + HH:mm (today omitted when `compactToday`); `adaptive` → today `HH:mm` (h23), else month short + day (L112-167) |

Additional formatting used by the usage panel (`packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx:13-40`):
compact numbers (`Intl` notation compact when >=1000, max 1 fraction digit), compact tokens (shared token formatter,
zh adds a space before 万亿), duration via `formatAppUsageDuration`, dates rendered with `timeZone:"UTC"` for
`YYYY-MM-DD` keys.

### 9.4 Reset UI entry points

`docs/coding-plan-quota-reset-ui.md` and `packages/ui/src/components/coding-plan-quota-reset/*`:

- Entry points: Usage-page quota card title actions, Model Provider status card, composer context panel/quota badge.
  They only open the unified dialog; `/use` is triggered by the dialog's per-type button.
- Dialog rows: `5-hour quota reset` / `Weekly quota reset` (`codingPlan.quotaReset.dialog.fiveHour/week`), count
  `×{count}`, expiry `Expires in {time}` (or "Soonest expires in …" for the merged badge), and a `Reset` button with
  per-type aria labels.
- Badge: `{count} reset available` merged across types (counts summed, countdown = earliest expiry).
- Completed state: `settings/…` and row show "已重置" (`codingPlan.quotaReset.done`), 600 ms success check + one
  confetti burst for manual reset; auto/operator reset discovered by polling shows a synthetic "resetting" (~1 s,
  purely visual) then completed.
- Reset action only applies to Personal Coding Plan / Team Plan scope.

---

## 10. Risks and open questions for a plugin with only OAuth tokens

**R1 (high). Monitor/quota/usage/subscription calls are PAT-scoped, not OAuth-scoped.** ZCode never sends an OAuth
access token to `/api/monitor/*` or (personal) `/api/biz/subscription/list`; it always resolves a PAT first
(§2.3, §5, §6, §7). A DSH plugin must reproduce the customerInfo → api_keys → access_tokens chain (§4) before any
balance/usage read. Whether the backend *additionally* accepts the OAuth business token on those endpoints is
[unverified] — ZCode contains no such call, and the header comment says the header takes an API key
(`bigmodelUsageQuotaProvider.ts:1151-1156`).

**R2. Workspace/project selection is implicit.** The personal PAT depends on choosing a personal org/project from
customerInfo (projectType != 2). Accounts whose customerInfo contains only team projects fail with
`project_token_project_unavailable` (`project-access-token-client.ts:280-302`). Accounts with multiple personal orgs get
an implicit default-name/first-item pick; DSH may want an explicit selection/config strategy and must surface the
distinction "no personal project" vs "no plan".

**R3. `clientVersion` is ZCode's build version.** The PAT issuance body sends `{"clientType":"zcode","clientVersion":ZCODE_VERSION}`.
DSH must send some version; whether the backend validates/allow-lists it is [unverified]. At minimum send a plausible
semantic version (ZCode fallback outside builds is `"0.0.0-dev"`, `packages/shared/src/version.ts`).

**R4. OAuth token refresh does not exist in ZCode.** `OAuthProviderAdapter.refreshToken` is optional
(`packages/services/src/oauth/providers/providerAdapter.ts:31`), and neither built-in adapter implements it; the
service throws "暂未提供 refresh token 交换接口" (`packages/services/src/oauth/oauthService.ts:999-1010`). BigModel
`refresh_token` is stored (`docs/analysis/credentials-json-code-audit.md:186`) but **never used to refresh**; ZCode's
own audit states the built-in BigModel adapter has no refresh implementation. Consequence: when the BigModel business
token expires, ZCode requires re-login; DSH likely must do the same, or discover an undocumented refresh endpoint
[none found in ZCode].

**R5. No expiry metadata is persisted for OAuth tokens.** ZCode does not store `expiresAt` for OAuth token sets
(`docs/analysis/credentials-json-code-audit.md:196`). DSH cannot know when the polled business token expires; it can
only detect failure at request time (401/403 on customerInfo/api-keys; 401 on PAT issuance). PAT expiry is known and
must drive refreshes (§4.5).

**R6. Third-party client acceptance of the CLI polling flow is [unverified].** The init endpoint needs only a
self-generated poll token; ZCode's CLI uses it directly. Whether zcode.z.ai rate-limits/identifies non-ZCode clients
(UA, app version headers, IP) is not visible in source. The `provider` field is the only login-scope signal.

**R7. Z.AI family needs an extra exchange.** For `provider=zai`, the polled `data.zai.access_token` is a raw Z.AI OAuth
token; ZCode exchanges it at `POST https://api.z.ai/api/auth/z/login` and uses the result as the business JWT (§2.2,
§3.5). If DSH supports Z.AI, it must implement this exchange; the exchange response has numeric-or-string success
codes and caches by JWT `exp`/`expires_in` with a 120 s lead
(`apps/zcode-cli/packages/adapters/src/auth/zai-business-token-cache.ts`).

**R8. Team Plan support is a separate scope.** Team quota uses `?type=2`, team credit usage `?type=3`, reset headers
carry `Bigmodel-Organization/Project`, and the team subscription probe is a different endpoint (§4.6, §5, §8). Team
PATs are `keyType=2` keys; ZCode persists only `{org, project, keyId}`. Whether DSH should support team scope at all
should be decided early — it changes the config/data model.

**R9. Credential storage/security.** ZCode keeps PATs in memory only and persists only the key location; OAuth tokens
live in an encrypted credentials file (`docs/analysis/credentials-json-code-audit.md:§6`). DSH must store the OAuth
tokens in its own credential service and never log PATs/business tokens. Do not reuse ZCode's `~/.zcode/v2/credentials.json`
directly unless the plugin is explicitly a ZCode-account integration (file format is internal and carries
`enc:v1:` ciphertext with a machine-derived key).

**R10. Reset is a mutating, user-asset endpoint.** `/opportunity` is a scope-level eligibility judgment and `/use`
consumes a reset opportunity; both are server-authoritative. DSH must not call `/use` without a real user action and
must honor `next_try_at`/429 cooldowns (§8.6-8.8). ZCode's own logs show transient `2007` backend failures and 429s
(`docs/coding-plan-quota-reset-review.md` §3), so the plugin needs visible retry/cooldown UX.

**R11. `usageScene`/key reuse semantics.** Creating keys is side-effectful on the user's account. Reuse-first by
name (`zcode-api-key` / `zcode-team-api-key`+`keyType=2`), create only when absent, and never create on transient
errors. ZCode's hard rule: `404` on a key ID means re-locate; permission/network/switch errors must NOT fall back to
creating a new key (`project-access-token-client.ts:219-224`).

**R12. Semantic traps when porting UI.**
- `percentage` is used-ratio; invert once, centrally.
- `nextResetTime`/`expire_at`/`used_at` are ms; OAuth `expires_at`/PAT `expiresAt` are seconds.
- Success codes differ per family (§0.1); don't reuse a single parser.
- `CREDIT_LIMIT` ≡ `TOKENS_LIMIT` for card matching.
- Missing weekly/tool limits must hide the row/card, not render 0 %.
- Team vs personal `type` differs per endpoint (2 vs 3 vs none).
- Timezone comes from the UI (`Intl…resolvedOptions().timeZone`), not the host clock.

**R13. No stable API versioning.** These are ZCode internals; ZCode itself tracks them in ad-hoc docs and e2e mocks
(no OpenAPI). Pin expectations in fixtures (§11) and make the plugin tolerate unknown/missing optional fields
(ZCode's parsers drop unknown fields and default missing series to 0).

**R14. `/api/v1/zcode-plan/billing/*` (Start Plan) is out of scope but adjacent.** It uses only `zcodejwttoken`
(`Authorization: Bearer`) and `app_version`; if the plugin ever shows "Start Plan" balances, it needs the shared JWT
and `X-Device-Mid` for some endpoints (`docs/model-provider-coding-plan-availability.md`). Not covered by the
fixtures here.

---

## 11. Fixtures

All files under `tests/fixtures/` in the plugin workspace. Values are sanitized but field names/types match the ZCode
parsers cited. Timestamps are fixed (2026-07-01 era) so tests can be deterministic.

| File | Endpoint/shape | Source shape used |
|---|---|---|
| `quota-limit.json` | `GET /api/monitor/usage/quota/limit` success | `docs/bigmodel-coding-plan-usage-quota.md` sample + `bigmodelUsageQuotaMapper.ts:24-50` |
| `subscription-list.json` | `GET /api/biz/subscription/list` success (2 items, one non-coding) | `bigmodelUsageQuotaMapper.ts:4-22`, `codingPlanEntitlement.ts:11-20` |
| `usage-model.json` | `GET /api/monitor/usage/model-usage` | `bigmodelUsageMonitorMapper.ts:43-55`; `packages/desktop/wdio.conf.ts` model-usage mock |
| `usage-tool.json` | `GET /api/monitor/usage/tool-usage` | `bigmodelUsageMonitorMapper.ts:57-72`; same wdio mock |
| `credit-activity.json` | `GET /api/monitor/credit-usage/activity` | `bigmodelUsageMonitorMapper.ts:79-98`; `packages/desktop/wdio.conf.ts` credit-activity mock; `packages/services/test/usageStatsService.test.ts:539-561` |
| `credit-detail-model.json` | `GET /api/monitor/credit-usage/usage-detail?usageType=MODEL` | `bigmodelUsageMonitorMapper.ts:100-115`; wdio + `packages/services/test/usageStatsService.test.ts:562-600` |
| `credit-detail-mcp.json` | `GET .../usage-detail?usageType=MCP` | `bigmodelUsageMonitorMapper.ts:117-128`; same tests (MCP branch) |
| `model-performance-day.json` | `GET /api/monitor/usage/model-performance-day` | `bigmodelUsageMonitorMapper.ts:161-166`; wdio mock |
| `reset-status.json` | `GET /api/v1/coding-plan/reset/status` | `bigmodelUsageQuotaProvider.ts:86-103`; `packages/services/test/codingPlanResetProvider.test.ts:150-192` |
| `customer-info.json` | `GET /api/biz/customer/getCustomerInfo` (personal+team projects) | `project-access-token-client.ts:10-28`; `packages/desktop/wdio.conf.ts` customerInfo mock; `bigmodelProviderAdapter.ts:223-275` |
| `api-keys.json` | `GET .../api_keys` list (personal + team entries) | `project-access-token-client.ts:29-33,317-341`; wdio api_keys mock |
| `access-tokens.json` | `POST .../api_keys/{id}/access_tokens` | `project-access-token.ts:10-31`; wdio `access_tokens` mock (Bearer + clientType check) |
| `oauth-init.json` | `POST /api/v1/oauth/cli/init` success | `cli-oauth.ts:172-198`; `apps/zcode-cli/packages/adapters/tests/auth.test.ts:296-315` |
| `oauth-poll-ready.json` | `GET /api/v1/oauth/cli/poll/{flowId}` ready (both provider blocks) | `cli-oauth.ts:200-239`; `tests/auth.test.ts:306-320` |

Non-fixture statuses worth testing inline: poll `{"status":"pending"}`, `{"status":"failed"}`, opportunity
`{"code":3301,"data":{"granted":false,"next_try_at":...}}`, reset `{"code":0,"data":{"used":true}}`,
`{"code":0,"data":{"granted":true}}`, quota no-plan `{"code":404,"msg":"当前用户不存在coding plan","data":null}`
(`packages/desktop/test/e2e/helpers/coding-plan-upgrade-mock-server.ts:436-484`).

---

## 12. Source index (most load-bearing files)

OAuth / credentials
- `apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts` — polling client
- `apps/zcode-cli/packages/bootstrap/src/auth-login-polling.ts`, `auth-login.ts` — poll loop + persistence
- `packages/services/src/oauth/oauthService.ts:629-853,999-1049` — desktop/Web polling, refresh limitations
- `packages/services/src/oauth/providers/{bigmodel,zai}ProviderConfig.ts`, `*ProviderAdapter.ts`
- `packages/shared/src/project-access-token-client.ts`, `project-access-token.ts` — PAT mint/cache
- `packages/services/src/model-provider/{accountProviderApiKeyResolver,accountProviderRequestAuthService}.ts`
- `packages/services/src/bigmodel/{codingPlanEntitlement,teamPlanApiKey}.ts`

Quota / usage / subscription
- `packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts` (endpoints, reset, headers)
- `.../bigmodelUsageQuotaMapper.ts`, `.../bigmodelUsageMonitorMapper.ts`, `.../bigmodelUsageMonitorRange.ts`
- `.../bigmodelSubscriptionProvider.ts`; `packages/services/src/model-provider/codingPlanProviderAvailability.ts`
- `packages/shared/src/usage-stats.ts`, `packages/shared/src/usage-quota.ts`, `packages/shared/src/coding-plan-reset.ts`

UI
- `packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx` (+ `usageStatsUiParts.tsx`, `UsageStatsErrorNotice.tsx`)
- `packages/ui/src/CodingPlanUsageRemainingPanel.tsx`
- `packages/ui/src/chat-input-toolbar/CodingPlanContextUsage.tsx`
- `packages/ui/src/lib/codingPlanQuotaPresentation.ts`, `codingPlanQuotaResetUi.ts`, `codingPlanQuotaResetCoordinator.ts`
- `packages/ui/src/components/coding-plan-quota-reset/*`, `packages/ui/src/i18n/locales/en-US.ts:4463-4693,4505-4545,4560-4598`

ZCode internal contracts/docs
- `docs/bigmodel-coding-plan-usage-quota.md` — quota + usage endpoints, ranges, UI sections
- `docs/coding-plan-quota-remaining-api.md` — quota card matching + percentage inversion
- `docs/model-provider-project-access-token.md` — PAT contract + interface test table (K01–K03, T01–T03, U01–U06)
- `docs/coding-plan-quota-reset-ui.md`, `docs/coding-plan-quota-reset-review.md` — reset contract, retries, error codes
- `docs/analysis/credentials-json-code-audit.md` — credential key table, per-endpoint auth headers, no-refresh fact
- `docs/usage-remaining-refresh-policy.md`, `docs/model-provider-coding-plan-availability.md` — refresh/availability
