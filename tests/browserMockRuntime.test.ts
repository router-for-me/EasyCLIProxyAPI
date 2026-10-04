import { describe, expect, test } from 'bun:test';
import {
  createBrowserMockRuntime,
  resolveBrowserMockOptions,
} from '../src/mocks/browserMockRuntime';

describe('browser mock options', () => {
  test('defaults to a running core and accepts stored scenarios', () => {
    expect(resolveBrowserMockOptions('', null)).toEqual({ mode: 'running', delayMs: 0 });
    expect(resolveBrowserMockOptions('', 'stopped')).toEqual({ mode: 'stopped', delayMs: 0 });
  });

  test('URL options override storage and clamp delay', () => {
    expect(resolveBrowserMockOptions('?mock=empty&mockDelay=9000', 'running'))
      .toEqual({ mode: 'empty', delayMs: 5000 });
    expect(resolveBrowserMockOptions('?mock=off&mockDelay=25', 'running'))
      .toEqual({ mode: 'off', delayMs: 25 });
  });
});

describe('browser mock runtime', () => {
  for (const scenario of ['running', 'empty'] as const) {
    test(`installs the bundled version independently of the latest release (${scenario})`, async () => {
      const runtime = createBrowserMockRuntime(scenario);
      const bundled = await runtime.invoke('detect_bundled_core') as { version: string; assetName: string };
      const latest = await runtime.invoke('check_latest_core') as { version: string };
      expect(bundled.version).not.toBe(latest.version);

      if (scenario === 'running') {
        await runtime.invoke('install_core_version', { version: latest.version });
      }
      expect(await runtime.invoke('install_bundled_core')).toMatchObject(bundled);
      expect(await runtime.invoke('get_core_status')).toMatchObject({
        installed: true,
        currentVersion: bundled.version,
        running: scenario === 'running',
      });
    });
  }

  test('models the core process lifecycle and emits status events', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const runtime = createBrowserMockRuntime('stopped', (event, payload) => {
      events.push({ event, payload });
    });

    expect(await runtime.invoke('get_core_status')).toMatchObject({
      installed: true,
      running: false,
      ready: false,
    });
    expect(await runtime.invoke('start_core_process')).toMatchObject({
      running: true,
      ready: true,
      processId: 42817,
    });
    expect(events.at(-1)).toMatchObject({
      event: 'core-status-changed',
      payload: { running: true, ready: true },
    });
  });

  test('persists config and management mutations in memory', async () => {
    const runtime = createBrowserMockRuntime('running');

    await runtime.invoke('add_core_api_key', { apiKey: 'sk-test', remark: 'test' });
    expect(await runtime.invoke('get_core_config_settings')).toMatchObject({
      apiKeys: expect.arrayContaining([{ apiKey: 'sk-test', remark: 'test' }]),
    });

    await runtime.invoke('management_request', {
      request: {
        method: 'PUT',
        path: '/config/api-keys/gemini',
        body: [{ name: 'test', keys: [{ 'api-key': 'AIza-test' }], models: [{ name: 'gemini-test' }] }],
      },
    });
    expect(await runtime.invoke('management_request', {
      request: { method: 'GET', path: '/config/api-keys/gemini' },
    })).toEqual([{ name: 'test', keys: [{ 'api-key': 'AIza-test' }], models: [{ name: 'gemini-test' }] }]);
  });

  test('uses normalized ratios for percentage-based usage metrics', async () => {
    const runtime = createBrowserMockRuntime('running');
    expect(await runtime.invoke('get_usage_overview')).toMatchObject({
      successRate: 96.47,
      cacheHitRate: 0.386,
    });
  });

  test('provides an explicit error scenario', async () => {
    const runtime = createBrowserMockRuntime('error');
    await expect(runtime.invoke('get_core_status')).rejects.toThrow('Browser Mock error scenario');
    expect(await runtime.invoke('plugin:app|version')).toBe('0.2.97-mock');
  });
});

