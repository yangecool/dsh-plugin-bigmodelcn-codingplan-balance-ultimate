/**
 * Usage-statistics section of the dedicated BigModel usage page.
 *
 * Renders the range switcher, the available summary metrics, an inline SVG
 * trend chart (no chart dependency), the model breakdown table, and the
 * tools/MCP usage list. Every payload field is optional: a missing metric is
 * not rendered, and an empty range falls back to an empty state.
 */
import { rt } from './runtime.js';
import { Button, Card, EmptyState, Notice, Segmented, Stat } from './ui.js';
import { formatPercent, formatRelative } from './format.js';
import {
  formatCompact,
  formatCredits,
  formatDateTime,
  formatNumber,
  formatPercentValue,
} from './page-format.js';
import {
  attempt,
  chartGeometry,
  cls,
  errorTextOf,
  isNumber,
  labelIndices,
  num,
  pointLabel,
  seriesPoints,
  shareOf,
  tokensOf,
} from './page-helpers.js';

/** Element factory routed through the runtime binding. */
function el(type, props, ...children) {
  const h = rt.h;
  return typeof h === 'function' ? h(type, props, ...children) : null;
}

/** Range switcher options in display order. */
const RANGE_OPTIONS = Object.freeze([
  { value: 'today', key: 'usage.rangeToday' },
  { value: '7d', key: 'usage.range7d' },
  { value: '30d', key: 'usage.range30d' },
]);

/** Loading skeleton of the usage card. */
function UsageSkeleton({ t }) {
  const tiles = [0, 1, 2, 3];
  const rows = [0, 1, 2];
  return el('div', { className: 'bmc-page-stack', 'aria-busy': 'true' },
    el('span', { className: 'bmc-sr-only' }, t('usage.loading')),
    el('div', { className: 'bmc-page-skeleton-metrics' },
      tiles.map((index) => el('div', {
        key: `tile-${index}`,
        className: 'bmc-page-skeleton bmc-page-skeleton-tile',
      }))),
    el('div', { className: 'bmc-page-skeleton bmc-page-skeleton-chart' }),
    el('div', { className: 'bmc-page-skeleton-rows' },
      rows.map((index) => el('div', {
        key: `row-${index}`,
        className: 'bmc-page-skeleton bmc-page-skeleton-row',
      }))));
}

/**
 * Cache hit rate as a 0..100 percentage.
 * @param value - ratio (0..1) or percentage (0..100) from the Host.
 * @returns percentage, else null.
 */
function hitRatePercent(value) {
  const numeric = num(value);
  if (numeric === null) {
    return null;
  }
  const percent = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.min(100, Math.max(0, percent));
}

/** Granularity the chart uses: Host value when known, otherwise range-derived. */
function chartGranularity(usage, range) {
  const value = usage && typeof usage === 'object' ? usage.granularity : null;
  if (value === 'hour' || value === 'day') {
    return value;
  }
  return range === 'today' ? 'hour' : 'day';
}

/**
 * Inline SVG trend chart of the usage series.
 * @param props - `t`, `locale`, `points`, `granularity`.
 * @returns the chart element, or null when there are no points.
 */
export function UsageChart({ t, locale, points, granularity }) {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }
  const { max, bars } = chartGeometry(points);
  const labels = labelIndices(points.length, 6).map((index) => pointLabel(points[index], granularity));
  const slot = 100 / points.length;
  return el('div', { className: 'bmc-page-chart' },
    el('div', { className: 'bmc-page-chart-head' },
      el('p', { className: 'bmc-page-chart-title' }, t('usage.chartTitle')),
      max > 0
        ? el('span', { className: 'bmc-page-chart-hint' }, t('usage.peakHint', { value: formatCompact(max, locale) }))
        : null),
    el('svg', {
      className: 'bmc-page-chart-svg',
      viewBox: '0 0 100 100',
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': t('usage.chartAria'),
      focusable: 'false',
    },
    max <= 0
      ? el('line', {
        className: 'bmc-page-chart-baseline',
        x1: 0,
        y1: 99.5,
        x2: 100,
        y2: 99.5,
      })
      : null,
    bars.map((bar) => {
      const point = points[bar.index];
      const label = pointLabel(point, granularity);
      return el('g', { key: `bar-${bar.index}`, className: 'bmc-page-chart-col' },
        el('title', null, t('usage.chartHover', {
          label: label === '' ? String(bar.index + 1) : label,
          value: formatCompact(tokensOf(point), locale),
        })),
        el('rect', {
          className: 'bmc-page-chart-hit',
          x: bar.index * slot,
          y: 0,
          width: slot,
          height: 100,
        }),
        el('rect', {
          className: 'bmc-page-chart-bar',
          x: bar.x,
          y: bar.y,
          width: bar.width,
          height: Math.max(0, bar.height),
        }));
    })),
    el('div', { className: 'bmc-page-chart-axis', 'aria-hidden': 'true' },
      labels.map((label, index) => el('span', { key: `label-${index}` }, label))));
}

