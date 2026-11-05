import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { setCurrentLocale } from '../src/i18n';
import { managementApi } from '../src/services/managementApi';
import { updateQuotaCache } from '../src/services/quotaCache';
import { loadQuota, providerForFile, quotaRowsFor } from '../src/services/quotaService';
import {
  loadZaiCodingPlanFiles,
  zaiCodingPlanFilesFromGroups,
  zaiMonitorOrigin,
  zaiPlanFromPayloads,
  zaiQuotaRows,
  ZAI_CODING_PLAN_BASE_URL,
  ZAI_CODING_PLAN_BASE_URL_CN,
} from '../src/services/zaiQuota';

const limits = {
  code: 200,
  success: true,
  data: {
    level: 'max',
    limits: [
      {
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 12,
        remaining: 3988,
        percentage: 0,
        nextResetTime: 1_788_073_095_998,
        usageDetails: [
          { modelCode: 'search-prime', usage: 0 },
          { modelCode: 'web-reader', usage: 12 },
        ],
      },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 100, nextResetTime: 1_787_056_863_927 },
      {
        type: 'TOKENS_LIMIT',
        unit: 6,
        number: 1,
        usage: 28000,
        currentValue: 6471,
        remaining: 21529,
        percentage: 23,
        nextResetTime: 1_787_641_095_989,
      },
    ],
  },
};

const subscription = {
  code: 200,
  success: true,
  data: [{ productName: 'GLM Coding Pro', status: 'active', valid: '2027-01-01' }],
};

let get: ReturnType<typeof spyOn> | undefined;
let post: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
  setCurrentLocale('en');
});
afterEach(() => {
  get?.mockRestore();
  post?.mockRestore();
  updateQuotaCache({});
  setCurrentLocale('en');
});

