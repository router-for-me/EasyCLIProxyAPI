import { describe, expect, it } from 'bun:test';
import {
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  getQuotaCacheSnapshot,
  pruneQuotaCache,
  pruneQuotaCacheNamespace,
  refreshQuotaCacheEntries,
  updateQuotaCache,
} from '../src/services/quotaCache';
import type { QuotaState } from '../src/services/quotaService';

describe('额度跨页面缓存', () => {
  it('保留仍存在的认证文件额度并清理失效项', () => {
    updateQuotaCache({
      first: { status: 'success', rows: [], fetchedAt: 1 },
      removed: { status: 'error', rows: [], error: 'old' },
    });
    pruneQuotaCache(new Set(['first']));

    expect(getQuotaCacheSnapshot()).toEqual({
      first: { status: 'success', rows: [], fetchedAt: 1 },
    });
  });

  it('认证文件集合变化后拒绝过期请求写回', () => {
    updateQuotaCache({
      stale: { status: 'loading', rows: [] },
      retained: { status: 'loading', rows: [] },
    });
    const generation = captureQuotaCacheGeneration();
    pruneQuotaCache(new Set(['retained']));
    let committed = false;

    expect(commitQuotaCacheIfCurrent(generation, () => {
      committed = true;
    })).toBe(false);
    expect(committed).toBe(false);
    expect(getQuotaCacheSnapshot().retained).toEqual({ status: 'idle', rows: [] });
  });

  it.each(['oauth', 'api'])('keeps the other namespace running when %s is reloaded during refresh all', async (reloaded) => {
    updateQuotaCache({});
    let finishOAuth!: (result: QuotaState) => void;
    let finishApi!: (result: QuotaState) => void;
    const refresh = refreshQuotaCacheEntries([
      { key: 'oauth', query: () => new Promise((resolve) => { finishOAuth = resolve; }) },
      { key: 'api-quota::one', query: () => new Promise((resolve) => { finishApi = resolve; }) },
    ]);
    if (reloaded === 'oauth') pruneQuotaCache(new Set(['oauth']));
    else pruneQuotaCacheNamespace('api-quota::', new Set(['api-quota::one']));
    finishOAuth({ status: 'success', rows: [], plan: 'OAuth' });
    finishApi({ status: 'success', rows: [], plan: 'API' });
    await refresh;
    expect(getQuotaCacheSnapshot().oauth.status).toBe(reloaded === 'oauth' ? 'idle' : 'success');
    expect(getQuotaCacheSnapshot()['api-quota::one'].status).toBe(reloaded === 'api' ? 'idle' : 'success');
    expect(Object.values(getQuotaCacheSnapshot()).some((quota) => quota.status === 'loading')).toBe(false);
  });

  it('continues queued API requests after OAuth changes and skips obsolete queued OAuth requests', async () => {
    updateQuotaCache({});
    let finishFirst!: (result: QuotaState) => void;
    const called: string[] = [];
    const refresh = refreshQuotaCacheEntries([
      { key: 'oauth-first', query: () => new Promise((resolve) => { finishFirst = resolve; }) },
      { key: 'oauth-next', query: async () => { called.push('OAuth'); return { status: 'success', rows: [] }; } },
      { key: 'api-quota::next', query: async () => { called.push('API'); return { status: 'success', rows: [] }; } },
    ], 1);
    pruneQuotaCache(new Set(['oauth-first', 'oauth-next']));
    finishFirst({ status: 'success', rows: [] });
    await refresh;
    expect(called).toEqual(['API']);
    expect(getQuotaCacheSnapshot()['api-quota::next'].status).toBe('success');
  });
});
