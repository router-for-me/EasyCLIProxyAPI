import { flattenV8ProviderGroups, groupLegacyProviderRecords } from './fixtures/legacyProviderRecords';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import {
  apiCallErrorMessage,
  providerGroupsApi,
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

  it('returns the native config tree without flattening groups or replacing access keys', async () => {
    const config = {
      'config-version': 8,
      access: { 'api-keys': ['client-test'] },
      'api-keys': { claude: [{ name: 'team', models: [{ name: 'upstream', alias: 'public' }],
        keys: [{ 'api-key': 'one', models: null }, { 'api-key': 'two', models: [] }] }] },
      oauth: { 'model-alias': { claude: [{ name: 'original', alias: 'desktop' }] } },
      requests: { payload: { override: [] } },
    };
    mockIPC((_command, args) => {
      expect(args?.request).toMatchObject({ method: 'GET', path: '/config' });
      return config;
    });
    expect(await managementApi.get('/config')).toEqual(config);
  });

  it('preserves native request bodies, query defaults and timeouts', async () => {
    const calls: unknown[] = [];
    mockIPC((_command, args) => { calls.push(args?.request); return { status: 'ok' }; });
    await managementApi.get('/credentials', { all: false, offset: 0, omitted: undefined });
    await managementApi.put('/config/access/api-keys', []);
    await managementApi.put('/config/routing/session-affinity', false);
    await managementApi.post('/requests/api-call', { method: 'GET', url: 'https://example.invalid', auth_index: '0' }, { timeoutMs: 12345 });
    await managementApi.delete('/credentials', { body: { names: ['test.json'] } });
    expect(calls).toMatchObject([
      { method: 'GET', path: '/credentials', query: { all: 'false', offset: '0' } },
      { method: 'PUT', path: '/config/access/api-keys', body: [] },
      { method: 'PUT', path: '/config/routing/session-affinity', body: false },
      { method: 'POST', path: '/requests/api-call', body: { method: 'GET', url: 'https://example.invalid', auth_index: '0' }, timeoutMs: 12345 },
      { method: 'DELETE', path: '/credentials', body: { names: ['test.json'] } },
    ]);
  });

  it('defaults absent exclusions and provider groups without swallowing other errors', async () => {
    for (const section of ['codex', 'openai-compatibility']) {
      mockIPC(() => { throw 'Management API error (404): not_found'; });
      expect(await providerGroupsApi.get(section)).toEqual([]);
      for (const message of [
        'Management API error (401): unauthorized',
        'Management API error (404): 404 page not found',
        'Management API request failed: connection refused',
      ]) {
        mockIPC(() => { throw new Error(message); });
        await expect(providerGroupsApi.get(section)).rejects.toThrow(message);
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
        await providerGroupsApi.put('codex', groupLegacyProviderRecords('codex', [regular, record]));
        const loaded = { 'codex-api-key': flattenV8ProviderGroups('codex', await providerGroupsApi.get('codex')) };
        expect(loaded['codex-api-key']).toEqual([regular, record]);
        expect(providerCategoryMatchesRecord('deepseek', loaded['codex-api-key'][1])).toBe(true);
        expect(apiAccessRemarkLocatorFromRecord('codex-api-key', loaded['codex-api-key'][1]))
          .toEqual(apiAccessRemarkLocatorFromRecord('codex-api-key', original));
        await providerGroupsApi.put('codex', groupLegacyProviderRecords('codex', [record, regular]));
        expect(flattenV8ProviderGroups('codex', await providerGroupsApi.get('codex'))).toEqual([record, regular]);
      }
      await providerGroupsApi.put('codex', groupLegacyProviderRecords('codex', [regular]));
      expect(flattenV8ProviderGroups('codex', await providerGroupsApi.get('codex'))).toEqual([regular]);
    }
  });
});

describe('apiCallErrorMessage', () => {
  it('保留 HTTP 状态，并从对象和 JSON 字符串错误体中提取可读消息', () => {
    expect(apiCallErrorMessage({
      status_code: 401,
      body: { error: { message: 'token expired', code: 'invalid_api_key' } },
    })).toBe('HTTP 401: token expired (invalid_api_key)');

    expect(apiCallErrorMessage({
      status_code: 401,
      body: { error: { message: 'Encountered invalidated oauth token for user, failing request', code: 401 } },
    })).toBe('HTTP 401: Encountered invalidated oauth token for user, failing request');

    expect(apiCallErrorMessage({
      statusCode: 403,
      bodyText: JSON.stringify({ detail: 'permission denied' }),
    })).toBe('HTTP 403: permission denied');
  });

  it('消息已经包含状态码时不重复，没有错误体时回退到 HTTP 状态', () => {
    expect(apiCallErrorMessage({
      status_code: 401,
      body: { error: { message: 'HTTP 401: token expired' } },
    })).toBe('HTTP 401: token expired');
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

});
