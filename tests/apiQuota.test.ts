import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { apiAccessIconForQuotaSource } from '../src/pages/QuotaPage';
import { managementApi } from '../src/services/managementApi';
import {
  apiAccessRecordIdentityFor,
  apiQuotaAdapterFor,
  apiQuotaCacheKey,
  apiQuotaErrorMessage,
  apiQuotaSourceLabel,
  countApiQuotaCards,
  countApiQuotaSources,
  countApiQuotaUnsupported,
  discoverApiQuotaSources,
  apiQuotaSourcesFromConfig,
  loadQuotaSourceStages,
  resolveApiQuotaAdapter,
  saveApiQuotaBalanceUrl,
  validateBalanceUrl,
  flattenApiQuotaRecords,
  withApiQuotaBalanceUrl,
  parseDeepSeekQuota,
  parseNovitaQuota,
  parseOpenRouterQuota,
  parseSiliconFlowQuota,
  parseStepFunQuota,
  queryApiQuotaSource,
  safeApiQuotaHostname,
} from '../src/services/apiQuota';
import {
  getQuotaCacheSnapshot,
  pruneQuotaCache,
  pruneQuotaCacheNamespace,
  updateQuotaCache,
  refreshQuotaCacheEntries,
} from '../src/services/quotaCache';
import type { QuotaState } from '../src/services/quotaService';

const success = (body: unknown) => ({ status_code: 200, body });

type ApiCallRequest = {
  authIndex?: string;
  method: string;
  url: string;
  header: Record<string, string>;
};

let get: ReturnType<typeof spyOn>;
let post: ReturnType<typeof spyOn>;
let put: ReturnType<typeof spyOn>;
let calls: ApiCallRequest[];
let handler: (request: ApiCallRequest) => unknown | Promise<unknown>;

beforeEach(() => {
  calls = [];
  handler = () => success({});
  get = spyOn(managementApi, 'get').mockImplementation(async (path) => {
    if (path === '/config') return {};
    throw new Error(`Unexpected GET ${path}`);
  });
  post = spyOn(managementApi, 'post').mockImplementation(async (path, body) => {
    expect(path).toBe('/api-call');
    const request = body as unknown as ApiCallRequest;
    calls.push(request);
    return await handler(request) as never;
  });
  put = spyOn(managementApi, 'put').mockImplementation(async () => success({}) as never);
});

afterEach(() => {
  get.mockRestore();
  post.mockRestore();
  put.mockRestore();
  updateQuotaCache({});
});

