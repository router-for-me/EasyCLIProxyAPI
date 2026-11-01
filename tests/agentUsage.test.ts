import { describe, expect, it, spyOn } from 'bun:test';
import {
  buildAgentUsagePriceRows, estimateAgentUsageDailyCost, filterAgentUsageReport,
  formatAgentUsageNumber, normalizeAgentUsageReport,
} from '../src/services/agentUsage';
import {
  AGENT_USAGE_REFRESH_INTERVALS, DEFAULT_AGENT_USAGE_REFRESH_INTERVAL,
  loadAgentUsageRefreshInterval, saveAgentUsageRefreshInterval,
} from '../src/services/agentUsagePreferences';
import { usagePreferences } from '../src/services/usagePreferences';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';

describe('Agent usage report normalization', () => {
  it('keeps the aggregate fields from the harness usage report', () => {
    const report = normalizeAgentUsageReport({
      schemaVersion: 1,
      generatedAt: '2026-10-29T12:00:00Z',
      sources: [{
        source: 'codex',
        status: 'ok',
        daily: [{
          date: '2026-10-29',
          inputTokens: 90,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 10,
          reasoningOutputTokens: 5,
          totalTokens: 155,
          costUSD: 0.0006,
          project: 'private-project',
          models: [{ model: 'gpt-5', inputTokens: 90, outputTokens: 50, totalTokens: 155, costUSD: 0.0006 }],
        }],
      }],
    });

    expect(report.sources[0].daily[0]).toEqual({
      date: '2026-10-29',
      inputTokens: 90,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 10,
      reasoningTokens: 5,
      totalTokens: 155,
      costUSD: 0.0006,
      models: [{
        model: 'gpt-5',
        inputTokens: 90,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        totalTokens: 155,
        costUSD: 0.0006,
      }],
    });
    expect(JSON.stringify(report)).not.toContain('private-project');
  });

  it('rejects malformed source and daily rows', () => {
    expect(() => normalizeAgentUsageReport({ sources: [{ source: 'codex', status: 'unknown', daily: [] }] })).toThrow();
    expect(() => normalizeAgentUsageReport({ sources: [{ source: 'codex', status: 'ok', daily: [{ date: 'today' }] }] })).toThrow();
    expect(() => normalizeAgentUsageReport({ sources: [{ source: 'codex', status: 'ok', daily: [{ date: '2026-02-30' }] }] })).toThrow();
  });

  it('uses saved model prices for local Agent cost estimates', () => {
    const report = normalizeAgentUsageReport({
      schemaVersion: 1,
      generatedAt: '2026-10-29T12:00:00Z',
      sources: [{
        source: 'codex',
        status: 'ok',
        daily: [{
          date: '2026-10-29',
          inputTokens: 100,
          outputTokens: 40,
          cacheCreationTokens: 0,
          cacheReadTokens: 20,
          totalTokens: 160,
          costUSD: 0,
          models: [{
            model: 'gpt-5',
            inputTokens: 100,
            outputTokens: 40,
            cacheCreationTokens: 0,
            cacheReadTokens: 20,
            reasoningTokens: 0,
            totalTokens: 160,
            costUSD: null,
          }],
        }],
      }],
    });
    const rows = buildAgentUsagePriceRows(report, {
      rows: [{
        model: 'gpt-5', requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        cacheCreationTokens: 0, totalTokens: 0, estimatedCost: 0,
        price: {
          model: 'gpt-5', prompt: 1, completion: 2, cacheRead: 0.5, cacheCreation: 0,
          promptConfigured: true, completionConfigured: true, cacheReadConfigured: true,
          cacheCreationConfigured: true, source: 'manual', sourceModelId: '', updatedAtMs: 0,
        },
      }],
      totalCost: 0, totalRequests: 0, pricedRequests: 0, savedPrices: 1,
    });
    expect(rows[0].estimatedCostUSD).toBeCloseTo(0.00019);
    expect(rows[0].price?.prompt).toBe(1);
  });
});

