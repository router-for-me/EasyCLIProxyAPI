import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import {
  apiCallErrorMessage,
  flattenV8ProviderGroups,
  groupLegacyProviderRecords,
  legacyManagementConfigView,
  managementApi,
} from '../src/services/managementApi';

describe('optional v8 config reads', () => {
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
        'base-url': 'https://example.test/v1', priority: 10,
        models: [{ name: 'model-a' }], 'api-key': 'first', 'proxy-url': 'direct',
      },
      {
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
      name: 'claude-1',
      'base-url': 'https://claude.test',
      models: [{ name: 'claude-test' }],
      keys: [{ name: 'delegated-key', 'api-key': 'secret', cloak: { mode: 'always' } }],
    }]);
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
