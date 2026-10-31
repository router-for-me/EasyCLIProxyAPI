import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { fetchModels } from '../src/services/modelService';
import { checkProviderModelHealth } from '../src/services/providerHealthCheck';
import { providerDraftConnection } from '../src/pages/ApiAccessPage';
import { providerKeyDraft } from '../src/services/providerGroups';

describe('provider request proxy routing', () => {
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

  it('uses the edited shared proxy unless a key supplies a non-null override', () => {
    const draft = { proxyUrl: 'socks5://127.0.0.1:19080', headersText: 'X-Team: new' };
    for (const override of [undefined, null, '', 'direct', 'http://127.0.0.1:18080']) {
      const key = providerKeyDraft({ 'api-key': 'test-key', ...(override === undefined ? {} : { 'proxy-url': override }) });
      const effective = providerDraftConnection(draft, key);
      expect(effective['proxy-url']).toBe(override == null ? draft.proxyUrl : override);
      expect(effective.headers).toEqual({ 'X-Team': 'new' });
    }
  });

  for (const firstResult of ['http-error', 'transport-error'] as const) {
    it(`retains direct proxy selection on unauthenticated discovery fallback (${firstResult})`, async () => {
      const requests: Record<string, any>[] = [];
      mockIPC((_command, args) => {
        const request = args?.request as Record<string, any>;
        requests.push(request);
        if (requests.length === 1) {
          if (firstResult === 'transport-error') throw new Error('mock transport failure');
          return { status_code: 401, body: 'unauthorized' };
        }
        return { status_code: 200, body: JSON.stringify({ data: [{ id: 'test-model' }] }) };
      });
      await fetchModels('openai', 'https://provider.invalid/v1', 'test-key', undefined, {}, undefined, ' direct ');
      expect(requests).toHaveLength(2);
      expect(requests.every(request => request.body.proxy_url === 'direct')).toBe(true);
      expect(requests[1].body.header).toBeUndefined();
    });
  }

  it('sends proxy overrides on every Gemini model page and uses SSE for health checks', async () => {
    const requests: Record<string, any>[] = [];
    mockIPC((command, args) => {
      const request = args?.request as Record<string, any>;
      requests.push(request);
      if (command === 'provider_health_probe') return { firstTokenLatencyMs: 12, responseLatencyMs: 12 };
      return { status_code: 200, body: { models: [{ name: `models/model-${requests.length}` }], ...(requests.length === 1 ? { nextPageToken: 'next' } : {}) } };
    });
    const proxyUrl = 'socks5://127.0.0.1:19080';
    await fetchModels('gemini', 'https://generativelanguage.googleapis.com', 'test-key', undefined, {}, undefined, proxyUrl);
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.body.proxy_url === proxyUrl)).toBe(true);
    const result = await checkProviderModelHealth({ provider: 'gemini', baseUrl: '', apiKeys: ['test-key'], proxyUrl }, 'model-1');
    expect(result.success).toBe(true);
    expect(requests[2].proxyUrl).toBe(proxyUrl);
    expect(requests[2].url).toEndWith(':streamGenerateContent?alt=sse');
  });

  it('leaves proxy inheritance unset rather than converting it to direct', async () => {
    mockIPC((command, args) => {
      const request = args?.request as Record<string, any>;
      if (command === 'provider_health_probe') {
        expect(request.proxyUrl).toBeUndefined();
        return { firstTokenLatencyMs: 12, responseLatencyMs: 12 };
      }
      expect(request.body.proxy_url).toBeUndefined();
      return { status_code: 200, body: { data: [{ id: 'model' }] } };
    });
    await fetchModels('openai', 'https://provider.invalid/v1', 'test-key');
    await checkProviderModelHealth({ provider: 'openai', baseUrl: 'https://provider.invalid/v1', apiKeys: ['test-key'], proxyUrl: '' }, 'model');
  });
});
