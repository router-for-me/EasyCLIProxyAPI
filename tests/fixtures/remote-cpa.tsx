import nativeMain from '../../src-tauri/src/main.rs?raw';
import '../../src/styles/layers.css';
import '../../src/styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import App from '../../src/App';
import { initializeWindowActivity } from '../../src/services/windowActivity';
import { I18nProvider } from '../../src/i18n';
import { createBrowserMockRuntime } from '../../src/mocks/browserMockRuntime';
import { localCpaConnection, type CpaConnection } from '../../src/services/remoteCpa';

const endpointA = 'http://127.0.0.1:8888/';
const endpointB = 'https://management-gateway-with-a-long-test-subdomain.for-a-private-network.example.test/team/';
const endpoints = new Map([[endpointA, 'first-management'], [endpointB, 'second-management']]);
const keys = new Map([[endpointA, ['first-client']], [endpointB, ['second-client']]]);
const runtime = createBrowserMockRuntime('running');
const selected = sessionStorage.getItem('remote-selected');
const connection: CpaConnection = selected
  ? { ...localCpaConnection, remoteActive: true, remoteSelected: true, endpoint: selected }
  : { ...localCpaConnection };
connection.savedEndpoints = JSON.parse(sessionStorage.getItem('external-instances') ?? '[]');
const remoteCommands = new Set(nativeMain.split('let remote_handler = target_commands![')[1].split('];')[0].split(',').map(item => item.trim().split('::').pop()));
const calls: string[] = [];
const controls = { offline: false, unconfirmed: false, failRefresh: false, localRunning: false };
let nextSnapshot = 0;
let lastRead: { id: number; keys: string } | undefined;
Object.assign(window, { isTauri: true, remoteTestCalls: calls, remoteTestKeys: keys, remoteTestControls: controls });
const assertCandidate = (endpoint: string, key: string) => {
  if (!key && !connection.savedEndpoints?.includes(endpoint)) throw 'keyRequired';
  if (key && endpoints.get(endpoint) !== key) throw 'notAuthorized';
};

mockWindows('main');
mockIPC(async (command, payload) => {
  if (!command.startsWith('plugin:')) calls.push(command);
  if (connection.remoteSelected && !command.startsWith('plugin:') && !remoteCommands.has(command)) throw new Error(`External dispatch rejected: ${command}`);
  const args = payload as { revision: number; endpoint: string; key: string; remote: boolean; keys: string[]; snapshot: number };
  if (command === 'refresh_agent_config_statuses' && controls.failRefresh) { controls.failRefresh = false; throw new Error('Fixture refresh failure'); }
  if (['get_usage_events','get_usage_analysis','get_usage_overview','get_usage_collector_status','shrink_usage_database'].includes(command) && (payload as {targetRevision?: number})?.targetRevision !== connection.revision) throw new Error('Missing or stale usage target revision');
  const request = (payload as { request?: { path: string; targetRevision: number } })?.request;
  if (connection.remoteSelected && command === 'management_request' && request?.path === '/config/config-version') {
    if (request.targetRevision !== connection.revision || controls.offline) throw 'unreachable';
    return 8;
  }
  if (connection.remoteSelected && command === 'management_request' && request?.path === '/observability/logs') {
    if (request.targetRevision !== connection.revision) throw 'endpointChanged';
    return { lines: [`fixture log: ${connection.endpoint}`] };
  }
  if (connection.remoteSelected && /^(get_|create_|delete_).*(alias|aliases)/.test(command) && (payload as { targetRevision?: number })?.targetRevision !== connection.revision) throw 'endpointChanged';
  switch (command) {
    case 'get_cpa_connection': return { ...connection };
    case 'test_remote_cpa': assertCandidate(args.endpoint, args.key); return null;
    case 'forget_cpa_instance':
      connection.savedEndpoints = connection.savedEndpoints!.filter(item => item !== args.endpoint);
      sessionStorage.setItem('external-instances', JSON.stringify(connection.savedEndpoints));
      connection.revision++;
      return { ...connection };
    case 'select_cpa_connection':
      if (args.remote) {
        assertCandidate(args.endpoint, args.key);
        connection.savedEndpoints = [...new Set([...connection.savedEndpoints!, args.endpoint])];
        sessionStorage.setItem('external-instances', JSON.stringify(connection.savedEndpoints));
        controls.localRunning = false;
      }
      if (!args.remote && (args.endpoint || args.key)) throw new Error('Local switch passed remote keys');
      controls.localRunning = !args.remote;
      connection.remoteSelected = args.remote;
      connection.endpoint = args.remote ? args.endpoint : null;
      if (args.remote) sessionStorage.setItem('remote-selected', args.endpoint);
      else sessionStorage.removeItem('remote-selected');
      connection.revision++;
      lastRead = undefined;
      connection.remoteActive = args.remote;
      return { ...connection };
    case 'remote_core_settings': {
      const { operation, args: values } = payload as { operation: string; args: { apiKey?: string } };
      if (!connection.remoteActive || args.revision !== connection.revision) throw new Error('stale target');
      const remoteKeys = keys.get(connection.endpoint!)!;
      if (operation === 'add_core_api_key') remoteKeys.push(values.apiKey!);
      if (operation === 'add_core_api_key' || operation === 'get_core_config_settings') {
        const config = await runtime.invoke('get_core_config_settings', {}) as Record<string, unknown>;
        return { ...config, apiKeys: remoteKeys.map(apiKey => ({ apiKey, remark: '' })) };
      }
      return runtime.invoke(operation, values);
    }
    case 'get_remote_cpa_keys': {
      lastRead = undefined;
      if (controls.offline) throw 'unreachable';
      if (args.revision !== connection.revision) throw 'endpointChanged';
      const loaded = keys.get(connection.endpoint!)!;
      lastRead = { id: ++nextSnapshot, keys: JSON.stringify(loaded) };
      return { keys: [...loaded], snapshot: lastRead.id };
    }
    case 'save_remote_cpa_keys': {
      const loaded = lastRead;
      lastRead = undefined;
      if (args.revision !== connection.revision || !loaded || args.snapshot !== loaded.id
        || loaded.keys !== JSON.stringify(keys.get(connection.endpoint!))) throw 'conflict';
      keys.set(connection.endpoint!, args.keys);
      if (controls.unconfirmed) { controls.unconfirmed = false; throw 'saveUnconfirmed'; }
      return null;
    }
    case 'get_linux_system_theme': return 'light';
    default: return runtime.invoke(command, payload);
  }
}, { shouldMockEvents: true });
void initializeWindowActivity();
void window.__TAURI_INTERNALS__.invoke('get_cpa_connection').then(initialConnection => createRoot(document.getElementById('root')!).render(<StrictMode><I18nProvider syncNativeLocale={false}><App initialConnection={initialConnection as CpaConnection} /></I18nProvider></StrictMode>));
