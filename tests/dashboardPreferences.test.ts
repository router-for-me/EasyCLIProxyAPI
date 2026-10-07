import { afterEach, expect, test } from 'bun:test';
import { readDashboardPreference, saveDashboardPreference } from '../src/services/dashboardPreferences';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
test('rejects old or malformed preference values', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'obsolete' } });
  expect(readDashboardPreference('quotaState', ['all', 'attention'], 'all')).toBe('all');
});
test('storage access and write failures leave display controls usable', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Storage denied'); } });
  expect(readDashboardPreference('quotaLayout', ['ledger', 'compact'], 'ledger')).toBe('ledger');
  expect(() => saveDashboardPreference('quotaLayout', 'compact')).not.toThrow();
});
test('preserves existing preference keys', () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) } });
  saveDashboardPreference('quotaLayout', 'compact');
  expect(values.get('personal.quotaLayout')).toBe('compact');
  expect(readDashboardPreference('quotaLayout', ['ledger', 'compact'], 'ledger')).toBe('compact');
});
