/**
 * Stylesheet of the dedicated BigModel usage page.
 *
 * Every class is prefixed `.bmc-page-`; every color comes from a
 * `--dsw-alias-*` theme token (optionally through `color-mix`) so light and
 * dark themes both work without any theme-specific rule. Space, radius, and
 * font sizes are literal because the theme exposes no tokens for them.
 */

export const pageCss = `
/* Root: one scroll container, one centered content column. */
.bmc-page {
  display: block;
  height: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 1.6;
}
.bmc-page-column {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: 32px clamp(20px, 4vw, 48px) 64px;
  box-sizing: border-box;
}
.bmc-page-column > * {
  flex: none;
  min-width: 0;
}

/* Header */
.bmc-page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px 24px;
}
.bmc-page-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.bmc-page-title {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary);
}
.bmc-page-subtitle {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-header-side {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.bmc-page-account {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  max-width: 100%;
  padding: 4px 12px 4px 5px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  box-sizing: border-box;
}
.bmc-page-account-text {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  line-height: 1.3;
}
.bmc-page-account-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.bmc-page-account-meta {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-avatar {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  overflow: hidden;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
}
.bmc-page-avatar-initials {
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  color: var(--dsw-alias-label-secondary);
  text-transform: uppercase;
  user-select: none;
}
.bmc-page-avatar-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.bmc-page-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.bmc-page-meta-warn {
  color: var(--dsw-alias-state-warn-primary);
}

/* Section scaffolding */
.bmc-page-sections {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}
.bmc-page-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  margin: 4px 0 -6px;
}
.bmc-page-section-title {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.bmc-page-section-hint {
  margin: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.bmc-page-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.bmc-page-spacer {
  flex: 1;
}

/* Quota cards */
.bmc-page-quota-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}
.bmc-page-quota-card {
  min-width: 0;
}
.bmc-page-quota-value-row {
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.bmc-page-quota-value {
  font-size: 32px;
  line-height: 38px;
  font-weight: 500;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
.bmc-page-quota-unit {
  font-size: 14px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-quota-caption {
  margin: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-quota-bar {
  margin: 12px 0 10px;
}
.bmc-page-quota-facts {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.bmc-page-quota-reset {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  margin-top: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.bmc-page-quota-reset-at {
  color: var(--dsw-alias-label-secondary);
  opacity: 0.85;
}
.bmc-page-model-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.bmc-page-model-list-title {
  margin: 0 0 1px;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.bmc-page-model-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-model-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bmc-page-model-value {
  flex: none;
  font-variant-numeric: tabular-nums;
}

/* Metric tiles */
.bmc-page-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  min-width: 0;
}
.bmc-page-metrics > * {
  min-width: 0;
}

/* Trend chart */
.bmc-page-chart {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.bmc-page-chart-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}
.bmc-page-chart-title {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-chart-hint {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.bmc-page-chart-svg {
  display: block;
  width: 100%;
  height: 160px;
  overflow: visible;
}
.bmc-page-chart-col {
  cursor: default;
}
.bmc-page-chart-bar {
  fill: var(--dsw-alias-brand-primary);
  opacity: 0.82;
  transition: opacity 120ms ease;
}
.bmc-page-chart-col:hover .bmc-page-chart-bar {
  opacity: 1;
}
.bmc-page-chart-hit {
  fill: transparent;
}
.bmc-page-chart-baseline {
  stroke: var(--dsw-alias-border-l2);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.bmc-page-chart-axis {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.bmc-page-chart-axis span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bmc-page-chart-axis span:first-child {
  text-align: left;
}
.bmc-page-chart-axis span:last-child {
  text-align: right;
}

/* Model and tool breakdown */
.bmc-page-table {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.bmc-page-table-head,
.bmc-page-table-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 104px 72px 80px;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 8px 0;
}
.bmc-page-table-head {
  padding: 0 0 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.bmc-page-table-row {
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 13px;
  line-height: 20px;
}
.bmc-page-table-row:last-child {
  border-bottom: none;
}
.bmc-page-table-name {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bmc-page-table-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary);
}
.bmc-page-table-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-table-num-head {
  text-align: right;
}
.bmc-page-table-title {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-share {
  height: 4px;
  border-radius: 2px;
  overflow: hidden;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
}
.bmc-page-share-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--dsw-alias-brand-primary);
}
.bmc-page-tools {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.bmc-page-tool-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 6px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-tool-row:last-child {
  border-bottom: none;
}
.bmc-page-tool-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary);
}
.bmc-page-tool-nums {
  flex: none;
  display: inline-flex;
  gap: 12px;
  font-variant-numeric: tabular-nums;
}

/* Status dot */
.bmc-page-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-status-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}
.bmc-page-status.is-success .bmc-page-status-dot {
  background: var(--dsw-alias-state-success-primary);
}
.bmc-page-status.is-warn .bmc-page-status-dot {
  background: var(--dsw-alias-state-warn-primary);
}
.bmc-page-status.is-error .bmc-page-status-dot {
  background: var(--dsw-alias-state-error-primary);
}

/* Sign-in cards */
.bmc-page-auth {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
  min-width: 0;
}
.bmc-page-auth-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.bmc-page-auth-body {
  margin: 0;
  max-width: 58ch;
  font-size: 13px;
  line-height: 21px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-auth-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.bmc-page-waiting {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-linkbox {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  box-sizing: border-box;
}
.bmc-page-link {
  color: var(--dsw-alias-brand-primary);
  font-size: 12px;
  line-height: 18px;
  text-decoration: underline;
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
}
.bmc-page-link:hover {
  opacity: 0.8;
}
.bmc-page-link-hint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

/* Reset chances */
.bmc-page-reset-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 20px;
  padding: 14px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  min-width: 0;
}
.bmc-page-reset-row:first-of-type {
  padding-top: 2px;
}
.bmc-page-reset-row:last-of-type {
  border-bottom: none;
  padding-bottom: 2px;
}
.bmc-page-reset-main {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.bmc-page-reset-title {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.bmc-page-reset-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.bmc-page-reset-count {
  flex: none;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}
.bmc-page-confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  box-sizing: border-box;
}
.bmc-page-confirm-text {
  flex: 1 1 220px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
}

/* Settings and inference forms */
.bmc-page-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  min-width: 0;
}
.bmc-page-field:first-of-type {
  padding-top: 0;
}
.bmc-page-field:last-of-type {
  border-bottom: none;
  padding-bottom: 0;
}
.bmc-page-field-label {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.bmc-page-field-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.bmc-page-field-hint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-field-error {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}
.bmc-page-input,
.bmc-page-select {
  height: 32px;
  min-width: 0;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}
.bmc-page-input {
  width: 240px;
  max-width: 100%;
}
.bmc-page-input.is-narrow {
  width: 110px;
}
.bmc-page-select {
  width: 200px;
  max-width: 100%;
}
.bmc-page-input:hover,
.bmc-page-select:hover {
  border-color: var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);
}
.bmc-page-input:focus-visible,
.bmc-page-select:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);
}
.bmc-page-form-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding-top: 14px;
}
.bmc-page-save-feedback {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.bmc-page-save-feedback.is-success {
  color: var(--dsw-alias-state-success-primary);
}
.bmc-page-save-feedback.is-error {
  color: var(--dsw-alias-state-error-primary);
}

/* Switch */
.bmc-page-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.bmc-page-switch input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.bmc-page-switch-track {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);
  transition: background 140ms ease;
}
.bmc-page-switch-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent);
  transition: transform 140ms ease;
}
.bmc-page-switch input:checked + .bmc-page-switch-track {
  background: var(--dsw-alias-brand-primary);
}
.bmc-page-switch input:checked + .bmc-page-switch-track .bmc-page-switch-thumb {
  transform: translateX(14px);
}
.bmc-page-switch input:focus-visible + .bmc-page-switch-track {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent);
}

/* Inference status line */
.bmc-page-inference-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.bmc-page-inference-ref {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  overflow-wrap: anywhere;
}

/* Loading skeletons */
.bmc-page-skeleton {
  background: var(--dsw-alias-bg-skeleton);
  border-radius: 8px;
  animation: bmc-page-pulse 1.6s ease-in-out infinite;
}
.bmc-page-skeleton-line {
  height: 12px;
  width: 100%;
}
.bmc-page-skeleton-line.is-short {
  width: 46%;
}
.bmc-page-skeleton-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
.bmc-page-skeleton-tile {
  height: 74px;
}
.bmc-page-skeleton-chart {
  height: 160px;
  margin-top: 4px;
}
.bmc-page-skeleton-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bmc-page-skeleton-row {
  height: 20px;
}
@keyframes bmc-page-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

/* Narrow layouts */
@media (max-width: 720px) {
  .bmc-page-column {
    padding: 24px 20px 48px;
  }
  .bmc-page-table-head,
  .bmc-page-table-row {
    grid-template-columns: minmax(0, 1fr) 88px 72px;
  }
  .bmc-page-table-col-credits {
    display: none;
  }
  .bmc-page-chart-svg {
    height: 140px;
  }
}
@media (max-width: 560px) {
  .bmc-page-header {
    flex-direction: column;
    align-items: stretch;
  }
  .bmc-page-header-side {
    justify-content: flex-start;
  }
  .bmc-page-account-name,
  .bmc-page-account-meta {
    max-width: 140px;
  }
  .bmc-page-quota-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .bmc-page-table-head,
  .bmc-page-table-row {
    grid-template-columns: minmax(0, 1fr) 84px;
  }
  .bmc-page-table-col-calls {
    display: none;
  }
  .bmc-page-chart-svg {
    height: 120px;
  }
  .bmc-page-input,
  .bmc-page-select {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bmc-page-skeleton {
    animation: none;
  }
  .bmc-page-chart-bar,
  .bmc-page-switch-track,
  .bmc-page-switch-thumb {
    transition: none;
  }
}
`;
