import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { managementApi } from '../src/services/managementApi';
import { parseMetaQuotaPayload } from '../src/services/metaQuota';
import { loadQuota, providerForFile, quotaRowsFor } from '../src/services/quotaService';
import { pruneQuotaCache, updateQuotaCache } from '../src/services/quotaCache';

const file = { name: 'muse.json', provider: 'meta', auth_index: '1' };
const payload = {
  api_key: 'private-llm-key',
  email: 'private@example.test',
  subs_tier_name: ' Pro ',
  subs_usage: {
    tier: 'Basic',
    window: { used_percent: '25', resets_at: '1800000000', window_duration_mins: 300 },
    weekly: { used_percent: 60, resets_at: 1800600000, window_duration_mins: 5 },
  },
};
let get: ReturnType<typeof spyOn> | undefined;
let post: ReturnType<typeof spyOn> | undefined;
afterEach(() => { get?.mockRestore(); post?.mockRestore(); updateQuotaCache({}); });

describe('Muse quota', () => {
  it('recognizes Meta and Muse provider aliases', () => {
    for (const provider of ['meta', 'muse', 'META', 'Muse']) {
      expect(providerForFile({ provider })).toBe('meta');
      expect(providerForFile({ type: provider })).toBe('meta');
    }
  });

  it('extracts only quota fields and prefers the explicit plan', () => {
    expect(parseMetaQuotaPayload(JSON.stringify(payload))).toEqual({
      plan: 'Pro',
      windows: [
        { id: 'window', usedPercent: 25, resetAt: 1800000000, durationMinutes: 300 },
        { id: 'weekly', usedPercent: 60, resetAt: 1800600000, durationMinutes: undefined },
      ],
    });
    expect(parseMetaQuotaPayload({ ...payload, subs_tier_name: ' ' })?.plan).toBe('Basic');
    expect(parseMetaQuotaPayload({ subs_tier_name: 123, subs_usage: { tier: false } })?.plan).toBeUndefined();
    for (const invalid of ['not-json', '[]', null, [], 1]) expect(parseMetaQuotaPayload(invalid)).toBeNull();
  });

  it('keeps absent quota unknown, clamps usage, and ignores invalid numeric fields', () => {
    expect(quotaRowsFor('meta', {})).toEqual([
      { label: 'Usage limit', remainingPercent: null, resetAtMs: undefined },
      { label: 'Weekly limit', remainingPercent: null, resetAtMs: undefined },
    ]);
    expect(quotaRowsFor('meta', payload)).toEqual([
      { label: '5-hour limit', remainingPercent: 75, resetAtMs: 1800000000000 },
      { label: 'Weekly limit', remainingPercent: 40, resetAtMs: 1800600000000 },
    ]);
    for (const [used, expected] of [[-5, 100], [150, 0], ['', null], [true, null], [Infinity, null], [{ val: 1 }, null]] as const) {
      const rows = quotaRowsFor('meta', { subs_usage: { window: { used_percent: used, resets_at: -1, window_duration_mins: 90 } } });
      expect(rows[0]).toEqual({ label: '90-minute limit', remainingPercent: expected, resetAtMs: undefined });
    }
  });

  it('downloads the credential and sends only its DCA token to the Muse endpoint', async () => {
    get = spyOn(managementApi, 'get').mockResolvedValue(JSON.stringify({ dca_token: ' dca:private-token ', api_key: 'wrong-key' }));
    post = spyOn(managementApi, 'post').mockResolvedValue({ status_code: 200, body: JSON.stringify(payload) });
    const result = await loadQuota(file);
    expect(result).toMatchObject({ status: 'success', plan: 'Pro', rows: [{ remainingPercent: 75 }, { remainingPercent: 40 }] });
    expect(result.fetchedAt).toBeGreaterThan(0);
    expect(get.mock.calls).toEqual([['/credentials/download', { name: file.name }]]);
    expect(post.mock.calls).toEqual([['/requests/api-call', {
      authIndex: '1', method: 'POST', url: 'https://api.meta.ai/muse-code/key', data: '{}',
      header: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-version': '1.0.0', Authorization: 'Bearer dca:private-token' },
    }]]);
    for (const secret of ['private-token', 'wrong-key', payload.api_key, payload.email]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('never falls back to API or LLM keys for missing or malformed DCA tokens', async () => {
    get = spyOn(managementApi, 'get');
    post = spyOn(managementApi, 'post');
    for (const dca_token of [undefined, '', 'raw-key', 'dca:', 'dca:two tokens', 123]) {
      get.mockResolvedValue({ dca_token, api_key: 'private-key', access_token: 'private-key' });
      expect(await loadQuota(file)).toMatchObject({ status: 'error', rows: [] });
    }
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects unavailable, malformed, runtime-only, disabled, or unidentified credentials', async () => {
    get = spyOn(managementApi, 'get').mockRejectedValue(new Error('private-key'));
    post = spyOn(managementApi, 'post');
    expect((await loadQuota(file)).error).not.toContain('private-key');
    for (const invalid of ['private-key', '[]', null]) {
      get.mockResolvedValue(invalid);
      expect((await loadQuota(file)).status).toBe('error');
    }
    get.mockClear();
    for (const metadata of [{ runtime_only: true }, { runtimeOnly: 'true' }, { disabled: true }, { name: '' }, { auth_index: '' }]) {
      expect((await loadQuota({ ...file, ...metadata })).status).toBe('error');
    }
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('never exposes response bodies or transport errors in quota errors', async () => {
    get = spyOn(managementApi, 'get').mockResolvedValue({ dca_token: 'dca:private-token' });
    post = spyOn(managementApi, 'post');
    for (const status of [401, 429, 500]) {
      post.mockResolvedValue({ status_code: status, body: payload });
      const result = await loadQuota(file);
      expect(result).toMatchObject({ status: 'error', rows: [] });
      expect(result.error).toContain(String(status));
      expect(JSON.stringify(result)).not.toContain('private');
    }
    post.mockRejectedValue(new Error('private-token private-llm-key'));
    expect((await loadQuota(file)).error).toBe('Muse quota request failed');
    post.mockResolvedValue({ statusCode: 200, bodyText: 'private-invalid-response' });
    expect((await loadQuota(file)).error).toBe('Invalid Muse quota response');
    post.mockResolvedValue({ statusCode: 200, bodyText: '{}' });
    expect(await loadQuota(file)).toMatchObject({ status: 'success', rows: [{ remainingPercent: null }, { remainingPercent: null }] });
  });

  it('rejects stale requests after credential download and quota lookup', async () => {
    updateQuotaCache({ removed: { status: 'idle', rows: [] } });
    get = spyOn(managementApi, 'get').mockImplementation(async () => {
      pruneQuotaCache(new Set());
      return { dca_token: 'dca:private-token' };
    });
    post = spyOn(managementApi, 'post');
    expect((await loadQuota(file)).status).toBe('error');
    expect(post).not.toHaveBeenCalled();
    updateQuotaCache({ removed: { status: 'idle', rows: [] } });
    get.mockResolvedValue({ dca_token: 'dca:private-token' });
    post.mockImplementation(async () => {
      pruneQuotaCache(new Set());
      return { status_code: 200, body: payload };
    });
    expect((await loadQuota(file)).status).toBe('error');
  });
});
