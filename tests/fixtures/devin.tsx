import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { OAuthLoginPage } from '../../src/pages/ManagementPages';
import { QuotaPage } from '../../src/pages/QuotaPage';
import { AuthFileManagementPage } from '../../src/pages/AuthFileManagementPage';
import { EasyModePage } from '../../src/pages/EasyModePage';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
const view = params.get('view');
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') ?? 'en');
localStorage.setItem('easy-cli-proxy-api.oauth-browser.v3', 'none');
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
const file = { name: 'devin-test.json', provider: 'devin', auth_index: 'devin-index', status: 'active' };
const fixture = {
  calls: [] as Array<{ cmd: string; args: any }>,
  attempts: 0,
  status: 'wait',
  cancelError: false,
  quotaError: false,
  holdStatus: false,
  releaseStatus: null as null | (() => void),
  files: view === 'quota' || view === 'files' ? [file] : [] as typeof file[],
};
Object.assign(window, { devinFixture: fixture });
mockIPC(async (cmd, args: any) => {
  fixture.calls.push({ cmd, args });
  if (cmd === 'set_app_locale') return null;
  if (cmd === 'list_oauth_browsers') return [{ id: 'default', label: 'System Default' }];
  if (cmd === 'start_oauth_login') {
    fixture.attempts++;
    fixture.status = 'wait';
    return { url: 'https://auth.devin.ai/authorize?state=attempt-' + fixture.attempts, state: 'attempt-' + fixture.attempts, opened: true };
  }
  if (cmd === 'get_oauth_status') {
    if (fixture.holdStatus) {
      fixture.holdStatus = false;
      return new Promise((resolve) => { fixture.releaseStatus = () => resolve({ status: 'ok' }); });
    }
    if (fixture.status === 'ok') fixture.files = [file];
    return { status: fixture.status };
  }
  if (cmd === 'submit_oauth_callback') { fixture.status = 'ok'; return null; }
  if (cmd === 'open_oauth_url') return null;
  if (cmd === 'management_request') {
    const request = args.request;
    if (request.path === '/auth-files') return { files: fixture.files };
    if (request.path === '/config') return {};
    if (request.path === '/auth-files/fields') return {};
    if (request.path === '/oauth-session') {
      if (fixture.cancelError) throw new Error('Cancellation failed');
      return { status: 'ok', cancelled: true };
    }
    if (request.path === '/api-call') return fixture.quotaError
      ? { status_code: 401, body: { error: 'Session expired' } }
      : { status_code: 200, body: { userStatus: { planStatus: {
        dailyQuotaRemainingPercent: 75, weeklyQuotaRemainingPercent: 0,
        dailyQuotaResetAtUnix: '1893456000', weeklyQuotaResetAtUnix: '1893542400',
        planInfo: { planName: 'Pro' }, planEnd: '2030-02-01T00:00:00Z',
      } } } };
  }
  throw new Error('Unexpected command: ' + cmd + ' ' + JSON.stringify(args));
}, { shouldMockEvents: true });
createRoot(document.getElementById('root')!).render(<I18nProvider><main style={{ padding: 24 }}>
  {view === 'quota' ? <QuotaPage /> : view === 'files' ? <AuthFileManagementPage /> : view === 'easy' ? <EasyModePage /> : <OAuthLoginPage />}
</main></I18nProvider>);
