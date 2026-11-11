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
    const commands: string[] = [];
    mockIPC((command, args) => {
      commands.push(command);
      if (command === 'refresh_managed_codex_model_catalog') return true;
      expect(command).toBe('management_request');
      expect(args?.request).toEqual({
        method: 'POST', path: '/models/refresh', query: undefined, body: undefined, timeoutMs: 120_000,
      });
      return response;
    });
    expect(await refreshModelCatalogs()).toEqual(response);
    expect(commands).toEqual(['management_request', 'refresh_managed_codex_model_catalog']);
  });

  it('accepts omitted or null change lists as successful refreshes', async () => {
    for (const changed_providers of [undefined, null, []]) {
      const commands: string[] = [];
      mockIPC((command) => {
        commands.push(command);
        return command === 'management_request' ? { ok: true, status: 'ok', changed_providers } : false;
      });
      expect((await refreshModelCatalogs()).ok).toBe(true);
      expect(commands).toEqual(['management_request', 'refresh_managed_codex_model_catalog']);
    }
  });

  it('rejects failed or malformed responses instead of reporting success', async () => {
    for (const response of [null, {}, { ok: false, status: 'ok' }, { ok: true, status: 'failed' },
      { ok: true, status: 'ok', changed_providers: 'codex' },
      { ok: true, status: 'ok', changed_providers: [null] }]) {
      const commands: string[] = [];
      mockIPC((command) => { commands.push(command); return response; });
      await expect(refreshModelCatalogs()).rejects.toThrow('invalid model catalog refresh response');
      expect(commands).toEqual(['management_request']);
    }
    mockIPC(() => ({ ok: false, error: 'Catalog source is invalid' }));
    await expect(refreshModelCatalogs()).rejects.toThrow('Catalog source is invalid');
  });

  it('waits for the core refresh before synchronizing the installed Codex catalog', async () => {
    const commands: string[] = [];
    let complete!: (value: unknown) => void;
    mockIPC((command) => {
      commands.push(command);
      if (command === 'management_request') return new Promise((resolve) => { complete = resolve; });
      return true;
    });
    const refresh = refreshModelCatalogs();
    expect(commands).toEqual(['management_request']);
    complete({ ok: true, status: 'ok' });
    await refresh;
    expect(commands).toEqual(['management_request', 'refresh_managed_codex_model_catalog']);
  });

  it('reports a Codex synchronization failure after a successful core refresh', async () => {
    mockIPC((command) => {
      if (command === 'management_request') return { ok: true, status: 'ok' };
      throw new Error('Unable to write Codex catalog');
    });
    await expect(refreshModelCatalogs()).rejects.toThrow(
      'Core model catalogs refreshed, but the Codex model catalog could not be synchronized: Unable to write Codex catalog',
    );
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
