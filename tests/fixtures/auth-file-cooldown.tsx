import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { AuthFileManagementPage } from '../../src/pages/AuthFileManagementPage';
import '../../src/styles/index.css';

// Fictional metadata only. All management IPC is handled locally by this fixture.
const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') || 'zh-CN');
document.documentElement.dataset.theme = params.get('theme') || 'light';
const startedAt = Date.now();
type MockFile = Record<string, unknown> & { name: string; cooldowns?: Record<string, unknown>[] | null };
type Request = { path: string; method: string; body?: Record<string, unknown> };
const timer = (seconds: number, model?: string, reason = 'quota', status = 429) => ({
  scope: model ? 'model' : 'credential', reason, model_key: model,
  retry_at: new Date(startedAt + seconds * 1000).toISOString(), remaining_seconds: seconds,
  http_status: status, backoff_level: 0,
});
const files: MockFile[] = [
  { name: '01-primary.json', auth_index: 'auth-primary-123', status: 'error', unavailable: true,
    status_message: 'quota exhausted', cooldowns: [timer(55), timer(55, 'gpt-fictional'), timer(180, 'claude-fictional', 'transient_error', 503)] },
  { name: '02-other.json', auth_index: 'auth-other-456', status: 'error',
    cooldowns: [timer(45, 'model-with-a-deliberately-long-name-for-responsive-wrapping-verification', 'model_not_supported', 404)] },
  { name: '03-disabled-runtime.json', auth_index: 'auth-runtime-789', status: 'disabled', disabled: true,
    runtime_only: true, cooldowns: [timer(120, 'runtime-model')] },
  { name: '04-expired-soon.json', auth_index: 'auth-expired-321', status: 'error', cooldowns: [timer(2, 'expired-model')] },
  { name: '05-empty.json', auth_index: 'auth-empty', status: 'active', cooldowns: [] },
  { name: '06-null.json', auth_index: 'auth-null', status: 'error', cooldowns: null },
  { name: '07-absent.json', auth_index: 'auth-absent', status: 'error' },
  { name: '08-no-index.json', status: 'error', cooldowns: [timer(120, 'missing-index-model')] },
];
const state = {
  files,
  reads: 0,
  resetRequests: [] as Request[],
  failReset: params.has('resetError'),
  releaseReset: undefined as (() => void) | undefined,
  holdNextRead: false,
  releaseRead: undefined as (() => void) | undefined,
  completedReads: 0,
};
(window as typeof window & { cooldownFixture: typeof state }).cooldownFixture = state;

mockIPC(async (cmd, args) => {
  if (cmd === 'set_app_locale') return null;
  if (cmd !== 'management_request') throw new Error(`Unhandled fixture command: ${cmd}`);
  const request = args?.request as Request;
  if (request.path === '/credentials' && request.method === 'GET') {
    state.reads += 1;
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const snapshot = {
      observed_at: new Date().toISOString(),
      files: state.files.map(file => ({
        provider: 'codex', source: 'file', size: 1024, updated_at: '2026-10-01T00:00:00Z',
        recent_requests: Array.from({ length: 20 }, (_, index) => ({
          time: `${String(8 + Math.floor(index / 6)).padStart(2, '0')}:${String(index % 6 * 10).padStart(2, '0')}`,
          success: index === 19 ? 0 : index === 18 ? 2 : 1,
          failed: index === 18 ? 1 : 0,
        })),
        success: 20, failed: 2, ...file,
        ...(Array.isArray(file.cooldowns) ? { cooldowns: file.cooldowns.map(record => ({
          ...record, remaining_seconds: Math.max(1, Number(record.remaining_seconds) - elapsed),
        })) } : {}),
      })),
    };
    if (state.holdNextRead) {
      state.holdNextRead = false;
      await new Promise<void>(resolve => { state.releaseRead = resolve; });
      state.releaseRead = undefined;
    }
    state.completedReads += 1;
    return snapshot;
  }
  if (request.path === '/routing/cooldown/reset' && request.method === 'POST') {
    state.resetRequests.push(structuredClone(request));
    await new Promise<void>(resolve => { state.releaseReset = resolve; });
    state.releaseReset = undefined;
    if (state.failReset) throw new Error('Fixture cooldown reset failed');
    const target = state.files.find(file => file.auth_index === request.body?.auth_index);
    if (!target) throw new Error('Fixture reset requires one known auth_index');
    target.cooldowns = [];
    target.unavailable = false;
    target.status_message = '';
    if (!target.disabled) target.status = 'active';
    return { status: 'ok', auth_index: target.auth_index, models: ['gpt-fictional', 'claude-fictional'] };
  }
  throw new Error(`Unhandled fixture request: ${request.method} ${request.path}`);
});

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <div className="app-shell">
      <aside className="sidebar" aria-hidden="true" />
      <div className="workspace"><main className="content"><AuthFileManagementPage /></main></div>
    </div>
  </I18nProvider>,
);