describe('API quota hostname adapters', () => {
  it('matches exact supported hostnames and allows base URL paths', () => {
    expect(apiQuotaAdapterFor('https://api.deepseek.com/v1')?.vendor).toBe('deepseek');
    expect(apiQuotaAdapterFor('https://openrouter.ai/anthropic')).toMatchObject({ vendor: 'openrouter' });
    expect(apiQuotaAdapterFor('https://api.siliconflow.com/v1')).toMatchObject({ vendor: 'siliconflow' });
    expect(apiQuotaAdapterFor('https://api.stepfun.ai/custom')).toMatchObject({ vendor: 'stepfun' });
    expect(apiQuotaAdapterFor('https://api.novita.ai/v1')).toMatchObject({ vendor: 'novita' });
  });

  it('reuses the icon of the API Access category that owns each credential', () => {
    const iconFor = (protocol: 'codex-api-key' | 'openai-compatibility' | 'claude-api-key' | 'gemini-api-key', recordName = '', baseUrl = '') => (
      apiAccessIconForQuotaSource({ protocol, recordName, baseUrl })
    );
    expect(iconFor('codex-api-key')).toContain('codex');
    expect(iconFor('claude-api-key')).toContain('claude');
    expect(iconFor('gemini-api-key')).toContain('gemini');
    expect(iconFor('openai-compatibility', 'OpenRouter', 'https://openrouter.ai/v1')).toContain('openai');
    expect(iconFor('openai-compatibility', 'DeepSeek', 'https://custom.example/v1')).toContain('deepseek');
    expect(iconFor('openai-compatibility', 'Custom', 'https://api.deepseek.com/v1')).toContain('deepseek');
  });

  it('rejects malicious suffixes, subdomains, credentials, and unsupported schemes', () => {
    expect(apiQuotaAdapterFor('https://api.deepseek.com.evil.example/v1')).toBeNull();
    expect(apiQuotaAdapterFor('https://evil.api.deepseek.com/v1')).toBeNull();
    expect(apiQuotaAdapterFor('https://user:password@api.deepseek.com/v1')).toBeNull();
    expect(apiQuotaAdapterFor('https://openrouter.ai.evil.example')).toBeNull();
    expect(apiQuotaAdapterFor('ftp://api.deepseek.com')).toBeNull();
    expect(apiQuotaAdapterFor('not a URL')).toBeNull();
  });

  it('localizes backend balance metadata error codes and preserves unknown errors', () => {
    expect(apiQuotaErrorMessage('api_balance.invalid_url')).toBe('余额查询 URL 无效');
    expect(apiQuotaErrorMessage(new Error('api_balance.invalid_base_url'))).toBe('API 接入 Base URL 无效');
    expect(apiQuotaErrorMessage('unexpected error')).toBe('unexpected error');
  });

  it.each([
    ['zh-CN', '管理 API 请求失败（HTTP 500）'],
    ['zh-TW', '管理 API 請求失敗（HTTP 500）'],
    ['en', 'Management API request failed (HTTP 500)'],
    ['ja', '管理 API リクエストに失敗しました（HTTP 500）'],
  ] as const)('localizes management failures in %s while preserving the server detail', (locale, expected) => {
    expect(apiQuotaErrorMessage(new Error('管理 API 错误 (500): upstream unavailable'), locale)).toBe(`${expected}: upstream unavailable`);
    expect(apiQuotaErrorMessage('管理 API 错误 (500)', locale)).toBe(expected);
  });

  it('validates secure balance URLs and rejects conflicting supported vendors', () => {
    expect(validateBalanceUrl('https://api.deepseek.com/user/balance', 'https://custom.example/v1')).toBe('https://api.deepseek.com/user/balance');
    expect(validateBalanceUrl('http://127.0.0.1:9000/balance', 'https://api.deepseek.com/v1')).toBe('http://127.0.0.1:9000/balance');
    expect(() => validateBalanceUrl('http://api.deepseek.com/balance', 'https://api.deepseek.com/v1')).toThrow();
    expect(() => validateBalanceUrl('https://openrouter.ai/api/v1/credits', 'https://api.deepseek.com/v1')).toThrow();
    expect(() => validateBalanceUrl('https://unknown.example/balance', 'https://api.deepseek.com/v1')).toThrow();
    expect(resolveApiQuotaAdapter('https://custom.example/v1', 'https://api.openrouter.ai/api/v1/credits')).toMatchObject({ adapter: null });
  });
});

describe('API quota response parsers', () => {
  it('parses DeepSeek balances', () => {
    expect(parseDeepSeekQuota({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '12.5' }],
    })).toEqual([expect.objectContaining({
      remainingPercent: null,
      amount: { remaining: 12.5, used: null, total: null, unit: 'CNY' },
    })]);
  });

  it('parses StepFun balances', () => {
    expect(parseStepFunQuota({ balance: '7.25' })[0].amount).toEqual({
      remaining: 7.25, used: null, total: null, unit: 'CNY',
    });
  });

  it('parses SiliconFlow balances', () => {
    const adapter = apiQuotaAdapterFor('https://api.siliconflow.cn/v1')!;
    expect(parseSiliconFlowQuota({ data: { totalBalance: 31 } }, adapter)[0].amount).toEqual({
      remaining: 31, used: null, total: null, unit: 'CNY',
    });
  });

  it('parses OpenRouter used and total credits without a fabricated percentage', () => {
    expect(parseOpenRouterQuota({ data: { total_credits: 100, total_usage: 35 } })[0].amount).toEqual({
      remaining: 65, used: 35, total: 100, unit: 'USD',
    });
    expect(parseOpenRouterQuota({ data: { total_credits: 100, total_usage: 35 } })[0].remainingPercent).toBeNull();
    expect(parseOpenRouterQuota({ data: { total_credits: 10, total_usage: 12 } })[0].amount).toEqual({
      remaining: -2, used: 12, total: 10, unit: 'USD',
    });
  });

  it('parses Novita units from ten-thousandths of a dollar', () => {
    expect(parseNovitaQuota({ availableBalance: 12500 })[0].amount).toEqual({
      remaining: 1.25, used: null, total: null, unit: 'USD',
    });
  });
});

