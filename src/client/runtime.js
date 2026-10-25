/**
 * Browser runtime binding for the plugin bundle.
 *
 * The Client module system materializes this bundle lazily and hands it React
 * through `require('react')`. Every module reaches React and the Cordis plugin
 * context through this one binding object, so no module imports React directly
 * and no module touches the runtime at load time.
 */

/** Shared runtime handles, bound once by `entry.js` inside the loader factory. */
export const rt = {
  /** React runtime (createElement, hooks). */
  React: null,
  /** React.createElement shorthand. */
  h: null,
  /** The plugin's Client Cordis context, for optional services such as layout/modelDirectories. */
  ctx: null,
};

/**
 * Bind the React runtime delivered by the loader factory.
 * @param React - the browser module table's React.
 */
export function bindReact(React) {
  rt.React = React;
  rt.h = React.createElement;
}

/**
 * Bind the plugin's Client Cordis context.
 * @param ctx - context passed to the plugin's `apply`.
 */
export function bindContext(ctx) {
  rt.ctx = ctx;
}
