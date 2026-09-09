import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { canResetCodexQuota, resetCodexQuotaWithConfirmation } from '../src/services/quotaActions';
import { getQuotaCacheSnapshot, pruneQuotaCache, updateQuotaCache } from '../src/services/quotaCache';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const file = { name: 'confirm-test.json', provider: 'codex', auth_index: 'confirm-test' };
const key = quotaKey(file);
const previous: QuotaState = {
  status: 'success', rows: [{ label: '5h', remainingPercent: 0 }], resetCredits: 2, resetCreditsApplicable: 1,
};
let originalWindow: PropertyDescriptor | undefined;
let originalCache: ReturnType<typeof getQuotaCacheSnapshot>;
let upstreamCalls: { url: string; method: string }[];
let consumeError: boolean;
let refreshError: boolean;

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  originalCache = getQuotaCacheSnapshot();
  updateQuotaCache({ [key]: previous });
  upstreamCalls = [];
  consumeError = false;
  refreshError = false;
  mockIPC((command, payload) => {
    if (command !== 'management_request') throw new Error('Unexpected IPC command: ' + command);
    const request = (payload as { request: { path: string; body: { url: string; method: string } } }).request;
    expect(request.path).toBe('/api-call');
    upstreamCalls.push(request.body);
    if (request.body.url.endsWith('/consume') && consumeError) return { status_code: 409, body: 'reset denied' };
    if (request.body.url.endsWith('/usage') && refreshError) return { status_code: 503, body: 'usage unavailable' };
    return {
      status_code: 200,
      body: request.body.url.endsWith('/usage')
        ? { rate_limit: { primary_window: { used_percent: 0 } } }
        : { available_count: 1 },
    };
  });
});

afterEach(() => {
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  updateQuotaCache(originalCache);
});

