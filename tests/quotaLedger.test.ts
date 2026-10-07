import { describe, expect, it } from 'bun:test';
import { ledgerWindows, orderedQuotaRows, summarizeWindow, summaryWindows } from '../src/services/quotaLedger';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

describe('quota ledger evidence', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ name: `claude-${i}.json`, auth_index: String(i) }));
  const snapshot = (values: Array<number | null>) => Object.fromEntries(files.map((file, i) => [quotaKey(file), {
    status: 'success', rows: [{ label: '7-day Fable 5', remainingPercent: values[i], resetAtMs: 2000 + i }],
  } satisfies QuotaState]));
  it('shows the reference sum with its actual denominator', () => {
    const result = summarizeWindow(files, snapshot([58, 100, 100, 51, 100]), '7-day Fable 5');
    expect(result.total).toBe(409); expect(result.capacity).toBe(500); expect(result.reported).toBe(5);
    expect(result.values).toEqual([58, 100, 100, 51, 100]); expect(result.resetAt).toBe(2000);
  });
  it('excludes missing, failed, loading and disabled accounts instead of calling them zero', () => {
    const quotas = snapshot([null, 50, 50, 50, 0]);
    quotas[quotaKey(files[1])].status = 'error'; quotas[quotaKey(files[2])].status = 'loading';
    const result = summarizeWindow(files.map((file, i) => ({ ...file, disabled: i === 3 })), quotas, '7-day Fable 5');
    expect(result.total).toBe(0); expect(result.reported).toBe(1); expect(result.capacity).toBe(100);
    expect(result.values).toEqual([null, null, null, null, 0]);
    expect(summarizeWindow(files, {}, 'weekly').total).toBeNull();
  });
  it('keeps distinct windows separate and aligns absent windows without inventing a value', () => {
    const quotas = snapshot([58, 100, 100, 51, 100]);
    quotas[quotaKey(files[0])].rows.push({ label: '5-hour window', remainingPercent: 99, resetAtMs: 1000 });
    expect(summaryWindows(files, quotas)[0].label).toBe('7-day Fable 5');
    const columns = ledgerWindows(files, quotas);
    const rows = orderedQuotaRows(quotas[quotaKey(files[1])].rows, columns);
    expect(rows.map(row => row.label)).toEqual(columns);
    expect(rows.find(row => row.label === '5-hour window')?.remainingPercent).toBeNull();
    expect(summarizeWindow(files, quotas, '7-day Fable 5').total).toBe(409);
  });
});