describe('local usage filtering and estimates', () => {
  const now = new Date(2026, 10, 1, 12);
  const day = (date: string, timestamp?: string) => ({
    date, ...(timestamp ? { timestamp } : {}), inputTokens: 100, outputTokens: 40,
    cacheReadTokens: 20, cacheCreationTokens: 10, totalTokens: 170,
    models: [{ model: 'Example', inputTokens: 100, outputTokens: 40, totalTokens: 170, costUSD: 0.5 }],
  });
  const report = normalizeAgentUsageReport({ sources: [
    { source: 'codex', status: 'ok', daily: [day('2026-10-02'), day('2026-10-03'), day('2026-10-25'), day('2026-10-26'), day('2026-10-31'), day('2026-11-01'), day('2026-11-02')] },
    { source: 'claude', status: 'empty', daily: [] },
  ] });

  it('uses inclusive calendar boundaries and excludes future dates', () => {
    expect(filterAgentUsageReport(report, 'today', '', now).sources[0].daily.map((row) => row.date)).toEqual(['2026-11-01']);
    expect(filterAgentUsageReport(report, '7d', '', now).sources[0].daily.map((row) => row.date)).toEqual(['2026-10-26', '2026-10-31', '2026-11-01']);
    expect(filterAgentUsageReport(report, '30d', '', now).sources[0].daily[0].date).toBe('2026-10-03');
    expect(filterAgentUsageReport(report, 'all', 'claude', now).sources.map((row) => row.source)).toEqual(['claude']);
    expect(filterAgentUsageReport(report, 'all', '', now).sources[0].daily).toHaveLength(7);
    expect(report.sources[0].daily).toHaveLength(7);
  });

  it('filters the rolling 24 hours by timestamps, not whole calendar days', () => {
    const timestamp = (dayOfMonth: number, hour: number) => new Date(2026, 9, dayOfMonth, hour).toISOString();
    const timed = normalizeAgentUsageReport({ sources: [{
      source: 'codex', status: 'ok', daily: [day('2026-10-31')],
      events: [day('2026-10-31', timestamp(31, 11)), day('2026-10-31', timestamp(31, 12)), day('2026-11-01', now.toISOString()), day('2026-11-01', new Date(now.getTime() + 1).toISOString())],
    }] });
    expect(filterAgentUsageReport(timed, '24h', '', now).sources[0].daily).toHaveLength(2);
    expect(filterAgentUsageReport(timed, 'today', '', now).sources[0].daily).toHaveLength(2);
  });

  it('counts unique dates for a model shared across sources and matches names case-insensitively', () => {
    const combined = normalizeAgentUsageReport({ sources: [
      { source: 'codex', status: 'ok', daily: [day('2026-11-01'), day('2026-11-01')] },
      { source: 'pi', status: 'ok', daily: [day('2026-11-01'), day('2026-10-31')] },
    ] });
    const rows = buildAgentUsagePriceRows(combined, null);
    expect(rows[0].days).toBe(2);
    expect(rows[0].totalTokens).toBe(680);
    expect(rows[0].recordedCostUSD).toBe(2);
    expect(rows[0].estimatedCostUSD).toBeNull();
  });

  it('retains recorded costs for unpriced models in partially priced days', () => {
    const daily = normalizeAgentUsageReport({ sources: [{ source: 'codex', status: 'ok', daily: [{
      ...day('2026-11-01'), costUSD: 5,
      models: [
        { model: 'priced', inputTokens: 1_000_000, totalTokens: 1_000_000, costUSD: 3 },
        { model: 'unpriced', inputTokens: 10, totalTokens: 10, costUSD: 2 },
      ],
    }] }] }).sources[0].daily[0];
    expect(estimateAgentUsageDailyCost(daily, null)).toBe(5);
    const price = {
      model: 'alias', sourceModelId: 'PRICED', prompt: 1, completion: 2, cacheRead: 0.5, cacheCreation: 0,
      promptConfigured: true, completionConfigured: true, cacheReadConfigured: true,
      cacheCreationConfigured: true, source: 'manual', updatedAtMs: 0,
    };
    expect(estimateAgentUsageDailyCost(daily, {
      rows: [{ model: 'alias', requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        cacheCreationTokens: 0, totalTokens: 0, estimatedCost: 0, price }],
      totalCost: 0, totalRequests: 0, pricedRequests: 0, savedPrices: 1,
    })).toBe(3);
  });

  it('formats full token counts with separators and normalizes non-finite values', () => {
    expect(formatAgentUsageNumber(1_234_567, 'en')).toBe('1,234,567');
    const invalid = normalizeAgentUsageReport({ sources: [{ source: 'pi', status: 'ok', daily: [{
      ...day('2026-11-01'), inputTokens: -1, outputTokens: Infinity, costUSD: Infinity,
      models: [{ model: 'test', costUSD: Infinity }],
    }] }] }).sources[0].daily[0];
    expect(invalid.inputTokens).toBe(0);
    expect(invalid.outputTokens).toBe(0);
    expect(invalid.costUSD).toBe(0);
    expect(invalid.models[0].costUSD).toBeNull();
  });

  it('returns timestamped browser records for every supported source', async () => {
    const mock = createBrowserMockRuntime('running');
    const result = normalizeAgentUsageReport(await mock.invoke('get_agent_usage'));
    expect(result.sources).toHaveLength(11);
    expect(result.sources.find((source) => source.source === 'codex')?.events?.[0].timestamp).toBe(result.generatedAt);
    expect(filterAgentUsageReport(result, '24h').sources.find((source) => source.source === 'codex')?.daily).toHaveLength(1);
  });
});

describe('local usage refresh preferences', () => {
  it('defaults missing, blank and invalid preferences to five minutes, preserving manual mode', () => {
    const read = spyOn(usagePreferences, 'getItem');
    try {
      for (const stored of [null, '', ' ', 'invalid', '-1', '1234']) {
        read.mockReturnValue(stored);
        expect(loadAgentUsageRefreshInterval()).toBe(DEFAULT_AGENT_USAGE_REFRESH_INTERVAL);
      }
      for (const interval of AGENT_USAGE_REFRESH_INTERVALS) {
        read.mockReturnValue(String(interval));
        expect(loadAgentUsageRefreshInterval()).toBe(interval);
      }
    } finally { read.mockRestore(); }
  });

  it('persists selected intervals', () => {
    const save = spyOn(usagePreferences, 'setItem').mockImplementation(() => {});
    try {
      saveAgentUsageRefreshInterval(0);
      expect(save).toHaveBeenCalledWith('cpa-gui.usage-agent-refresh-interval.v1', '0');
    } finally { save.mockRestore(); }
  });
});
