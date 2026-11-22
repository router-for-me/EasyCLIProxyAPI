import { describe, expect, test } from 'bun:test';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';
import type { UsageAnalysis, UsageEventPage, UsageOverview, UsagePricing } from '../src/services/usage';

describe('browser mock usage consistency', () => {
  test('overview, categories, pricing and paginated events share upstream and date filters', async () => {
    const runtime = createBrowserMockRuntime('running');
    const analysis = await runtime.invoke('get_usage_analysis') as UsageAnalysis;
    expect(analysis.upstreams).toHaveLength(3);
    for (const upstream of analysis.upstreams!) {
      const query = { upstream: upstream.key };
      const page = await runtime.invoke('get_usage_events', { query }) as UsageEventPage;
      const overview = await runtime.invoke('get_usage_overview', { query }) as UsageOverview;
      const pricing = await runtime.invoke('get_usage_pricing', { query }) as UsagePricing;
      expect(page.total).toBe(upstream.requests);
      expect(page.items.every(event => `auth:${event.auth_index}` === upstream.key)).toBe(true);
      expect(overview.totalRequests).toBe(page.total);
      expect(overview.totalTokens).toBe(page.items.reduce((sum, event) => sum + event.tokens.total_tokens, 0));
      expect(overview.timeline.reduce((sum, point) => sum + point.requests, 0)).toBe(page.total);
      expect(pricing.totalRequests).toBe(page.total);
      expect(pricing.totalCost).toBe(overview.estimatedCost);
      const timestamp = page.items[0].timestamp;
      const exact = await runtime.invoke('get_usage_overview', { query: { ...query, start: timestamp, end: timestamp } }) as UsageOverview;
      expect(exact.totalRequests).toBe(1);
    }
  });

  test('saving, importing and deleting prices updates costs while retaining unpriced usage', async () => {
    const runtime = createBrowserMockRuntime('running');
    const query = { model: 'gemini-3-pro' };
    const pricing = () => runtime.invoke('get_usage_pricing', { query }) as Promise<UsagePricing>;
    const before = await pricing();
    expect(before.rows[0].price).toBeNull();
    expect(before.pricedRequests).toBe(0);
    await runtime.invoke('apply_usage_model_prices', { prices: [{ model: query.model, prompt: 2, completion: 8, cacheRead: 0.2, cacheCreation: 0 }] });
    const imported = await pricing();
    expect(imported.pricedRequests).toBe(imported.totalRequests);
    expect(imported.totalCost).toBeGreaterThan(0);
    await runtime.invoke('save_usage_model_price', { price: { model: query.model, prompt: 4, completion: 16, cacheRead: 0.4, cacheCreation: 0 } });
    expect((await pricing()).totalCost).toBeCloseTo(imported.totalCost * 2);
    await runtime.invoke('delete_usage_model_price', { model: query.model });
    expect((await pricing()).totalRequests).toBe(before.totalRequests);
    expect((await pricing()).totalCost).toBe(0);
  });

  test('empty selections have zero statistics and no speed samples', async () => {
    const runtime = createBrowserMockRuntime('running');
    expect(await runtime.invoke('get_usage_overview', { query: { model: 'missing-model' } }))
      .toMatchObject({ totalRequests: 0, totalTokens: 0, estimatedCost: 0, tps: 0, tpsSampleCount: 0, timeline: [] });
    const total = await runtime.invoke('get_usage_overview') as UsageOverview;
    const ttft = await runtime.invoke('get_usage_overview', { query: { speed_mode: 'ttft' } }) as UsageOverview;
    expect(ttft.tps).toBeGreaterThan(total.tps);
    expect(total.successCount + total.failureCount + total.canceledCount).toBe(total.totalRequests);
  });
});
