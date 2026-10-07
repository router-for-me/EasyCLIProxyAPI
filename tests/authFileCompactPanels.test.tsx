import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { AuthFileQuotaPanel } from '../src/components/AuthFileQuotaPanel';
import { AuthFileRequestStatus } from '../src/components/AuthFileRequestStatus';
import type { QuotaState } from '../src/services/quotaService';

const renderQuota = (quota: QuotaState, compact = true) => renderToStaticMarkup(
  <I18nProvider><AuthFileQuotaPanel file={{ name: 'test.json', provider: 'codex' }} quota={quota}
    disabled={false} onRefresh={() => {}} onReset={() => {}} compact={compact} /></I18nProvider>,
);

const renderRequests = (file: Record<string, unknown>, compact = true) => renderToStaticMarkup(
  <I18nProvider><AuthFileRequestStatus file={file} compact={compact} /></I18nProvider>,
);

describe('compact credential panels', () => {
  it('keeps extra quota rows accessible through native details and preserves reset information', () => {
    const quota: QuotaState = {
      status: 'success', plan: 'Plan only shown in the plan column', resetCredits: 2, resetCreditsApplicable: 0,
      rows: [
        { label: 'Five hour', remainingPercent: 24 },
        { label: 'Weekly', remainingPercent: 68 },
        { label: 'Extra model', remainingPercent: 0, detail: 'Additional quota detail' },
      ],
    };
    const compact = renderQuota(quota);
    const beforeDetails = compact.split('<details')[0];
    expect(beforeDetails).toContain('Five hour');
    expect(beforeDetails).toContain('Weekly');
    expect(beforeDetails).not.toContain('Extra model');
    expect(compact).toMatch(/<details[^>]*><summary>Details \(\+1\)<\/summary>.*Extra model.*Additional quota detail.*<\/details>/);
    expect(compact).toContain('title="Reset Quota"');
    expect(compact).not.toContain('2 manual resets');
    expect(compact).not.toContain('Currently applicable: 0');
    expect(compact).not.toContain('credential-quota-refresh');
    expect(compact).not.toContain(quota.plan!);

    const full = renderQuota(quota, false);
    expect(full).not.toContain('<details');
    expect(full).toContain(quota.plan!);
    expect(full).toContain('credential-quota-refresh');
  });

  it('preserves quota loading and error feedback in compact mode', () => {
    expect(renderQuota({ status: 'loading', rows: [], pendingAction: 'reset' })).toContain('aria-busy="true"');
    expect(renderQuota({ status: 'error', rows: [], error: 'Quota server unavailable' })).toContain('Quota server unavailable');
  });

  it('uses the latest nonempty request bucket time while retaining all twenty interactive buckets', () => {
    const file = {
      success: 91, failed: 9, modified: 'Unrelated modification time',
      recent_requests: [
        { time: '09:00–09:10', success: 4, failed: 0 },
        { time: '09:10–09:20', success: 0, failed: 1 },
        { time: '09:20–09:30', success: 0, failed: 0 },
      ],
    };
    const compact = renderRequests(file);
    expect(compact).toMatch(/auth-file-requests-latest[^>]*>09:10–09:20<\/div>/);
    expect(compact.match(/class="auth-file-request-block"/g)).toHaveLength(20);
    expect(compact).toContain('aria-label="09:10–09:20');
    expect(compact).not.toContain('Unrelated modification time');
    expect(compact).not.toContain('auth-file-requests-rate');
    expect(compact).not.toContain('auth-file-requests-counts');
    expect(renderRequests(file, false)).toContain('auth-file-requests-counts');
  });

  it('does not invent a recent request time for empty, unavailable or untimed statistics', () => {
    const empty = renderRequests({ recent_requests: [{ time: '10:00–10:10', success: 0, failed: 0 }] });
    const unavailable = renderRequests({});
    const untimed = renderRequests({ recent_requests: [{ success: 1, failed: 0 }] });
    for (const html of [empty, unavailable, untimed]) {
      expect(html).toMatch(/auth-file-requests-latest[^>]*>—<\/div>/);
    }
    expect(empty).toContain('No requests');
    expect(unavailable).toContain('The core did not provide recent request statistics');
  });
});
