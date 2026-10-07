import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { I18nProvider } from '../../src/i18n';
import { CoreRuntimeProvider } from '../../src/coreRuntime';
import { AppUpdateProvider } from '../../src/appUpdate';
import { KernelPage } from '../../src/pages/Kernel';
import { CoreHealthPanel } from '../../src/pages/CoreHealthPanel';
import { createBrowserMockRuntime } from '../../src/mocks/browserMockRuntime';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') || 'en');
document.documentElement.dataset.theme = params.get('theme') || 'light';
const runtime = createBrowserMockRuntime(params.has('offline') ? 'stopped' : 'running', (event, payload) => { void emit(event, payload); });
const initialModels = ['gpt-5.2-codex', 'claude-sonnet-4-6', 'gemini-3-pro', 'deepseek-chat', 'custom/team-alias', 'long-provider/llama-4-scout-instruct-with-a-long-model-name']
  .map((name) => ({ name }));
const fixture = {
  calls: [] as Array<{ cmd: string; args: any; at: number }>,
  copied: [] as string[],
  models: initialModels,
  modelError: params.has('modelError') ? 'Fixture model list unavailable' : '',
  holdModels: params.has('loading'),
  modelReleases: [] as Array<() => void>,
  holdProbes: false,
  probeReleases: [] as Array<() => void>,
  probeFailures: {} as Record<string, string>,
  usageError: params.has('usageError'),
  keyError: params.has('keyError'),
  key: params.has('noKey') ? '' : 'test-client-access-key-never-real',
  port: 8317,
  refreshPanel: () => {},
  resolvePanel: () => {},
  changeConfig: () => { fixture.port += 1; return emit('config-files-changed', {}); },
  releaseModels: () => { fixture.holdModels = false; fixture.modelReleases.splice(0).forEach((release) => release()); },
  releaseProbes: () => { fixture.holdProbes = false; fixture.probeReleases.splice(0).forEach((release) => release()); },
};
Object.assign(window, { homeFixture: fixture });
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (value: string) => { fixture.copied.push(value); } },
});

mockIPC(async (cmd, args: any = {}) => {
  fixture.calls.push({ cmd, args, at: Date.now() });
  if (cmd === 'get_gui_settings') return { host: '127.0.0.1', port: fixture.port, runOnStartup: false };
  if (cmd === 'get_core_config_settings') {
    if (fixture.keyError) throw new Error('Fixture key unavailable');
    return { apiKeys: fixture.key ? [{ apiKey: fixture.key }] : [] };
  }
  if (cmd === 'get_core_tls_settings') return { enabled: params.has('tls'), cert: '', key: '' };
  if (cmd === 'get_usage_overview') {
    if (fixture.usageError) throw new Error('Fixture usage unavailable');
    if (params.has('noRequests')) return { totalRequests: 0, successCount: 0, failureCount: 0, canceledCount: 0, successRate: 0 };
    return { totalRequests: 503, successCount: 492, failureCount: 11, canceledCount: 0, successRate: 0 };
  }
  if (cmd === 'management_request' && args.request.path === '/credentials') {
    if (params.has('noCredentials')) return { files: [] };
    if (params.has('unknownCredentials')) return { files: Array.from({ length: 11 }, (_, index) => ({
      name: `oauth-${index}.json`, provider: 'codex', source: 'file', status: 'refreshing',
    })) };
    return { files: Array.from({ length: 11 }, (_, index) => ({
      name: `oauth-${index}.json`, provider: 'codex', source: 'file', status: 'active', disabled: index >= 5,
    })) };
  }
  if (cmd === 'management_request' && args.request.path === '/config/api-keys') {
    return { openai: [{ keys: [{ 'api-key': 'fixture-provider-key-a' }, { 'api-key': '' }] }], claude: [{ keys: [{ 'api-key': 'fixture-provider-key-b' }] }] };
  }
  if (cmd === 'get_core_models') {
    if (fixture.holdModels) await new Promise<void>((resolve) => { fixture.modelReleases.push(resolve); });
    if (fixture.modelError) throw new Error(fixture.modelError);
    return structuredClone(fixture.models);
  }
  if (cmd === 'core_health_probe') {
    const failure = fixture.probeFailures[args.model];
    if (fixture.holdProbes) await new Promise<void>((resolve) => { fixture.probeReleases.push(resolve); });
    if (failure) throw new Error(failure);
    return { firstTokenLatencyMs: 184, responseLatencyMs: 642 };
  }
  return runtime.invoke(cmd, args);
}, { shouldMockEvents: true });

function PanelHarness() {
  const [models, setModels] = useState(initialModels);
  const [loading, setLoading] = useState(false);
  fixture.refreshPanel = () => { setModels((current) => current.map((model) => ({ ...model }))); setLoading(true); };
  fixture.resolvePanel = () => { setModels((current) => current.map((model) => ({ ...model }))); setLoading(false); };
  return <CoreHealthPanel coreReady models={models} modelsLoading={loading} modelsError="" contextKey="stable-fixture" onRefreshModels={fixture.refreshPanel} />;
}

createRoot(document.getElementById('root')!).render(
  <I18nProvider><AppUpdateProvider><CoreRuntimeProvider>
    <div className="app-shell">
      <aside className="sidebar" aria-hidden="true"><strong>EasyCLIProxyAPI</strong><span>Desktop console</span></aside>
      <div className="workspace"><main className="content">{params.get('view') === 'panel' ? <PanelHarness /> : <KernelPage />}</main></div>
    </div>
  </CoreRuntimeProvider></AppUpdateProvider></I18nProvider>,
);
