import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { UsageRecordsPage } from '../../src/pages/UsageRecordsPage';
import type { UsageCategory } from '../../src/pages/UsageAnalysisView';
import type { UsageTimelinePoint } from '../../src/services/usageTrend';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') || 'mixed';
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') || 'en');
localStorage.setItem('cpa-gui.usage-records-tab.v1', 'analysis');
// All 36 sample hours must remain in range independently of the machine clock.
localStorage.setItem('cpa-gui.usage-records-range.v1', 'all');
document.documentElement.dataset.theme = params.get('theme') || 'light';

const specifications = [
  ['model-a', 'gpt-6-astra', 10, 1000],
  ['model-b', 'claude-sonnet-4-5', 8, 500],
  ['model-c', 'gemini-3.1-pro', 12, 300],
  ['model-d', 'gpt-6-sol', 6, 200],
  ['model-e', 'deepseek-v3.2', 4, 100],
  ['model-f', 'qwen3-coder-plus', 9, 60],
  ['model-g', 'grok-code-fast', 5, 40],
  ['model-h', 'llama-4-scout-instruct-with-a-long-model-name', 6, 10],
] as const;

// Derive every displayed dimension from these same 60 requests. The mixed
// sample has 44 successes, eight failures, eight cancellations, and 20K tokens.
const records = scenario === 'empty' ? [] : specifications.flatMap(([model, label, requests, tokens]) =>
  Array.from({ length: requests }, (_, index) => ({
    model,
    label,
    tokens: scenario === 'zero-tokens' || scenario === 'canceled' ? 0 : tokens,
    status: scenario === 'canceled' ? 'canceled' : index === 0 ? 'failed' : index === 1 ? 'canceled' : 'success',
  })),
);
const sumTokens = records.reduce((total, record) => total + record.tokens, 0);
const count = (status: string) => records.filter(record => record.status === status).length;
const groups = (identify: (record: typeof records[number], index: number) => [string, string]): UsageCategory[] => {
  const items = new Map<string, UsageCategory>();
  records.forEach((record, index) => {
    const [key, label] = identify(record, index);
    const item = items.get(key) || { key, label, requests: 0, failures: 0, tokens: 0 };
    item.requests += 1;
    item.failures += Number(record.status === 'failed');
    item.tokens += record.tokens;
    items.set(key, item);
  });
  return [...items.values()].reverse();
};
const analysis = {
  models: groups(record => [record.model, record.label]),
  providers: groups((_, index) => [`provider-${index % 2}`, ['OpenAI', 'Anthropic'][index % 2]]),
  sources: groups((_, index) => [`source-${index % 3}`, ['CLI workspace', 'Desktop assistant', 'long-source-name-for-development@example.com'][index % 3]]),
  apiKeys: groups((_, index) => [`key-${index % 4}`, ['Development', 'Personal', 'Team workspace', 'Long API key description for layout verification'][index % 4]]),
};
const timeline: UsageTimelinePoint[] = Array.from({ length: records.length ? 36 : 0 }, (_, hour) => {
  const date = new Date(2026, 9, 1, hour);
  const items = records.filter((_, index) => index % 36 === hour);
  return {
    hour: [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()].map((part, index) => index ? String(part).padStart(2, '0') : part).join('-'),
    requests: items.length,
    success: items.filter(item => item.status === 'success').length,
    failure: items.filter(item => item.status === 'failed').length,
    canceled: items.filter(item => item.status === 'canceled').length,
    tokens: items.reduce((total, item) => total + item.tokens, 0),
  };
}).reverse(); // The UI must sort timestamps, not trust the backend array order.

mockIPC(async command => {
  if (command === 'plugin:event|listen') return 1;
  if (command === 'plugin:event|unlisten' || command === 'set_app_locale') return null;
  if (command === 'get_usage_collector_status') return { state: 'collecting', message: '', lastCollectedAt: null, totalRecords: records.length };
  if (command === 'get_usage_analysis') return analysis;
  if (command === 'get_usage_overview') return {
    totalRequests: records.length, successCount: count('success'), failureCount: count('failed'), canceledCount: count('canceled'),
    successRate: count('success') + count('failed') > 0 ? count('success') / (count('success') + count('failed')) * 100 : 0,
    totalTokens: sumTokens, inputTokens: sumTokens, outputTokens: 0,
    reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    rpm: records.length / (36 * 60), tpm: sumTokens / (36 * 60), tps: 0, tpsSampleCount: 0,
    averageLatencyMs: 0, cacheHitRate: 0, estimatedCost: 0, pricedRequests: 0, timeline,
  };
  throw new Error(`Unhandled analysis fixture command: ${command}`);
});

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <div className="app-shell">
      <aside className="sidebar" aria-hidden="true" />
      <div className="workspace"><main className="content"><UsageRecordsPage /></main></div>
    </div>
  </I18nProvider>,
);
