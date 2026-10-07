import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import {
  countHomeProviderKeys,
  loadHomeOverview,
  normalizeHomeModels,
  summarizeHomeCredentials,
  summarizeHomeUsage,
} from '../src/services/homeOverview';

describe('home overview aggregation', () => {
  it('measures success over completed requests and leaves empty/canceled-only windows unmeasured', () => {
    expect(summarizeHomeUsage({ totalRequests: 12, successCount: 9, failureCount: 1, canceledCount: 2 }).successRate).toBe(90);
    expect(summarizeHomeUsage({ totalRequests: 0, successCount: 0, failureCount: 0, canceledCount: 0 }).successRate).toBeNull();
    expect(summarizeHomeUsage({ totalRequests: 5, successCount: 0, failureCount: 0, canceledCount: 5 }).successRate).toBeNull();
    expect(summarizeHomeUsage({ totalRequests: 2, successCount: 0, failureCount: 2, canceledCount: 0 }).successRate).toBe(0);
    expect(() => summarizeHomeUsage({ totalRequests: 0 })).toThrow();
    expect(() => summarizeHomeUsage({ totalRequests: 1, successCount: 2, failureCount: 0, canceledCount: 0 })).toThrow();
  });

  it('deduplicates OAuth files and excludes runtime/API key records', () => {
    expect(summarizeHomeCredentials({ files: [
      { name: 'meta-user.json', source: 'file', status: 'active', cooldowns: [] },
      { name: 'meta-user.json', runtime_only: true, status: 'active' },
      { name: 'codex-user.json', source: 'file', status: 'ready' },
      { name: 'disabled.json', disabled: true },
      { name: 'runtime.json', runtime_only: true, status: 'active' },
      { name: 'key.json', account_type: 'api_key', status: 'active' },
      { name: 'plain-key', status: 'active' },
    ] })).toEqual({ total: 3, available: 2, unavailable: 1, unknown: 0 });
  });

  it('does not call missing, pending, model-only error, or malformed cooldown states available', () => {
    const cooldown = { scope: 'credential', remaining_seconds: 60, retry_at: '2026-10-03T12:00:00Z' };
    expect(summarizeHomeCredentials({ files: [
      { name: 'quota.json', status: 'active', cooldowns: [cooldown] },
      { name: 'expired.json', status: 'error', unavailable: true },
      { name: 'disabled.json', status: 'disabled' },
      { name: 'missing.json' },
      { name: 'pending.json', status: 'pending' },
      { name: 'refreshing.json', status: 'refreshing' },
      { name: 'model-only.json', status: 'error', unavailable: false,
        cooldowns: [{ ...cooldown, scope: 'model', model_key: 'model-a' }] },
      { name: 'unknown-cooldown.json', status: 'active', cooldowns: null },
      { name: 'broken-cooldown.json', status: 'ready', cooldowns: [{}] },
    ] })).toEqual({ total: 9, available: 0, unavailable: 3, unknown: 6 });
    expect(() => summarizeHomeCredentials({})).toThrow();
    expect(() => summarizeHomeCredentials({ files: [null] })).toThrow();
    expect(summarizeHomeCredentials({ files: [] })).toEqual({ total: 0, available: 0, unavailable: 0, unknown: 0 });
  });

  it('counts actual provider keys across groups, including disabled keys and future providers', () => {
    expect(countHomeProviderKeys({
      gemini: [{ name: 'one', keys: [{ 'api-key': 'gemini-1' }, { 'api-key': 'gemini-2', disabled: true }] }],
      'openai-compatibility': [{ name: 'compat', keys: [{ 'api-key': 'compat-1' }, { 'api-key': 'compat-2' }] }],
      meta: [{ keys: [{ 'api-key': 'meta-1' }] }],
      'future-provider': [{ keys: [{ 'api-key': 'next-key' }, { 'api-key': '  ' }, {}] }],
      claude: [{ keys: [] }, { name: 'keyless' }],
    })).toBe(6);
    expect(countHomeProviderKeys({})).toBe(0);
    expect(() => countHomeProviderKeys(['client-key'])).toThrow();
    expect(() => countHomeProviderKeys({ codex: [{ keys: 'invalid' }] })).toThrow();
  });

  it('preserves exposed aliases and case-sensitive model IDs while removing duplicate IDs', () => {
    expect(normalizeHomeModels([
      { name: ' prefix/Model-A ', displayName: 'Model A', isAlias: true },
      { name: 'prefix/Model-A' },
      { name: 'prefix/model-a' },
      { name: 'custom-alias', displayName: '' },
    ])).toEqual([
      { name: 'prefix/Model-A', displayName: 'Model A' },
      { name: 'prefix/model-a' },
      { name: 'custom-alias' },
    ]);
    expect(normalizeHomeModels([])).toEqual([]);
    expect(() => normalizeHomeModels(null)).toThrow();
    expect(() => normalizeHomeModels([{ name: '' }])).toThrow();
  });
});

