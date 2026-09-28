import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import {
  apiCallErrorMessage,
  flattenV8ProviderGroups,
  groupLegacyProviderRecords,
  legacyManagementConfigView,
  managementApi,
} from '../src/services/managementApi';
import {
  apiAccessRemarkLocatorFromRecord,
  buildProviderRecord,
  createProviderDraft,
  providerCategoryMatchesRecord,
  providerRecordWithDisabledState,
} from '../src/pages/ApiAccessPage';

describe('v8 Management API requests', () => {
  let originalWindow: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  });
  afterEach(() => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('defaults absent exclusions and provider groups without swallowing other errors', async () => {
    for (const [path, key, empty] of [
      ['/oauth-excluded-models', 'oauth-excluded-models', {}],
      ['/codex-api-key', 'codex-api-key', []],
      ['/openai-compatibility', 'openai-compatibility', []],
    ] as const) {
      mockIPC(() => { throw 'Management API error (404): not_found'; });
      expect(await managementApi.get(path)).toEqual({ [key]: empty });
      for (const message of [
        'Management API error (401): unauthorized',
        'Management API error (404): 404 page not found',
        'Management API request failed: connection refused',
      ]) {
        mockIPC(() => { throw new Error(message); });
        await expect(managementApi.get(path)).rejects.toThrow(message);
      }
    }
  });

  it('saves and reloads DeepSeek through the v8 Codex group without credential names', async () => {
    for (const baseUrl of ['https://api.deepseek.com', 'https://gateway.example.test/v1']) {
      let persisted: unknown = [];
      mockIPC((command, args) => {
        expect(command).toBe('management_request');
        const request = args?.request as { method: string; path: string; body: unknown };
        expect(request.path).toBe('/config/api-keys/codex');
        if (request.method === 'GET') return persisted;
        expect(request.method).toBe('PUT');
        const groups = request.body as Record<string, unknown>[];
        for (const group of groups) {
          for (const key of group.keys as Record<string, unknown>[]) {
            if ('name' in key) throw new Error('invalid_config: field name not found in type config.CodexKey');
          }
        }
        persisted = request.body;
        return { status: 'ok' };
      });
      const original = buildProviderRecord('codex-api-key', {
        ...createProviderDraft('deepseek'), apiKey: 'deepseek-test-key', baseUrl,
        models: [{ name: 'deepseek-chat', alias: 'my-deepseek' }],
        priority: '5', proxyUrl: 'direct', headersText: 'X-Team: test',
      });
      const regular = buildProviderRecord('codex-api-key', {
        ...createProviderDraft('codex-api-key'), apiKey: 'codex-test-key',
        baseUrl: 'https://codex.example.test/v1', models: [{ name: 'gpt-test' }],
      });
      for (const record of [original, providerRecordWithDisabledState('codex-api-key', original, true)]) {
        await managementApi.put('/codex-api-key', [regular, record]);
        const loaded = await managementApi.get<{ 'codex-api-key': Record<string, unknown>[] }>('/codex-api-key');
        expect(loaded['codex-api-key']).toEqual([regular, record]);
        expect(providerCategoryMatchesRecord('deepseek', loaded['codex-api-key'][1])).toBe(true);
        expect(apiAccessRemarkLocatorFromRecord('codex-api-key', loaded['codex-api-key'][1]))
          .toEqual(apiAccessRemarkLocatorFromRecord('codex-api-key', original));
        await managementApi.put('/codex-api-key', [record, regular]);
        expect((await managementApi.get('/codex-api-key'))).toEqual({ 'codex-api-key': [record, regular] });
      }
      await managementApi.put('/codex-api-key', [regular]);
      expect(await managementApi.get('/codex-api-key')).toEqual({ 'codex-api-key': [regular] });
    }
  });
});

