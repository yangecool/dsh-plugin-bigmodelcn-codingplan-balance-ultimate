/**
 * Fixed protocol constants for the BigModel Coding Plan plugin.
 *
 * These are external-service contracts (BigModel business APIs, the ZCode OAuth
 * relay, Coding Plan reset APIs) rather than deployment tunables; user-facing
 * choices live in the plugin's own config file and settings UI.
 */

/** Same-origin prefix every Host route of this plugin mounts under. */
export const ROUTE_PREFIX = '/bigmodelcn-codingplan';

/** Package id: the Client bundle registration id and the Host plugin name. */
export const PACKAGE_ID = 'dsh-plugin-bigmodelcn-codingplan-balance-ultimate';

/** Sidebar panel key shared by the `main` panel and its `sidebar.panellist` icon. */
export const PANEL_ID = 'bigmodelcn-usage';

/** Client locale namespace used by dictionaries and slot `locale` options. */
export const LOCALE_NS = 'bigmodelcn-balance';

/** ZCode OAuth relay origin: the CLI login flow the desktop and web clients use. */
export const ZCODE_ORIGIN = 'https://zcode.z.ai';

/** ZCode CLI OAuth flow endpoints. */
export const OAUTH_INIT_PATH = '/api/v1/oauth/cli/init';
/** @param flowId - flow id returned by the init call. @returns the poll path. */
export const oauthPollPath = (flowId) => `/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`;

/** Coding Plan API paths on a family origin (BigModel or Z.AI business API). */
export const QUOTA_LIMIT_PATH = '/api/monitor/usage/quota/limit';
export const MODEL_USAGE_PATH = '/api/monitor/usage/model-usage';
export const TOOL_USAGE_PATH = '/api/monitor/usage/tool-usage';
export const CREDIT_ACTIVITY_PATH = '/api/monitor/credit-usage/activity';
export const CREDIT_DETAIL_PATH = '/api/monitor/credit-usage/usage-detail';
export const MODEL_PERFORMANCE_PATH = '/api/monitor/usage/model-performance-day';
export const SUBSCRIPTION_LIST_PATH = '/api/biz/subscription/list';
export const CUSTOMER_INFO_PATH = '/api/biz/customer/getCustomerInfo';
/** @param org - organization id. @param project - project id. @returns the project API-key collection path. */
export const apiKeysPath = (org, project) =>
  `/api/biz/v1/organization/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/api_keys`;
/** @param org - organization id. @param project - project id. @param keyId - API key id. @returns the access-token issuance path. */
export const accessTokensPath = (org, project, keyId) =>
  `${apiKeysPath(org, project)}/${encodeURIComponent(keyId)}/access_tokens`;

/** ZCode-hosted Coding Plan reset endpoints (MaaS JWT + X-Bigmodel-Authorization). */
export const RESET_STATUS_PATH = '/api/v1/coding-plan/reset/status';
export const RESET_USE_PATH = '/api/v1/coding-plan/reset/use';
export const RESET_OPPORTUNITY_PATH = '/api/v1/coding-plan/reset/opportunity';
export const RESET_HISTORY_READ_PATH = '/api/v1/coding-plan/reset/history/read';

/** `usageScene` of an API key created for Coding Plan usage (ZCode constant). */
export const CODING_PLAN_USAGE_SCENE = 1;

/**
 * API-key display name reused from ZCode so an account that already installed a
 * Coding Plan key through ZCode is adopted instead of duplicating the key.
 */
export const API_KEY_NAME = 'zcode-api-key';

/**
 * Client identity the project access-token endpoint expects. The endpoint is
 * ZCode's own server API, so the plugin presents a ZCode-compatible client
 * identity (current ZCode desktop release) rather than a DSH version.
 */
export const ACCESS_TOKEN_CLIENT_TYPE = 'zcode';
export const ACCESS_TOKEN_CLIENT_VERSION = '3.16.3';

/**
 * Z.AI OAuth access tokens are OAuth tokens, not business tokens: the Z.AI
 * family exchanges one for a business JWT before calling /api/biz/* endpoints.
 */
export const ZAI_BUSINESS_LOGIN_PATH = '/api/auth/z/login';

/** BigModel and Z.AI both expose the same business/monitor surface on different origins. */
export const FAMILIES = Object.freeze({
  bigmodel: Object.freeze({
    id: 'bigmodel',
    label: 'BigModel',
    origin: 'https://bigmodel.cn',
    authorizeProvider: 'bigmodel',
    usagePageUrl: 'https://bigmodel.cn/coding-plan/personal/usage',
  }),
  zai: Object.freeze({
    id: 'zai',
    label: 'Z.AI',
    origin: 'https://api.z.ai',
    authorizeProvider: 'zai',
    usagePageUrl: 'https://z.ai/manage-apikey/coding-plan/personal/usage',
  }),
});

/** Family id list accepted by config validation. */
export const FAMILY_IDS = Object.freeze(Object.keys(FAMILIES));

/** Default user config: persisted in `$DSH_HOME/bigmodelcn-codingplan.json`. */
export const DEFAULT_CONFIG = Object.freeze({
  family: 'bigmodel',
  refreshMinutes: 30,
  // Empty means: show the composer widget once signed in, whatever model
  // provider the session routes to; users can restrict it to specific routes.
  providerIds: [],
  showIndicatorWhenLoggedOut: false,
  usagePageUrl: '',
  /**
   * Automatic model-inference sign-in: after OAuth login the plugin issues the
   * Coding Plan project token and stores it under the pi-ai route's credential
   * reference, so the configured provider authenticates without a pasted key.
   */
  inferenceEnabled: true,
  /** Credential reference of the pi-ai provider route that should use the token. */
  inferenceCredentialRef: 'ZAI_CODING_CN_API_KEY',
});

/** Default usage-stats range shown by the dedicated page. */
export const DEFAULT_USAGE_RANGE = 'today';

/** Usage range ids shared by the Host query and the Client range switcher. */
export const USAGE_RANGES = Object.freeze(['today', '7d', '30d']);

/** Upper bound of a config file we are willing to parse and rewrite. */
export const MAX_CONFIG_BYTES = 64 * 1024;

/** Per-request upstream timeout. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** A login flow the user never finishes stops polling after this long. */
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60_000;

/** Freshness of the aggregated overview while an auto-refresh tick fires. */
export const OVERVIEW_TTL_MS = 30_000;
export const USAGE_TTL_MS = 120_000;
export const RESET_TTL_MS = 60_000;

/** Project access tokens are refreshed when less than this remains. */
export const PROJECT_TOKEN_REFRESH_LEAD_MS = 120_000;

/** Inference credentials are rewritten when less than this remains. */
export const INFERENCE_REFRESH_LEAD_MS = 5 * 60_000;

/** How often the inference credential owner checks for expiry. */
export const INFERENCE_SYNC_INTERVAL_MS = 60_000;