describe('home overview loading', () => {
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

  const usage = { totalRequests: 5, successCount: 4, failureCount: 1, canceledCount: 0 };

  it('loads a rolling 24 hour window locally without contacting a stopped core', async () => {
    const calls: string[] = [];
    mockIPC((command, args) => {
      calls.push(command);
      expect(command).toBe('get_usage_overview');
      expect(args?.query).toEqual({ start: '2026-10-02T08:30:00.000Z', end: '2026-10-03T08:30:00.000Z' });
      return usage;
    });
    expect(await loadHomeOverview(false, Date.parse('2026-10-03T08:30:00Z'))).toEqual({
      usage: { ...usage, successRate: 80 }, credentials: null, providerKeys: null, models: null, errors: {},
    });
    expect(calls).toEqual(['get_usage_overview']);
  });

  it('uses the credential and raw provider config endpoints plus the dedicated core model command', async () => {
    const requests: string[] = [];
    mockIPC((command, args) => {
      if (command === 'get_usage_overview') return usage;
      if (command === 'get_core_models') return [{ name: 'exposed-alias' }];
      expect(command).toBe('management_request');
      const request = args?.request as { method: string; path: string };
      expect(request.method).toBe('GET');
      requests.push(request.path);
      if (request.path === '/credentials') return { files: [{ name: 'muse.json', status: 'ready' }] };
      if (request.path === '/config/api-keys') return { meta: [{ keys: [{ 'api-key': 'provider-key' }] }] };
      throw new Error(`Unexpected path ${request.path}`);
    });
    expect(await loadHomeOverview(true)).toEqual({
      usage: { ...usage, successRate: 80 }, credentials: { total: 1, available: 1, unavailable: 0, unknown: 0 },
      providerKeys: 1, models: [{ name: 'exposed-alias' }], errors: {},
    });
    expect(requests.sort()).toEqual(['/config/api-keys', '/credentials']);
  });

  it('keeps successful metrics when independent requests fail and reports failed values as unknown', async () => {
    mockIPC((command, args) => {
      if (command === 'get_usage_overview') return usage;
      if (command === 'get_core_models') throw 'Model list unavailable';
      const request = args?.request as { path: string };
      if (request.path === '/credentials') return { files: [] };
      throw new Error('Management API error (401): unauthorized');
    });
    expect(await loadHomeOverview(true)).toEqual({
      usage: { ...usage, successRate: 80 }, credentials: { total: 0, available: 0, unavailable: 0, unknown: 0 },
      providerKeys: null, models: null,
      errors: { providerKeys: 'Management API error (401): unauthorized', models: 'Model list unavailable' },
    });
  });

  it('treats only an explicitly absent provider config node as an empty configuration', async () => {
    for (const message of ['Management API error (404): not_found', 'Management API error (404): 404 page not found']) {
      mockIPC((command, args) => {
        if (command === 'get_usage_overview') throw new Error('Usage database unavailable');
        if (command === 'get_core_models') return [];
        const request = args?.request as { path: string };
        if (request.path === '/credentials') return { files: [] };
        throw message;
      });
      const overview = await loadHomeOverview(true);
      expect(overview.usage).toBeNull();
      expect(overview.errors.usage).toBe('Usage database unavailable');
      expect(overview.models).toEqual([]);
      if (message.endsWith(': not_found')) {
        expect(overview.providerKeys).toBe(0);
        expect(overview.errors.providerKeys).toBeUndefined();
      } else {
        expect(overview.providerKeys).toBeNull();
        expect(overview.errors.providerKeys).toBe(message);
      }
    }
  });
});
