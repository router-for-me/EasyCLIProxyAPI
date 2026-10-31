import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { QuotaCard } from '../src/pages/QuotaPage';
import { AuthFileQuotaPanel } from '../src/components/AuthFileQuotaPanel';
import { quotaRowsFor } from '../src/services/quotaService';

const payload = {
  limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 100, used: 5 } }],
  usage: { limit: 100, used: 40 },
  usages: {
    limit_month_total: { used_ratio: 0.2529, reset_time: '2099-10-22T00:00:00Z' },
    limit_month_code: { used_ratio: '0.6', reset_time: '2099-10-23T00:00:00Z' },
  },
};

describe('Kimi monthly quotas', () => {
  it('appends both monthly quotas, preserving precision and independent resets', () => {
    const rows = quotaRowsFor('kimi', payload);
    expect(rows.map(row => row.label)).toEqual([
      '5 hours window', 'Weekly quota', 'Monthly total quota', 'Monthly coding quota',
    ]);
    expect(rows[2].remainingPercent).toBeCloseTo(74.71);
    expect(rows[3].remainingPercent).toBe(40);
    expect(rows[2].resetAtMs).toBe(Date.parse(payload.usages.limit_month_total.reset_time));
    expect(rows[3].resetAtMs).toBe(Date.parse(payload.usages.limit_month_code.reset_time));
    expect(rows[2].reset).toBeTruthy();
    expect(rows[2].detail).toBeUndefined();
  });

  it('supports monthly-only plans and either monthly quota independently', () => {
    for (const key of ['limit_month_total', 'limit_month_code']) {
      const rows = quotaRowsFor('kimi', { usages: { [key]: { used_ratio: 0 } } });
      expect(rows).toHaveLength(1);
      expect(rows[0].remainingPercent).toBe(100);
      expect(rows[0].resetAtMs).toBeUndefined();
    }
    expect(quotaRowsFor('kimi', { ...payload, usages: {} })).toHaveLength(2);
  });

  it('ignores invalid ratios without fabricating unused quotas', () => {
    for (const used_ratio of [undefined, null, '', ' ', 'invalid', NaN, Infinity, true]) {
      expect(quotaRowsFor('kimi', { usages: { limit_month_total: { used_ratio } } })).toEqual([]);
    }
    for (const [used_ratio, remaining] of [[1, 0], [1.2, 0], [-0.2, 100]]) {
      const rows = quotaRowsFor('kimi', { usages: { limit_month_code: { used_ratio, reset_time: 'invalid' } } });
      expect(rows[0].remainingPercent).toBe(remaining);
      expect(rows[0].resetAtMs).toBeUndefined();
    }
  });

  it('renders monthly quotas and resets in cards and expandable credential panels', () => {
    const quota = { status: 'success' as const, rows: quotaRowsFor('kimi', payload) };
    const file = { name: 'kimi.json', provider: 'kimi' };
    for (const content of [
      <QuotaCard file={file} quota={quota} onRefresh={() => {}} />,
      <AuthFileQuotaPanel file={file} quota={quota} disabled={false} compact dense onRefresh={() => {}} />,
    ]) {
      const html = renderToStaticMarkup(<I18nProvider>{content}</I18nProvider>);
      expect(html).toContain('Monthly total quota');
      expect(html).toContain('Monthly coding quota');
      expect(html).toContain('75%');
      expect(html).toContain('40%');
      expect(html).toContain('10/22');
      expect(html).toContain('10/23');
    }
  });
});
