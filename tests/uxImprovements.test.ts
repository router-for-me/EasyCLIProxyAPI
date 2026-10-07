import { expect, test } from 'bun:test';
import { explicitReasoning, failureKind } from '../src/services/connectionPresentation';
import { quotaAvailability } from '../src/services/quotaAvailability';
import { recoveryEvents, recoveredAccounts } from '../src/services/overviewInsights';
import { quotaKey, type QuotaState } from '../src/services/quotaService';
import { configurationDifferences } from '../src/components/ConfigurationChangePreview';
const model = { model: 'gemini-3.8-flash-high', alias: 'claude-custom-2' };
test('reasoning is explicit configuration evidence, never guessed from the model name', () => {
  expect(explicitReasoning({}, model)).toBeNull();
  const rule = { models: [{ name: model.alias, protocol: 'antigravity' }], params: { 'generationConfig.thinkingConfig': { thinkingLevel: 'high' } } };
  expect(explicitReasoning({ override: [rule] }, model)).toBe('high');
  expect(explicitReasoning({ override: [rule, { models: [{ name: '*' }], params: { reasoning_effort: 'low' } }] }, model)).toBe('low');
  expect(explicitReasoning({ override: [rule], filter: [{}] }, model)).toBeNull();
  expect(explicitReasoning({ override: [{ ...rule, models: [{ name: 'other' }] }] }, model)).toBeNull();
  expect(explicitReasoning({ override: [{ ...rule, models: [{ name: model.alias, 'from-protocol': 'claude' }] }] }, model)).toBeNull();
});
test('uncertainty distinguishes failed, stale, not-yet-checked and offline snapshots', () => {
  const file = { name: 'account', provider: 'claude', status: 'active' }; const now = Date.now();
  expect(quotaAvailability(file, undefined, now).uncertainty).toBe('notChecked');
  expect(quotaAvailability(file, { status: 'error', rows: [] }, now).uncertainty).toBe('checkFailed');
  expect(quotaAvailability(file, { status: 'success', fetchedAt: now - 400000, rows: [] }, now).uncertainty).toBe('stale');
  expect(quotaAvailability(file, undefined, now, true).uncertainty).toBe('offline');
});
test('recovery waits for all account blockers, excludes stale evidence and labels credit renewal', () => {
  const file = { name: 'codex', provider: 'codex', status: 'active' }; const now = Date.now();
  const quota: QuotaState = { status: 'success', fetchedAt: now, rows: [
    { scope: 'account', label: 'short', remainingPercent: 0, resetAtMs: now + 1000 },
    { scope: 'account', label: 'week', remainingPercent: 0, resetAtMs: now + 5000 },
  ] };
  const quotas = { [quotaKey(file)]: quota };
  expect(recoveryEvents([file], quotas, now)[0]).toMatchObject({ at: now + 5000, includedOnly: true });
  expect(recoveryEvents([file], quotas, now, true)).toEqual([]);
  expect(recoveryEvents([file], quotas, now + 5001)).toEqual([]);
});
test('recovery notifications require a known constrained-to-available transition', () => {
  expect(recoveredAccounts({ a: 'exhausted', b: 'unknown', c: 'creditBacked' }, { a: 'available', b: 'available', c: 'available' })).toEqual(['a', 'c']);
  expect(recoveredAccounts({}, { a: 'available' })).toEqual([]);
});
test('failure actions use recorded HTTP status; unknown remains unknown', () => {
  expect(failureKind({ failure_status: 401 })).toBe('auth');
  expect(failureKind({ failure_status: 429 })).toBe('limit');
  expect(failureKind({ failure_status: 404, failure_body: 'model not found' })).toBe('model');
  expect(failureKind({ failure_status: 503 })).toBe('network');
  expect(failureKind({})).toBe('other');
});
test('save preview includes removals and changed model aliases without unchanged noise', () => {
  expect(configurationDifferences({ model: 'old', mappings: { alias: 'same', removed: true } }, { model: 'new', mappings: { alias: 'same' } })).toEqual([
    { key: 'model', before: 'old', after: 'new' }, { key: 'mappings.removed', before: 'true', after: '—' },
  ]);
});
