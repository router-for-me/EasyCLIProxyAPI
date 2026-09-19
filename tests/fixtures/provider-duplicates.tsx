import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { ApiAccessPage, providerRemarkIdentity, type ApiAccessRemarkLocator, type ProviderSection } from '../../src/pages/ApiAccessPage';
import '../../src/styles.css';

localStorage.setItem('easy-cli-proxy-api.locale', 'en');
const fixture = window as typeof window & {
  providerFixture: { records: Record<string, unknown>[]; writes: { method: string; body: unknown }[] };
};
fixture.providerFixture = {
  records: [{
    'api-key': 'shared-test-key', 'base-url': 'https://claude.example.test', priority: 10,
    models: [{ name: 'upstream-a', alias: 'claude-a' }],
  }],
  writes: [],
};
const remarks = new Map<string, string>();
mockIPC((cmd, rawArgs) => {
  if (cmd === 'set_app_locale') return null;
  if (cmd === 'resolve_api_access_remarks') {
    const { queries } = rawArgs as { queries: (ApiAccessRemarkLocator & { providerSection: ProviderSection })[] };
    return queries.map((query) => remarks.get(providerRemarkIdentity(query.providerSection, query)) ?? '');
  }
  if (cmd === 'save_api_access_remark') {
    const { update } = rawArgs as { update: {
      providerSection: ProviderSection; previousRecords: ApiAccessRemarkLocator[];
      records: ApiAccessRemarkLocator[]; remark: string;
    } };
    for (const record of update.previousRecords) remarks.delete(providerRemarkIdentity(update.providerSection, record));
    for (const record of update.records) remarks.set(providerRemarkIdentity(update.providerSection, record), update.remark);
    return null;
  }
  if (cmd === 'management_request') {
    const { request } = rawArgs as { request: { method: string; path: string; body: Record<string, unknown>[] } };
    const section = request.path.slice(1);
    if (request.method === 'GET') {
      if (section === 'config') return { 'claude-api-key': structuredClone(fixture.providerFixture.records) };
      return { [section]: section === 'claude-api-key'
        ? fixture.providerFixture.records.map((record, index) => ({ ...record, 'auth-index': `auth-${index}` }))
        : [] };
    }
    fixture.providerFixture.writes.push({ method: request.method, body: structuredClone(request.body) });
    if (request.method !== 'PUT' || section !== 'claude-api-key') throw new Error('Unexpected provider mutation');
    fixture.providerFixture.records = structuredClone(request.body);
    return { status: 'ok' };
  }
  throw new Error(`Unhandled fixture command: ${cmd}`);
});

createRoot(document.getElementById('root')!).render(
  <I18nProvider><div className="app-shell"><div className="workspace"><main className="content">
    <ApiAccessPage />
  </main></div></div></I18nProvider>,
);
