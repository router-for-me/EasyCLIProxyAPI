import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { managementApi } from '../src/services/managementApi';
import {
  AUTO_BALANCE_PRIORITY,
  applyQuotaRoutingChange,
  computeQuotaRoutingTarget,
  getQuotaAutoBalanceEnabled,
  restoreQuotaRoutingOriginals,
  setQuotaAutoBalanceEnabled,
  subscribeQuotaRoutingChanges,
  syncCredentialQuotaRouting,
  watchQuotaAutoBalanceStorage,
} from '../src/services/quotaAutoBalance';
import { commitFetchedQuota } from '../src/services/quotaEnrichment';
import { captureQuotaCacheGeneration, updateQuotaCache } from '../src/services/quotaCache';
import { quotaRowsFor, type QuotaState } from '../src/services/quotaService';

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

const fakeApi = (stored: Record<string, Record<string, unknown>>) => {
  const patches: Array<Record<string, unknown>> = [];
  const api = {
    patches,
    beforeDownload: undefined as undefined | (() => Promise<void>),
    get: async (path: string, query?: Record<string, string>) => {
      if (path === '/credentials') return { files: Object.keys(stored).map((name) => ({ name })) };
      await api.beforeDownload?.();
      return { ...stored[String(query?.name)] };
    },
    patch: async (_path: string, body: Record<string, unknown>) => {
      patches.push(body);
      const { name, ...fields } = body;
      Object.assign(stored[String(name)], fields);
    },
  };
  return api;
};

const claudeFile = { name: 'claude-test.json', provider: 'claude', auth_index: 'idx-1', source: 'file', priority: 3 };

