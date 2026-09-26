import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { AuthFileManagementPage } from '../../src/pages/AuthFileManagementPage';
import { QuotaPage } from '../../src/pages/QuotaPage';
import { updateQuotaCache } from '../../src/services/quotaCache';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') || 'zh-CN');
document.documentElement.dataset.theme = params.get('theme') || 'light';

let refreshCount = 0;
let resetCount = 0;
const metadata: Record<string, Record<string, unknown>> = {};
const settingsFor = (name: string) => metadata[name] ??= {
  prefix: 'team', proxy_url: '', priority: 3, weight: 2, disable_cooling: false,
  websockets: true, excluded_models: ['gpt-old-*'], headers: { 'X-Team': 'demo' }, note: '开发环境 · 主用凭证',
};
const cardFiles = [
  { name: 'codex-demo.json', provider: 'codex', auth_index: 'demo', email: 'demo@example.com', status: 'active', cooldowns: [] },
  { name: 'claude-idle.json', provider: 'claude', auth_index: 'idle', email: 'developer@example.com', status: 'error', unavailable: true, status_message: 'Rate limit exceeded', cooldowns: [{ scope: 'model', reason: 'quota', model_key: 'claude-example', remaining_seconds: 620, retry_at: new Date(Date.now() + 620_000).toISOString(), http_status: 429 }] },
  { name: 'codex-disabled.json', provider: 'codex', auth_index: 'disabled', disabled: true, status: 'disabled', cooldowns: [] },
  { name: 'runtime.json', provider: 'codex', auth_index: 'runtime', runtime_only: true, status: 'active', cooldowns: [] },
  { name: 'a-very-long-credential-file-name-with-extra-identification-for-layout-testing.json', provider: 'codex', auth_index: 'long', status: 'pending', cooldowns: [] },
];
if (params.has('cards')) updateQuotaCache({
  'claude-idle.json::idle': { status: 'success', rows: [{ label: '5 小时', remainingPercent: 0, resetAtMs: Date.now() + 620_000 }, { label: '每周', remainingPercent: 24, resetAtMs: Date.now() + 3_600_000 }] },
  'codex-disabled.json::disabled': { status: 'success', rows: [{ label: '5 小时', remainingPercent: null, detail: '上游未返回百分比' }] },
});
const buckets = Array.from({ length: 20 }, (_, index) => ({
  time: `${String(10 + Math.floor(index / 6)).padStart(2, '0')}:${String(index % 6 * 10).padStart(2, '0')}-${String(10 + Math.floor((index + 1) / 6)).padStart(2, '0')}:${String((index + 1) % 6 * 10).padStart(2, '0')}`,
  success: index < 3 ? 0 : index === 15 ? 0 : 18,
  failed: index < 3 ? 0 : index === 15 ? 4 : index % 4 === 0 ? 6 : 0,
}));