describe('browser mock native provider groups', () => {
  const providers = ['gemini', 'interactions', 'vertex', 'codex', 'claude', 'xai', 'meta', 'openai-compatibility'] as const;
  const request = (runtime: ReturnType<typeof createBrowserMockRuntime>, method: string, path: string, body?: unknown) =>
    runtime.invoke('management_request', { request: { method, path, body } });

  for (const provider of providers) {
    test(`preserves native ${provider} groups, overrides, and extensions across saves`, async () => {
      const runtime = createBrowserMockRuntime('running');
      const path = `/config/api-keys/${provider}`;
      const groups = [{
        name: `${provider} production`,
        'base-url': 'https://provider.example/v1',
        headers: { 'X-Team': 'shared' },
        models: [{ name: 'model', alias: 'primary', 'future-model-option': false }],
        'request-retry': 0,
        'future-group-option': { enabled: false, values: [] },
        keys: [
          { 'api-key': 'first', weight: 2, headers: null, models: [], 'future-key-option': 0 },
          { 'api-key': 'second', 'proxy-url': '', headers: {}, models: null },
        ],
      }, { name: `${provider} empty standby`, keys: [], 'future-group-option': null }];

      expect(await request(runtime, 'GET', path)).toBeArray();
      expect(await request(runtime, 'PUT', path, groups)).toEqual({ status: 'ok', 'config-version': 8 });
      expect(await request(runtime, 'GET', path)).toEqual(groups);
      expect(await request(runtime, 'GET', '/config')).toMatchObject({
        'config-version': 8, 'api-keys': { [provider]: groups },
      });

      // Reading the legacy view must not flatten the authoritative state.
      const legacyPath = provider === 'openai-compatibility' ? path.slice('/config/api-keys'.length) : `/${provider}-api-key`;
      await request(runtime, 'GET', legacyPath);
      expect(await request(runtime, 'GET', path)).toEqual(groups);

      // Both writes and reads isolate stored values from caller mutations.
      const expected = structuredClone(groups);
      groups[0].keys[0]['api-key'] = 'mutated request';
      const readBack = await request(runtime, 'GET', path) as typeof groups;
      readBack[0].keys[0]['api-key'] = 'mutated response';
      expect(await request(runtime, 'GET', path)).toEqual(expected);

      await request(runtime, 'PUT', path, []);
      expect(await request(runtime, 'GET', path)).toEqual([]);
    });
  }

  test('returns native groups without flattening inherited and explicit empty values', async () => {
    const runtime = createBrowserMockRuntime('running');
    const groups = [{
      name: 'preserve this group name',
      'base-url': 'https://provider.example',
      priority: 5,
      headers: { 'X-Team': 'shared' },
      models: [{ name: 'shared-model' }],
      keys: [
        { 'api-key': 'first', priority: 0, headers: null, models: [] },
        { 'api-key': 'second', headers: {}, models: null },
      ],
    }];
    await request(runtime, 'PUT', '/config/api-keys/interactions', groups);
    expect(await request(runtime, 'GET', '/config/api-keys/interactions')).toEqual(groups);
  });

  test('updates native OpenAI groups while preserving metadata and keys', async () => {
    const runtime = createBrowserMockRuntime('running');
    const group = {
      name: 'custom group', 'base-url': 'https://provider.example/v1', disabled: false,
      'future-option': { enabled: false },
      keys: [{ 'api-key': 'first', weight: 0, 'proxy-url': '' }, { 'api-key': 'second', weight: 3 }],
    };
    await request(runtime, 'PUT', '/config/api-keys/openai-compatibility', [group]);
    await request(runtime, 'PUT', '/config/api-keys/openai-compatibility', [{ ...group, disabled: true }]);
    expect(await request(runtime, 'GET', '/config/api-keys/openai-compatibility')).toEqual([{ ...group, disabled: true }]);
    await request(runtime, 'PUT', '/config/api-keys/openai-compatibility', [{ ...group, keys: [group.keys[1]] }]);
    expect(await request(runtime, 'GET', '/config/api-keys/openai-compatibility')).toEqual([{ ...group, keys: [group.keys[1]] }]);
  });
});
