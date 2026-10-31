import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { PluginConfigDialog } from '../../src/pages/PluginConfigDialog';
import { pluginsApi, type PluginConfigObject, type PluginListEntry } from '../../src/services/plugins';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') ?? 'en');
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
mockIPC(() => null);
const fixture = {
  loads: 0,
  saved: 0,
  patches: [] as PluginConfigObject[],
  options: [] as unknown[],
  holdSave: false,
  releaseSave: null as null | (() => void),
};
Object.assign(window, { pluginConfigFixture: fixture });
const config: PluginConfigObject = {
  enabled: true, priority: 4, token: ' keep spaces ', retries: 2, timeout: 0.5,
  active: false, modes: ['chat'], headers: { old: 'value' }, algorithm: 'fast',
  undeclared: { preserved: true },
};
pluginsApi.getConfig = async () => {
  fixture.loads += 1;
  if (params.has('loadError') && fixture.loads === 1) throw new Error('Fixture load failure');
  return { ...config };
};
pluginsApi.patchConfig = async (_id, patch, options) => {
  fixture.patches.push(patch);
  fixture.options.push(options);
  if (fixture.holdSave) await new Promise<void>(resolve => { fixture.releaseSave = resolve; });
  return { ...config, ...patch };
};
const plugin: PluginListEntry = {
  id: 'test-plugin', path: '/plugins/test', configured: true, registered: true,
  enabled: true, effectiveEnabled: true, supportsOAuth: false, supportsQuota: false, logo: '', menus: [], metadata: null,
  configFields: params.has('raw') ? [] : [
    ['token', 'string'], ['retries', 'integer'], ['timeout', 'number'], ['active', 'boolean'],
    ['modes', 'array'], ['headers', 'object'], ['algorithm', 'enum'], ['inherited', 'boolean'],
  ].map(([name, type]) => ({ name, type, description: `${name} configuration`, enumValues: type === 'enum' ? ['fast', 'accurate'] : [] })),
};

function Fixture() {
  const [open, setOpen] = useState(false);
  return <I18nProvider><button type="button" onClick={() => setOpen(true)}>Open configuration</button>
    {open ? <PluginConfigDialog plugin={plugin} onClose={() => setOpen(false)} onSaved={() => { fixture.saved += 1; }} /> : null}
  </I18nProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
