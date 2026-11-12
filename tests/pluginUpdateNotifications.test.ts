import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { normalizePluginList, normalizePluginStore } from '../src/services/plugins';
import {
  checkInstalledPluginUpdates, forgetUpdatedPlugins, mergeCheckedPluginUpdates,
  pluginUpdateIndicatorState, pruneKnownPluginUpdates, readKnownPluginUpdates,
  resetPluginUpdateNotifications, runStartupPluginUpdateCheck,
} from '../src/pluginUpdateModel';

const LOCAL = normalizePluginList({
  plugins_enabled: true,
  plugins: [
    { id: 'active-plugin', path: 'plugins/a.dll', registered: true, enabled: true, effective_enabled: true, metadata: { version: '1.0.0' } },
    { id: 'disabled-plugin', path: 'plugins/b.dll', registered: false, enabled: false, metadata: { version: '2.0.0' } },
    { id: 'config-only', path: '', configured: true, enabled: false },
  ],
}).plugins;

const STORE_ROWS = [
  { id: 'active-plugin', source_id: 'official', version: '1.1.0', installed: true, installed_version: '1.0.0', install_source_status: 'matched' },
  { id: 'disabled-plugin', source_id: 'official', version: '3.0.0', installed: true, installed_version: '2.0.0', install_source_status: 'matched' },
  { id: 'other-plugin', source_id: 'official', version: '9.0.0', installed: false },
];

const storeResponse = (rows: unknown[] = STORE_ROWS, sourceErrors: unknown[] = []) => ({ plugins: rows, source_errors: sourceErrors });

describe('plugin startup update notifications', () => {
  let originalWindow: PropertyDescriptor | undefined;
  let calls: { command: string; payload: unknown }[];
  beforeEach(() => {
    resetPluginUpdateNotifications();
    calls = [];
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  });
  afterEach(() => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  const mockBackend = (store: () => unknown = () => storeResponse()) => mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === 'get_plugin_support') return true;
    if (command === 'get_plugin_latest_releases') return [];
    if (command === 'management_request') {
      const path = (payload as { request: { path: string } }).request.path;
      if (path === '/plugins') {
        return {
          plugins_enabled: true,
          plugins: LOCAL.map((plugin) => ({
            id: plugin.id, path: plugin.path, configured: plugin.configured, registered: plugin.registered,
            enabled: plugin.enabled, effective_enabled: plugin.effectiveEnabled, metadata: plugin.metadata,
          })),
        };
      }
      if (path === '/plugins/store') return store();
    }
    throw new Error(`Unexpected command ${command}`);
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

  it('checks every installed plugin once and reports only newer versions', async () => {
    // Store rows without installed_version let the local plugin metadata decide.
    mockBackend(() => storeResponse([
      { id: 'active-plugin', source_id: 'official', version: '1.1.0', installed: true, install_source_status: 'matched' },
      { id: 'disabled-plugin', source_id: 'official', version: '3.0.0', installed: true, install_source_status: 'matched' },
    ]));
    const result = await checkInstalledPluginUpdates(LOCAL);
    expect(result?.plugins.map((entry) => entry.id).sort()).toEqual(['active-plugin', 'disabled-plugin']);
    expect(result?.plugins.every((entry) => entry.updateAvailable)).toBe(true);
    expect(calls.filter((call) => call.command === 'management_request' && (call.payload as { request: { path: string } }).request.path === '/plugins/store')).toHaveLength(1);
    expect(calls.filter((call) => call.command === 'get_plugin_latest_releases')).toHaveLength(0);
  });

  it('never marks equal or older versions as new', () => {
    mergeCheckedPluginUpdates(normalizePluginStore(storeResponse([
      { id: 'active-plugin', version: '1.0.0', installed: true, installed_version: '1.0.0', install_source_status: 'matched' },
      { id: 'disabled-plugin', version: '1.0.0', installed: true, installed_version: '2.0.0', install_source_status: 'matched' },
    ])));
    expect(pluginUpdateIndicatorState()).toBeNull();
  });

  it('makes no store request when nothing is installed', async () => {
    mockBackend();
    expect(await checkInstalledPluginUpdates([LOCAL[2]])).toBeNull();
    expect(calls.map((call) => call.command)).toEqual([]);
  });

  it('runs the startup check once and stays silent when the source fails', async () => {
    mockBackend(() => { throw new Error('store offline'); });
    runStartupPluginUpdateCheck();
    runStartupPluginUpdateCheck();
    await settle();
    expect(calls.filter((call) => call.command === 'management_request' && (call.payload as { request: { path: string } }).request.path === '/plugins')).toHaveLength(1);
    expect(readKnownPluginUpdates()).toEqual({});
    expect(pluginUpdateIndicatorState()).toBeNull();
  });

  it('records startup hits and clears them after an update or uninstall', async () => {
    mockBackend(() => storeResponse([
      { id: 'active-plugin', source_id: 'official', version: '1.1.0', installed: true, install_source_status: 'matched' },
      { id: 'disabled-plugin', source_id: 'official', version: '3.0.0', installed: true, install_source_status: 'matched' },
    ]));
    runStartupPluginUpdateCheck();
    await settle();
    expect(readKnownPluginUpdates()).toEqual({ 'active-plugin': '1.1.0', 'disabled-plugin': '3.0.0' });
    expect(pluginUpdateIndicatorState()).toBe('available');
    forgetUpdatedPlugins(['active-plugin']);
    expect(readKnownPluginUpdates()).toEqual({ 'disabled-plugin': '3.0.0' });
    pruneKnownPluginUpdates(['active-plugin']);
    expect(readKnownPluginUpdates()).toEqual({});
    expect(pluginUpdateIndicatorState()).toBeNull();
  });

  it('keeps a known update when its source fails and clears it on a clean check', async () => {
    const hit = normalizePluginStore(storeResponse([
      { id: 'disabled-plugin', source_id: 'official', version: '3.0.0', installed: true, installed_version: '1.0.0', install_source_status: 'matched' },
    ]));
    mergeCheckedPluginUpdates({ ...hit, plugins: hit.plugins.map((entry) => ({ ...entry, updateAvailable: true })) });
    mergeCheckedPluginUpdates(normalizePluginStore(storeResponse([
      { id: 'disabled-plugin', source_id: 'official', version: '', installed: true, installed_version: '2.0.0', install_source_status: 'matched' },
    ], [{ source_id: 'official', message: 'offline' }])));
    expect(readKnownPluginUpdates()).toEqual({ 'disabled-plugin': '3.0.0' });
    mergeCheckedPluginUpdates(normalizePluginStore(storeResponse([
      { id: 'disabled-plugin', source_id: 'official', version: '2.0.0', installed: true, installed_version: '2.0.0', install_source_status: 'matched' },
    ])));
    expect(readKnownPluginUpdates()).toEqual({});
  });
});