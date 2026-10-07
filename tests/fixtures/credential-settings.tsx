import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { AuthFileSettingsDialog } from '../../src/components/AuthFileSettingsDialog';
import '../../src/styles/index.css';

localStorage.setItem('easy-cli-proxy-api.locale', 'zh-CN');
const models = Array.from({ length: 20 }, (_, index) => ({ id: `gpt-${index + 1}`, display_name: `GPT ${index + 1}` }));
mockIPC(async (cmd, rawArgs) => {
  if (cmd === 'set_app_locale') return null;
  if (cmd !== 'management_request') return null;
  const request = (rawArgs as { request?: { path?: string } }).request;
  if (request?.path === '/credentials/download') {
    return { prefix: '', proxy_url: 'socks5://127.0.0.1:1080', priority: 0, weight: 1, excluded_models: ['gpt-example', 'claude-*'], headers: {}, note: '' };
  }
  if (request?.path === '/credentials/models') return { models };
  return { status: 'ok' };
});
createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <AuthFileSettingsDialog name="codex-cbb7bd85-lzt404rum@gmail.com-team.json" provider="codex" onClose={() => {}} onSaved={() => {}} />
  </I18nProvider>,
);