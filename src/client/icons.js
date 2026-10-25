/**
 * Line-art SVG path data for the plugin's controls.
 *
 * Every entry is a stroked path in a 24×24 viewBox. {@link Icon} renders it
 * with `currentColor` and `aria-hidden`, so the accessible name always comes
 * from the surrounding button's `aria-label`/text rather than the glyph.
 */
import { rt } from './runtime.js';

/** Stable icon names mapped to 24×24 stroked path data. */
export const ICONS = Object.freeze({
  refresh: 'M20.5 12a8.5 8.5 0 1 1-2.5-6M20.5 4v6h-6',
  close: 'M6 6l12 12M18 6L6 18',
  login: 'M14 4h4.5a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5H14M4 12h11M11.5 8.5L15 12l-3.5 3.5',
  logout: 'M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10M9.5 12H21M17.5 8.5L21 12l-3.5 3.5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19.5v-11A1.5 1.5 0 0 1 5.5 7H11',
  chart: 'M3.5 20h17M6.5 20v-7M12 20V5M17.5 20v-10',
  gauge: 'M3.5 18a8.5 8.5 0 1 1 17 0M12.5 18l4-5.5',
  calendar: 'M5.5 6h13A1.5 1.5 0 0 1 20 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6zM8 3.5V7M16 3.5V7M4 10.5h16',
  reset: 'M4 12a8 8 0 1 1 2.34 5.66M4 5.5v6h6',
  spark: 'M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z',
  warning: 'M12 4l8.5 15h-17L12 4zM12 10v4M12 17.2v.1',
  check: 'M5 12.5l4.5 4.5L19 7',
  chevronDown: 'M6 9.5l6 6 6-6',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM12 2.8v2.1M12 19.1v2.1M4.6 4.6l1.5 1.5M17.9 17.9l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.6 19.4l1.5-1.5M17.9 6.1l1.5-1.5',
  chartArea: 'M4 19V5M4 19h16M4 15.5l4.5-6 3.5 3L19 5.5V19H4z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
});

/**
 * Render one icon from {@link ICONS}.
 * @param props - `name` selects the path, `size` sets width/height in pixels,
 *   `className` adds classes to the `<svg>`. Missing or unknown names render nothing.
 * @returns the icon element, or null when the name is unknown or the runtime is unbound.
 */
export function Icon(props) {
  const { name, size = 16, className } = props ?? {};
  const path = typeof name === 'string' ? ICONS[name] : undefined;
  if (path === undefined || rt.h === null) return null;
  const pixels = Number.isFinite(Number(size)) ? Math.max(8, Number(size)) : 16;
  return rt.h('svg', {
    className: className === undefined || className === '' ? 'bmc-icon' : `bmc-icon ${className}`,
    width: pixels,
    height: pixels,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }, rt.h('path', { d: path }));
}
