import { expect, test } from 'bun:test';
import { estimateCredentialCardHeight, lowestQuotaRow, stackQuotaColumns } from '../src/services/quotaLayout';
import type { QuotaState } from '../src/services/quotaService';

test('stacked layout puts each card in the shortest column, keeping order within columns', () => {
  // Worked by hand: 10 -> col 0; 2, 2, 2 -> col 1 (2, 4, 6); 8 -> col 1 (6 < 10, now 14); 1 -> col 0 (10 < 14).
  expect(stackQuotaColumns([10, 2, 2, 2, 8, 1], 2)).toEqual([[0, 5], [1, 2, 3, 4]]);
  // Equal heights fill left to right, like Even rows.
  expect(stackQuotaColumns([1, 1, 1, 1, 1], 3)).toEqual([[0, 3], [1, 4], [2]]);
  expect(stackQuotaColumns([3, 1], 0)).toEqual([[0, 1]]);
});

test('the credential glance line shows the quota row with the least remaining share', () => {
  const rows = [{ label: '5h', remainingPercent: 62 }, { label: 'Week', remainingPercent: null }, { label: 'Opus', remainingPercent: 18 }, { label: 'Month', remainingPercent: 40 }];
  expect(lowestQuotaRow({ status: 'success', rows } as QuotaState)?.label).toBe('Opus');
  expect(lowestQuotaRow({ status: 'success', rows: [{ label: 'Week', remainingPercent: null }] } as QuotaState)).toBeNull();
  expect(lowestQuotaRow({ status: 'loading', rows } as QuotaState)).toBeNull();
});

test('credential card heights grow with what the card shows, and glance cards are short', () => {
  const quota = (count: number) => ({ status: 'success', rows: Array.from({ length: count }, (_, index) => ({ label: String(index), remainingPercent: 50 })) }) as QuotaState;
  const base = { quota: quota(2), tags: false, cooldown: false, expanded: false, glance: false };
  // Two quota rows share a line in the dense panel: 9 + 1 line x 1.5.
  expect(estimateCredentialCardHeight(base)).toBe(10.5);
  expect(estimateCredentialCardHeight({ ...base, quota: quota(3) })).toBe(12);
  expect(estimateCredentialCardHeight({ ...base, tags: true, cooldown: true, expanded: true })).toBe(19);
  expect(estimateCredentialCardHeight({ ...base, glance: true, expanded: true })).toBe(3);
  expect(estimateCredentialCardHeight({ ...base, glance: true, tags: true })).toBe(4);
});
