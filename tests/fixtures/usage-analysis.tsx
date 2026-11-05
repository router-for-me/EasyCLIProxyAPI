import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { UsageRecordsPage } from '../../src/pages/UsageRecordsPage';
import type { UsageCategory } from '../../src/pages/UsageAnalysisView';
import type { UsageTimelinePoint } from '../../src/services/usageTrend';
import type { UsageQuery } from '../../src/services/usage';
import { initializeWindowActivity } from '../../src/services/windowActivity';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') || 'mixed';
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') || 'en');
localStorage.setItem('cpa-gui.usage-records-tab.v1', 'analysis');
// All 36 sample hours must remain in range independently of the machine clock.
localStorage.setItem('cpa-gui.usage-records-range.v1', 'all');
localStorage.setItem('easy-cli-proxy-api.privacy-mode', params.has('privacy') ? 'on' : 'off');
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
    tokens: scenario === 'zero-tokens' || scenario === 'canceled' || scenario === 'key-ties' ? 0
      : tokens * (scenario === 'large' ? 1_000_003 : 1),
    status: scenario === 'canceled' ? 'canceled' : index === 0 ? 'failed' : index === 1 ? 'canceled' : 'success',
  })),
);
const keyIndex = (record: typeof records[number], index: number) => scenario === 'key-ties' ? index % 4
  : ({ 'model-a': 0, 'model-b': 2, 'model-c': 1, 'model-d': 1, 'model-e': 2, 'model-f': 3, 'model-g': 3, 'model-h': 3 }[record.model] ?? 0);
const keyLabels = params.get('locale') === 'zh-CN'
  ? ['developer@example.com', '个人使用', '团队工作区', '用于验证响应式布局的长密钥名称']
  : ['developer@example.com', 'Personal', 'Team workspace', 'Long API key description for layout verification'];
const groups = (source: typeof records, identify: (record: typeof records[number], index: number) => [string, string]): UsageCategory[] => {
  const items = new Map<string, UsageCategory>();
  source.forEach((record) => {
    const index = records.indexOf(record);
    const [key, label] = identify(record, index);
    const item = items.get(key) || { key, label, requests: 0, failures: 0, tokens: 0 };
    item.requests += 1;
    item.failures += Number(record.status === 'failed');
    item.tokens += record.tokens;
    items.set(key, item);
  });
  return [...items.values()].reverse();
};
const analysisFor = (source: typeof records) => ({
  models: groups(source, record => [record.model, record.label]),
  providers: groups(source, (_, index) => [`provider-${index % 2}`, ['OpenAI', 'Anthropic'][index % 2]]),
  sources: groups(source, (_, index) => [`source-${index % 3}`, ['CLI workspace', 'Desktop assistant', 'long-source-name-for-development@example.com'][index % 3]]),
  upstreams: groups(source, (_, index) => [`auth:source-${index % 3}`, ['CLI workspace', 'Desktop assistant', 'long-source-name-for-development@example.com'][index % 3]])
    .map(item => ({ ...item, provider: 'codex' })),
  apiKeys: groups(source, (record, index) => [`key-${keyIndex(record, index)}`, keyLabels[keyIndex(record, index)]]),
});
const timelineFor = (source: typeof records): UsageTimelinePoint[] => Array.from({ length: source.length ? 36 : 0 }, (_, hour) => {
  const date = new Date(2026, 9, 1, hour);
  const items = source.filter(record => records.indexOf(record) % 36 === hour);
  return {
    hour: [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()].map((part, index) => index ? String(part).padStart(2, '0') : part).join('-'),
    requests: items.length,
    success: items.filter(item => item.status === 'success').length,
    failure: items.filter(item => item.status === 'failed').length,
    canceled: items.filter(item => item.status === 'canceled').length,
    tokens: items.reduce((total, item) => total + item.tokens, 0),
  };
}).reverse(); // The UI must sort timestamps, not trust the backend array order.

mockIPC(async (command, args) => {
  if (command === 'plugin:event|listen') return 1;
  if (command === 'plugin:event|unlisten' || command === 'set_app_locale') return null;
  if (command === 'get_usage_collector_status') return { state: 'collecting', message: '', lastCollectedAt: null, totalRecords: records.length };
  const query = (args?.query ?? {}) as UsageQuery;
  const filtered = records.filter((record, index) => {
    const timestamp = new Date(2026, 9, 1, index % 36).toISOString();
    return (!query.model || record.model === query.model)
      && (!query.api_key_hash || `key-${keyIndex(record, index)}` === query.api_key_hash)
      && (!query.upstream || `auth:source-${index % 3}` === query.upstream)
      && (!query.start || timestamp >= query.start) && (!query.end || timestamp <= query.end);
  });
  const sumTokens = filtered.reduce((total, record) => total + record.tokens, 0);
  const count = (status: string) => filtered.filter(record => record.status === status).length;
  if (command === 'get_usage_analysis') return analysisFor(filtered);
  if (command === 'get_usage_overview') return {
    totalRequests: filtered.length, successCount: count('success'), failureCount: count('failed'), canceledCount: count('canceled'),
    successRate: count('success') + count('failed') > 0 ? count('success') / (count('success') + count('failed')) * 100 : 0,
    totalTokens: sumTokens, inputTokens: sumTokens, outputTokens: 0,
    reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    rpm: filtered.length / (36 * 60), tpm: sumTokens / (36 * 60), tps: 0, tpsSampleCount: 0,
    averageLatencyMs: 0, cacheHitRate: 0, estimatedCost: 0, pricedRequests: 0, timeline: timelineFor(filtered),
  };
  throw new Error(`Unhandled analysis fixture command: ${command}`);
});

void initializeWindowActivity();
createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <div className="app-shell">
      <aside className="sidebar" aria-hidden="true" />
      <div className="workspace"><main className="content"><UsageRecordsPage /></main></div>
    </div>
  </I18nProvider>,
);