describe('quota action confirmation with fully mocked IPC', () => {
  it('preserves displayed quota and sends nothing until explicit confirmation', async () => {
    let decide!: (confirmed: boolean) => void;
    const resetting = resetCodexQuotaWithConfirmation(file, () => new Promise((resolve) => { decide = resolve; }));
    expect(getQuotaCacheSnapshot()[key]).toBe(previous);
    expect(upstreamCalls).toHaveLength(0);
    decide(true);
    expect(await resetting).toBe('success');
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
    expect(upstreamCalls[0].method).toBe('POST');
    expect(getQuotaCacheSnapshot()[key]).toMatchObject({ status: 'success', resetCredits: 1, actionResult: { action: 'reset', status: 'success' } });
  });

  it.each([false, null, undefined, 'unexpected', 'true'])('never consumes on cancellation or an invalid answer: %s', async (answer) => {
    expect(await resetCodexQuotaWithConfirmation(file, async () => answer as boolean)).toBe('cancelled');
    expect(upstreamCalls).toHaveLength(0);
    expect(getQuotaCacheSnapshot()[key]).toBe(previous);
  });

  it('releases the reservation if opening the confirmation fails', async () => {
    await expect(resetCodexQuotaWithConfirmation(file, async () => { throw new Error('confirmation unavailable'); }))
      .rejects.toThrow('confirmation unavailable');
    expect(getQuotaCacheSnapshot()[key]).toBe(previous);
    expect(upstreamCalls).toHaveLength(0);
    await resetCodexQuotaWithConfirmation(file, async () => true);
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
  });

  it('reserves the account while awaiting a decision and prevents duplicate confirmations', async () => {
    let decide!: (confirmed: boolean) => void;
    let confirmations = 0;
    const ask = () => { confirmations++; return new Promise<boolean>((resolve) => { decide = resolve; }); };
    const first = resetCodexQuotaWithConfirmation(file, ask);
    expect(await resetCodexQuotaWithConfirmation(file, ask)).toBe('cancelled');
    expect(confirmations).toBe(1);
    expect(upstreamCalls).toHaveLength(0);
    decide(true);
    await first;
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
  });

  it('ignores approval after the credential is removed', async () => {
    let decide!: (confirmed: boolean) => void;
    const resetting = resetCodexQuotaWithConfirmation(file, () => new Promise((resolve) => { decide = resolve; }));
    pruneQuotaCache(new Set());
    decide(true);
    expect(await resetting).toBe('cancelled');
    expect(upstreamCalls).toHaveLength(0);
    expect(getQuotaCacheSnapshot()[key]).toBeUndefined();
  });

  it('does not act on a stale quota snapshot or overwrite newer data', async () => {
    let decide!: (confirmed: boolean) => void;
    const resetting = resetCodexQuotaWithConfirmation(file, () => new Promise((resolve) => { decide = resolve; }));
    const newer: QuotaState = { status: 'success', rows: [], resetCredits: 3 };
    updateQuotaCache({ [key]: newer });
    decide(true);
    await resetting;
    expect(getQuotaCacheSnapshot()[key]).toBe(newer);
    expect(upstreamCalls).toHaveLength(0);
  });

  it.each([0, undefined])('allows a confirmed reset with full quota regardless of applicable credits: %s', async (applicable) => {
    const quota: QuotaState = {
      ...previous, rows: [{ label: '5h', remainingPercent: 100 }], resetCreditsApplicable: applicable,
    };
    updateQuotaCache({ [key]: quota });
    expect(canResetCodexQuota(file, quota)).toBe(true);
    expect(await resetCodexQuotaWithConfirmation(file, async () => false)).toBe('cancelled');
    expect(upstreamCalls).toHaveLength(0);
    expect(getQuotaCacheSnapshot()[key]).toBe(quota);

    let decide!: (confirmed: boolean) => void;
    const resetting = resetCodexQuotaWithConfirmation(file, () => new Promise((resolve) => { decide = resolve; }));
    expect(upstreamCalls).toHaveLength(0);
    expect(getQuotaCacheSnapshot()[key]).toBe(quota);
    decide(true);
    expect(await resetting).toBe('success');
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
  });

  it('keeps disabled credentials and pending requests unavailable', async () => {
    expect(canResetCodexQuota({ ...file, disabled: true }, previous)).toBe(false);
    expect(await resetCodexQuotaWithConfirmation({ ...file, disabled: true }, async () => true)).toBe('cancelled');
    updateQuotaCache({ [key]: { ...previous, status: 'loading' } });
    expect(canResetCodexQuota(file, getQuotaCacheSnapshot()[key])).toBe(false);
    expect(await resetCodexQuotaWithConfirmation(file, async () => true)).toBe('cancelled');
    expect(upstreamCalls).toHaveLength(0);
  });

  it('reports a failed reset and allows retry after a new confirmation', async () => {
    consumeError = true;
    expect(await resetCodexQuotaWithConfirmation(file, async () => true)).toBe('error');
    expect(getQuotaCacheSnapshot()[key]).toMatchObject({
      rows: previous.rows, actionResult: { action: 'reset', status: 'error', error: 'reset denied' },
    });
    expect(canResetCodexQuota(file, getQuotaCacheSnapshot()[key])).toBe(true);
    expect(await resetCodexQuotaWithConfirmation(file, async () => false)).toBe('cancelled');
    expect(upstreamCalls).toHaveLength(1);
    consumeError = false;
    expect(await resetCodexQuotaWithConfirmation(file, async () => true)).toBe('success');
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(2);
  });

  it('reports a failed follow-up refresh and requires a new confirmation for another reset', async () => {
    refreshError = true;
    expect(await resetCodexQuotaWithConfirmation(file, async () => true)).toBe('refresh-error');
    expect(getQuotaCacheSnapshot()[key]).toMatchObject({
      rows: previous.rows, actionResult: { action: 'reset', status: 'refresh-error', error: 'usage unavailable' },
    });
    expect(canResetCodexQuota(file, getQuotaCacheSnapshot()[key])).toBe(true);
    expect(await resetCodexQuotaWithConfirmation(file, async () => false)).toBe('cancelled');
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
    refreshError = false;
    expect(await resetCodexQuotaWithConfirmation(file, async () => true)).toBe('success');
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(2);
  });

  it('keeps application confirmations out of native and browser dialog APIs', async () => {
    for (const name of ['QuotaPage', 'AuthFileManagementPage', 'ApiAccessPage', 'ThinkingAliasesPage', 'UsageRecordsPage']) {
      const source = await Bun.file(new URL('../src/pages/' + name + '.tsx', import.meta.url)).text();
      expect(source).not.toContain('window.confirm');
      expect(source).not.toContain('@tauri-apps/plugin-dialog');
    }
  });
});
