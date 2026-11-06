import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthFileQuotaPanel } from '../src/components/AuthFileQuotaPanel';
import { QuotaCard } from '../src/pages/QuotaPage';
import { I18nProvider, supportedLocales, translate } from '../src/i18n';
import { formatClaudeDollars, quotaRowsFor } from '../src/services/quotaService';

const reset = '2030-12-01T00:00:00Z';
const balance = { limit_dollars: '100', used_dollars: '23.50', remaining_dollars: '76.50', utilization: 23.5, resets_at: reset };
const scoped = { kind: 'weekly_scoped', percent: 32, is_active: true, scope: { model: { display_name: 'Fable 5' } } };
const rowsFor = (window: Record<string, unknown>) => quotaRowsFor('claude', { iguana_necktie: window });

describe('Claude cloud credits', () => {
  it('accepts cloud-only numeric strings as dollars, with reset and no duplicate Fable meter', () => {
    const rows = rowsFor(balance);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Cloud session credits', remainingPercent: 76.5, resetAtMs: Date.parse(reset) });
    expect(rows[0].detail).toBe('Used $23.50 · Limit $100.00 · Remaining $76.50');
    expect(rows[0].reset).toBeTruthy();
  });

  it('keeps cloud credit and scoped Fable windows alongside ordinary quota and extra usage', () => {
    const rows = quotaRowsFor('claude', {
      five_hour: { utilization: 10 }, seven_day: { utilization: 20 },
      iguana_necktie: balance, limits: [scoped],
      extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 2350 },
    });
    expect(rows.map(row => row.label)).toEqual(['5-hour limit', 'Weekly limit', 'Weekly Fable limit', 'Cloud session credits', 'Extra usage']);
    expect(rows[2].remainingPercent).toBe(68);
    expect(rows[4].detail).toBe('Used $23.50 / $100.00');
  });

  it('preserves legacy Fable fallback and scoped precedence when no dollar fields exist', () => {
    expect(rowsFor({ utilization: 41 })[0]).toMatchObject({ label: 'Weekly Fable limit', remainingPercent: 59 });
    expect(quotaRowsFor('claude', { iguana_necktie: { utilization: 41 }, limits: [scoped] }))
      .toEqual([expect.objectContaining({ label: 'Weekly Fable limit', remainingPercent: 68 })]);
    expect(rowsFor({})).toEqual([]);
  });

  it.each(['limit_dollars', 'used_dollars', 'remaining_dollars'])('recognizes a partial %s balance even without utilization or reset', field => {
    const rows = quotaRowsFor('claude', { iguana_necktie: { [field]: '0' }, limits: [scoped] });
    expect(rows).toHaveLength(2);
    expect(rows[1].label).toBe('Cloud session credits');
    expect(rows[1].detail).toContain('$0.00');
    expect(rows[1].remainingPercent).toBeNull();
    expect(rows[1].reset).toBeUndefined();
    expect(rows[1].detail?.match(/\$/g)).toHaveLength(1);
  });

  it('retains all zero balances without dividing by zero or fabricating a percent', () => {
    expect(rowsFor({ limit_dollars: 0, used_dollars: 0, remaining_dollars: 0 })[0])
      .toMatchObject({ remainingPercent: null, detail: 'Used $0.00 · Limit $0.00 · Remaining $0.00' });
    expect(rowsFor({ ...balance, remaining_dollars: 0, used_dollars: 100, utilization: 100 })[0].remainingPercent).toBe(0);
  });

  it.each([null, undefined, '', 'bad', Infinity, -Infinity, NaN, 'Infinity', true])('does not fabricate malformed amounts: %s', invalid => {
    const row = rowsFor({ ...balance, limit_dollars: invalid, used_dollars: invalid, remaining_dollars: invalid, utilization: invalid, resets_at: 'bad' })[0];
    expect(row.label).toBe('Cloud session credits');
    expect(row.remainingPercent).toBeNull();
    expect(row.detail).toBeUndefined();
    expect(row.reset).toBeUndefined();
    expect(row.resetAtMs).toBeUndefined();
  });

  it.each([-1, 101, 'bad', null, Infinity])('uses dollar ratios when utilization is invalid: %s', utilization => {
    expect(rowsFor({ ...balance, utilization })[0].remainingPercent).toBe(76.5);
    expect(rowsFor({ ...balance, remaining_dollars: null, utilization })[0].remainingPercent).toBe(76.5);
  });

  it('uses only valid utilization as fallback without inventing missing dollar amounts', () => {
    const partial = { ...balance, limit_dollars: null, remaining_dollars: null, utilization: '25' };
    expect(rowsFor(partial)[0]).toMatchObject({ remainingPercent: 75, detail: 'Used $23.50' });
    expect(rowsFor({ ...partial, utilization: 101 })[0].remainingPercent).toBeNull();
  });

  it('recognizes independent dollar windows, but not core plan or extra-usage fields', () => {
    const rows = quotaRowsFor('claude', { seven_day_opus: balance, other_pool: balance, five_hour: balance, seven_day: balance, extra_usage: balance });
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.label)).toEqual(['5-hour limit', 'Weekly limit', 'Cloud session credits (seven_day_opus)', 'Cloud session credits (other_pool)']);
  });

  it('formats dollars without cents conversion or nonfinite output', () => {
    expect(formatClaudeDollars(100)).toBe('$100.00');
    expect(formatClaudeDollars(0)).toBe('$0.00');
    expect(formatClaudeDollars(1.25)).toBe('$1.25');
    for (const invalid of [null, NaN, Infinity, -Infinity]) expect(formatClaudeDollars(invalid)).toBeUndefined();
  });

  it('renders once with all balances and no explanatory caveat in both quota surfaces', () => {
    const quota = { status: 'success' as const, rows: rowsFor(balance) };
    const file = { provider: 'claude', name: 'cloud.json' };
    const surfaces = [<QuotaCard file={file} quota={quota} onRefresh={() => {}} />,
      <AuthFileQuotaPanel file={file} quota={quota} disabled={false} onRefresh={() => {}} />];
    for (const surface of surfaces) {
      const html = renderToStaticMarkup(<I18nProvider>{surface}</I18nProvider>);
      expect(html).toContain('Used $23.50 · Limit $100.00 · Remaining $76.50');
      expect(html.match(/role="progressbar"/g)).toHaveLength(1);
      expect(html).not.toContain('Fable');
      expect(html).not.toContain('How are credits used?');
      expect(html).not.toContain('does not establish ordinary Messages API routing support');
      expect(html).not.toContain('<details>');
    }
  });

  it('provides localized labels and guidance in every supported locale', () => {
    for (const locale of supportedLocales) {
      const label = translate(locale, 'quota.service.cloud.label');
      expect(label).not.toBe('quota.service.cloud.label');
      if (locale !== 'en') expect(label).not.toBe('Cloud session credits');
      expect(translate(locale, 'quota.service.cloud.remaining', { value: '$0.00' })).toContain('$0.00');
    }
  });

  it.each([true, false])('keeps cloud balances outside collapsed additional windows with dense=%s', dense => {
    const rows = quotaRowsFor('claude', { five_hour: { utilization: 10 }, seven_day: { utilization: 20 }, iguana_necktie: balance, limits: [scoped] });
    const html = renderToStaticMarkup(<I18nProvider><AuthFileQuotaPanel file={{ provider: 'claude' }} quota={{ status: 'success', rows }} disabled={false} compact dense={dense} onRefresh={() => {}} /></I18nProvider>);
    expect(html.indexOf('Used $23.50')).toBeLessThan(html.indexOf('class="credential-quota-more"'));
    expect(html).toContain('(+1)');
  });
});
