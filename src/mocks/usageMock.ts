import type { ModelPrice, UsageAnalysis, UsageOverview, UsagePriceRow, UsageQuery, UsageRecord } from '../services/usage';

export function filterMockUsage(events: UsageRecord[], query: UsageQuery): UsageRecord[] {
  return events.filter(event => {
    for (const key of ['model', 'provider', 'source', 'api_key_hash'] as const) {
      if (query[key] && event[key] !== query[key]) return false;
    }
    for (const key of ['failed', 'canceled'] as const) {
      if (typeof query[key] === 'boolean' && event[key] !== query[key]) return false;
    }
    if (query.upstream && query.upstream !== `auth:${event.auth_index}`) return false;
    const timestamp = Date.parse(event.timestamp);
    return (!query.start || timestamp >= Date.parse(query.start))
      && (!query.end || timestamp <= Date.parse(query.end));
  });
}

export function mockUsagePricing(events: UsageRecord[], prices: ModelPrice[]) {
  const rows = new Map<string, UsagePriceRow>();
  let pricedRequests = 0;
  for (const event of events) {
    const price = prices.find(price => price.model === event.model) ?? null;
    const row = rows.get(event.model) ?? { model: event.model, requests: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, estimatedCost: 0, price };
    row.requests++;
    row.inputTokens += event.tokens.input_tokens;
    row.outputTokens += event.tokens.output_tokens;
    row.cacheReadTokens += event.tokens.cache_read_tokens;
    row.cacheCreationTokens += event.tokens.cache_creation_tokens;
    row.totalTokens += event.tokens.total_tokens;
    if (price) {
      pricedRequests++;
      const input = Math.max(0, event.tokens.input_tokens - event.tokens.cache_read_tokens - event.tokens.cache_creation_tokens);
      row.estimatedCost += (input * price.prompt + event.tokens.output_tokens * price.completion
        + event.tokens.cache_read_tokens * price.cacheRead + event.tokens.cache_creation_tokens * price.cacheCreation) / 1_000_000;
    }
    rows.set(event.model, row);
  }
  return { rows: [...rows.values()], totalCost: [...rows.values()].reduce((sum, row) => sum + row.estimatedCost, 0),
    totalRequests: events.length, pricedRequests, savedPrices: prices.length };
}

export function mockUsageAnalysis(events: UsageRecord[]): UsageAnalysis {
  const category = (key: (event: UsageRecord) => string, label: (event: UsageRecord) => string) => {
    const groups = new Map<string, { key: string; label: string; requests: number; failures: number; tokens: number; provider: string }>();
    for (const event of events) {
      const id = key(event);
      const row = groups.get(id) ?? { key: id, label: label(event), requests: 0, failures: 0, tokens: 0, provider: event.provider };
      row.requests++;
      row.failures += Number(event.failed && !event.canceled);
      row.tokens += event.tokens.total_tokens;
      groups.set(id, row);
    }
    return [...groups.values()];
  };
  return {
    models: category(event => event.model, event => event.model),
    providers: category(event => event.provider, event => event.provider),
    sources: category(event => event.source, event => event.source_display),
    apiKeys: category(event => event.api_key_hash, event => event.api_key_remark || event.api_key_display),
    upstreams: category(event => `auth:${event.auth_index}`, event => event.source_display),
  };
}

export function mockUsageOverview(events: UsageRecord[], prices: ModelPrice[], speedMode?: unknown): UsageOverview {
  const sum = (read: (event: UsageRecord) => number) => events.reduce((total, event) => total + read(event), 0);
  const successCount = events.filter(event => !event.failed && !event.canceled).length;
  const completedCount = events.filter(event => !event.canceled).length;
  const inputTokens = sum(event => event.tokens.input_tokens);
  const cacheReadTokens = sum(event => event.tokens.cache_read_tokens);
  const timeline = new Map<string, UsageOverview['timeline'][number]>();
  for (const event of events) {
    const date = new Date(event.timestamp);
    const hour = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'), String(date.getHours()).padStart(2, '0')].join('-');
    const point = timeline.get(hour) ?? { hour, requests: 0, success: 0, failure: 0, canceled: 0, tokens: 0, models: [] };
    point.requests++;
    point.success += Number(!event.failed && !event.canceled);
    point.failure += Number(event.failed && !event.canceled);
    point.canceled += Number(event.canceled);
    point.tokens += event.tokens.total_tokens;
    const model = point.models!.find(model => model.key === event.model);
    if (model) { model.tokens += event.tokens.total_tokens; model.requests = (model.requests ?? 0) + 1; }
    else point.models!.push({ key: event.model, label: event.model, tokens: event.tokens.total_tokens, requests: 1 });
    timeline.set(hour, point);
  }
  const samples = events.filter(event => !event.failed && !event.canceled && event.tokens.output_tokens > 0
    && event.latency_ms > (speedMode === 'ttft' ? event.ttft_ms ?? event.latency_ms : 0));
  const seconds = samples.reduce((total, event) => total + (event.latency_ms - (speedMode === 'ttft' ? event.ttft_ms ?? 0 : 0)) / 1000, 0);
  const recent = events.filter(event => Date.parse(event.timestamp) >= Date.now() - 60_000);
  const pricing = mockUsagePricing(events, prices);
  return { totalRequests: events.length, successCount, failureCount: events.filter(event => event.failed && !event.canceled).length,
    canceledCount: events.filter(event => event.canceled).length, successRate: completedCount ? successCount / completedCount * 100 : 0,
    inputTokens, outputTokens: sum(event => event.tokens.output_tokens), reasoningTokens: sum(event => event.tokens.reasoning_tokens),
    cacheReadTokens, cacheCreationTokens: sum(event => event.tokens.cache_creation_tokens), totalTokens: sum(event => event.tokens.total_tokens),
    rpm: recent.length, tpm: recent.reduce((total, event) => total + event.tokens.total_tokens, 0),
    tps: seconds ? samples.reduce((total, event) => total + event.tokens.output_tokens, 0) / seconds : 0, tpsSampleCount: samples.length,
    averageLatencyMs: events.length ? sum(event => event.latency_ms) / events.length : 0,
    cacheHitRate: inputTokens ? cacheReadTokens / inputTokens : 0, estimatedCost: pricing.totalCost, pricedRequests: pricing.pricedRequests,
    timeline: [...timeline.values()].sort((a, b) => a.hour.localeCompare(b.hour)) };
}