/**
 * Summary metric tiles for one usage payload.
 * @param props - `t`, `locale`, `summary`.
 * @returns the tile grid, or null when no metric is available.
 */
export function UsageMetrics({ t, locale, summary }) {
  const data = summary && typeof summary === 'object' ? summary : {};
  const tiles = [];
  const totalTokens = num(data.totalTokens);
  if (totalTokens !== null) {
    tiles.push(el(Stat, {
      key: 'tokens',
      label: t('usage.totalTokens'),
      value: formatCompact(totalTokens, locale),
    }));
  }
  const totalCalls = num(data.totalCalls);
  if (totalCalls !== null) {
    tiles.push(el(Stat, {
      key: 'calls',
      label: t('usage.totalCalls'),
      value: formatNumber(totalCalls, locale),
    }));
  }
  const totalCredits = num(data.totalCredits);
  if (totalCredits !== null) {
    tiles.push(el(Stat, {
      key: 'credits',
      label: t('usage.totalCredits'),
      value: formatCredits(totalCredits, locale),
    }));
  }
  const hitRate = hitRatePercent(data.cacheHitRate);
  if (hitRate !== null) {
    const text = attempt(() => formatPercent(hitRate, locale), '') || formatPercentValue(hitRate, locale);
    tiles.push(el(Stat, {
      key: 'cache',
      label: t('usage.cacheHitRate'),
      value: text,
    }));
  }
  const activeDays = num(data.activeDays);
  if (activeDays !== null) {
    tiles.push(el(Stat, {
      key: 'active',
      label: t('usage.activeDays'),
      value: t('usage.daysValue', { count: formatNumber(activeDays, locale) }),
    }));
  }
  const peak = num(data.peakDailyTokens);
  if (peak !== null) {
    const peakDate = data.peakDailyTokensDate;
    const hint = typeof peakDate === 'string' && peakDate.length > 0
      ? formatDateTime(peakDate, locale, { dateOnly: true })
      : null;
    tiles.push(el(Stat, {
      key: 'peak',
      label: t('usage.peakDay'),
      value: formatCompact(peak, locale),
      hint: hint !== null && hint !== '—' ? hint : undefined,
    }));
  }
  const streak = num(data.currentStreakDays);
  const longest = num(data.longestStreakDays);
  if (streak !== null || longest !== null) {
    tiles.push(el(Stat, {
      key: 'streak',
      label: t('usage.currentStreak'),
      value: t('usage.daysValue', { count: formatNumber(streak ?? 0, locale) }),
      hint: longest !== null ? t('usage.streakHint', { days: formatNumber(longest, locale) }) : undefined,
    }));
  }
  if (tiles.length === 0) {
    return null;
  }
  return el('div', { className: 'bmc-page-metrics' }, tiles);
}

/**
 * Model breakdown table with a share bar per row.
 * @param props - `t`, `locale`, `models`, `totalTokens`.
 * @returns the table, or null when no model row is usable.
 */
export function UsageModelTable({ t, locale, models, totalTokens }) {
  const rows = Array.isArray(models)
    ? models.filter((model) => model !== null && typeof model === 'object').slice(0, 8)
    : [];
  if (rows.length === 0) {
    return null;
  }
  const tokensSum = num(totalTokens) ??
    rows.reduce((sum, model) => sum + (num(model.tokens) ?? 0), 0);
  const nameOf = (model) => {
    if (typeof model.modelName === 'string' && model.modelName.length > 0) return model.modelName;
    if (typeof model.modelCode === 'string' && model.modelCode.length > 0) return model.modelCode;
    return '—';
  };
  return el('div', { className: 'bmc-page-table' },
    el('p', { className: 'bmc-page-table-title' }, t('usage.modelBreakdown')),
    el('div', { className: 'bmc-page-table-head' },
      el('span', null, t('usage.modelColumn')),
      el('span', { className: 'bmc-page-table-num-head' }, t('usage.tokensColumn')),
      el('span', { className: 'bmc-page-table-num-head bmc-page-table-col-calls' }, t('usage.callsColumn')),
      el('span', { className: 'bmc-page-table-num-head bmc-page-table-col-credits' }, t('usage.creditsColumn'))),
    rows.map((model, index) => {
      const name = nameOf(model);
      const share = shareOf(model.tokens, tokensSum);
      return el('div', {
        key: `model-${typeof model.modelCode === 'string' ? model.modelCode : index}`,
        className: 'bmc-page-table-row',
      },
      el('div', { className: 'bmc-page-table-name' },
        el('span', { className: 'bmc-page-table-name-text', title: name }, name),
        el('div', {
          className: 'bmc-page-share',
          role: 'img',
          'aria-label': `${t('usage.shareLabel')} ${formatPercentValue(share, locale)}`,
        },
        el('div', {
          className: 'bmc-page-share-fill',
          style: { width: `${share}%` },
        }))),
      el('span', { className: 'bmc-page-table-num' }, formatCompact(model.tokens, locale)),
      el('span', { className: 'bmc-page-table-num bmc-page-table-col-calls' }, formatNumber(model.calls, locale)),
      el('span', { className: 'bmc-page-table-num bmc-page-table-col-credits' }, formatCredits(model.credits, locale)));
    }));
}

