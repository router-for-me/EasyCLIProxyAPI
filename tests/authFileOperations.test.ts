import { describe, expect, it } from 'bun:test';
import { normalizeCredentialResults, refreshCredential, runCredentialBatch } from '../src/services/authFileOperations';
import { authFileSettingsFromPayload, buildAuthFileSettingsPatch } from '../src/services/authFileSettings';
import { managementApi } from '../src/services/managementApi';
import { credentialQuotaPlugin, parsePluginCredentialQuota } from '../src/services/pluginCredentialQuota';

describe('credential operations', () => {
  it('keeps refresh results free of tokens and rejects malformed acknowledgements', () => {
    expect(normalizeCredentialResults({ ok: true, results: [{ id: 'one', success: true, auth: { access_token: 'secret' } }] })).toEqual([{ id: 'one', success: true }]);
    expect(() => normalizeCredentialResults({ results: [] })).toThrow();
    expect(() => normalizeCredentialResults({ ok: true, results: [{ id: '', success: true }] })).toThrow();
  });
  it('addresses the selected identity and does not return refreshed token metadata', async () => {
    const calls: unknown[][] = [];
    const api = { post: (async (...args: unknown[]) => { calls.push(args); return { ok: true, auth: { access_token: 'secret' } }; }) as typeof managementApi.post };
    expect(await refreshCredential({ name: 'same.json', auth_index: '2' }, api)).toBeUndefined();
    expect(calls).toEqual([['/credentials/refresh', { name: 'same.json', auth_index: '2' }, { timeoutMs: 300000 }]]);
    await expect(refreshCredential({ name: 'same.json', disabled: true }, api)).rejects.toThrow();
    await expect(refreshCredential({ name: 'same.json', runtime_only: true }, api)).rejects.toThrow();
    expect(calls.length).toBe(1);
  });
  it('continues after individual batch failures', async () => {
    const result = await runCredentialBatch([{ name: 'a.json' }, { name: 'b.json' }], async file => { if (file.name === 'a.json') throw new Error('failed'); });
    expect(result).toEqual([{ id: 'a.json', success: false, error: 'failed' }, { id: 'b.json', success: true }]);
  });
});

describe('credential policies', () => {
  it('preserves untouched rules and unknown fields while updating a retry override', () => {
    const original = authFileSettingsFromPayload({ 'request-retry': '2', request_scoped_errors: [{ status: 429, action: 'future-action', extension: true }], access_token: 'secret' });
    expect(buildAuthFileSettingsPatch(original, { ...original, advanced: { ...original.advanced, request_retry: 0 } })).toEqual({ request_retry: 0 });
    expect(buildAuthFileSettingsPatch(original, { ...original, advanced: { ...original.advanced, request_retry: undefined } })).toEqual({ request_retry: null });
  });
  it('supports inheritance, xAI mode and validates retry and error rules', () => {
    const original = authFileSettingsFromPayload({ request_retry: -1 });
    expect(buildAuthFileSettingsPatch(original, original)).toEqual({});
    expect(buildAuthFileSettingsPatch(original, { ...original, advanced: { using_api: true, request_scoped_errors: [] } })).toEqual({ using_api: true, request_scoped_errors: [] });
    expect(() => buildAuthFileSettingsPatch(original, { ...original, advanced: { request_retry: 1.5 } })).toThrow();
    expect(() => buildAuthFileSettingsPatch(original, { ...original, advanced: { request_scoped_errors: [{ status: 999, action: 'stop' }] } })).toThrow();
  });
});

describe('plugin credential quotas', () => {
  it('preserves exhausted buckets, unknown amounts, summaries and clock offsets', () => {
    const quota = parsePluginCredentialQuota({ subscription: { plan: 'Example' }, server_time_offset_ms: 500,
      groups: [{ display_name: 'Requests', buckets: [{ window: 'Daily', remaining_fraction: 0, reset_time: '2026-10-22T00:00:00Z' }, { window: 'Other' }] }],
      summary: [{ key: 'credits', label: 'Credits', value: 12, unit: 'credits' }] });
    expect(quota.plan).toBe('Example');
    expect(quota.serverTimeOffsetMs).toBe(500);
    expect(quota.rows.map(row => row.remainingPercent)).toEqual([0, null, null]);
    expect(quota.rows[0].resetAtMs).toBe(Date.parse('2026-10-22T00:00:00Z'));
    expect(quota.rows[2].detail).toBe('12 credits');
    expect(credentialQuotaPlugin({ supports_quota: false, quota_plugin_id: 'example' })).toBe('');
    expect(credentialQuotaPlugin({ supports_quota: true, quota_plugin_id: 'example' })).toBe('example');
    expect(() => parsePluginCredentialQuota({ groups: {} })).toThrow();
  });
});
