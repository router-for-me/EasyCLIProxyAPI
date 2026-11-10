import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { setCurrentLocale } from '../src/i18n';
import { refreshModelCatalogs } from '../src/services/modelCatalogs';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';

describe('remote model catalog refresh', () => {
  let originalWindow: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: { location: { search: '' } }, writable: true, configurable: true });
    setCurrentLocale('en');
  });
  afterEach(() => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('posts through the authenticated management transport and preserves catalog metadata', async () => {
    const response = {
      ok: true, status: 'ok', changed_providers: ['codex', 'claude'],
      catalog: [{ id: 'new-model' }], codex_catalog: [], devin_catalog: [], sources: [], catalogs: [],
    };
    mockIPC((command, args) => {
      expect(command).toBe('management_request');
      expect(args?.request).toEqual({
        method: 'POST', path: '/models/refresh', query: undefined, body: undefined, timeoutMs: 120_000,
      });
      return response;
    });
    expect(await refreshModelCatalogs()).toEqual(response);
  });

  it('accepts omitted or null change lists as successful refreshes', async () => {
    for (const changed_providers of [undefined, null, []]) {
      mockIPC(() => ({ ok: true, status: 'ok', changed_providers }));
      expect((await refreshModelCatalogs()).ok).toBe(true);
    }
  });

  it('rejects failed or malformed responses instead of reporting success', async () => {
    for (const response of [null, {}, { ok: false, status: 'ok' }, { ok: true, status: 'failed' },
      { ok: true, status: 'ok', changed_providers: 'codex' },
      { ok: true, status: 'ok', changed_providers: [null] }]) {
      mockIPC(() => response);
      await expect(refreshModelCatalogs()).rejects.toThrow('invalid model catalog refresh response');
    }
    mockIPC(() => ({ ok: false, error: 'Catalog source is invalid' }));
    await expect(refreshModelCatalogs()).rejects.toThrow('Catalog source is invalid');
  });

  it('explains unsupported cores and preserves authentication and network failures', async () => {
    for (const status of [404, 405]) {
      mockIPC(() => { throw new Error(`Management API error (${status}): not found`); });
      await expect(refreshModelCatalogs()).rejects.toThrow('Update the core in Version Management');
    }
    for (const message of ['Management API error (401): unauthorized', 'Management API error (502): download failed', 'Request timed out']) {
      mockIPC(() => { throw message; });
      await expect(refreshModelCatalogs()).rejects.toBe(message);
    }
  });

  it('supports the refresh route in browser previews', async () => {
    const runtime = createBrowserMockRuntime('running');
    mockIPC((command, args) => runtime.invoke(command, args));
    expect(await refreshModelCatalogs()).toMatchObject({ ok: true, status: 'ok', changed_providers: [] });
  });
});
