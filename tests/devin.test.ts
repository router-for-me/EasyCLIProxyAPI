import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { validateDevinCallback } from '../src/services/devinOAuth';
import { readDevinQuota } from '../src/services/devinQuota';
import { loadQuota, providerForFile, quotaRowsFor } from '../src/services/quotaService';
import { changedOAuthAuthFileNames, snapshotAuthFiles } from '../src/services/authFiles';
import { managementApi } from '../src/services/managementApi';
import { loadOAuthModelSettings, saveOAuthModelSettings } from '../src/services/oauthModelSettings';

const liveStatus = (fields: Record<string, unknown>) => ({ userStatus: { planStatus: fields } });
const file = { name: 'devin-test.json', provider: 'devin', auth_index: 'devin-index' };
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => { mocks.splice(0).forEach((mock) => mock.mockRestore()); });

describe('Devin OAuth', () => {
  it('accepts the complete redirect and denial callback from the current attempt', () => {
    expect(validateDevinCallback(' http://127.0.0.1:8317/callback?state=current&code=abc ', 'current')).toBeUndefined();
    expect(validateDevinCallback('https://remote.example/callback?state=current&error=access_denied', 'current')).toBeUndefined();
  });
  it('rejects missing, duplicated or stale state and never manufactures a callback', () => {
    for (const input of ['abc', 'code=abc', 'file:///callback?state=current&code=a', 'http://localhost/callback?code=abc', 'http://localhost/callback?state=current', 'http://localhost/callback?state=current&state=current&code=a']) {
      expect(validateDevinCallback(input, 'current')).toBe('invalid');
    }
    expect(validateDevinCallback('http://localhost/callback?state=old&code=a', 'current')).toBe('state_mismatch');
    expect(validateDevinCallback('http://localhost/callback?state=current&code=a')).toBe('state_mismatch');
  });
  it('recognizes Devin and Cognition files when applying defaults to newly created credentials', () => {
    expect(providerForFile(file)).toBe('devin');
    expect(providerForFile({ type: 'cognition' })).toBe('devin');
    const old = { ...file, priority: 5 };
    expect(changedOAuthAuthFileNames(snapshotAuthFiles([old]), [old, { name: 'new.json', type: 'cognition' }], 'devin')).toEqual(['new.json']);
  });
});

describe('Devin live quota', () => {
  it('preserves zero and fractional remaining percentages and Unix reset times', () => {
    const result = readDevinQuota(JSON.stringify(liveStatus({
      dailyQuotaRemainingPercent: 0, weeklyQuotaRemainingPercent: '81.25',
      dailyQuotaResetAtUnix: '1893456000', weeklyQuotaResetAtUnix: 1893542400,
      planInfo: { planName: ' Pro ' }, planEnd: '2030-02-01T00:00:00Z',
    })));
    expect(result).toMatchObject({ plan: 'Pro', subscriptionActiveUntil: '2030-02-01T00:00:00Z', windows: [
      { id: 'daily', remainingPercent: 0, resetAtMs: 1893456000000 },
      { id: 'weekly', remainingPercent: 81.25, resetAtMs: 1893542400000 },
    ] });
    expect(quotaRowsFor('devin', liveStatus({ dailyQuotaRemainingPercent: 0 }))).toEqual([
      { label: '每日额度', remainingPercent: 0, resetAtMs: undefined },
      { label: '每周额度', remainingPercent: null, resetAtMs: undefined },
    ]);
  });
  it('does not turn malformed, missing or cached metadata into live quota', () => {
    for (const value of [-1, 101, Infinity, true, '', ' ', '0x10', {}, null]) {
      expect(readDevinQuota(liveStatus({ dailyQuotaRemainingPercent: value })).windows).toEqual([]);
    }
    expect(readDevinQuota({ quota: { signals: { daily_quota_remaining_percent: 100 } } }).windows).toEqual([]);
    expect(readDevinQuota('invalid JSON').windows).toEqual([]);
    expect(readDevinQuota(liveStatus({ dailyQuotaResetAtUnix: '1.5', weeklyQuotaResetAtUnix: '9999999999999999999' })).windows).toEqual([]);
    expect(readDevinQuota(liveStatus({ weeklyQuotaResetAtUnix: 1893456000 })).windows[0].remainingPercent).toBeNull();
  });
  it('uses the selected auth index with a body placeholder and shares concurrent refreshes', async () => {
    const post = spyOn(managementApi, 'post').mockResolvedValue({ status_code: 200, body: liveStatus({ dailyQuotaRemainingPercent: 75, weeklyQuotaRemainingPercent: 50, planInfo: { planName: 'Pro' } }) } as never);
    const get = spyOn(managementApi, 'get').mockRejectedValue(new Error('Must not download credentials'));
    mocks.push(post, get);
    const first = loadQuota(file);
    const second = loadQuota(file);
    expect(first).toBe(second);
    expect(await first).toMatchObject({ status: 'success', plan: 'Pro', rows: [{ remainingPercent: 75 }, { remainingPercent: 50 }] });
    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0];
    expect(path).toBe('/api-call');
    expect(body).toMatchObject({ authIndex: 'devin-index', method: 'POST', url: 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus', header: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' } });
    expect(JSON.parse((body as { data: string }).data)).toEqual({ metadata: { ideName: 'chisel', ideVersion: '3000.10.21', apiKey: '$TOKEN$', locale: 'en', os: 'darwin', extensionVersion: '3000.10.21', clientName: 'chisel' } });
    await loadQuota(file);
    expect(post).toHaveBeenCalledTimes(2);
  });
  it('refuses disabled credentials and incomplete identities without upstream requests', async () => {
    const post = spyOn(managementApi, 'post');
    mocks.push(post);
    for (const entry of [{ ...file, disabled: true }, { ...file, auth_index: undefined }, { ...file, name: '' }]) {
      expect(await loadQuota(entry)).toMatchObject({ status: 'error', rows: [] });
    }
    expect(post).not.toHaveBeenCalled();
  });
  it('reports upstream errors and empty successful responses', async () => {
    const post = spyOn(managementApi, 'post').mockResolvedValue({ status_code: 401, body: { error: 'expired' } } as never);
    mocks.push(post);
    expect(await loadQuota(file)).toMatchObject({ status: 'error', rows: [], error: 'expired' });
    post.mockResolvedValue({ status_code: 200, body: liveStatus({ planInfo: { planName: 'Pro' } }) } as never);
    expect(await loadQuota(file)).toMatchObject({ status: 'error', rows: [] });
  });
});

it('loads and saves Devin model exclusions under its own provider channel', async () => {
  const calls: unknown[] = [];
  const api = {
    get: async (path: string) => {
      calls.push(path);
      return path === '/model-definitions/devin'
        ? { models: [{ id: 'devin/swe-2', display_name: 'SWE-2' }] }
        : { 'oauth-excluded-models': { devin: ['devin/old'] } };
    },
    patch: async (path: string, body: Record<string, unknown>) => { calls.push([path, body]); },
    delete: async () => {},
  };
  const settings = await loadOAuthModelSettings({ scope: 'provider', provider: 'devin', label: 'Devin' }, api);
  expect(settings.models.map((model) => model.id)).toEqual(['devin/old', 'devin/swe-2']);
  await saveOAuthModelSettings(settings, ['devin/swe-2'], api);
  expect(calls).toContainEqual(['/oauth-excluded-models', { provider: 'devin', models: ['devin/swe-2'] }]);
});
