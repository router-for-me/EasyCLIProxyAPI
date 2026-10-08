import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../../src/i18n';
import { QuotaPage } from '../../../src/pages/QuotaPage';
import '../../../src/styles/index.css';

// Fictional billing and subscription responses; no upstream calls or real credentials.
const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') || 'zh-CN');
document.documentElement.dataset.theme = params.get('theme') || 'light';
mockIPC(async (command, args) => {
  if (command !== 'management_request') throw new Error('Unexpected fixture command');
  const request = args.request as { path: string; body?: { url: string } };
  if (request.path === '/credentials') return { files: [{ name: 'grok-fictional.json', provider: 'xai', auth_index: 'fixture' }] };
  const url = request.body?.url || '';
  if (url.endsWith('/settings') || url.includes('/user?')) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { status_code: 200, body: { subscription_tier_display: 'SuperGrok Heavy' } };
  }
  return { status_code: 200, body: { config: url.includes('format=credits')
    ? { currentPeriod: { type: 'weekly', end: '2030-01-08T00:00:00Z' }, prepaidBalance: { val: 250 } }
    : { monthlyLimit: 15000, used: 3000, billingPeriodEnd: '2030-02-01T00:00:00Z' } } };
});
createRoot(document.getElementById('root')!).render(<I18nProvider><QuotaPage /></I18nProvider>);
