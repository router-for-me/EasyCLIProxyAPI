import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { PluginOAuthDialog } from '../../src/pages/PluginOAuthDialog';
import type { PluginListEntry } from '../../src/services/plugins';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') ?? 'en');
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
const nativeSetTimeout = window.setTimeout.bind(window);
window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => nativeSetTimeout(handler, timeout === 3000 ? 25 : timeout, ...args)) as typeof window.setTimeout;
const fixture = {
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  starts: 0, completed: 0, polls: 0,
  status: 'wait',
  cancelled: [] as string[],
  copied: [] as string[],
  releaseStart: null as (() => void) | null,
  releaseStatus: null as (() => void) | null,
  unmount: () => {},
};
Object.assign(window, { pluginOAuthFixture: fixture });
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { fixture.copied.push(value); } } });
mockIPC(async (cmd, unknownArgs) => {
  const args = (unknownArgs ?? {}) as Record<string, unknown>;
  fixture.calls.push({ cmd, args });
  if (cmd === 'start_oauth_login') {
    const attempt = ++fixture.starts;
    if (params.has('startError') && attempt === 1) throw new Error('Fixture start error');
    const result = {
      url: params.has('invalidUrl') ? 'javascript:alert(1)' : `https://login.example.test/authorize?state=plugin-${attempt}`,
      state: params.has('missingState') ? null : `plugin-${attempt}`,
      userCode: params.has('device') ? 'ABCD-EFGH' : null,
      flow: params.has('device') ? 'device' : 'authorization_code',
      expiresIn: params.has('expiry') ? 1 : 900,
      opened: true, openError: null,
    };
    if (params.has('holdStart')) await new Promise<void>(resolve => { fixture.releaseStart = resolve; });
    return result;
  }
  if (cmd === 'get_oauth_status') {
    fixture.polls += 1;
    if (params.has('holdStatus')) await new Promise<void>(resolve => { fixture.releaseStatus = resolve; });
    if (params.has('pollError')) throw new Error('Fixture poll error');
    return { status: fixture.status, error: fixture.status === 'error' ? 'Fixture authorization denied' : null };
  }
  if (cmd === 'management_request') {
    const request = args.request as { method: string; path: string; query: { state: string } };
    if (request.method === 'DELETE' && request.path === '/oauth/session') fixture.cancelled.push(request.query.state);
    return { status: 'ok', cancelled: true };
  }
  if (cmd === 'open_oauth_url' && params.has('openError')) throw new Error('Fixture browser error');
  return null;
});
const plugin: PluginListEntry = {
  id: 'test-plugin', path: '/plugins/test', configured: true, registered: true,
  enabled: true, effectiveEnabled: !params.has('disabled'), supportsOAuth: true,
  oauthProvider: 'grok', supportsQuota: false, logo: '', menus: [], metadata: null, configFields: [],
};
function Fixture() {
  const [open, setOpen] = useState(false);
  fixture.unmount = () => setOpen(false);
  return <I18nProvider><button type="button" onClick={() => setOpen(true)}>Open plugin login</button>
    {open ? <PluginOAuthDialog plugin={plugin} onClose={() => setOpen(false)} onCompleted={() => { fixture.completed += 1; }} /> : null}
  </I18nProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
