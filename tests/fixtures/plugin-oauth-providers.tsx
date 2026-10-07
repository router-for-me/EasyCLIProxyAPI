import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { OAuthLoginPage } from '../../src/pages/ManagementPages';
import { notifyPluginResourcesChanged } from '../../src/services/pluginResources';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') ?? 'en');
localStorage.setItem('easy-cli-proxy-api.oauth-browser.v3', 'none');
document.documentElement.dataset.theme = params.get('theme') ?? 'light';

const plugin = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, path: `/plugins/${id}`, configured: true, registered: true,
  enabled: true, effective_enabled: true, supports_oauth: true, oauth_provider: id,
  supports_quota: false, logo: '', menus: [], config_fields: [],
  metadata: { name, version: '1.0.0', author: 'Fixture', logo: '', config_fields: [] },
  ...extra,
});

const installedPlugins = [plugin('zcode', 'ZCode'), plugin('codebuddy', 'CodeBuddy')];
const filteredPlugins = [
  plugin('disabled', 'Disabled provider', { enabled: false, effective_enabled: false }),
  plugin('unregistered', 'Unregistered provider', { registered: false, effective_enabled: false }),
  plugin('non-oauth', 'Non OAuth provider', { supports_oauth: false }),
  plugin('invalid', 'Invalid provider', { oauth_provider: '../unsafe' }),
  plugin('missing', 'Missing provider', { oauth_provider: '' }),
  plugin('zcode-duplicate', 'Duplicate ZCode', { oauth_provider: 'zcode' }),
  plugin('builtin-duplicate', 'Duplicate Codex', { oauth_provider: 'codex' }),
];
const fixture = {
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  plugins: params.has('empty') ? [] : params.has('pendingRegistration')
    ? [plugin('zcode', 'ZCode', { registered: false, effective_enabled: false })]
    : [...installedPlugins, ...filteredPlugins],
  installedPlugins,
  listCalls: 0,
  holdNextList: false,
  releaseList: null as (() => void) | null,
  releasedLists: 0,
  starts: 0,
  status: 'wait',
  cancelled: [] as string[],
  refresh: notifyPluginResourcesChanged,
};
Object.assign(window, { pluginOAuthProvidersFixture: fixture });

const nativeSetTimeout = window.setTimeout.bind(window);
window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
  nativeSetTimeout(handler, timeout === 3000 ? 25 : timeout, ...args)) as typeof window.setTimeout;

mockIPC(async (cmd, unknownArgs) => {
  const args = (unknownArgs ?? {}) as Record<string, unknown>;
  fixture.calls.push({ cmd, args });
  if (cmd === 'set_app_locale') return null;
  if (cmd === 'list_oauth_browsers') return [
    { id: 'default', label: 'System Default' }, { id: 'edge', label: 'Microsoft Edge' },
  ];
  if (cmd === 'get_plugin_support') return !params.has('unsupported');
  if (cmd === 'start_oauth_login') {
    const state = `plugin-session-${++fixture.starts}`;
    const device = args.provider === 'codebuddy';
    return {
      url: `https://login.example.test/authorize?state=${state}`,
      state, userCode: device ? 'BUDDY-CODE' : null,
      flow: device ? 'device' : 'authorization_code', expiresIn: 900, opened: false,
    };
  }
  if (cmd === 'get_oauth_status') return { status: fixture.status };
  if (cmd === 'submit_oauth_callback' || cmd === 'open_oauth_url') return null;
  if (cmd === 'management_request') {
    const request = args.request as { method: string; path: string; query?: Record<string, string> };
    if (request.path === '/plugins') {
      fixture.listCalls += 1;
      if (params.has('listError')) throw new Error('Fixture plugin list unavailable');
      const response = {
        plugins_enabled: true, plugins_dir: '/plugins', plugins: structuredClone(fixture.plugins),
      };
      if (fixture.holdNextList) {
        fixture.holdNextList = false;
        await new Promise<void>(resolve => {
          fixture.releaseList = () => { fixture.releaseList = null; fixture.releasedLists += 1; resolve(); };
        });
      }
      return response;
    }
    if (request.method === 'DELETE' && request.path === '/oauth/session') {
      fixture.cancelled.push(request.query?.state ?? '');
      return { status: 'ok', cancelled: true };
    }
    if (request.path === '/credentials') return { files: [] };
    throw new Error(`Unexpected management request: ${request.method} ${request.path}`);
  }
  throw new Error(`Unexpected command: ${cmd}`);
}, { shouldMockEvents: true });

createRoot(document.getElementById('root')!).render(
  <I18nProvider><main style={{ padding: 20 }}><OAuthLoginPage /></main></I18nProvider>,
);
