import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { AuthFileHealthStatus } from '../src/components/AuthFileHealthStatus';
import { dedupeAuthFiles } from '../src/services/authFiles';
import {
  authFileHealth,
  cooldownReasonKey,
  normalizeAuthFileCooldowns,
  summarizeAuthFileCooldowns,
} from '../src/services/authFileHealth';

const receivedAtMs = Date.now();
const record = {
  scope: 'model', model_key: 'model-a', reason: 'quota',
  retry_at: '2026-01-01T10:00:32Z', remaining_seconds: 32, http_status: 429, backoff_level: 0,
};
const normalize = (value: unknown) => normalizeAuthFileCooldowns(value, receivedAtMs, '2026-01-01T10:00:00Z');
const render = (file: Record<string, unknown>, received = receivedAtMs) => renderToStaticMarkup(
  createElement(I18nProvider, { children: createElement(AuthFileHealthStatus, { file, receivedAtMs: received }) }),
);

describe('credential health and cooldowns', () => {
  it('distinguishes old cores, unknown snapshots and known-empty restrictions', () => {
    expect(normalize(undefined)).toBeUndefined();
    expect(normalize(null)?.records).toBeNull();
    expect(normalize([])?.records).toEqual([]);
    const snapshot = normalize([record])!;
    expect(snapshot.records?.[0]).toMatchObject({
      model: 'model-a', reason: 'quota', httpStatus: 429, backoffLevel: 0,
      retryAt: '2026-01-01T10:00:32.000Z', remainingSeconds: 32,
    });
    expect(snapshot.observedAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it('keeps malformed restrictions unknown instead of silently clearing them', () => {
    for (const value of [null, {}, 'bad', [null], [{ ...record, scope: 'future' }],
      [{ ...record, model_key: '' }], [{ ...record, model_key: {} }],
      [{ ...record, retry_at: 'bad-date' }], [{ ...record, remaining_seconds: 0 }],
      [{ ...record, remaining_seconds: -1 }], [{ ...record, remaining_seconds: 1.5 }],
      [{ ...record, remaining_seconds: Infinity }], [record, { scope: 'future' }]]) {
      expect(normalize(value)?.records).toBeNull();
    }
    const diagnostics = normalize([{ ...record, http_status: 200, backoff_level: -1 }])?.records?.[0];
    expect(diagnostics?.httpStatus).toBeUndefined();
    expect(diagnostics?.backoffLevel).toBeUndefined();
  });

  it('preserves authoritative empty/unknown snapshots when deduplicating files', () => {
    for (const cooldowns of [[], null]) {
      const [file] = dedupeAuthFiles([
        { name: 'a.json', source: 'file', path: '/synthetic/a.json', cooldowns },
        { name: 'a.json', source: 'memory', cooldowns: [record] },
      ]);
      expect(file.cooldowns).toEqual(cooldowns);
    }
  });

  it('uses server-relative time despite clock skew and keeps elapsed restrictions pending confirmation', () => {
    const snapshot = normalize([record])!;
    expect(summarizeAuthFileCooldowns(snapshot, receivedAtMs - 5000).earliestSeconds).toBe(32);
    expect(summarizeAuthFileCooldowns(snapshot, receivedAtMs + 1001).earliestSeconds).toBe(31);
    const elapsed = summarizeAuthFileCooldowns(snapshot, receivedAtMs + 33_000);
    expect(elapsed.earliestSeconds).toBe(0);
    expect(elapsed.elapsed).toBe(true);
    expect(elapsed.rows).toHaveLength(1);
    expect(elapsed.active).toHaveLength(0);
    expect(authFileHealth({ status: 'error', unavailable: true, cooldowns: [] }).tone).toBe('error');
  });

  it('separates credential-wide cooldowns from model restrictions as timers expire', () => {
    const snapshot = normalize([
      record,
      { ...record, scope: 'credential', reason: 'credential_quota', remaining_seconds: 10 },
    ]);
    expect(summarizeAuthFileCooldowns(snapshot, receivedAtMs)).toMatchObject({
      modelCount: 1, credentialWide: true, earliestSeconds: 10,
    });
    expect(summarizeAuthFileCooldowns(snapshot, receivedAtMs + 11_000)).toMatchObject({
      modelCount: 1, credentialWide: false, earliestSeconds: 21,
    });
  });

  it('uses appropriate status tones and only exact known diagnostic markers', () => {
    expect(authFileHealth({ status: 'active', status_message: 'OK' })).toMatchObject({ tone: 'success', message: '' });
    expect(authFileHealth({ status: 'error', unavailable: false }).tone).toBe('error');
    expect(authFileHealth({ status: 'refreshing' }).label).toBe('authFiles.health.refreshing');
    expect(authFileHealth({ status: 'pending' }).label).toBe('authFiles.health.pending');
    expect(authFileHealth({ status: 'disabled', unavailable: true }).tone).toBe('neutral');
    expect(authFileHealth({}).label).toBe('authFiles.health.unknown');
    expect(authFileHealth({ status: 'active', status_message: 'Unexpected upstream response' }).tone).toBe('warning');
    expect(authFileHealth({ status: 'error', status_message: 'token expired' }).label)
      .toBe('authFiles.health.reason.tokenExpired');
    expect(authFileHealth({ status: 'error', status_message: 'HTTP 403: policy restriction' }).label)
      .toBe('authFiles.health.error');
    for (const reason of ['future', '__proto__', 'constructor']) {
      expect(cooldownReasonKey(reason)).toBe('authFiles.health.reason.unknown');
    }
    expect(cooldownReasonKey('payment_required')).toBe('authFiles.health.reason.accessDenied');
  });

  it('renders expandable diagnostics with escaped error text and no fabricated HTTP status', () => {
    const html = render({ status: 'error', status_message: '<script>unsafe</script>', cooldowns: [record] });
    expect(html).toContain('<details>');
    expect(html).toContain('<summary');
    expect(html).toContain('model-a');
    expect(html).toContain('HTTP 429');
    expect(html).toContain('dateTime="2026-01-01T10:00:32.000Z"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(render({ status: 'active', cooldowns: [{ ...record, http_status: undefined }] })).not.toContain('HTTP 429');
  });

  it('does not render elapsed timers as healthy, or hide disabled state behind a cooldown', () => {
    expect(render({ status: 'active', cooldowns: [record] }, receivedAtMs - 60_000)).toContain('冷却计时已到期');
    expect(render({ disabled: true, status: 'error', cooldowns: [record] })).toContain('已停用');
    expect(render({ status: 'error', unavailable: true })).toContain('无法确定恢复时间');
    expect(render({ status: 'active', cooldowns: null })).toContain('冷却状态未知');
    const expiredToken = render({ status: 'error', status_message: 'token expired', cooldowns: [record] }, receivedAtMs - 60_000);
    expect(expiredToken.slice(0, expiredToken.indexOf('</summary>'))).toContain('访问令牌已过期');
  });
});
