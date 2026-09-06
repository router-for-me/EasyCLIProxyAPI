import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { confirm } from '@tauri-apps/plugin-dialog';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { resetCodexQuotaWithConfirmation } from '../src/services/quotaActions';
import { getQuotaCacheSnapshot, pruneQuotaCache, updateQuotaCache } from '../src/services/quotaCache';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const file = { name: 'confirm-test.json', provider: 'codex', auth_index: 'confirm-test' };
const key = quotaKey(file);
const previous: QuotaState = {
  status: 'success', rows: [{ label: '5h', remainingPercent: 0 }], resetCredits: 2,
};
const ask = () => confirm('Consume one Codex reset credit?', { title: 'Reset quota', kind: 'warning' });
let originalWindow: PropertyDescriptor | undefined;
let originalCache: ReturnType<typeof getQuotaCacheSnapshot>;
let answer: () => Promise<unknown>;
let dialogCalls: unknown[];
let upstreamCalls: { url: string; method: string }[];
let consumeError: boolean;

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  originalCache = getQuotaCacheSnapshot();
  updateQuotaCache({ [key]: previous });
  answer = async () => 'Cancel';
  dialogCalls = [];
  upstreamCalls = [];
  consumeError = false;
  mockIPC((command, payload) => {
    if (command === 'plugin:dialog|message') {
      dialogCalls.push(payload);
      return answer();
    }
    if (command === 'management_request') {
      const request = (payload as { request: { path: string; body: { url: string; method: string } } }).request;
      expect(request.path).toBe('/api-call');
      upstreamCalls.push(request.body);
      if (request.body.url.endsWith('/consume') && consumeError) return { status_code: 409, body: 'reset denied' };
      return {
        status_code: 200,
        body: request.body.url.endsWith('/usage')
          ? { rate_limit: { primary_window: { used_percent: 0 } } }
          : { available_count: 1 },
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => {
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  updateQuotaCache(originalCache);
});

describe('native quota reset confirmation', () => {
  it('uses the native dialog IPC and has its required Tauri capability', async () => {
    const capabilities = await Bun.file(new URL('../src-tauri/capabilities/default.json', import.meta.url)).json();
    expect(capabilities.permissions).toContain('dialog:allow-message');
    await resetCodexQuotaWithConfirmation(file, ask);
    expect(dialogCalls).toEqual([{
      message: 'Consume one Codex reset credit?', title: 'Reset quota', kind: 'warning', buttons: 'OkCancel',
    }]);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('waits for explicit confirmation before sending any request', async () => {
    let resolve!: (value: string) => void;
    answer = () => new Promise((done) => { resolve = done; });
    const resetting = resetCodexQuotaWithConfirmation(file, ask);
    expect(getQuotaCacheSnapshot()[key].status).toBe('loading');
    expect(upstreamCalls).toHaveLength(0);
    resolve('Ok');
    await resetting;
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
    expect(upstreamCalls[0].method).toBe('POST');
    expect(getQuotaCacheSnapshot()[key]).toMatchObject({ status: 'success', resetCredits: 1 });
  });

  it.each(['Cancel', null, undefined, 'unexpected'])('does not consume a credit when dismissed with %s', async (result) => {
    answer = async () => result;
    await resetCodexQuotaWithConfirmation(file, ask);
    expect(upstreamCalls).toHaveLength(0);
    expect(getQuotaCacheSnapshot()[key]).toBe(previous);
  });

  it('restores the previous quota when opening the dialog fails, and allows retry', async () => {
    answer = async () => { throw new Error('dialog permission denied'); };
    await expect(resetCodexQuotaWithConfirmation(file, ask)).rejects.toThrow('dialog permission denied');
    expect(getQuotaCacheSnapshot()[key]).toBe(previous);
    expect(upstreamCalls).toHaveLength(0);
    answer = async () => 'Ok';
    await resetCodexQuotaWithConfirmation(file, ask);
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
  });

  it('does not open another dialog or consume twice on repeated clicks', async () => {
    let resolve!: (value: string) => void;
    answer = () => new Promise((done) => { resolve = done; });
    const first = resetCodexQuotaWithConfirmation(file, ask);
    await resetCodexQuotaWithConfirmation(file, ask);
    expect(dialogCalls).toHaveLength(1);
    expect(upstreamCalls).toHaveLength(0);
    resolve('Ok');
    await first;
    expect(upstreamCalls.filter((request) => request.url.endsWith('/consume'))).toHaveLength(1);
  });

  it('ignores confirmation if the credential was removed while the dialog was open', async () => {
    let resolve!: (value: string) => void;
    answer = () => new Promise((done) => { resolve = done; });
    const resetting = resetCodexQuotaWithConfirmation(file, ask);
    pruneQuotaCache(new Set());
    resolve('Ok');
    await resetting;
    expect(upstreamCalls).toHaveLength(0);
    expect(getQuotaCacheSnapshot()[key]).toBeUndefined();
  });

  it('does not overwrite newer quota state after a pending dialog is cancelled', async () => {
    let resolve!: (value: string) => void;
    answer = () => new Promise((done) => { resolve = done; });
    const resetting = resetCodexQuotaWithConfirmation(file, ask);
    const newer: QuotaState = { status: 'success', rows: [], resetCredits: 3 };
    updateQuotaCache({ [key]: newer });
    resolve('Cancel');
    await resetting;
    expect(getQuotaCacheSnapshot()[key]).toBe(newer);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('reports reset failures and releases the pending state', async () => {
    answer = async () => 'Ok';
    consumeError = true;
    await expect(resetCodexQuotaWithConfirmation(file, ask)).rejects.toThrow('reset denied');
    expect(getQuotaCacheSnapshot()[key]).toMatchObject({ status: 'error', error: 'reset denied' });
  });

  it('does not reintroduce browser confirmation in quota actions', async () => {
    const page = await Bun.file(new URL('../src/pages/QuotaPage.tsx', import.meta.url)).text();
    expect(page).not.toContain('window.confirm');
    expect(page).toContain('await resetCodexQuotaWithConfirmation(file, () => confirm(');
  });
});
