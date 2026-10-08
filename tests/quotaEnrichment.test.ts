import { afterEach, expect, it, spyOn } from 'bun:test';
import { managementApi } from '../src/services/managementApi';
import { commitFetchedQuota } from '../src/services/quotaEnrichment';
import { captureQuotaCacheGeneration, getQuotaCacheSnapshot, pruneQuotaCache, updateQuotaCache } from '../src/services/quotaCache';
import { enrichXaiQuotaPlan, loadQuota, quotaKey, type QuotaState } from '../src/services/quotaService';

const file = { name: 'grok-fixture.json', provider: 'xai', auth_index: 'fixture', sub: 'fictional-user' };
const key = quotaKey(file);
const quota: QuotaState = { status: 'success', rows: [{ label: 'Weekly', remainingPercent: 75 }], plan: 'Paid' };
let post: ReturnType<typeof spyOn> | undefined;
afterEach(() => { post?.mockRestore(); updateQuotaCache({}); });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it('先提交额度，再后台补套餐；两次请求使用短超时和现有用户头', async () => {
  let release!: (value: unknown) => void;
  const gate = new Promise((resolve) => { release = resolve; });
  post = spyOn(managementApi, 'post').mockImplementation(async (path, body, options) => {
    expect(path).toBe('/requests/api-call');
    expect(getQuotaCacheSnapshot()[key]).toBe(quota);
    expect(options).toEqual({ timeoutMs: 8000 });
    expect(body).toMatchObject({ authIndex: 'fixture', method: 'GET', header: { 'x-userid': 'fictional-user' } });
    return await gate as never;
  });
  commitFetchedQuota(captureQuotaCacheGeneration(), file, quota);
  expect(getQuotaCacheSnapshot()[key]).toBe(quota);
  expect(post).toHaveBeenCalledTimes(2);
  release({ status_code: 200, body: { subscription_tier_display: 'SuperGrok Heavy' } });
  await flush();
  expect(getQuotaCacheSnapshot()[key]).toEqual({ ...quota, plan: 'SuperGrok Heavy' });
});

it('settings 失败仍可使用 user 套餐，两个失败保留原结果', async () => {
  post = spyOn(managementApi, 'post').mockImplementation(async (_path, body) => {
    const request = body as { url: string };
    if (request.url.endsWith('/settings')) throw new Error('offline');
    return { status_code: 200, body: JSON.stringify({ subscriptionTier: 'SuperGrok' }) } as never;
  });
  expect(await enrichXaiQuotaPlan(file, quota)).toEqual({ ...quota, plan: 'SuperGrok' });
  post.mockImplementation(async () => ({ status_code: 403, body: 'unavailable' }) as never);
  expect(await enrichXaiQuotaPlan(file, quota)).toBe(quota);
  post.mockImplementation(async () => ({ status_code: 200, body: {
    subscription_tier_display: { invalid: true }, subscriptionTier: false,
  } }) as never);
  expect(await enrichXaiQuotaPlan(file, quota)).toBe(quota);
});

for (const change of ['refresh', 'remove', 'session'] as const) {
  it(`迟到套餐不覆盖 ${change}`, async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    post = spyOn(managementApi, 'post').mockImplementation(async () => await gate as never);
    commitFetchedQuota(captureQuotaCacheGeneration(), file, quota);
    if (change === 'refresh') updateQuotaCache({ [key]: { status: 'loading', rows: [] } });
    else if (change === 'remove') updateQuotaCache({});
    else { pruneQuotaCache(new Set()); updateQuotaCache({ [key]: quota }); }
    const expected = getQuotaCacheSnapshot();
    release({ status_code: 200, body: { subscription_tier_display: 'SuperGrok Heavy' } });
    await flush();
    expect(getQuotaCacheSnapshot()).toBe(expected);
  });
}

it('套餐接口不阻塞账单结果，并按月额度提供套餐回退', async () => {
  post = spyOn(managementApi, 'post').mockImplementation(async (_path, body) => {
    expect((body as { url: string }).url).toContain('/billing');
    return { status_code: 200, body: { config: { monthlyLimit: 15000, used: 3000 } } } as never;
  });
  expect(await loadQuota(file)).toMatchObject({ status: 'success', plan: 'SuperGrok' });
  expect(post).toHaveBeenCalledTimes(2);
});