describe('API quota source discovery and requests', () => {
  it('flattens each OpenAI-compatible API key entry into an independent source', () => {
    const sources = flattenApiQuotaRecords('openai-compatibility', [{
      name: 'Shared provider',
      'base-url': 'https://api.deepseek.com/v1',
      'api-key-entries': [
        { 'api-key': 'first-secret', 'auth-index': 'auth-first' },
        { 'api-key': 'second-secret', 'auth-index': 'auth-second' },
      ],
    }]);
    expect(sources).toHaveLength(2);
    expect(sources[0].id).not.toBe(sources[1].id);
    expect(sources[0].authIndex).toBe('auth-first');
    expect(sources[1].authIndex).toBe('auth-second');
    expect(sources[0].id).not.toContain('secret');
    expect(apiQuotaCacheKey(sources[0])).not.toContain('secret');
  });

  it('invalidates cached quota identity when a direct API key changes', () => {
    const [before] = flattenApiQuotaRecords('codex-api-key', [
      { 'base-url': 'https://api.deepseek.com/v1', 'api-key': 'first-secret' },
    ]);
    const [after] = flattenApiQuotaRecords('codex-api-key', [
      { 'base-url': 'https://api.deepseek.com/v1', 'api-key': 'second-secret' },
    ]);
    expect(after.id).not.toBe(before.id);
  });

  it('prefers record names and distinguishes duplicate records and entries', () => {
    const sources = flattenApiQuotaRecords('openai-compatibility', [
      {
        name: 'Shared account',
        'base-url': 'https://api.deepseek.com/v1',
        'api-key-entries': [{ 'api-key': 'first-secret' }],
      },
      {
        name: 'Shared account',
        'base-url': 'https://api.deepseek.com/v1',
        'api-key-entries': [
          { 'api-key': 'second-secret' },
          { 'api-key': 'third-secret' },
        ],
      },
    ]);
    expect(sources.map(apiQuotaSourceLabel)).toEqual([
      'Shared account（1）',
      'Shared account（2） · API 凭据 1',
      'Shared account（2） · API 凭据 2',
    ]);
    expect(sources.map((source) => source.label)).toEqual(sources.map(apiQuotaSourceLabel));
  });

  it('does not expose query-bearing record URLs in card labels', () => {
    const [source] = flattenApiQuotaRecords('openai-compatibility', [{
      name: 'https://custom.example/provider?token=hidden',
      'base-url': 'https://custom.example/v1',
      'api-key': 'secret-key',
    }]);
    expect(source.label).toBe('custom.example');
    expect(source.label).not.toContain('hidden');
  });

  it('uses only safe hostnames or protocol fallbacks for unnamed unsupported sources', () => {
    const sources = flattenApiQuotaRecords('openai-compatibility', [
      { 'base-url': 'https://custom.example/v1?token=hidden-token', 'api-key': 'first-secret' },
      { 'base-url': 'https://user:password@another.example/v1', 'api-key': 'second-secret' },
    ]);
    expect(safeApiQuotaHostname(sources[0].baseUrl)).toBe('custom.example');
    expect(sources[0].label).toContain('custom.example');
    expect(sources[0].label).not.toContain('hidden-token');
    expect(sources[0].label).not.toContain('first-secret');
    expect(sources[1].label).toContain('OpenAI');
    expect(sources[1].label).not.toContain('another.example');
    expect(sources[1].label).not.toContain('password');
  });

  it('counts queryable credentials separately from displayed API cards and unsupported cards', () => {
    const sources = flattenApiQuotaRecords('codex-api-key', [
      { 'base-url': 'https://api.deepseek.com/v1', 'api-key': 'enabled-secret' },
      { 'base-url': 'https://api.stepfun.com/v1', 'api-key': 'disabled-secret', disabled: true },
      { 'base-url': 'https://custom.example/v1', 'api-key': 'unsupported-secret' },
      { 'base-url': 'https://api.deepseek.com/v1', 'api-key': 'another-secret' },
    ]);
    expect(countApiQuotaCards(sources)).toBe(4);
    expect(countApiQuotaUnsupported(sources)).toBe(1);
    expect(countApiQuotaSources(sources)).toBe(2);
  });

  it('applies GUI balance metadata to enriched runtime records', async () => {
    const paths: string[] = [];
    const discovery = await discoverApiQuotaSources(async (path) => {
      paths.push(path);
      if (path === '/config') return {};
      if (path === '/openai-compatibility') return {
        'openai-compatibility': [{
          name: 'Custom inference',
          'base-url': 'https://custom.example/v1',
          'api-key-entries': [{ 'api-key': 'configured-secret', 'auth-index': 'runtime-auth' }],
        }],
      };
      return { [path.slice(1)]: [] };
    }, async (queries) => {
      expect(queries).toEqual([{
        providerSection: 'openai-compatibility',
        recordName: 'Custom inference',
        baseUrl: 'https://custom.example/v1',
        apiKeys: ['configured-secret'],
      }]);
      return ['https://api.deepseek.com/user/balance?source=configured'];
    });
    const [source] = discovery.sources;
    expect(source.adapter).toMatchObject({ vendor: 'deepseek', endpoint: 'https://api.deepseek.com/user/balance?source=configured' });
    expect(source.authIndex).toBe('runtime-auth');
    expect(paths).toEqual([
      '/config',
      '/codex-api-key',
      '/openai-compatibility',
      '/claude-api-key',
      '/gemini-api-key',
    ]);
    handler = () => success({ balance_infos: [{ total_balance: 2 }] });
    await queryApiQuotaSource(source);
    expect(calls[0]?.url).toBe('https://api.deepseek.com/user/balance?source=configured');
    expect(calls[0]?.authIndex).toBe('runtime-auth');
  });

  it('persists balance metadata in GUI settings without mutating core providers', async () => {
    const [source] = flattenApiQuotaRecords('openai-compatibility', [{
      name: 'Shared',
      'base-url': 'https://custom.example/v1',
      'api-key-entries': [{ 'api-key': 'hidden' }],
    }]);
    const calls: unknown[][] = [];
    const result = await saveApiQuotaBalanceUrl(
      source,
      'https://api.deepseek.com/user/balance',
      async (...args) => { calls.push(args); },
    );
    const identity = apiAccessRecordIdentityFor(source);
    expect(result).toBe('https://api.deepseek.com/user/balance');
    expect(calls).toEqual([[
      identity,
      identity,
      'https://api.deepseek.com/user/balance',
    ]]);
    expect(put).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('discovers all supported API Access sections without querying balances', async () => {
    const paths: string[] = [];
    const result = await discoverApiQuotaSources(async (path) => {
      paths.push(path);
      if (path === '/config') return {};
      if (path === '/openai-compatibility') return {
        'openai-compatibility': [{ name: 'DeepSeek', 'base-url': 'https://api.deepseek.com/v1', 'api-key-entries': [{ 'api-key': 'secret' }] }],
      };
      return { [path.slice(1)]: [] };
    }, async () => [null]);
    expect(result.sources).toHaveLength(1);
    expect(paths).toEqual([
      '/config',
      '/codex-api-key',
      '/openai-compatibility',
      '/claude-api-key',
      '/gemini-api-key',
    ]);
    expect(post).not.toHaveBeenCalled();
  });

  it('parses all API Access sections from one config payload', () => {
    const result = apiQuotaSourcesFromConfig({
      'codex-api-key': [{ 'base-url': 'https://api.deepseek.com/v1', 'api-key': 'codex-secret' }],
      'openai-compatibility': [{ 'base-url': 'https://api.stepfun.com/v1', 'api-key-entries': [{ 'api-key': 'openai-secret' }] }],
      'claude-api-key': [{ 'base-url': 'https://openrouter.ai/v1', 'api-key': 'claude-secret' }],
      'gemini-api-key': [{ 'base-url': 'https://api.novita.ai/v1', 'api-key': 'gemini-secret' }],
    });
    expect(result.sources).toHaveLength(4);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('short-circuits OAuth loading when API source loading rejects', async () => {
    let oauthLoaded = false;
    await expect(loadQuotaSourceStages(
      async () => { throw new Error('管理 API 错误 (401): invalid management key'); },
      async () => { oauthLoaded = true; },
    )).rejects.toThrow('(401)');
    expect(oauthLoaded).toBe(false);
  });

  it('loads config once before auth-files and never posts during source staging', async () => {
    const paths: string[] = [];
    get.mockImplementation(async (path) => {
      paths.push(path);
      if (path === '/config') return {};
      if (path === '/auth-files') return { files: [] };
      return { [String(path).slice(1)]: [] };
    });
    await loadQuotaSourceStages(
      discoverApiQuotaSources,
      async () => { await managementApi.get('/auth-files'); },
    );
    expect(paths).toEqual([
      '/config',
      '/codex-api-key',
      '/openai-compatibility',
      '/claude-api-key',
      '/gemini-api-key',
      '/auth-files',
    ]);
    expect(post).not.toHaveBeenCalled();
  });

  it('skips auth-files after a management config failure', async () => {
    const paths: string[] = [];
    get.mockImplementation(async (path) => {
      paths.push(path);
      if (path === '/config') throw new Error('管理 API 错误 (401): invalid management key');
      return { files: [] };
    });
    await expect(loadQuotaSourceStages(
      discoverApiQuotaSources,
      async () => { await managementApi.get('/auth-files'); },
    )).rejects.toThrow('(401)');
    expect(paths).toEqual(['/config']);
    expect(post).not.toHaveBeenCalled();
  });

  it('uses auth-index and token placeholder before falling back to the direct key', async () => {
    handler = (request) => {
      expect(request.method).toBe('GET');
      return success({ balance: 3 });
    };
    const [withAuthIndex] = flattenApiQuotaRecords('codex-api-key', [{
      'base-url': 'https://api.stepfun.com/v1',
      'api-key': 'direct-secret',
      'auth-index': 'credential-1',
    }]);
    expect(await queryApiQuotaSource(withAuthIndex)).toMatchObject({ status: 'success' });
    expect(calls[0]).toMatchObject({
      authIndex: 'credential-1',
      url: 'https://api.stepfun.com/v1/accounts',
      header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' },
    });

    calls = [];
    const [direct] = flattenApiQuotaRecords('codex-api-key', [{
      'base-url': 'https://api.stepfun.com/v1',
      'api-key': 'direct-secret',
    }]);
    await queryApiQuotaSource(direct);
    expect(calls[0]).toMatchObject({
      authIndex: undefined,
      header: { Authorization: 'Bearer direct-secret' },
    });
  });

  it('redacts direct API keys from balance errors', async () => {
    handler = () => ({ status_code: 401, body: 'invalid direct-secret' });
    const [source] = flattenApiQuotaRecords('codex-api-key', [{
      'base-url': 'https://api.deepseek.com/v1',
      'api-key': 'direct-secret',
    }]);
    const result = await queryApiQuotaSource(source);
    expect(result.error).toContain('[redacted]');
    expect(result.error).not.toContain('direct-secret');
  });

  it('uses the fixed official endpoint for each supported vendor', async () => {
    const cases = [
      ['https://api.deepseek.com/v1', { balance_infos: [{ total_balance: 1 }] }, 'https://api.deepseek.com/user/balance'],
      ['https://api.stepfun.ai/v1', { balance: 1 }, 'https://api.stepfun.com/v1/accounts'],
      ['https://api.siliconflow.cn/v1', { data: { totalBalance: 1 } }, 'https://api.siliconflow.cn/v1/user/info'],
      ['https://openrouter.ai/anthropic', { data: { total_credits: 1, total_usage: 0 } }, 'https://openrouter.ai/api/v1/credits'],
      ['https://api.novita.ai/v1', { availableBalance: 10000 }, 'https://api.novita.ai/v3/user/balance'],
    ] as const;
    handler = () => success({});
    for (const [baseUrl, body, endpoint] of cases) {
      handler = () => success(body);
      const [source] = flattenApiQuotaRecords('codex-api-key', [{ 'base-url': baseUrl, 'api-key': 'direct-secret' }]);
      await queryApiQuotaSource(source);
      expect(calls.at(-1)?.url).toBe(endpoint);
      expect(calls.at(-1)?.header).toEqual({ Authorization: 'Bearer direct-secret', Accept: 'application/json' });
    }
  });
});

describe('quota loading failure isolation', () => {
  it('keeps healthy API sources and loads OAuth after a provider returns 500', async () => {
    const paths: string[] = [];
    let oauthLoaded = false;
    const result = await loadQuotaSourceStages(
      () => discoverApiQuotaSources(async (path) => {
        paths.push(path);
        if (path === '/config') return {};
        if (path === '/claude-api-key') throw new Error('管理 API 错误 (500): unavailable');
        return { [path.slice(1)]: [{ 'api-key': 'test-key', 'base-url': 'https://api.deepseek.com/v1' }] };
      }, async (queries) => queries.map(() => null)),
      async () => { oauthLoaded = true; },
    );
    expect(oauthLoaded).toBe(true);
    expect(paths.at(-1)).toBe('/gemini-api-key');
    expect(result.sources).toHaveLength(3);
    expect(result.failedProtocols).toEqual(['claude-api-key']);
    expect(result.errors?.join(' ')).toContain('HTTP 500');
  });

  it.each([401, 403])('stops all later reads if authentication expires with %s', async (status) => {
    const paths: string[] = [];
    let oauthLoaded = false;
    await expect(loadQuotaSourceStages(
      () => discoverApiQuotaSources(async (path) => {
        paths.push(path);
        if (path === '/config') return {};
        throw `管理 API 错误 (${status}): denied`;
      }, async () => []),
      async () => { oauthLoaded = true; },
    )).rejects.toContain(`(${status})`);
    expect(oauthLoaded).toBe(false);
    expect(paths).toEqual(['/config', '/codex-api-key']);
  });

  it('still loads OAuth when the config endpoint has a non-authentication failure', async () => {
    let oauthLoaded = false;
    const result = await loadQuotaSourceStages(
      async () => { throw new Error('管理 API 错误 (500): unavailable'); },
      async () => { oauthLoaded = true; },
    );
    expect(oauthLoaded).toBe(true);
    expect(result.errors?.[0]).toContain('HTTP 500');
  });

  it('isolates malformed balance metadata while retaining other saved endpoints and OAuth', async () => {
    let oauthLoaded = false;
    const result = await loadQuotaSourceStages(
      () => discoverApiQuotaSources(async (path) => path === '/openai-compatibility' ? {
        'openai-compatibility': [
          { name: 'bad', 'base-url': 'invalid', 'api-key-entries': [{ 'api-key': 'bad-key' }] },
          { name: 'healthy', 'base-url': 'https://custom.example/v1', 'api-key-entries': [{ 'api-key': 'good-key' }] },
        ],
      } : {}, async (queries) => {
        if (queries.some((query) => query.recordName === 'bad')) throw 'api_balance.invalid_base_url';
        return queries.map(() => 'https://api.deepseek.com/user/balance');
      }),
      async () => { oauthLoaded = true; },
    );
    expect(oauthLoaded).toBe(true);
    expect(result.sources[0].configurationError).toBeTruthy();
    expect(result.sources[1].configurationError).toBeUndefined();
    expect(result.sources[1].adapter?.endpoint).toBe('https://api.deepseek.com/user/balance');
    expect(result.errors).toHaveLength(1);
  });
});

describe('balance endpoint cache invalidation', () => {
  const sharedSources = () => flattenApiQuotaRecords('openai-compatibility', [{
    name: 'Shared', 'base-url': 'https://custom.example/v1',
    'api-key-entries': [{ 'api-key': 'first-key' }, { 'api-key': 'second-key' }],
  }]);
  const oldEndpoint = 'https://api.deepseek.com/user/balance';
  const newEndpoint = 'https://openrouter.ai/api/v1/credits';

  it('invalidates every key after rereading a record with a changed balance endpoint', async () => {
    let endpoint = oldEndpoint;
    const discover = () => discoverApiQuotaSources(async (path) => path === '/openai-compatibility'
      ? { 'openai-compatibility': [{ name: 'Shared', 'base-url': 'https://custom.example/v1',
        'api-key-entries': [{ 'api-key': 'first-key' }, { 'api-key': 'second-key' }] }] }
      : {}, async (queries) => queries.map(() => endpoint));
    const before = (await discover()).sources;
    updateQuotaCache(Object.fromEntries(before.map((source) => [apiQuotaCacheKey(source), { status: 'success', rows: [], plan: 'old' }])));
    endpoint = newEndpoint;
    const after = (await discover()).sources;
    pruneQuotaCacheNamespace('api-quota::', new Set(after.map(apiQuotaCacheKey)));
    expect(after.map((source) => source.id)).toEqual(before.map((source) => source.id));
    expect(after.map(apiQuotaCacheKey)).not.toEqual(before.map(apiQuotaCacheKey));
    expect(getQuotaCacheSnapshot()).toEqual({});
  });

  it('rejects an old response after saving a new endpoint and preserves the new response', async () => {
    const source = sharedSources()[0];
    const oldSource = withApiQuotaBalanceUrl(source, oldEndpoint);
    const newSource = withApiQuotaBalanceUrl(source, newEndpoint);
    let completeOld!: (result: QuotaState) => void;
    const pending = refreshQuotaCacheEntries([{ key: apiQuotaCacheKey(oldSource),
      query: () => new Promise((resolve) => { completeOld = resolve; }) }]);
    pruneQuotaCacheNamespace('api-quota::', new Set([apiQuotaCacheKey(newSource)]));
    await refreshQuotaCacheEntries([{ key: apiQuotaCacheKey(newSource),
      query: async () => ({ status: 'success', rows: [], plan: 'new' }) }]);
    completeOld({ status: 'success', rows: [], plan: 'old' });
    await pending;
    expect(getQuotaCacheSnapshot()[apiQuotaCacheKey(oldSource)]).toBeUndefined();
    expect(getQuotaCacheSnapshot()[apiQuotaCacheKey(newSource)]?.plan).toBe('new');
  });
});

describe('API quota cache isolation', () => {
  it('prunes only the API namespace and preserves OAuth quota entries', () => {
    updateQuotaCache({
      'oauth-file::one': { status: 'success', rows: [] },
      'api-quota::keep': { status: 'success', rows: [] },
      'api-quota::remove': { status: 'success', rows: [] },
    });
    pruneQuotaCacheNamespace('api-quota::', new Set(['api-quota::keep']));
    expect(getQuotaCacheSnapshot()).toEqual({
      'oauth-file::one': { status: 'success', rows: [] },
      'api-quota::keep': { status: 'success', rows: [] },
    });
  });

  it('does not reset an API request when the OAuth namespace is refreshed', () => {
    updateQuotaCache({
      'oauth-file::one': { status: 'success', rows: [] },
      'api-quota::loading': { status: 'loading', rows: [] },
    });
    pruneQuotaCache(new Set(['oauth-file::one']));
    expect(getQuotaCacheSnapshot()['api-quota::loading']).toEqual({ status: 'loading', rows: [] });
  });
});
