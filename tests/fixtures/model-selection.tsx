import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { ApiProviderDialog, type ProviderDraft } from '../../src/pages/ApiAccessPage';
import '../../src/styles.css';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'saved';
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') ?? 'en');
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
const fixture = window as typeof window & {
  fixtureCatalog: { name: string }[];
  fixtureFailFetch: boolean;
  fixtureHoldNext: boolean;
  fixturePending: (() => void)[];
  fixtureSaved: ProviderDraft | null;
};
fixture.fixtureCatalog = scenario.startsWith('alias-')
  ? [{ name: 'dsv4' }, { name: 'dsv4.1' }, { name: 'other' }]
  : [
      ...Array.from({ length: 240 }, (_, i) => ({ name: `gpt-${String(i + 1).padStart(3, '0')}` })),
      ...Array.from({ length: 120 }, (_, i) => ({ name: `claude-${String(i + 1).padStart(3, '0')}` })),
      ...Array.from({ length: 40 }, (_, i) => ({ name: `deepseek-${String(i + 1).padStart(3, '0')}` })),
      { name: 'GPT-001' },
    ];
fixture.fixtureFailFetch = false;
fixture.fixtureHoldNext = false;
fixture.fixturePending = [];
fixture.fixtureSaved = null;
mockIPC(async (cmd, rawArgs) => {
  if (cmd === 'set_app_locale') return null;
  const args = rawArgs as { request?: { path?: string } };
  if (cmd === 'management_request' && args.request?.path === '/api-call') {
    const response = fixture.fixtureFailFetch
      ? { status_code: 503, body: 'Fixture discovery failed' }
      : { status_code: 200, body: { data: fixture.fixtureCatalog.slice() } };
    if (fixture.fixtureHoldNext) {
      fixture.fixtureHoldNext = false;
      await new Promise<void>((resolve) => fixture.fixturePending.push(resolve));
    }
    return response;
  }
  throw new Error(`Unhandled fixture command: ${cmd}`);
});

const initialDraft: ProviderDraft = {
  name: '', apiKey: 'fixture-key', remark: '', baseUrl: 'https://models.example.test', priority: '',
  models: scenario === 'alias-saved' ? [{ name: 'dsv4.1', alias: 'dsv4' }]
    : scenario === 'saved' ? [{ name: ' gpt-001 ', alias: 'Focus' }, { name: 'custom-local', alias: 'Local alias' }] : [],
  excludedModelsText: scenario === 'alias-saved' ? 'manual-model\nlegacy-*\ndsv4'
    : scenario === 'alias-new' ? 'manual-model\nlegacy-*'
    : scenario === 'excluded' ? 'gpt-*' : '',
};
createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <ApiProviderDialog
      activeCategory={scenario === 'new' ? 'deepseek' : 'codex-api-key'}
      editingRow={null}
      initialDraft={initialDraft}
      busy={false}
      onClose={() => {}}
      onSave={async (draft) => { fixture.fixtureSaved = draft; return { saved: true }; }}
    />
  </I18nProvider>,
);
