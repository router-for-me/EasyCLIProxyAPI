import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { UsageRecordsPage } from '../../src/pages/UsageRecordsPage';
import '../../src/styles.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') || 'zh-TW');
localStorage.setItem('cpa-gui.usage-records-tab.v1', 'overview');
localStorage.setItem('cpa-gui.usage-records-range.v1', '4h');
document.documentElement.dataset.theme = params.get('theme') || 'dark';

const hourKey = (date: Date) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
  String(date.getHours()).padStart(2, '0'),
].join('-');
const now = new Date();
const trendModels = [
  'gpt-test',
  'claude-test',
  'gemini-test',
  'deepseek-test',
  'grok-test',
  'qwen-test',
  'mistral-test',
  'llama-test',
];
const timeline = Array.from({ length: 4 }, (_, index) => ({
  hour: hourKey(new Date(now.getTime() - (3 - index) * 60 * 60 * 1000)),
  requests: 12 + index,
  success: 11 + index,
  failure: 1,
  canceled: 0,
  tokens: 22_000 + index * 2_000,
  models: trendModels.map((key, modelIndex) => ({
    key,
    label: key,
    tokens: 1_700 + modelIndex * 300 + index * 250,
  })),
}));

mockIPC(async (cmd) => {
  if (cmd === 'plugin:event|listen') return 1;
  if (cmd === 'plugin:event|unlisten' || cmd === 'set_app_locale') return null;
  if (cmd === 'get_usage_collector_status') {
    return { state: 'collecting', message: '', lastCollectedAt: now.toISOString(), totalRecords: 54 };
  }
  if (cmd === 'get_usage_analysis') {
    return { models: [], providers: [], sources: [], apiKeys: [] };
  }
  if (cmd === 'get_usage_overview') {
    return {
      totalRequests: 54,
      successCount: 50,
      failureCount: 4,
      canceledCount: 0,
      successRate: 92.6,
      inputTokens: 52_000,
      outputTokens: 24_000,
      reasoningTokens: 8_000,
      cacheReadTokens: 16_000,
      cacheCreationTokens: 0,
      totalTokens: 100_000,
      rpm: 0.23,
      tpm: 416.7,
      tps: 31.2,
      tpsSampleCount: 54,
      averageLatencyMs: 2_840,
      cacheHitRate: 0.307,
      estimatedCost: 1.2345,
      pricedRequests: 54,
      timeline,
    };
  }
  throw new Error(`Unhandled fixture command: ${cmd}`);
});

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <div className="app-shell">
      <aside className="sidebar" aria-hidden="true" />
      <div className="workspace">
        <main className="content">
          <UsageRecordsPage />
        </main>
      </div>
    </div>
  </I18nProvider>,
);
