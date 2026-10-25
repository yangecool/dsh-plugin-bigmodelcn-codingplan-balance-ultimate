# dsh-plugin-bigmodelcn-codingplan-balance-ultimate

[English](#english) | [中文](#中文)

<a id="english"></a>
BigModel Coding Plan quota and usage for the DeepSeek Harness Web GUI — an
upgraded, ZCode-parity port of `dsh-plugin-glm-balance`.

It signs in to BigModel with OAuth, shows the remaining Coding Plan quota in a
composer popover, opens a dedicated usage statistics page, and — the part that
removes the last manual step — writes the Coding Plan project token into the
DeepSeek Harness credential store so model inference works **without pasting an
API key**.

## Why this exists

The previous `dsh-plugin-glm-balance` widget required an `authorization` header
copied from the browser devtools and refreshed nothing; it also could not show
subscription state, reset chances, or usage statistics. This plugin ports
ZCode's Coding Plan capability set:

- **OAuth login** through the ZCode CLI login relay (device-style polling flow;
  no redirect URI registration, no copied headers).
- **Automatic model-inference sign-in**: after login the Host half issues the
  Coding Plan project access token and stores it under the credential reference
  that the `zai-coding-cn` pi-ai route resolves, then renews it before expiry.
  Select a model from that provider and chat — no key prompt.
- **Composer remaining-quota popover**: two compact bars at the composer open a
  floating card with the 5-hour and weekly remaining percentages, reset
  countdowns, today's tokens/calls, remaining reset chances, and shortcuts to
  the full page.
- **Dedicated usage statistics page** (sidebar panel + Settings section):
  subscription card, quota cards per window, reset chances, range-switched
  usage statistics (tokens, calls, credits, cache hit ratio, streak, peak day),
  an inline SVG trend chart, per-model breakdown, and MCP/tool usage.
- **Models settings integration**: an account row at the bottom of Settings →
  Models (identity, sign-in status, edit/sign-out, account and credential
  details) plus a note inside each coding-plan provider card saying its API key
  is provisioned by the OAuth sign-in — matching how the built-in account row
  presents itself.
- **Own settings** on the page: provider family, refresh interval, provider gate
  list, inference credential reference.

## Install

```sh
dsh plugin --profile web add /absolute/path/to/dsh-plugin-bigmodelcn-codingplan-balance-ultimate
```

Then reload the Web GUI page. A new sidebar icon and a Settings page appear.
The Host half registers same-origin routes under `/bigmodelcn-codingplan` on the
running Web server.

Uninstall:

```sh
dsh plugin --profile web remove dsh-plugin-bigmodelcn-codingplan-balance-ultimate
```

## First-time setup

1. Open the sidebar page **BigModel usage** (or Settings → BigModel usage).
2. Click **Sign in to BigModel**. A new browser tab opens the BigModel login
   page; finish the login there.
3. The plugin page switches to the dashboard automatically. Subscription,
   quota windows, reset chances, and usage statistics load immediately.
4. Model inference is signed in at the same time: the plugin writes the issued
   Coding Plan project token into the credential reference configured under
   **Model inference** (default `ZAI_CODING_CN_API_KEY`). Settings → Models now
   shows a **BigModel account** row with the sign-in state and a note inside the
   coding-plan provider card. The shipped
   `zai-coding-cn` provider route (endpoint
   `https://open.bigmodel.cn/api/coding/paas/v4`) resolves that reference on
   every call, so choosing one of its models now works without a pasted key.

The token is renewed in the background before it expires; a DSH restart re-issues
it from the stored login.

## Configuration

The plugin persists two files in the Harness home (`$DSH_HOME`, default `~/.dsh`):

| File | Contents |
| --- | --- |
| `bigmodelcn-codingplan.json` | Non-secret settings (`0600`) |
| `bigmodelcn-codingplan-auth.json` | OAuth tokens, account info, key location, inference bookkeeping (`0600`) |

Settings (`Settings` card on the page, or edit the JSON while DSH is stopped):

```json
{
  "family": "bigmodel",
  "refreshMinutes": 30,
  "providerIds": [],
  "showIndicatorWhenLoggedOut": false,
  "usagePageUrl": "",
  "inferenceEnabled": true,
  "inferenceCredentialRef": "ZAI_CODING_CN_API_KEY"
}
```

- `family` — `bigmodel` (bigmodel.cn) or `zai` (api.z.ai). Personal plans only.
- `refreshMinutes` — automatic refresh of the quota overview, 1–1440.
- `providerIds` — show the composer widget only for these model-provider ids;
  the default empty list shows it for every provider once signed in. When the
  model directory service is unavailable the widget stays visible.
- `showIndicatorWhenLoggedOut` — render a quiet sign-in chip instead of hiding
  the widget while signed out.
- `inferenceEnabled` / `inferenceCredentialRef` — the model-inference sign-in
  described above. Set the reference to whatever the pi-ai provider profile
  names in its `apiKeyEnv`.

## How it works

- **Login**: the Host half calls the ZCode CLI OAuth relay
  (`POST https://zcode.z.ai/api/v1/oauth/cli/init`, then polls
  `/api/v1/oauth/cli/poll/<flow_id>`). Poll results carry the BigModel business
  token and the ZCode JWT; the probe finishes in the browser, the Host never
  sees a password.
- **Authorization chain**: OAuth business token → `customer/getCustomerInfo` →
  personal organization/project → reuse-or-create the `zcode-api-key` Coding
  Plan key → project access token (PAT) → `/api/monitor/*` and
  `/api/biz/subscription/list` calls with the PAT.
- **Quota**: `/api/monitor/usage/quota/limit`. A limit's `percentage` is the
  **used** ratio; the UI inverts it once and shows the remaining share.
  5-hour window = `unit 3, number 5`; weekly = `unit 6`; monthly tools =
  `TIME_LIMIT, unit 5, number 1`.
- **Usage statistics**: `/api/monitor/usage/model-usage`, `tool-usage`,
  `credit-usage/activity`, `credit-usage/usage-detail`, `model-performance-day`
  over the selected range in the browser's time zone.
- **Reset chances**: `/api/v1/coding-plan/reset/status` and `/use` on the ZCode
  origin. Consuming a reset invalidates the cached quota so the next refresh
  reflects the refreshed window.
- **Model inference**: the issued PAT is written with
  `ctx.credentials.set(ref, token)`; DSH's pi-ai plugin resolves that reference
  per operation, so renewal reaches the next model call without a restart.

## Security

- The Host routes require the same authenticated browser session as the rest of
  the Harness UI (the connection carrier's browser cookie plus Host/Origin
  fence); a LAN peer that merely reaches the port gets 401/403.
- Tokens are never logged, never enter the session log, and never appear in
  route responses. Route payloads expose only timestamps and status codes.
- The auth file is created with mode `0600`; logout unsets the credential the
  login wrote and deletes the auth file.
- Sign in replaces whatever value is currently stored under the inference
  credential reference. If you kept a personal key there, it is not restored on
  logout (the ambient environment variable becomes effective again).

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| `Sign in` state with "expired" notice | The stored login was rejected (expired/revoked); sign in again. |
| "No Coding Plan" empty card | The account has no active personal Coding Plan in the selected family. |
| `Credentials service unavailable` | This Host composition has no `credentials` service; inference sign-in is skipped, quota features keep working. |
| Widget shows `--` | Quota request failed; open the page for the error and retry, or check the BigModel console. |
| Reset button says retry later | The reset endpoint is throttled (HTTP 429 or business code 3301); wait for the cooldown shown on the card. |
| Model inference still asks for a key | The pi-ai provider profile's `apiKeyEnv` differs from `inferenceCredentialRef`; set the same reference. |

## Development

```sh
npm install --include=dev          # esbuild for the client bundle
node scripts/build-client.mjs      # src/client -> lib/client.js (committed artifact)
node --test tests/host/*.test.mjs tests/client/*.test.mjs
```

Layout: `lib/index.js` is the Host entry; `lib/host/*` holds storage, HTTP,
OAuth, account/PAT, upstream BigModel calls, snapshot caches, route table, and
inference sign-in. `src/client/*` holds the browser half; `scripts/build-client.mjs`
bundles it into the single classic script the Harness Client module loader
executes. `notes/zcode-api-spec.md` documents the upstream protocol with ZCode
source references, and `tests/fixtures/*` holds sanitized response samples.

## Known limits

- Personal Coding Plan scope only; team plans, Start plans, and the ZCode
  MCP quota are out of scope.
- No OAuth refresh token flow: when the BigModel token expires the page asks to
  sign in again (the project token itself is renewed while the login lasts).
- The login depends on the ZCode OAuth relay; if the relay changes or rejects
  third-party clients, sign-in fails with a clear error.
- Only the BigModel/Z.AI families are supported; both share the same UI.

## License

MIT.

---

<a id="中文"></a>
DeepSeek Harness Web GUI 的 BigModel（智谱）编程套餐额度与用量插件，是
`dsh-plugin-glm-balance` 的全面升级版，能力对标 ZCode。

它通过 OAuth 登录 BigModel，在输入框浮窗显示编程套餐剩余额度，提供独立的使用统计
页面，并把编程套餐项目令牌自动写入 DeepSeek Harness 凭证库——**模型推理也一起
登录，无需再手动粘贴密钥**。

## 功能

- **OAuth 登录**：走 ZCode CLI 登录中转（轮询式设备登录流程），不需要注册回调
  地址，也不需要从开发者工具复制请求头。
- **模型推理自动登录**：登录后插件签发编程套餐项目令牌，写入 pi-ai 路由
  `zai-coding-cn` 解析的凭证引用（默认 `ZAI_CODING_CN_API_KEY`），并在过期前自动
  续期。选该供应商的模型直接对话，不再提示输入密钥。
- **输入框剩余额度浮窗**：输入框右侧两条紧凑额度条，点开后是浮窗卡片：5 小时 /
  每周剩余百分比、重置倒计时、今日 tokens 与调用次数、剩余重置机会，以及进入完整
  统计页的快捷入口。
- **独立使用统计页**（侧边栏面板 + 设置分区）：套餐卡片、各时间窗口额度卡、重置
  机会、按范围切换的用量统计（tokens、调用、额度、缓存命中率、连续天数、峰值日）、
  内联 SVG 趋势图、按模型明细与 MCP / 工具用量。
- **模型设置页集成**：设置 → 模型 底部新增「BigModel 账号」横栏（账号、登录状态、
  编辑/退出登录、凭证详情），并在编程套餐供应商卡片内提示：API 密钥由 OAuth 登录
  自动提供，无需手动粘贴。
- **页面内设置**：服务族（BigModel / Z.AI）、自动刷新间隔、供应商显示范围、模型
  推理凭证引用。

## 安装

```sh
dsh plugin --profile web add /插件目录的绝对路径
```

安装后刷新 Web GUI 页面，侧边栏与设置中会出现「BigModel 用量」入口。

## 首次使用

1. 打开侧边栏「BigModel 用量」页面（或 设置 → BigModel 用量）。
2. 点击「登录 BigModel」，在新标签页完成 BigModel 登录。
3. 页面自动切换为数据面板，套餐、额度、重置机会与用量统计立即加载。
4. 模型推理同时完成登录：插件把签发的编程套餐项目令牌写入「模型推理」设置中的
   凭证引用。DSH 内置的 `zai-coding-cn` 供应商（端点
   `https://open.bigmodel.cn/api/coding/paas/v4`）每次调用都会解析该引用，因此选择
   它的模型即可直接对话，无需粘贴密钥。

令牌会在过期前由后台自动续期；DSH 重启后会根据已保存的登录重新签发。

## 配置

插件在 Harness 主目录（`$DSH_HOME`，默认 `~/.dsh`）保存两个文件：

| 文件 | 内容 |
| --- | --- |
| `bigmodelcn-codingplan.json` | 非机密设置（`0600`） |
| `bigmodelcn-codingplan-auth.json` | OAuth 令牌、账号信息、Key 位置、推理凭证记录（`0600`） |

配置字段说明：

- `family`：`bigmodel`（bigmodel.cn）或 `zai`（api.z.ai），仅支持个人套餐。
- `refreshMinutes`：额度概览自动刷新间隔（1–1440 分钟）。
- `providerIds`：仅在这些模型供应商下显示输入框浮窗；默认空数组表示登录后始终显示。
- `showIndicatorWhenLoggedOut`：未登录时显示「登录」小徽标而不是隐藏浮窗。
- `inferenceEnabled` / `inferenceCredentialRef`：模型推理自动登录开关与凭证引用名。

## 工作原理与安全

- 登录经 ZCode CLI 中转（`/api/v1/oauth/cli/init` + 轮询 `/poll/<flow_id>`），
  浏览器完成授权，插件只轮询结果，不接触密码。
- 授权链：OAuth 业务令牌 → `customer/getCustomerInfo` → 个人机构/项目 →
  复用或创建 `zcode-api-key` → 项目访问令牌（PAT）→ 查询额度、订阅与用量。
- 额度接口的 `percentage` 是**已使用**比例，界面统一反转成剩余比例一次。
- 插件路由复用 Harness 的浏览器会话鉴权：仅能从已登录的 Web 页面访问，局域网内
  未认证请求返回 401/403。
- 令牌不写日志、不进会话记录、不出现在接口响应中；认证文件权限 `0600`；退出登录
  会删除插件写入的凭证并清除认证文件。
- 登录会覆盖凭证引用下已存在的值；退出登录不会恢复它（环境变量回退会重新生效）。

## 已知限制

- 仅支持个人编程套餐；团队套餐、Start 套餐与 ZCode MCP 额度暂不支持。
- 没有 OAuth refresh token 流程：BigModel 登录令牌过期后需要重新登录（项目令牌
  在登录有效期内会自动续期）。
- 登录依赖 ZCode OAuth 中转服务；若中转变更或拒绝第三方客户端，登录会给出明确
  错误。
- 仅支持 BigModel 与 Z.AI 两个服务族。

## License

MIT。
