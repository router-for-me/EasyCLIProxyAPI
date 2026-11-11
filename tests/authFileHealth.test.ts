import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { AuthFileHealthStatus } from '../src/components/AuthFileHealthStatus';
import { dedupeAuthFiles } from '../src/services/authFiles';
import {
  authFileAppeal,
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

describe('upstream TOS suspension', () => {
  it('labels a TOS-deactivated credential separately from a plain disable', () => {
    const suspended = authFileHealth({ status: 'disabled', status_message: 'tos_violation', tos_appeal_url: 'https://example.com/appeal', tos_appeal_url_text: 'Appeal now' });
    expect(suspended).toMatchObject({ disabled: true, suspension: 'tos', label: 'authFiles.health.reason.tosViolation', tone: 'warning', message: '' });
    const plain = authFileHealth({ status: 'disabled' });
    expect(plain).toMatchObject({ disabled: true, label: 'authFiles.status.disabled', tone: 'neutral' });
    expect(plain.suspension).toBeUndefined();
    expect(authFileHealth({ disabled: true, status_message: 'ok' }).label).toBe('authFiles.status.disabled');
  });

  it('publishes only HTTPS appeal links', () => {
    expect(authFileAppeal({ tos_appeal_url: 'https://example.com/appeal', tos_appeal_url_text: 'Appeal now' }))
      .toEqual({ url: 'https://example.com/appeal', text: 'Appeal now' });
    expect(authFileAppeal({ tos_appeal_url: 'https://example.com/appeal' })).toEqual({ url: 'https://example.com/appeal' });
    for (const value of ['javascript:alert(1)', 'http://example.com/appeal', 'example.com/appeal', '', 42]) {
      expect(authFileAppeal({ tos_appeal_url: value })).toBeUndefined();
    }
  });

  it('reports a link-only record as historical instead of a current suspension', () => {
    // Re-enabling a credential keeps the appeal metadata on disk, so a link with no
    // live status marker cannot distinguish "reloaded suspension" from "manually
    // disabled afterwards". It is reported as a past suspension, in a neutral tone.
    const linkOnly = authFileHealth({ status: 'disabled', disabled: true, tos_appeal_url: 'https://example.com/appeal' });
    expect(linkOnly).toMatchObject({
      disabled: true, label: 'authFiles.health.reason.tosViolationHistorical',
      tone: 'neutral', suspension: 'tos', suspensionHistorical: true,
    });
    // A status reason still wins over the leftover link.
    const quota = authFileHealth({ status: 'disabled', disabled: true, status_message: 'quota exhausted', tos_appeal_url: 'https://example.com/appeal' });
    expect(quota.label).toBe('authFiles.status.disabled');
    expect(quota.suspension).toBeUndefined();
    // An active credential with a leftover link stays healthy.
    expect(authFileHealth({ status: 'active', tos_appeal_url: 'https://example.com/appeal' }).label).toBe('authFiles.health.active');
  });

  it('keeps a restart-reloaded suspension visible after the marker is gone', () => {
    // The core keeps the marker in memory, so a reloaded credential carries the
    // appeal link but no status message. It must not degrade to a plain disable,
    // and it must not claim the live state the running core cannot report.
    const reloaded = authFileHealth({ status: 'disabled', tos_appeal_url: 'https://example.com/appeal' });
    expect(reloaded).toMatchObject({
      disabled: true, suspension: 'tos', suspensionHistorical: true,
      label: 'authFiles.health.reason.tosViolationHistorical', tone: 'neutral', message: '',
    });
    expect(render({ status: 'disabled', tos_appeal_url: 'https://example.com/appeal' }))
      .toContain('Previously suspended for a terms-of-service violation');
  });

  it('renders the TOS reason with an appeal link and leaves other disables neutral', () => {
    const suspended = render({ status: 'disabled', status_message: 'tos_violation', tos_appeal_url: 'https://example.com/appeal', tos_appeal_url_text: 'Appeal now' });
    expect(suspended).toContain('Suspended by upstream terms-of-service violation');
    expect(suspended).toContain('Appeal now');
    const plain = render({ status: 'disabled' });
    expect(plain).toContain('Disabled');
    expect(plain).not.toContain('<details');
    expect(plain).not.toContain('Appeal');
    expect(suspended).toContain('Appeal now');
    expect(suspended).not.toContain('tos_violation');
    const unsafe = render({ status: 'disabled', status_message: 'tos_violation', tos_appeal_url: 'javascript:alert(1)' });
    expect(unsafe).toContain('Suspended by upstream terms-of-service violation');
    expect(unsafe).not.toContain('javascript:');
    expect(unsafe).not.toContain('Open appeal page');
    expect(render({ status: 'disabled', status_message: 'tos_violation', tos_appeal_url: 'https://example.com/appeal' }))
      .toContain('Open appeal page');
  });
});

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
    expect(render({ status: 'active', cooldowns: [record] }, receivedAtMs - 60_000)).toContain('Cooldown timer elapsed');
    expect(render({ disabled: true, status: 'error', cooldowns: [record] })).toContain('Disabled');
    expect(render({ status: 'error', unavailable: true })).toContain('recovery time is unknown');
    expect(render({ status: 'active', cooldowns: null })).toContain('Cooldown state is unknown');
    const expiredToken = render({ status: 'error', status_message: 'token expired', cooldowns: [record] }, receivedAtMs - 60_000);
    expect(expiredToken.slice(0, expiredToken.indexOf('</summary>'))).toContain('Access token expired');
  });
});
