import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createProvider } from '../../lib/host/provider.js';
import { createStore, sanitizeConfig } from '../../lib/host/store.js';

/** One mutable settings service double over the `llm-pi-ai` namespace. */
function fakeSettings(profiles = {}) {
  const state = { profiles: structuredClone(profiles), mutations: [] };
  return {
    state,
    service: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: state.profiles } }],
      mutate: async (ns, ops) => {
        assert.equal(ns, 'llm-pi-ai');
        state.mutations.push(ops);
        for (const op of ops) {
          if (op.op === 'set' && op.path[0] === 'providers') {
            state.profiles[op.path[1]] = op.value;
          } else if (op.op === 'unset' && op.path[0] === 'providers') {
            delete state.profiles[op.path[1]];
          } else {
            throw new Error(`unexpected op ${JSON.stringify(op)}`);
          }
        }
      },
    },
  };
}

/** In-memory store double for the config document. */
function fakeStore(config = {}) {
  let current = sanitizeConfig(config);
  return {
    readConfig: () => current,
    writeConfig: (next) => {
      current = sanitizeConfig(next);
      return current;
    },
  };
}

describe('provider provisioning', () => {
  it('creates the minimal Coding Plan profile for the bigmodel family', async () => {
    const settings = fakeSettings();
    const store = fakeStore();
    const provider = createProvider({
      store,
      resolveSettings: () => settings.service,
      now: () => 1234,
    });
    const result = await provider.ensure({ family: 'bigmodel' });
    assert.deepEqual(result, { created: true, reason: 'created' });
    assert.deepEqual(settings.state.mutations, [[
      { op: 'set', path: ['providers', 'zai-coding-cn'], value: { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' } },
    ]]);
    assert.deepEqual(settings.state.profiles['zai-coding-cn'], { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' });
    assert.equal(store.readConfig().provisioned.route, 'zai-coding-cn');
    assert.equal(store.readConfig().provisioned.createdAt, 1234);
  });

  it('maps the zai family onto the zai route with the same credential ref', async () => {
    const settings = fakeSettings();
    const provider = createProvider({
      store: fakeStore({ family: 'zai' }),
      resolveSettings: () => settings.service,
    });
    const result = await provider.ensure({ family: 'zai' });
    assert.equal(result.created, true);
    assert.deepEqual(settings.state.profiles.zai, { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' });
  });

  it('never rewrites a route any layer already configures', async () => {
    const settings = fakeSettings({ 'zai-coding-cn': { apiKeyEnv: 'OTHER_REF' } });
    const store = fakeStore();
    const provider = createProvider({ store, resolveSettings: () => settings.service });
    const result = await provider.ensure({ family: 'bigmodel' });
    assert.deepEqual(result, { created: false, reason: 'already_configured' });
    assert.equal(settings.state.mutations.length, 0);
    assert.equal(store.readConfig().provisioned, null);
  });

  it('skips when disabled in the config', async () => {
    const settings = fakeSettings();
    const provider = createProvider({
      store: fakeStore({ autoCreateProvider: false }),
      resolveSettings: () => settings.service,
    });
    assert.deepEqual(await provider.ensure({ family: 'bigmodel' }), {
      created: false,
      reason: 'disabled',
    });
    assert.equal(settings.state.mutations.length, 0);
  });

  it('skips with typed reasons for absent settings or namespace', async () => {
    const absent = createProvider({ store: fakeStore(), resolveSettings: () => undefined });
    assert.deepEqual(await absent.ensure({ family: 'bigmodel' }), {
      created: false,
      reason: 'settings_unavailable',
    });
    const noNamespace = fakeSettings();
    noNamespace.service.describe = () => [{ ns: 'other', value: {} }];
    const provider = createProvider({
      store: fakeStore(),
      resolveSettings: () => noNamespace.service,
    });
    assert.deepEqual(await provider.ensure({ family: 'bigmodel' }), {
      created: false,
      reason: 'namespace_unavailable',
    });
  });

  it('reports a failed write without claiming bookkeeping', async () => {
    const settings = fakeSettings();
    settings.service.mutate = async () => {
      throw new Error('boom');
    };
    const store = fakeStore();
    const provider = createProvider({ store, resolveSettings: () => settings.service });
    assert.deepEqual(await provider.ensure({ family: 'bigmodel' }), {
      created: false,
      reason: 'write_failed',
    });
    assert.equal(store.readConfig().provisioned, null);
  });

  it('releases an untouched provisioned row and clears bookkeeping', async () => {
    const settings = fakeSettings({ 'zai-coding-cn': { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' } });
    const store = fakeStore({
      provisioned: { route: 'zai-coding-cn', apiKeyEnv: 'ZAI_CODING_CN_API_KEY', createdAt: 1 },
    });
    const provider = createProvider({ store, resolveSettings: () => settings.service });
    assert.deepEqual(await provider.release(), { removed: true });
    assert.equal('zai-coding-cn' in settings.state.profiles, false);
    assert.equal(store.readConfig().provisioned, null);
  });

  it('keeps a user-edited provisioned row but still drops the claim', async () => {
    const settings = fakeSettings({
      'zai-coding-cn': { apiKeyEnv: 'ZAI_CODING_CN_API_KEY', displayName: 'My plan' },
    });
    const store = fakeStore({
      provisioned: { route: 'zai-coding-cn', apiKeyEnv: 'ZAI_CODING_CN_API_KEY', createdAt: 1 },
    });
    const provider = createProvider({ store, resolveSettings: () => settings.service });
    assert.deepEqual(await provider.release(), { removed: false });
    assert.deepEqual(settings.state.profiles['zai-coding-cn'], {
      apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
      displayName: 'My plan',
    });
    assert.equal(store.readConfig().provisioned, null);
  });

  it('serializes concurrent actions behind each other', async () => {
    const settings = fakeSettings();
    const order = [];
    settings.service.mutate = async (_ns, ops) => {
      order.push('mutate');
      for (const op of ops) {
        if (op.op === 'set') settings.state.profiles[op.path[1]] = op.value;
        else delete settings.state.profiles[op.path[1]];
      }
    };
    const store = fakeStore();
    const provider = createProvider({ store, resolveSettings: () => settings.service });
    // ensure() runs first; the release() queued behind it then finds the row it
    // just created still untouched and removes it again.
    const ensured = provider.ensure({ family: 'bigmodel' });
    const released = provider.release();
    assert.equal((await ensured).created, true);
    assert.deepEqual(await released, { removed: true });
    assert.deepEqual(order, ['mutate', 'mutate']);
  });

  it('sanitizeConfig keeps the provisioning fields', () => {
    const config = sanitizeConfig({
      autoCreateProvider: false,
      provisioned: { route: 'zai-coding-cn', apiKeyEnv: 'ZAI_CODING_CN_API_KEY', createdAt: 5 },
    });
    assert.equal(config.autoCreateProvider, false);
    assert.deepEqual(config.provisioned, {
      route: 'zai-coding-cn',
      apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
      createdAt: 5,
    });
    assert.equal(sanitizeConfig({}).autoCreateProvider, true);
    assert.equal(sanitizeConfig({ provisioned: { route: '', apiKeyEnv: 'X' } }).provisioned, null);
  });
});

describe('provider provisioning against the real store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bmc-provider-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('persists bookkeeping through the file-backed store', async () => {
    const logger = { info: () => {}, warn: () => {} };
    const store = createStore({ dshHome: dir, logger, now: () => 7 });
    const settings = fakeSettings();
    const provider = createProvider({ store, resolveSettings: () => settings.service, logger });
    assert.equal((await provider.ensure({ family: 'bigmodel' })).created, true);
    const reloaded = createStore({ dshHome: dir, logger, now: () => 8 });
    assert.equal(reloaded.readConfig().provisioned.route, 'zai-coding-cn');
  });
});
