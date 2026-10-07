import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { authFileCooldownResetIndex, resetAuthFileCooldown } from '../src/services/authFiles';
import {
  cooldownReasonKey,
  cooldownRemainingSeconds,
  normalizeAuthFileCooldowns,
  summarizeAuthFileCooldowns,
} from '../src/services/authFileHealth';

describe('credential cooldown reset', () => {
  let originalWindow: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  });
  afterEach(() => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('uses only an auth index and accepts runtime and disabled credentials', () => {
    expect(authFileCooldownResetIndex({ auth_index: ' auth-one ', disabled: true })).toBe('auth-one');
    expect(authFileCooldownResetIndex({ authIndex: 0, runtime_only: true })).toBe('0');
    expect(authFileCooldownResetIndex({ auth_index: 'runtime-key', account_type: 'api_key' })).toBe('runtime-key');
    expect(authFileCooldownResetIndex({ auth_index: null, authIndex: 'alias' })).toBe('alias');
    expect(authFileCooldownResetIndex({ name: 'file.json', id: 'auth-id' })).toBeUndefined();
    for (const auth_index of [undefined, null, '', ' ', {}, [], true, NaN, Infinity, -1, 1.5]) {
      expect(authFileCooldownResetIndex({ auth_index })).toBeUndefined();
    }
  });

  it('posts a raw auth_index operation through the v8 management bridge', async () => {
    const requests: unknown[] = [];
    mockIPC((command, args) => {
      expect(command).toBe('management_request');
      requests.push(args?.request);
      return { status: 'ok', auth_index: 'auth-one', models: ['model-a', 'model-b'] };
    });
    expect(await resetAuthFileCooldown(' auth-one ')).toEqual({
      status: 'ok', auth_index: 'auth-one', models: ['model-a', 'model-b'],
    });
    expect(requests).toEqual([{
      method: 'POST', path: '/routing/cooldown/reset', body: { auth_index: 'auth-one' },
      query: undefined, timeoutMs: undefined,
    }]);
  });

  it('rejects a missing index before making a request', async () => {
    let called = false;
    const api = { post: async () => { called = true; return {}; } };
    await expect(resetAuthFileCooldown(' ', api)).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('requires a successful acknowledgement for the selected credential', async () => {
    for (const response of [undefined, null, [], {},
      { status: 'error', auth_index: 'auth-one', error: 'operation failed' },
      { status: 'ok', auth_index: 'another-index' },
      { status: 'ok' },
      { status: 'ok', auth_index: 'auth-one', models: [null] },
      { status: 'ok', auth_index: 'auth-one', models: 'model-a' },
    ]) {
      await expect(resetAuthFileCooldown('auth-one', { post: async () => response })).rejects.toThrow();
    }
    for (const models of [[], null, undefined]) {
      expect(await resetAuthFileCooldown('auth-one', {
        post: async () => ({ status: 'ok', auth_index: 'auth-one', models }),
      })).toEqual({ status: 'ok', auth_index: 'auth-one', models: [] });
    }
  });

  it('preserves backend and transport failures without reporting successful reset', async () => {
    for (const message of [
      'Management API error (404): auth not found',
      'Management API error (404): 404 page not found',
      'Management API error (401): unauthorized',
      'Management API error (500): failed to reset quota',
      'Management API request failed: connection refused',
    ]) {
      const failure = new Error(message);
      mockIPC(() => { throw failure; });
      await expect(resetAuthFileCooldown('auth-one')).rejects.toBe(failure);
    }
  });
});

describe('cooldown snapshot and timer invariants', () => {
  const receivedAtMs = 10_000;
  const model = {
    scope: 'model', model_key: 'model-a', reason: 'quota',
    retry_at: '2040-01-01T00:00:32Z', remaining_seconds: 32,
  };

  it('counts each model once and does not infer timers from diagnostic backoff', () => {
    const snapshot = normalizeAuthFileCooldowns([
      model, { ...model, remaining_seconds: 10, backoff_level: 100 },
    ], receivedAtMs)!;
    const record = snapshot.records![1];
    expect(cooldownRemainingSeconds(record, receivedAtMs, receivedAtMs - 5000)).toBe(10);
    expect(cooldownRemainingSeconds(record, receivedAtMs, receivedAtMs + 1001)).toBe(9);
    expect(cooldownRemainingSeconds(record, receivedAtMs, receivedAtMs + 10_000)).toBe(0);
    expect(summarizeAuthFileCooldowns(snapshot, receivedAtMs)).toMatchObject({ modelCount: 1, earliestSeconds: 10 });
    const elapsed = summarizeAuthFileCooldowns(snapshot, receivedAtMs + 40_000);
    expect(elapsed.rows).toHaveLength(2);
    expect(elapsed).toMatchObject({ elapsed: true, modelCount: 0, earliestSeconds: 0 });
  });

  it('treats absent, unknown, fresh empty and expired snapshots as separate states', () => {
    expect(normalizeAuthFileCooldowns(undefined, receivedAtMs)).toBeUndefined();
    expect(normalizeAuthFileCooldowns(null, receivedAtMs)?.records).toBeNull();
    expect(normalizeAuthFileCooldowns([], receivedAtMs)?.records).toEqual([]);
    const expired = normalizeAuthFileCooldowns([model], receivedAtMs)!;
    expect(summarizeAuthFileCooldowns(expired, receivedAtMs + 33_000).elapsed).toBe(true);
    const refreshed = normalizeAuthFileCooldowns([], receivedAtMs + 33_000)!;
    expect(summarizeAuthFileCooldowns(refreshed, receivedAtMs + 33_000).elapsed).toBe(false);
    expect(refreshed.records).toEqual([]);
  });

  it('normalizes diagnostics without displaying arbitrary reason values or invalid dates', () => {
    for (const reason of [null, {}, 429, true, '']) {
      const snapshot = normalizeAuthFileCooldowns([{ ...model, reason }], receivedAtMs, 'invalid');
      expect(snapshot?.observedAt).toBeUndefined();
      expect(snapshot?.records?.[0].reason).toBe('unknown');
    }
    for (const reason of ['future_reason', '__proto__', 'constructor', '<script>']) {
      const record = normalizeAuthFileCooldowns([{ ...model, reason }], receivedAtMs)!.records![0];
      expect(cooldownReasonKey(record.reason)).toBe('authFiles.health.reason.unknown');
    }
    expect(normalizeAuthFileCooldowns([
      { ...model, remaining_seconds: Number.MAX_SAFE_INTEGER },
    ], receivedAtMs)?.records).toBeNull();
  });
});
