# Changelog

All notable changes to this plugin are documented here. Version numbers follow
[SemVer](https://semver.org/).

## [1.0.0] - 2026-10-25

First release: a ZCode-parity rebuild of `dsh-plugin-glm-balance` for BigModel
Coding Plan accounts.

### Added

- **OAuth login** through the ZCode CLI login relay: `登录 BigModel` starts the
  relay flow in a new tab, the Host half polls until the relay reports tokens,
  and the login is validated against BigModel customer info. No copied
  `authorization` header, no callback URI to register.
- **Automatic model-inference sign-in**: after login the plugin issues the
  Coding Plan project access token and stores it under the credential reference
  the `zai-coding-cn` pi-ai route resolves (`ZAI_CODING_CN_API_KEY` by default),
  renewing it before expiry. Model inference works without pasting a key; a DSH
  restart re-signs it from the stored login.
- **Dedicated usage statistics page** in the sidebar and in Settings:
  subscription card, 5-hour / weekly / monthly-tool quota cards with remaining
  percentages and reset countdowns, per-window reset chances (with the reset
  action), range-switched usage statistics (today / 7 days / 30 days) with
  metric tiles, an inline SVG trend chart, model breakdown, and MCP/tool usage.
- **Composer remaining-quota popover**: two compact bars in the composer tool
  row open a floating card with quota bars, reset countdowns, today's
  tokens/calls, remaining reset chances, a refresh action, and links to the full
  page and the BigModel usage console.
- **Models settings page integration**: a `BigModel account` row in
  Settings → Models (identity, status dot, sign-in state, edit panel with
  account/email/family/sign-in time, inference credential state and expiry,
  open-usage and sign-out actions) plus a credential note inside each
  coding-plan provider card; both match the host's own account-row presentation.
- **Inference status card and settings**: family selector (BigModel / Z.AI),
  refresh interval, provider gate list, inference toggle and credential
  reference, all persisted in `$DSH_HOME/bigmodelcn-codingplan.json`.
- **Session-gated Host routes** under `/bigmodelcn-codingplan`: the raw Web
  routes reuse the connection carrier's browser-session authentication
  (`connection.requestRejection`), answering 401/403 to untrusted peers.
- Host modules for the full BigModel Coding Plan chain: OAuth start/poll, token
  persistence (`0600`), customer info, personal project selection, API-key
  reuse-or-create, project access token issuance and caching, quota,
  subscription, five usage-statistics endpoints, Coding Plan reset status/use,
  TTL caches with single-flight and stale-last-good semantics, and automatic
  inference-credential renewal.
- ZCode API reference notes with source references (`notes/zcode-api-spec.md`)
  and sanitized response fixtures (`tests/fixtures/`).
- 237 unit and integration tests: OAuth/account/PAT, upstream normalizers over
  fixtures, snapshot caching and error mapping, inference bookkeeping, client
  formatters, and a Host integration suite that exercises the real route table
  with only the network replaced.

### Changed from `dsh-plugin-glm-balance`

- Replaced the pasted `authorization` header with OAuth login and automatic
  credential provisioning.
- Settings moved from a standalone GLM settings section into the feature page
  (the page is also a Settings section).
- The composer indicator only appears for providers listed in `providerIds`
  (default `zai-coding-cn`, `bigmodel-coding-cn`) and stays hidden while signed
  out unless configured otherwise.
- The token file format changed; previous `~/.dsh/glm-balance.json` values are
  not read, so sign in once after installing.

### Known limits

- Personal Coding Plan only (no team/Start plans or ZCode MCP quota).
- No OAuth refresh-token flow: an expired BigModel login requires signing in
  again; the project token itself is renewed while the login lasts.
- Login depends on the ZCode OAuth relay.
