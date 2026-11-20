import '../../src/styles/layers.css';
import '../../src/styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import App from '../../src/App';
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
const calls: string[] = [];
const controls = { offline: false, unconfirmed: false, localRunning: false };
let nextSnapshot = 0;
let lastRead: { id: number; keys: string } | undefined;
Object.assign(window, { isTauri: true, remoteTestCalls: calls, remoteTestKeys: keys, remoteTestControls: controls });
const assertCandidate = (endpoint: string, key: string) => {
  if (!key && endpoint !== connection.endpoint) throw 'keyRequired';
  if (key && endpoints.get(endpoint) !== key) throw 'notAuthorized';
};

mockWindows('main');
mockIPC((command, payload) => {
  if (!command.startsWith('plugin:')) calls.push(command);
  const args = payload as { revision: number; endpoint: string; key: string; remote: boolean; keys: string[]; snapshot: number };
  switch (command) {
    case 'get_cpa_connection': return { ...connection };
    case 'test_remote_cpa': assertCandidate(args.endpoint, args.key); return null;
    case 'select_cpa_connection':
      if (args.remote) {
        assertCandidate(args.endpoint, args.key);
        if (!connection.remoteActive && controls.localRunning) throw 'localRunning';
      }
      if (!args.remote && (args.endpoint || args.key)) throw new Error('Local switch passed remote keys');
      connection.remoteSelected = args.remote;
      connection.endpoint = args.remote ? args.endpoint : null;
      if (args.remote) sessionStorage.setItem('remote-selected', args.endpoint);
      else sessionStorage.removeItem('remote-selected');
      connection.revision++;
      lastRead = undefined;
      return { ...connection };
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
void window.__TAURI_INTERNALS__.invoke('get_cpa_connection').then(initialConnection => createRoot(document.getElementById('root')!).render(<StrictMode><I18nProvider syncNativeLocale={false}><App initialConnection={initialConnection as CpaConnection} /></I18nProvider></StrictMode>));
