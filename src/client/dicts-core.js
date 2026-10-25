/**
 * Shared zh/en dictionaries every client component may use.
 *
 * Keys are flat and dot-separated; owners are split by prefix:
 * `action.*`, `state.*`, `auth.*`, `app.*`, `time.*` live here, while the page
 * and composer widget own `page.*`/`quota.*`/`usage.*`/`reset.*`/`settings.*`
 * and `widget.*`. Placeholders use `{name}` and are filled by the locale
 * service's translate function (or {@link interpolate} for the store's
 * pre-binding fallback). English copy is sentence case.
 */

/** Chinese dictionary. */
const zh = {
  'action.refresh': '刷新',
  'action.retry': '重试',
  'action.close': '关闭',
  'action.cancel': '取消',
  'action.save': '保存',
  'action.login': '登录',
  'action.logout': '退出登录',
  'action.openUsagePage': '打开用量页面',
  'action.viewDetails': '查看详情',
  'action.confirm': '确认',
  'action.back': '返回',

  'state.loading': '加载中…',
  'state.loadingSlow': '加载时间较长…',
  'state.error': '出错了',
  'state.networkError': '网络连接失败',
  'state.notLoggedIn': '未登录',
  'state.loginExpired': '登录已过期',
  'state.noPlan': '未开通编程套餐',
  'state.empty': '暂无数据',
  'state.updating': '正在更新',
  'state.justNow': '刚刚',
  'state.minutesAgo': '{n} 分钟前',
  'state.hoursAgo': '{n} 小时前',
  'state.daysAgo': '{n} 天前',

  'auth.loginTitle': '登录 BigModel',
  'auth.loginBody': '使用 BigModel 账号完成 OAuth 授权后，即可查看编程套餐剩余额度与用量统计。',
  'auth.loginButton': '登录 BigModel',
  'auth.loginWaiting': '等待授权…',
  'auth.loginWaitingHint': '请在浏览器中完成授权，完成后此页面会自动刷新。',
  'auth.loginFailed': '登录失败，请重试。',
  'auth.loginExpiredBody': '登录已过期，请重新登录。',
  'auth.loginPopupBlocked': '弹窗被拦截，请允许弹窗后重试。',
  'auth.account': '账号',
  'auth.family': '平台',
  'auth.expiresAt': '到期时间',
  'auth.renewTime': '续订时间',
  'auth.billingCycle': '计费周期',
  'auth.billingCycleAutopay': '自动续费',
  'auth.billingCycleRenew': '手动续费',
  'auth.billingCycleNone': '无',
  'auth.logoutConfirm': '确定要退出登录吗？',

  'app.nav': 'BigModel 用量',
  'app.title': 'BigModel 编程套餐',
  'app.subtitle': '额度与用量统计',

  'time.today': '今天',
  'time.tomorrow': '明天',
  'time.resetIn': '还有 {n} 重置',
  'time.resetAt': '{t} 重置',
  'time.hoursShort': '{n} 小时',
  'time.minutesShort': '{n} 分钟',
  'time.daysShort': '{n} 天',
  'time.resetDue': '即将重置',
  'time.lessThanMinute': '不到 1 分钟',
  'time.windowFiveHour': '5 小时',
  'time.windowWeek': '每周',
  'time.windowTool': '工具',
  'time.windowOther': '其他',
};

/** English dictionary (sentence case). */
const en = {
  'action.refresh': 'Refresh',
  'action.retry': 'Retry',
  'action.close': 'Close',
  'action.cancel': 'Cancel',
  'action.save': 'Save',
  'action.login': 'Log in',
  'action.logout': 'Log out',
  'action.openUsagePage': 'Open usage page',
  'action.viewDetails': 'View details',
  'action.confirm': 'Confirm',
  'action.back': 'Back',

  'state.loading': 'Loading…',
  'state.loadingSlow': 'Taking longer than usual…',
  'state.error': 'Something went wrong',
  'state.networkError': 'Network error',
  'state.notLoggedIn': 'Not signed in',
  'state.loginExpired': 'Session expired',
  'state.noPlan': 'No coding plan',
  'state.empty': 'No data yet',
  'state.updating': 'Updating',
  'state.justNow': 'Just now',
  'state.minutesAgo': '{n} min ago',
  'state.hoursAgo': '{n} hr ago',
  'state.daysAgo': '{n} d ago',

  'auth.loginTitle': 'Sign in to BigModel',
  'auth.loginBody': 'Sign in with your BigModel account through OAuth to view Coding Plan quota and usage.',
  'auth.loginButton': 'Sign in to BigModel',
  'auth.loginWaiting': 'Waiting for authorization…',
  'auth.loginWaitingHint': 'Complete authorization in the browser; this page refreshes automatically.',
  'auth.loginFailed': 'Sign-in failed. Try again.',
  'auth.loginExpiredBody': 'Your session expired. Sign in again.',
  'auth.loginPopupBlocked': 'The popup was blocked. Allow popups and try again.',
  'auth.account': 'Account',
  'auth.family': 'Platform',
  'auth.expiresAt': 'Expires',
  'auth.renewTime': 'Renews',
  'auth.billingCycle': 'Billing cycle',
  'auth.billingCycleAutopay': 'Auto-renew',
  'auth.billingCycleRenew': 'Manual renewal',
  'auth.billingCycleNone': 'None',
  'auth.logoutConfirm': 'Sign out of BigModel?',

  'app.nav': 'BigModel usage',
  'app.title': 'BigModel coding plan',
  'app.subtitle': 'Quota and usage statistics',

  'time.today': 'Today',
  'time.tomorrow': 'Tomorrow',
  'time.resetIn': 'Resets in {n}',
  'time.resetAt': 'Resets at {t}',
  'time.hoursShort': '{n} hr',
  'time.minutesShort': '{n} min',
  'time.daysShort': '{n} d',
  'time.resetDue': 'Resetting now',
  'time.lessThanMinute': 'Less than a minute',
  'time.windowFiveHour': '5-hour',
  'time.windowWeek': 'Weekly',
  'time.windowTool': 'Tools',
  'time.windowOther': 'Other',
};

/**
 * Fill `{name}` placeholders in one dictionary template.
 * @param template - dictionary string.
 * @param params - placeholder values; `null`/`undefined` keep the literal placeholder.
 * @returns the interpolated string, or the input when it is not a string.
 */
export function interpolate(template, params) {
  if (typeof template !== 'string' || params === null || typeof params !== 'object') return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Shared dictionaries, keyed by dictionary locale id. */
export const coreDicts = Object.freeze({ zh: Object.freeze(zh), en: Object.freeze(en) });
