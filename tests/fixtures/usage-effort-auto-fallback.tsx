import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { EventsView, type UsageRecord } from '../../src/pages/UsageEventsView';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') || 'zh-CN');
localStorage.setItem('cpa-gui.usage-events-visible-cols.v3', JSON.stringify([
  'time', 'key', 'source', 'model', 'result', 'request', 'latency', 'speed', 'total', 'cache', 'provider',
]));
localStorage.removeItem('cpa-gui.usage-events-visible-cols.v2');
localStorage.removeItem('cpa-gui.usage-events-visible-cols.v4');
localStorage.removeItem('cpa-gui.usage-events-visible-cols.v5');
localStorage.removeItem('cpa-gui.usage-events-col-widths.v2');
localStorage.removeItem('cpa-gui.usage-events-col-widths.v3');
document.documentElement.dataset.theme = params.get('theme') || 'light';

const tokens = {
  input_tokens: 1000,
  output_tokens: 200,
  reasoning_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  total_tokens: 1200,
};

const record = (id: string, model: string, alias: string, reasoningEffort?: string): UsageRecord => ({
  id,
  row_id: id,
  timestamp: '2026-10-03T08:00:00.000Z',
  latency_ms: 2000,
  ttft_ms: 200,
  source: 'ui-regression',
  source_display: 'UI regression',
  failed: false,
  canceled: false,
  failure_status: 0,
  failure_body: '',
  provider: 'codex',
  cost: null,
  model,
  alias,
  reasoning_effort: reasoningEffort as string,
  endpoint: 'POST /v1/responses',
  api_key_hash: 'ui-key',
  api_key_display: 'sk-ui',
  api_key_remark: 'UI fixture',
  tokens,
});

// Keep these cases in a stable order; the browser test uses it to inspect each model cell.
const records: UsageRecord[] = [
  record('missing-effort', 'gpt-4o', ''),
  record('whitespace-effort', 'gpt-4o', '', '   '),
  record('recorded-auto', 'gpt-4o', '', 'auto'),
  record('recorded-high', 'gpt-4o', '', 'high'),
  record('recorded-max', 'gpt-4o', '', 'max'),
  record('recorded-none', 'gpt-4o', '', 'none'),
  record('recorded-off', 'gpt-4o', '', 'off'),
  { ...record('inferred-alias', 'gemini-3.8-flash', 'gemini-3.8-flash-high') },
  record('inferred-model', 'gpt-5.1-high', ''),
  record('whitespace-alias-tier', 'gemini-3.8-flash', 'gemini-3.8-flash-high', '   '),
];

mockIPC(async () => null);

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <div className="app-shell">
      <aside className="sidebar" aria-hidden="true" />
      <div className="workspace">
        <main className="content">
          <div className="usage-records-page">
            <EventsView
              events={{ items: records, total: records.length, page: 1, pageSize: 20, totalPages: 1 }}
              pageSize={20}
              onPage={() => {}}
              onPageSizeChange={() => {}}
            />
          </div>
        </main>
      </div>
    </div>
  </I18nProvider>,
);