describe('z.ai Coding Plan quota', () => {
  it('recognizes coding-plan hosts and ignores lookalike hosts', () => {
    expect(zaiMonitorOrigin(ZAI_CODING_PLAN_BASE_URL)).toBe('https://api.z.ai');
    expect(zaiMonitorOrigin(`${ZAI_CODING_PLAN_BASE_URL_CN}/`)).toBe('https://open.bigmodel.cn');
    expect(zaiMonitorOrigin('https://api.z.ai/api/anthropic')).toBe('https://api.z.ai');
    expect(zaiMonitorOrigin('https://dev.bigmodel.cn/api/coding/paas/v4')).toBe('https://dev.bigmodel.cn');
    expect(zaiMonitorOrigin('https://api.z.ai.attacker.test/api/coding/paas/v4')).toBeNull();
    expect(zaiMonitorOrigin('https://open.bigmodel.cn.evil/v1')).toBeNull();
    expect(zaiMonitorOrigin('not a url')).toBeNull();
  });

  it('recognizes provider aliases without taking over other providers', () => {
    for (const provider of ['zai', 'z.ai', 'z_ai', 'Zhipu', 'glm', 'openai-compatible-zai', 'bigmodel']) {
      expect(providerForFile({ provider })).toBe('zai');
    }
    expect(providerForFile({ provider: 'openai-compatible-relay', base_url: 'https://api.z.ai/api/coding/paas/v4' })).toBe('zai');
    expect(providerForFile({ provider: 'claude', base_url: 'https://api.z.ai/api/anthropic' })).toBe('claude');
    expect(providerForFile({ provider: 'codex' })).toBe('codex');
  });

  it('orders 5-hour, weekly, then MCP tool usage and prefers real counts', () => {
    const rows = zaiQuotaRows(limits);
    expect(rows.map((row) => row.label)).toEqual(['5-hour limit', 'Weekly limit', 'MCP tools limit']);
    expect(rows[0].remainingPercent).toBe(0);
    expect(rows[0].detail).toBeUndefined();
    expect(rows[1].remainingPercent).toBeCloseTo(76.889, 2);
    expect(rows[1].detail).toBe('6471 / 28000');
    expect(rows[1].resetAtMs).toBe(1_787_641_095_989);
    expect(rows[2].remainingPercent).toBeCloseTo(99.7, 2);
    expect(rows[2].detail).toBe('12 / 4000 · search-prime 0, web-reader 12');
    expect(quotaRowsFor('zai', limits)).toEqual(rows);
    expect(zaiPlanFromPayloads(limits, subscription)).toBe('GLM Coding Pro');
    expect(zaiPlanFromPayloads(limits, { code: 200, success: false, msg: 'no' })).toBe('max');
  });

  it('labels a 7-week row and an unnumbered team window like the proxy core does', () => {
    const rows = zaiQuotaRows({
      success: true,
      code: 200,
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 6, number: 7, percentage: 40 },
          { type: 'TOKENS_LIMIT', unit: 3, number: 0, percentage: 12 },
        ],
      },
    });
    expect(rows.map((row) => row.label)).toEqual(['5-hour limit', 'Weekly limit']);
    expect(rows[0].remainingPercent).toBe(88);
    expect(rows[1].remainingPercent).toBe(60);
  });

  it('keeps a percentage-only credit window and skips rows with no measurement', () => {
    const rows = zaiQuotaRows({
      success: true,
      code: '200',
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 0, remaining: 12000, percentage: 0 },
          { type: 'TOKENS_LIMIT', unit: 9, number: 1 },
        ],
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('5-hour limit');
    expect(rows[0].remainingPercent).toBe(100);
    expect(rows[0].detail).toBe('0 / 12000');
  });

  it('builds one quota credential per coding-plan API key on both hosts', () => {
    const files = zaiCodingPlanFilesFromGroups({
      'openai-compatibility': [
        {
          name: 'z.ai',
          'base-url': ZAI_CODING_PLAN_BASE_URL,
          keys: [
            { 'api-key': 'global-key', auth_index: 'g1' },
            { 'api-key': 'spare', auth_index: 'g2', disabled: true },
          ],
        },
        { name: 'relay', 'base-url': 'https://relay.example/v1', keys: [{ 'api-key': 'x', auth_index: 'r1' }] },
      ],
      claude: [
        {
          name: 'glm-cn',
          'base-url': 'https://open.bigmodel.cn/api/anthropic',
          keys: [{ 'api-key': 'cn-key', auth_index: 'c1' }],
        },
        {
          name: 'anthropic',
          'base-url': 'https://api.anthropic.com',
          keys: [{ 'api-key': 'claude', auth_index: 'a1' }],
        },
      ],
      codex: [{ name: 'ignored', 'base-url': 'https://api.z.ai/api/coding/paas/v4', keys: [{ auth_index: 'nope' }] }],
    });
    expect(files.map((file) => [file.name, file.auth_index, file.base_url])).toEqual([
      ['z.ai', 'g1', 'https://api.z.ai'],
      ['glm-cn', 'c1', 'https://open.bigmodel.cn'],
    ]);
    expect(JSON.stringify(files)).not.toContain('global-key');
    expect(JSON.stringify(files)).not.toContain('cn-key');
  });

  it('queries the monitor and subscription endpoints on the credential host', async () => {
    post = spyOn(managementApi, 'post').mockImplementation(async (_path, body) => ({
      status_code: 200,
      body: String(body?.url).endsWith('/subscription/list') ? subscription : limits,
    }));
    const file = {
      name: 'z.ai',
      provider: 'zai',
      auth_index: 'g1',
      base_url: 'https://open.bigmodel.cn',
      runtime_only: true,
    };
    expect(await loadQuota(file)).toMatchObject({
      status: 'success',
      plan: 'GLM Coding Pro',
      rows: [{ label: '5-hour limit' }, { label: 'Weekly limit' }, { label: 'MCP tools limit' }],
    });
    expect(post.mock.calls.map((call) => call[1]?.url)).toEqual([
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      'https://open.bigmodel.cn/api/biz/subscription/list',
    ]);
    expect(post.mock.calls[0][1]).toMatchObject({
      authIndex: 'g1',
      method: 'GET',
      header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' },
    });
  });

  it('surfaces an auth failure from the quota body and keeps quota when subscription fails', async () => {
    post = spyOn(managementApi, 'post').mockImplementation(async (_path, body) => {
      if (String(body?.url).includes('subscription')) throw new Error('plan down');
      return { status_code: 200, body: limits };
    });
    expect(await loadQuota({ provider: 'zai', auth_index: '1', base_url: 'https://api.z.ai', runtime_only: true }))
      .toMatchObject({ status: 'success', plan: 'max' });
    post.mockImplementation(async () => ({ status_code: 200, body: { code: 401, success: false, msg: 'token expired' } }));
    const failed = await loadQuota({ provider: 'zai', auth_index: '1', base_url: 'https://api.z.ai', runtime_only: true });
    expect(failed.status).toBe('error');
    expect(failed.error).toContain('token expired');
    expect(failed.error).not.toContain('Bearer');
  });

  it('reads a saved credential base URL and defaults file credentials to the international host', async () => {
    get = spyOn(managementApi, 'get').mockResolvedValue({ base_url: 'https://dev.bigmodel.cn/api/anthropic' });
    post = spyOn(managementApi, 'post').mockResolvedValue({ status_code: 200, body: limits });
    expect((await loadQuota({ name: 'zai.json', provider: 'zai', auth_index: '4' })).status).toBe('success');
    expect(post.mock.calls[0][1]?.url).toBe('https://dev.bigmodel.cn/api/monitor/usage/quota/limit');
    get.mockResolvedValue({});
    post.mockClear();
    expect((await loadQuota({ name: 'zai.json', provider: 'zai', auth_index: '4' })).status).toBe('success');
    expect(String(post.mock.calls[0][1]?.url)).toContain('https://api.z.ai/api/monitor/usage/quota/limit');
  });

  it('loads coding-plan keys from API key config and ignores a missing family', async () => {
    get = spyOn(managementApi, 'get').mockImplementation(async (path) => {
      if (path === '/config/api-keys/openai-compatibility') {
        return [{ name: 'z.ai', 'base-url': ZAI_CODING_PLAN_BASE_URL, keys: [{ auth_index: 'g1', 'api-key': 'secret' }] }];
      }
      throw new Error('Management API error (404): not_found');
    });
    const files = await loadZaiCodingPlanFiles();
    expect(files).toEqual([expect.objectContaining({ name: 'z.ai', auth_index: 'g1', provider: 'zai' })]);
    expect(JSON.stringify(files)).not.toContain('secret');
  });
});
