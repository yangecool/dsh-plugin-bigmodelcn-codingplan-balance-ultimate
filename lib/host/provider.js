/**
 * Automatic Models-provider provisioning for the Coding Plan routes.
 *
 * A pi-ai route only offers its models in the picker once a provider profile
 * resolves from settings, and a fresh install has none — so a login that
 * provisions the credential still leaves the user unable to select a model
 * until they hand-create a provider row. This module writes the minimal
 * profile itself: `providers[route] = { apiKeyEnv }` in the `llm-pi-ai`
 * settings namespace, where `apiKeyEnv` is the exact reference the inference
 * module keeps renewing. Every write path is the shared settings service, so
 * the Models page, its revision fencing, and the live route registration all
 * observe the change exactly as if the user had typed it.
 *
 * The row is only ever claimed once and released only while it still holds
 * exactly what this module wrote; a user-edited profile is the user's.
 */

/** Settings namespace of the pi-ai adapter (its Loader entry id). */
const SETTINGS_NS = 'llm-pi-ai';

/** Coding-plan route per service family (pi-ai installed catalog). */
const ROUTE_BY_FAMILY = Object.freeze({
  bigmodel: 'zai-coding-cn',
  zai: 'zai',
});

/** True for a non-null, non-array object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON-shaped deep equality for the values compared here. */
function sameProfile(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Build the provider-provisioning module bound to one plugin instance.
 *
 * The settings service arrives on its own schedule (it is mounted by the
 * profile composition, not this plugin), so every entry point resolves it
 * lazily through `resolveSettings` and reports a typed skip when it is absent.
 * @param options - store, settings resolver, logger, and clock.
 * @returns provisioning methods used by the snapshot module and the apply wire.
 */
export function createProvider(options = {}) {
  const { store, resolveSettings, logger, now = () => Date.now() } = options;
  if (store === undefined || typeof resolveSettings !== 'function') {
    throw new TypeError('bigmodelcn-balance: createProvider requires store and resolveSettings');
  }
  /** One ensure/release at a time; the latest request wins after the current one. */
  let inflight = Promise.resolve();

  /** Read the profile dict of the namespace descriptor, null when unreadable. */
  function readProfiles(settings) {
    try {
      const descriptors = settings.describe();
      if (!Array.isArray(descriptors)) return null;
      const descriptor = descriptors.find((entry) => isRecord(entry) && entry.ns === SETTINGS_NS);
      if (!isRecord(descriptor) || !isRecord(descriptor.value)) return null;
      return isRecord(descriptor.value.providers) ? descriptor.value.providers : {};
    } catch (error) {
      logger?.warn?.(`bigmodelcn-balance: settings describe failed (${error?.message ?? 'unknown'})`);
      return null;
    }
  }

  /**
   * Ensure the Coding Plan provider row exists for one family.
   *
   * Skips when the config disables provisioning, when the settings service or
   * the `llm-pi-ai` namespace is absent, or when any layer already configures
   * the route. Never throws: the outcome is reported, the caller logs it.
   * @param request - `family` of the login that just became usable.
   * @returns `{ created, reason }` describing what happened.
   */
  async function ensureProvider({ family } = {}) {
    const config = store.readConfig();
    if (config.autoCreateProvider !== true) {
      return { created: false, reason: 'disabled' };
    }
    const route = ROUTE_BY_FAMILY[family] ?? ROUTE_BY_FAMILY.bigmodel;
    const apiKeyEnv = config.inferenceCredentialRef;
    const settings = resolveSettings();
    if (settings === undefined || typeof settings.mutate !== 'function') {
      return { created: false, reason: 'settings_unavailable' };
    }
    const profiles = readProfiles(settings);
    if (profiles === null) {
      return { created: false, reason: 'namespace_unavailable' };
    }
    if (isRecord(profiles[route])) {
      // Any layer configuring the route owns it: a hand-made provider row, a
      // composition base, or an earlier provisioning. Never rewrite it.
      return { created: false, reason: 'already_configured' };
    }
    const profile = { apiKeyEnv };
    try {
      await settings.mutate(SETTINGS_NS, [
        { op: 'set', path: ['providers', route], value: profile },
      ]);
    } catch (error) {
      logger?.warn?.(`bigmodelcn-balance: provider provisioning failed (${error?.message ?? 'unknown'})`);
      return { created: false, reason: 'write_failed' };
    }
    store.writeConfig({
      ...config,
      provisioned: { route, apiKeyEnv, createdAt: now() },
    });
    logger?.info?.(`bigmodelcn-balance: provisioned Models provider "${route}" (${apiKeyEnv})`);
    return { created: true, reason: 'created' };
  }

  /**
   * Release the provider row this module provisioned, but only while it still
   * holds exactly what was written: an edited row belongs to the user and is
   * left in place. Bookkeeping is cleared either way — after a release the
   * module no longer claims the row.
   * @returns `{ removed }` telling whether the row was unset.
   */
  async function releaseProvider() {
    const config = store.readConfig();
    const provisioned = config.provisioned;
    if (provisioned === null) return { removed: false };
    store.writeConfig({ ...config, provisioned: null });
    const settings = resolveSettings();
    if (settings === undefined || typeof settings.mutate !== 'function') {
      return { removed: false };
    }
    const profiles = readProfiles(settings);
    if (profiles === null || !isRecord(profiles[provisioned.route])) {
      return { removed: false };
    }
    if (!sameProfile(profiles[provisioned.route], { apiKeyEnv: provisioned.apiKeyEnv })) {
      logger?.info?.(`bigmodelcn-balance: provisioned provider "${provisioned.route}" was edited; keeping it`);
      return { removed: false };
    }
    try {
      await settings.mutate(SETTINGS_NS, [
        { op: 'unset', path: ['providers', provisioned.route] },
      ]);
    } catch (error) {
      logger?.warn?.(`bigmodelcn-balance: provider release failed (${error?.message ?? 'unknown'})`);
      return { removed: false };
    }
    logger?.info?.(`bigmodelcn-balance: released provisioned provider "${provisioned.route}"`);
    return { removed: true };
  }

  /** Serialize one provisioning action behind the previous one. */
  function run(task) {
    inflight = inflight.then(task, task);
    return inflight;
  }

  return {
    /**
     * Ensure the provider row of a login's family exists.
     * @param request - `family` of the login (`'bigmodel'` | `'zai'`).
     * @returns `{ created, reason }`; never rejects.
     */
    ensure(request) {
      return run(() => ensureProvider(request).catch((error) => {
        logger?.warn?.(`bigmodelcn-balance: provider ensure crashed (${error?.message ?? 'unknown'})`);
        return { created: false, reason: 'crashed' };
      }));
    },
    /**
     * Release the row this module provisioned when it is still untouched.
     * @returns `{ removed }`; never rejects.
     */
    release() {
      return run(() => releaseProvider().catch((error) => {
        logger?.warn?.(`bigmodelcn-balance: provider release crashed (${error?.message ?? 'unknown'})`);
        return { removed: false };
      }));
    },
  };
}
