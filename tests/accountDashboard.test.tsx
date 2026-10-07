import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountCard } from '../src/components/AccountDashboard';
import { I18nProvider } from '../src/i18n';
import { accountSummary, nextAccountReset, resetCountdown } from '../src/services/accountDashboard';
import type { QuotaState } from '../src/services/quotaService';
import { refreshDashboardQuotas } from '../src/services/accountDashboardRefresh';
import { getQuotaCacheSnapshot, pruneQuotaCache, updateQuotaCache } from '../src/services/quotaCache';

const now = Date.parse('2030-01-01T00:00:00Z');
const file = { name: 'test.json', provider: 'claude', status: 'active', priority: 3 };
const render = (quota: QuotaState, stale = false) => renderToStaticMarkup(
  <I18nProvider><AccountCard file={file} quota={quota} now={now} stale={stale} disabled={stale} onSave={async () => {}} /></I18nProvider>,
);

describe('account dashboard evidence', () => {
  it('stops obsolete quota batches after an account list prunes the shared cache', async () => {
    updateQuotaCache({});
    const files = [1, 2, 3].map((id) => ({ ...file, name: `${id}.json`, auth_index: String(id) }));
    const finish: Array<(value: QuotaState) => void> = [];
    const loading = refreshDashboardQuotas(files, true, {}, () => true,
      async () => new Promise<QuotaState>((resolve) => finish.push(resolve)));
    expect(finish.length).toBe(2);
    pruneQuotaCache(new Set());
    finish.forEach((resolve) => resolve({ status: 'success', rows: [] }));
    await loading;
    expect(finish.length).toBe(2);
    expect(getQuotaCacheSnapshot()).toEqual({});
  });
  it('finishes in-flight entries on unmount without starting a new batch', async () => {
    updateQuotaCache({});
    let mounted = true;
    const finish: Array<(value: QuotaState) => void> = [];
    const loading = refreshDashboardQuotas([1, 2, 3].map((id) => ({ ...file, name: `${id}.json` })), true, {}, () => mounted,
      async () => new Promise<QuotaState>((resolve) => finish.push(resolve)));
    mounted = false;
    finish.forEach((resolve) => resolve({ status: 'success', rows: [] }));
    await loading;
    expect(finish.length).toBe(2);
    expect(Object.values(getQuotaCacheSnapshot()).every((value) => value.status === 'success')).toBe(true);
    updateQuotaCache({});
  });
  it('does not invent a reset for missing, failed, or expired quota data', () => {
    expect(nextAccountReset(undefined, now)).toBeUndefined();
    expect(nextAccountReset({ status: 'error', rows: [{ label: 'Week', remainingPercent: 20, resetAtMs: now + 1000 }] }, now)).toBeUndefined();
    expect(nextAccountReset({ status: 'success', rows: [{ label: 'Week', remainingPercent: 0, resetAtMs: now - 1 }] }, now)).toBeUndefined();
    expect(resetCountdown(now - 1, now)).toContain('refresh');
  });
  it('selects the earliest future window without treating it as a weekly reset', () => {
    expect(nextAccountReset({ status: 'success', rows: [
      { label: 'Week', remainingPercent: 25, resetAtMs: now + 86400000 },
      { label: 'Session', remainingPercent: 40, resetAtMs: now + 3600000 },
    ] }, now)).toBe(now + 3600000);
    expect(resetCountdown(now + 90000000, now)).toBe('1d 1h');
  });
  it('does not claim disabled or unavailable accounts are ready', () => {
    expect(accountSummary(file).ready).toBe(true);
    expect(accountSummary({ ...file, disabled: true }).ready).toBe(false);
    expect(accountSummary({ ...file, unavailable: true }).ready).toBe(false);
    expect(accountSummary({ name: 'unknown.json' }).ready).toBe(false);
  });
  it('preserves zero quota after a reset passes, instead of displaying a full allowance', () => {
    const html = render({ status: 'success', rows: [{ label: 'Week', remainingPercent: 0, resetAtMs: now - 1 }] });
    expect(html).toContain('0% left');
    expect(html).toContain('refresh to confirm');
    expect(html).not.toContain('100% left');
  });
  it('distinguishes missing percentages and errors from zero remaining', () => {
    const html = render({ status: 'success', rows: [{ label: 'Week', remainingPercent: null }] });
    expect(html).toContain('Not reported');
    expect(html).not.toContain('<meter');
    expect(render({ status: 'error', rows: [] })).toContain('Quota unavailable');
  });
  it('labels stale status and disables priority edits while offline', () => {
    const html = render({ status: 'idle', rows: [] }, true);
    expect(html).toContain('Status stale');
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).not.toContain('>Active<');
  });
});
