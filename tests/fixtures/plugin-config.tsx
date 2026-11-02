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
if (params.has('semanticRouter')) {
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, {
    enabled: true, alias: 'semantic-auto', timeout_ms: 3000,
    classifier: { provider: 'openai-compatible-local', model: 'classifier' },
    fallback: { provider: 'openai-compatible-local', model: 'general' },
    candidates: [
      { provider: 'openai-compatible-local', model: 'coder', description: '程序设计、调试和代码审查' },
      { provider: 'openai-compatible-local', model: 'writer', description: '翻译、文学创作和文案写作' },
    ],
  });
}
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
if (params.has('semanticRouter')) {
  plugin.id = 'semantic-router';
  plugin.configFields = [
    ['alias', 'string', '自动路由别名（勿用内核保留名 auto）/ Exact alias, not reserved name auto'],
    ['classifier', 'object', '分类模型 / Existing classifier: {"provider":"openai-compatible-local","model":"classifier"}'],
    ['fallback', 'object', '安全回退 / Existing fallback: {"provider":"openai-compatible-local","model":"general"}'],
    ['candidates', 'array', '候选模型及语义描述 / Existing candidates: [{"provider":"openai-compatible-local","model":"coder","description":"编程任务"}]'],
    ['timeout_ms', 'integer', '分类等待上限，50–30000 毫秒 / Classifier wait timeout (ms)'],
  ].map(([name, type, description]) => ({ name, type, description, enumValues: [] }));
}

function Fixture() {
  const [open, setOpen] = useState(false);
  return <I18nProvider><button type="button" onClick={() => setOpen(true)}>Open configuration</button>
    {open ? <PluginConfigDialog plugin={plugin} onClose={() => setOpen(false)} onSaved={() => { fixture.saved += 1; }} /> : null}
  </I18nProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