describe('quotaAutoBalance', () => {
  const originalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  let spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = memoryStorage();
  });

  afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
    spies = [];
    setQuotaAutoBalanceEnabled(false);
    updateQuotaCache({});
    (globalThis as { localStorage?: unknown }).localStorage = originalStorage;
  });

  it('computes priority and weight tiers based on bottleneck and average remaining quota', () => {
    const healthy: QuotaState = {
      status: 'success',
      rows: [
        { label: '5-hour window', remainingPercent: 81 },
        { label: '7-day window', remainingPercent: 72 },
      ],
    };
    expect(computeQuotaRoutingTarget(healthy)).toEqual({
      priority: AUTO_BALANCE_PRIORITY.healthy,
      weight: Math.round(72 * 0.7 + 76.5 * 0.3),
      bottleneckPercent: 72,
      averagePercent: 76.5,
    });

    const lowWarning: QuotaState = {
      status: 'success',
      rows: [
        { label: '5-hour window', remainingPercent: 81 },
        { label: '7-day window', remainingPercent: 5 },
      ],
    };
    expect(computeQuotaRoutingTarget(lowWarning)).toEqual({
      priority: AUTO_BALANCE_PRIORITY.low,
      weight: 5,
      bottleneckPercent: 5,
      averagePercent: 43,
    });

    const critical: QuotaState = {
      status: 'success',
      rows: [
        { label: '5-hour window', remainingPercent: 2 },
        { label: '7-day window', remainingPercent: 50 },
      ],
    };
    expect(computeQuotaRoutingTarget(critical)).toEqual({
      priority: AUTO_BALANCE_PRIORITY.critical,
      weight: 1,
      bottleneckPercent: 2,
      averagePercent: 26,
    });
  });

  it('ranks depleted credentials below credentials left at the default priority', () => {
    expect(AUTO_BALANCE_PRIORITY.healthy).toBe(0);
    expect(AUTO_BALANCE_PRIORITY.low).toBeLessThan(0);
    expect(AUTO_BALANCE_PRIORITY.critical).toBeLessThan(AUTO_BALANCE_PRIORITY.low);
  });

  it('ignores model-scoped limits when account-wide windows exist', () => {
    const target = computeQuotaRoutingTarget({
      status: 'success',
      rows: [
        { label: '5-hour window', remainingPercent: 80 },
        { label: '7-day window', remainingPercent: 60 },
        { label: '7-day Opus', remainingPercent: 0, scoped: true },
      ],
    });
    expect(target?.priority).toBe(AUTO_BALANCE_PRIORITY.healthy);
    expect(target?.bottleneckPercent).toBe(60);
  });

  it('treats the Claude OAuth apps window as account-wide and model windows as scoped', () => {
    const rows = quotaRowsFor('claude', {
      five_hour: { utilization: 20 },
      seven_day: { utilization: 40 },
      seven_day_oauth_apps: { utilization: 100 },
      seven_day_opus: { utilization: 100 },
    });
    expect(rows.map((row) => Boolean(row.scoped))).toEqual([false, false, false, true]);
    const target = computeQuotaRoutingTarget({ status: 'success', rows });
    expect(target?.priority).toBe(AUTO_BALANCE_PRIORITY.critical);
    expect(target?.bottleneckPercent).toBe(0);
  });

  it('uses the healthiest model group when only grouped limits exist', () => {
    const target = computeQuotaRoutingTarget({
      status: 'success',
      rows: [
        { label: 'Claude · 5h', groupLabel: 'Claude', remainingPercent: 0 },
        { label: 'Gemini · 5h', groupLabel: 'Gemini', remainingPercent: 90 },
        { label: 'Gemini · weekly', groupLabel: 'Gemini', remainingPercent: 70 },
      ],
    });
    expect(target).toEqual({
      priority: AUTO_BALANCE_PRIORITY.healthy,
      weight: Math.round(70 * 0.7 + 35 * 0.3),
      bottleneckPercent: 70,
      averagePercent: 35,
    });
  });

  it('reads current values from the stored credential and skips redundant PATCH requests', async () => {
    const stored = { 'claude-test.json': { priority: 0, weight: 70 } as Record<string, unknown> };
    const api = fakeApi(stored);
    setQuotaAutoBalanceEnabled(true);
    const quota: QuotaState = {
      status: 'success',
      rows: [
        { label: '5h', remainingPercent: 70 },
        { label: '7d', remainingPercent: 70 },
      ],
    };

    await syncCredentialQuotaRouting({ ...claudeFile }, quota, api);
    expect(api.patches).toEqual([]);
  });

  it('patches via commitFetchedQuota without mutating the file and notifies subscribers', async () => {
    const stored = { 'claude-test.json': { priority: 3 } as Record<string, unknown> };
    const api = fakeApi(stored);
    spies.push(spyOn(managementApi, 'get').mockImplementation(api.get as never));
    spies.push(spyOn(managementApi, 'patch').mockImplementation(api.patch as never));
    const changes: Array<[string, unknown]> = [];
    const unsubscribe = subscribeQuotaRoutingChanges((name, fields) => changes.push([name, fields]));
    setQuotaAutoBalanceEnabled(true);
    expect(getQuotaAutoBalanceEnabled()).toBe(true);

    const file = { ...claudeFile };
    commitFetchedQuota(captureQuotaCacheGeneration(), file, {
      status: 'success',
      rows: [
        { label: '5h', remainingPercent: 70 },
        { label: '7d', remainingPercent: 70 },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();

    expect(api.patches).toEqual([{ name: 'claude-test.json', priority: 0, weight: 70 }]);
    expect(file.priority).toBe(3);
    expect(changes).toEqual([['claude-test.json', { priority: 0, weight: 70 }]]);

    const files = [file, { name: 'other.json' }];
    const updated = applyQuotaRoutingChange(files, 'claude-test.json', { priority: 0, weight: 70 });
    expect(updated).not.toBe(files);
    expect(updated[0]).toEqual({ ...claudeFile, priority: 0, weight: 70 });
    expect(updated[1]).toBe(files[1]);
  });

  it('restores manual priority and weight captured before the first auto-balance change', async () => {
    const stored = { 'claude-test.json': { priority: -10, weight: '' } as Record<string, unknown> };
    const api = fakeApi(stored);
    const lowQuota: QuotaState = { status: 'success', rows: [{ label: '5h', remainingPercent: 10 }] };
    const healthyQuota: QuotaState = { status: 'success', rows: [{ label: '5h', remainingPercent: 90 }] };
    setQuotaAutoBalanceEnabled(true);

    await syncCredentialQuotaRouting({ ...claudeFile }, lowQuota, api);
    await syncCredentialQuotaRouting({ ...claudeFile }, healthyQuota, api);
    expect(stored['claude-test.json']).toEqual({ priority: 0, weight: 90 });

    setQuotaAutoBalanceEnabled(false);
    await restoreQuotaRoutingOriginals(api);
    expect(stored['claude-test.json']).toEqual({ priority: -10, weight: null });

    api.patches.length = 0;
    await restoreQuotaRoutingOriginals(api);
    expect(api.patches).toEqual([]);
  });

  it('does not re-apply auto values when a sync finishes after auto-balance is turned off', async () => {
    const stored = { 'claude-test.json': { priority: 7, weight: 3 } as Record<string, unknown> };
    const api = fakeApi(stored);
    const healthyQuota: QuotaState = { status: 'success', rows: [{ label: '5h', remainingPercent: 90 }] };
    setQuotaAutoBalanceEnabled(true);
    await syncCredentialQuotaRouting({ ...claudeFile }, healthyQuota, api);
    expect(stored['claude-test.json']).toEqual({ priority: 0, weight: 90 });

    let releaseDownload = () => {};
    api.beforeDownload = () => new Promise<void>((resolve) => { releaseDownload = resolve; });
    const lateSync = syncCredentialQuotaRouting({ ...claudeFile },
      { status: 'success', rows: [{ label: '5h', remainingPercent: 10 }] }, api);
    await new Promise((resolve) => setTimeout(resolve, 0));

    setQuotaAutoBalanceEnabled(false);
    api.beforeDownload = undefined;
    const restore = restoreQuotaRoutingOriginals(api);
    releaseDownload();
    await Promise.all([lateSync, restore]);

    expect(stored['claude-test.json']).toEqual({ priority: 7, weight: 3 });
  });

  it('keeps manual edits made while enabled and forgets deleted credentials on restore', async () => {
    const stored: Record<string, Record<string, unknown>> = {
      'claude-test.json': { priority: 3 },
      'gone.json': { priority: 4 },
    };
    const api = fakeApi(stored);
    const quota: QuotaState = { status: 'success', rows: [{ label: '5h', remainingPercent: 90 }] };
    setQuotaAutoBalanceEnabled(true);
    await syncCredentialQuotaRouting({ ...claudeFile }, quota, api);
    await syncCredentialQuotaRouting({ ...claudeFile, name: 'gone.json' }, quota, api);

    stored['claude-test.json'] = { priority: 50, weight: 200 };
    delete stored['gone.json'];
    setQuotaAutoBalanceEnabled(false);
    api.patches.length = 0;
    await restoreQuotaRoutingOriginals(api);

    expect(api.patches).toEqual([]);
    expect(stored['claude-test.json']).toEqual({ priority: 50, weight: 200 });
    expect(localStorage.getItem('easy-cli-proxy-api.quota-auto-balance.originals')).toBeNull();
  });

  it('balances credentials whose unrelated metadata would fail settings validation', async () => {
    const stored = { 'claude-test.json': { priority: 3, headers: { 'x-retry': 3 }, excluded_models: 42 } as Record<string, unknown> };
    const api = fakeApi(stored);
    setQuotaAutoBalanceEnabled(true);
    await syncCredentialQuotaRouting({ ...claudeFile },
      { status: 'success', rows: [{ label: '5h', remainingPercent: 90 }] }, api);
    expect(api.patches).toEqual([{ name: 'claude-test.json', priority: 0, weight: 90 }]);
  });

  it('follows the toggle when another tab changes it', () => {
    const target = new EventTarget();
    const unwatch = watchQuotaAutoBalanceStorage(target);
    setQuotaAutoBalanceEnabled(true);

    localStorage.setItem('easy-cli-proxy-api.quota-auto-balance', 'off');
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'easy-cli-proxy-api.quota-auto-balance' }));
    expect(getQuotaAutoBalanceEnabled()).toBe(false);

    localStorage.setItem('easy-cli-proxy-api.quota-auto-balance', 'on');
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'unrelated' }));
    expect(getQuotaAutoBalanceEnabled()).toBe(false);
    unwatch();
  });

  it('skips syncing once another tab has turned auto-balance off', async () => {
    const stored = { 'claude-test.json': { priority: 7 } as Record<string, unknown> };
    const api = fakeApi(stored);
    setQuotaAutoBalanceEnabled(true);
    localStorage.setItem('easy-cli-proxy-api.quota-auto-balance', 'off');

    await syncCredentialQuotaRouting({ ...claudeFile },
      { status: 'success', rows: [{ label: '5h', remainingPercent: 90 }] }, api);

    expect(api.patches).toEqual([]);
    expect(getQuotaAutoBalanceEnabled()).toBe(false);
  });
});
