import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { OAuthLoginPage } from '../../src/pages/ManagementPages';
import { EasyModePage } from '../../src/pages/EasyModePage';
import '../../src/styles/index.css';

type MetaStatus = 'wait' | 'ok' | 'error';

type MetaFixture = {
  calls: Array<{ cmd: string; args: any }>;
  attempts: number;
  status: MetaStatus;
  statusCalls: number;
  holdStatus: boolean;
  releaseStatus: null | (() => void);
  cancelledStates: string[];
  priorityPatches: Array<{ name: string; priority: number }>;
  files: Array<Record<string, unknown>>;
  currentState: string;
  copied: string[];
  clockOffsetMs: number;
};

const params = new URLSearchParams(location.search);
const view = params.get('view');
const locale = params.get('locale') ?? 'en';
localStorage.setItem('easy-cli-proxy-api.locale', locale);
localStorage.setItem('easy-cli-proxy-api.oauth-browser.v3', 'none');
document.documentElement.dataset.theme = params.get('theme') ?? 'light';

// Keep OAuth polling quick in this fixture while preserving the production timer behavior.
const nativeSetInterval = window.setInterval.bind(window);
const nativeSetTimeout = window.setTimeout.bind(window);
(window as any).setInterval = (handler: TimerHandler, timeout?: number, ...args: any[]) =>
  nativeSetInterval(handler, timeout === 3000 ? 25 : timeout, ...args);
(window as any).setTimeout = (handler: TimerHandler, timeout?: number, ...args: any[]) =>
  nativeSetTimeout(handler, timeout === 1500 ? 25 : timeout, ...args);

const fixture: MetaFixture = {
  calls: [],
  attempts: 0,
  status: 'wait',
  statusCalls: 0,
  holdStatus: false,
  releaseStatus: null,
  cancelledStates: [],
  priorityPatches: [],
  files: params.has('kimiAi') ? [{ name: 'kimi-ai-existing.json', provider: 'kimi-ai', status: 'active' }] : [],
  currentState: '',
  copied: [],
  clockOffsetMs: 0,
};
Object.assign(window, { metaFixture: fixture });
const nativeDateNow = Date.now.bind(Date);
Date.now = () => nativeDateNow() + fixture.clockOffsetMs;

const credentialForAttempt = (attempt: number) => ({
  name: `meta-oauth-${attempt}.json`,
  provider: 'meta',
  auth_index: `meta-${attempt}`,
  status: 'active',
});

mockIPC(async (cmd, args: any = {}) => {
  fixture.calls.push({ cmd, args });
  if (cmd === 'set_app_locale') return null;
  if (cmd === 'list_oauth_browsers') {
    return [{ id: 'default', label: 'System Default' }];
  }
  if (cmd === 'start_oauth_login') {
    fixture.attempts += 1;
    fixture.status = 'wait';
    fixture.statusCalls = 0;
    fixture.currentState = `meta-attempt-${fixture.attempts}`;
    return {
      url: `https://auth.meta.ai/device?state=${fixture.currentState}`,
      state: fixture.currentState,
      opened: !params.has('openError'),
      openError: params.has('openError') ? 'Fixture browser open failed' : null,
      userCode: `META-CODE-${fixture.attempts}`,
      flow: 'device',
      expiresIn: 900,
    };
  }
  if (cmd === 'get_oauth_status') {
    fixture.statusCalls += 1;
    const state = String(args.state ?? '');
    if (fixture.holdStatus && state === 'meta-attempt-1') {
      fixture.holdStatus = false;
      return new Promise((resolve) => {
        fixture.releaseStatus = () => resolve({ status: 'ok' });
      });
    }
    if (fixture.status === 'ok') {
      const generated = credentialForAttempt(Number(state.split('-').pop()) || fixture.attempts);
      if (!fixture.files.some((file) => file.name === generated.name)) fixture.files.push(generated);
      return { status: 'ok' };
    }
    if (fixture.status === 'error') return { status: 'error', error: 'Meta authorization failed' };
    return { status: 'wait' };
  }
  if (cmd === 'open_oauth_url') return null;
  if (cmd === 'management_request') {
    const request = args.request ?? {};
    if (request.path === '/credentials') return { files: fixture.files };
    if (request.path === '/credentials/fields') {
      const body = request.body ?? {};
      const patch = { name: String(body.name ?? ''), priority: Number(body.priority) };
      fixture.priorityPatches.push(patch);
      const file = fixture.files.find((item) => item.name === patch.name);
      if (file) file.priority = patch.priority;
      return {};
    }
    if (request.path === '/oauth/session') {
      const state = String(request.query?.state ?? '');
      fixture.cancelledStates.push(state);
      return { status: 'ok', cancelled: true };
    }
    if (request.path === '/config') return {};
    if (request.path.startsWith('/config/api-keys/')) return [];
    throw new Error(`Unexpected management request: ${request.method} ${request.path}`);
  }
  throw new Error('Unexpected command: ' + cmd + ' ' + JSON.stringify(args));
}, { shouldMockEvents: true });

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <main style={{ padding: 24 }}>
      {view === 'easy' ? <EasyModePage /> : <OAuthLoginPage />}
    </main>
  </I18nProvider>,
);