describe('apiCallErrorMessage', () => {
  it('从对象和 JSON 字符串错误体中提取可读消息', () => {
    expect(apiCallErrorMessage({
      status_code: 401,
      body: { error: { message: 'token expired' } },
    })).toBe('token expired');

    expect(apiCallErrorMessage({
      statusCode: 403,
      bodyText: JSON.stringify({ detail: 'permission denied' }),
    })).toBe('permission denied');
  });

  it('没有错误体时回退到 HTTP 状态', () => {
    expect(apiCallErrorMessage({ status_code: 429 })).toBe('Upstream returned HTTP 429');
  });
});

describe('v8 Management API compatibility view', () => {
  it('flattens grouped credentials and preserves per-key overrides', () => {
    const groups = [{
      name: 'production',
      'base-url': 'https://example.test/v1',
      priority: 10,
      models: [{ name: 'model-a' }],
      keys: [
        { 'api-key': 'first', priority: null, 'proxy-url': 'direct' },
        { 'api-key': 'second', priority: 0 },
      ],
    }];
    expect(flattenV8ProviderGroups('codex', groups)).toEqual([
      {
        name: 'production',
        'base-url': 'https://example.test/v1', priority: 10,
        models: [{ name: 'model-a' }], 'api-key': 'first', 'proxy-url': 'direct',
      },
      {
        name: 'production',
        'base-url': 'https://example.test/v1', priority: 0,
        models: [{ name: 'model-a' }], 'api-key': 'second',
      },
    ]);
  });

  it('groups legacy records without moving key-specific fields into shared policy', () => {
    expect(groupLegacyProviderRecords('claude', [{
      name: 'delegated-key',
      'api-key': 'secret',
      'base-url': 'https://claude.test',
      models: [{ name: 'claude-test' }],
      cloak: { mode: 'always' },
    }])).toEqual([{
      name: 'delegated-key',
      'base-url': 'https://claude.test',
      models: [{ name: 'claude-test' }],
      keys: [{ 'api-key': 'secret', cloak: { mode: 'always' } }],
    }]);
  });

  it('repairs legacy credential names while preserving policies and unnamed record identities', () => {
    const records = flattenV8ProviderGroups('codex', [{
      name: 'codex-1', 'base-url': 'https://gateway.example.test/v1', priority: 5,
      keys: [
        { name: 'DeepSeek', 'api-key': 'first', weight: 2 },
        { 'api-key': 'second', priority: 0 },
      ],
    }]);
    const groups = groupLegacyProviderRecords('codex', records);
    expect(groups[0]).toMatchObject({ name: 'DeepSeek', keys: [{ 'api-key': 'first', weight: 2 }] });
    expect(groups[1]).toMatchObject({ name: 'codex-2', keys: [{ 'api-key': 'second' }] });
    expect(flattenV8ProviderGroups('codex', groups)).toEqual(records);
    expect(records[1]).not.toHaveProperty('name');
  });

  it('projects the v8 config tree into the legacy semantic view used by the UI', () => {
    const view = legacyManagementConfigView({
      access: { 'api-keys': ['client-key'] },
      'api-keys': {
        codex: [{ name: 'codex-1', keys: [{ 'api-key': 'upstream-key' }] }],
        'openai-compatibility': [{ name: 'openrouter', keys: [{ 'api-key': 'openrouter-key' }] }],
      },
      oauth: { 'model-alias': { codex: [{ name: 'gpt', alias: 'custom' }] } },
      requests: { payload: { override: [] } },
    }) as Record<string, unknown>;
    expect(view['api-keys']).toEqual(['client-key']);
    expect(view['codex-api-key']).toEqual([{ 'api-key': 'upstream-key' }]);
    expect(view['openai-compatibility']).toEqual([{
      name: 'openrouter', 'api-key-entries': [{ 'api-key': 'openrouter-key' }],
    }]);
    expect(view['oauth-model-alias']).toEqual({ codex: [{ name: 'gpt', alias: 'custom' }] });
    expect(view.payload).toEqual({ override: [] });
  });
});