/**
 * Tools/MCP usage list.
 * @param props - `t`, `locale`, `tools`.
 * @returns the list, or null when no tool row is usable.
 */
export function UsageTools({ t, locale, tools }) {
  const rows = Array.isArray(tools)
    ? tools.filter((tool) => tool !== null && typeof tool === 'object').slice(0, 8)
    : [];
  if (rows.length === 0) {
    return null;
  }
  const nameOf = (tool) => {
    if (typeof tool.toolName === 'string' && tool.toolName.length > 0) return tool.toolName;
    if (typeof tool.toolCode === 'string' && tool.toolCode.length > 0) return tool.toolCode;
    return '—';
  };
  return el('div', { className: 'bmc-page-tools' },
    el('p', { className: 'bmc-page-table-title' }, t('usage.toolsTitle')),
    rows.map((tool, index) => {
      const name = nameOf(tool);
      return el('div', {
        key: `tool-${typeof tool.toolCode === 'string' ? tool.toolCode : index}`,
        className: 'bmc-page-tool-row',
      },
      el('span', { className: 'bmc-page-tool-name', title: name }, name),
      el('span', { className: 'bmc-page-tool-nums' },
        el('span', null, t('usage.toolCalls', { count: formatNumber(tool.calls, locale) })),
        num(tool.credits) !== null
          ? el('span', null, formatCredits(tool.credits, locale))
          : null));
    }));
}

/**
 * The usage-statistics card.
 * @param props - `t`, `locale`, `now`, `range`, `usage`, `loading`, `error`,
 *   `requested`, `onRangeChange(value)`, `onRetry()`.
 * @returns the card element.
 */
export function UsageSection(props) {
  const {
    t, locale, now, range, usage, loading = false, error = null,
    requested = false, onRangeChange, onRetry,
  } = props ?? {};
  const options = RANGE_OPTIONS.map((option) => ({ value: option.value, label: t(option.key) }));
  const generatedAt = usage && typeof usage === 'object' ? usage.generatedAt : null;
  const updatedHint = isNumber(generatedAt)
    ? attempt(() => formatRelative(generatedAt, t, now), '')
    : '';
  const subtitle = typeof updatedHint === 'string' && updatedHint.length > 0
    ? t('usage.updated', { time: updatedHint })
    : undefined;

  const contents = [];
  if (loading === true && (usage === null || usage === undefined)) {
    contents.push(el(UsageSkeleton, { key: 'skeleton', t }));
  } else if (usage === null || usage === undefined) {
    if (error !== null && error !== undefined) {
      contents.push(el(Notice, {
        key: 'error',
        tone: 'error',
        title: t('usage.errorTitle'),
        children: el('span', null, errorTextOf(error, t)),
        action: el(Button, {
          variant: 'ghost',
          size: 'sm',
          onClick: typeof onRetry === 'function' ? onRetry : undefined,
        }, t('usage.retry')),
      }));
    } else if (requested === true) {
      contents.push(el(EmptyState, {
        key: 'empty',
        title: t('usage.emptyTitle'),
        body: t('usage.emptyBody'),
      }));
    } else {
      contents.push(el(UsageSkeleton, { key: 'skeleton', t }));
    }
  } else {
    const summary = usage.summary;
    const models = usage.models;
    const tools = usage.tools;
    const granularity = chartGranularity(usage, range);
    const points = seriesPoints(usage.series, 40);
    const metrics = el(UsageMetrics, { key: 'metrics', t, locale, summary });
    const chart = el(UsageChart, { key: 'chart', t, locale, points, granularity });
    const table = el(UsageModelTable, {
      key: 'models',
      t,
      locale,
      models,
      totalTokens: summary && typeof summary === 'object' ? summary.totalTokens : null,
    });
    const toolList = el(UsageTools, { key: 'tools', t, locale, tools });
    if (metrics !== null) contents.push(metrics);
    if (chart !== null) contents.push(chart);
    if (table !== null) contents.push(table);
    if (toolList !== null) contents.push(toolList);
    if (contents.length === 0) {
      contents.push(el(EmptyState, {
        key: 'empty',
        title: t('usage.emptyTitle'),
        body: t('usage.emptyBody'),
      }));
    }
  }

  return el(Card, {
    className: cls('bmc-page-usage-card'),
    title: t('page.sectionUsage'),
    subtitle,
    actions: el(Segmented, {
      value: range,
      options,
      onChange: (value) => {
        if (typeof onRangeChange === 'function' && typeof value === 'string') {
          onRangeChange(value);
        }
      },
      label: t('usage.rangeLabel'),
    }),
  }, el('div', { className: 'bmc-page-stack' }, contents));
}