mockIPC(async (cmd, args) => {
  if (cmd === 'set_app_locale') return null;
  if (cmd === 'management_request') {
    const request = args?.request as { path: string; method: string; query?: Record<string, string>; body?: Record<string, unknown> };
    if (request.path === '/auth-files/download') {
      if (params.has('metadataError')) throw new Error('Fixture metadata read failed');
      return { ...settingsFor(request.query?.name ?? '') };
    }
    if (request.path === '/auth-files/models') {
      if (params.has('catalogError')) throw new Error('Fixture catalog read failed');
      return { models: [{ id: 'gpt-example' }, { id: 'gpt-old-example' }, { id: 'claude-example' }] };
    }
    if (request.path === '/auth-files/fields' && request.method === 'PATCH') {
      if (params.has('saveError')) throw new Error('Fixture settings save failed');
      const { name, headers, ...patch } = request.body ?? {};
      const target = settingsFor(String(name));
      Object.assign(target, patch);
      if (headers) {
        const merged = { ...(target.headers as Record<string, string>) };
        for (const [key, value] of Object.entries(headers as Record<string, string>)) {
          if (value) merged[key] = value;
          else delete merged[key];
        }
        target.headers = merged;
      }
      const output = document.getElementById('fixture-writes');
      if (output) output.textContent = JSON.stringify(request.body, null, 2);
      return { status: 'ok' };
    }
    if (request.path === '/api-call') {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (params.has('quotaError')) throw new Error('Fixture quota unavailable');
      if (String(request.body?.url).endsWith('/consume')) {
        resetCount += 1;
        const output = document.getElementById('fixture-reset-count');
        if (output) output.textContent = String(resetCount);
        return { status_code: 200, body: '{}' };
      }
      return { status_code: 200, body: JSON.stringify(String(request.body?.url).includes('reset-credits')
        ? { available_count: Math.max(0, 2 - resetCount), applicable_available_count: 0, credits: [{ reset_type: 'codex_rate_limits', status: 'available', expires_at: '2030-01-01T00:00:00Z' }] }
        : { plan_type: 'Plus', rate_limit: { primary_window: { used_percent: resetCount ? 0 : 16, limit_window_seconds: 18000, reset_after_seconds: 3600 }, secondary_window: { used_percent: resetCount ? 0 : 72, limit_window_seconds: 604800, reset_after_seconds: 86400 } } }) };
    }
    if (request.path === '/auth-files' && request.method === 'GET') {
      refreshCount += 1;
      if (params.has('cards')) return { files: cardFiles.map((file) => ({ source: 'file', size: 2048, updated_at: '2026-09-20T01:20:00Z', success: 1200, failed: 28, recent_requests: buckets, ...file, ...settingsFor(file.name) })) };
      if (params.has('health')) {
        const now = Date.now();
        const timer = (scope: string, reason: string, seconds: number, model?: string, httpStatus?: number) => ({
          scope, reason, remaining_seconds: seconds,
          retry_at: new Date(now + seconds * 1000 + 3_600_000).toISOString(),
          model_key: model, http_status: httpStatus,
        });
        const recovered = params.has('fast') && refreshCount > 1;
        const files = [
          { name: '01-healthy.json', status: 'active', cooldowns: [], status_message: 'ok' },
          { name: '02-quota.json', status: recovered ? 'active' : 'error', unavailable: !recovered,
            status_message: recovered ? '' : 'quota exhausted',
            cooldowns: recovered ? [] : [
              timer('credential', 'credential_quota', params.has('fast') ? 3 : 125),
              timer('model', 'quota', params.has('fast') ? 3 : 125, 'gpt-example', 429),
            ] },
          { name: '03-model-errors.json', status: 'error', unavailable: false,
            cooldowns: [
              { ...timer('model', 'transient_error', 45, 'claude-example', 503), backoff_level: 0 },
              timer('model', 'model_not_supported', 7200, 'model-with-a-long-name-for-wrapping-layout-verification', 404),
            ] },
          { name: '04-auth-expired.json', status: 'error', unavailable: true, status_message: 'token expired', cooldowns: [] },
          { name: '05-pending.json', status: 'pending', cooldowns: [] },
          { name: '06-refreshing.json', status: 'refreshing', cooldowns: [] },
          { name: '07-disabled.json', status: 'disabled', disabled: true, cooldowns: [] },
          { name: '08-unknown-cooldown.json', status: 'unknown', cooldowns: null },
          { name: '09-legacy-error.json', status: 'error', status_message: '{"error":{"code":"upstream_error","message":"Example upstream failure with a long message. Refresh the list after the provider becomes available."}}' },
        ];
        return {
          observed_at: new Date(now + 3_600_000).toISOString(),
          files: files.map((file) => ({ provider: 'codex', auth_index: file.name,
            source: 'file', size: 1024, success: 20, failed: 2, recent_requests: buckets, ...file })),
        };
      }
      return { files: [
        { name: 'codex-demo.json', provider: 'codex', email: 'demo@example.com',
          auth_index: 'demo', source: 'file', size: 2048, status: 'ready',
          success: 1200 + refreshCount, failed: 28, recent_requests: buckets },
        { name: 'claude-idle.json', provider: 'claude', auth_index: 'idle',
          source: 'file', size: 1024, status: 'active', success: 0, failed: 0,
          recent_requests: buckets.map((bucket) => ({ ...bucket, success: 0, failed: 0 })) },
        { name: 'gemini-disabled.json', provider: 'gemini', auth_index: 'disabled',
          source: 'file', disabled: true, size: 1024, success: 0, failed: 40,
          recent_requests: buckets.map((bucket) => ({ ...bucket, success: 0, failed: 2 })) },
        { name: 'legacy-no-stats.json', provider: 'codex', auth_index: 'legacy', size: 1024 },
      ] };
    }
  }
  throw new Error(`Unhandled fixture command: ${cmd}`);
});

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <div className="app-shell">
      <aside className="sidebar" aria-hidden="true" />
      <div className="workspace">
        <main className="content">{params.has('quotaPage') ? <QuotaPage /> : <AuthFileManagementPage />}{params.has('cards') ? <><pre id="fixture-writes" aria-label="Fixture saved payload" /><output id="fixture-reset-count" aria-label="Fixture reset calls">0</output></> : null}</main>
      </div>
    </div>
  </I18nProvider>,
);
