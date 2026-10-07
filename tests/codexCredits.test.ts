import { expect, test } from 'bun:test';
import { codexCreditsFor } from '../src/services/codexCredits';
import { quotaAvailability } from '../src/services/quotaAvailability';
import type { QuotaState } from '../src/services/quotaService';

test('separates live Codex included allowance exhaustion from usable credits', () => {
  const credits = codexCreditsFor({ credits: { has_credits: true, unlimited: false, balance: '849.8945545000', overage_limit_reached: false } });
  const now = Date.now();
  const quota: QuotaState = { status: 'success', fetchedAt: now, rows: [{ label: 'Weekly limit', scope: 'account', remainingPercent: 0, resetAtMs: now + 400000 }], credits, resetCredits: 1 };
  const file = { provider: 'codex', status: 'active' };
  expect(quotaAvailability(file, quota, now)).toMatchObject({ kind: 'creditBacked', includedOnly: true, creditBalance: 849.8945545, resetsAvailable: 1 });
  expect(quotaAvailability(file, quota, now + 7 * 60000).kind).toBe('unknown');
  expect(quotaAvailability(file, { ...quota, credits: undefined }, now).kind).toBe('exhausted');
  expect(quotaAvailability({ ...file, disabled: true }, quota, now).kind).toBe('disabled');
  expect(quota.rows[0].remainingPercent).toBe(0);
});
test('invalid, missing, or blocked balances never imply usable credits', () => {
  for (const balance of [undefined, null, '', ' ', false, [], {}, 'n/a', '-1', Infinity, 0]) {
    expect(codexCreditsFor({ credits: { has_credits: true, balance } })?.available).toBe(false);
  }
  expect(codexCreditsFor({})).toBeUndefined();
  expect(codexCreditsFor({ credits: { balance: 100 } })?.available).toBe(false);
  expect(codexCreditsFor({ credits: { has_credits: true, balance: 100, overage_limit_reached: true } })?.available).toBe(false);
  expect(codexCreditsFor({ credits: { has_credits: true, unlimited: true } })?.available).toBe(true);
});
