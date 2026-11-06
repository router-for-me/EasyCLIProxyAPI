import { describe, expect, it, spyOn } from 'bun:test';
import {
  formatAgentUsageAxisLabel,
  formatAgentUsageCompact,
  formatAgentUsageNumber,
  normalizeAgentUsageReport,
  AGENT_USAGE_PRESETS,
  agentUsageDay,
  agentUsageHourAvailable,
  agentUsagePresetRange,
  rangeGranularity,
  type AgentUsageBucketRow,
  type AgentUsageReport,
} from '../src/services/agentUsage';
import {
  buildCalendarGrid,
  buildHourGrid,
  calendarMinColumns,
  calendarMonthStarts,
  calendarSpanDays,
  buildModelRanking,
  buildStackedSeries,
  buildTokenStructure,
  axisGutter,
  axisLabelWidth,
  axisScale,
  cacheHitRate,
  heatLevel,
  heatThresholds,
  labelStep,
  periodChange,
  slotIndexAt,
  sparklinePoints,
} from '../src/services/agentUsageCharts';
import {
  AGENT_USAGE_REFRESH_INTERVALS, DEFAULT_AGENT_USAGE_REFRESH_INTERVAL,
  loadAgentUsageRefreshInterval, saveAgentUsageRefreshInterval, shouldSyncAgentUsageOnOpen,
} from '../src/services/agentUsagePreferences';
import { usagePreferences } from '../src/services/usagePreferences';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';

const bucket = (name: string, totalTokens: number, costUSD = 0): AgentUsageBucketRow => ({
  bucket: name,
  inputTokens: totalTokens / 2,
  outputTokens: totalTokens / 4,
  cacheCreationTokens: totalTokens / 8,
  cacheReadTokens: totalTokens / 8,
  reasoningTokens: 0,
  totalTokens,
  costUSD,
  samples: 1,
});

const totals = (totalTokens: number, costUSD = 0) => ({
  inputTokens: totalTokens / 2,
  outputTokens: totalTokens / 4,
  cacheCreationTokens: totalTokens / 8,
  cacheReadTokens: totalTokens / 8,
  reasoningTokens: 0,
  totalTokens,
  costUSD,
  samples: 2,
  days: 1,
});

const source = (name: string, status: string, rows: AgentUsageBucketRow[], archivedAt = '') => ({
  source: name,
  status,
  archivedAt,
  error: '',
  totals: totals(rows.reduce((sum, row) => sum + row.totalTokens, 0)),
  models: [{
    model: `${name}-model`,
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 1,
    cacheReadTokens: 2,
    reasoningOutputTokens: 0,
    totalTokens: 18,
    costUSD: 0.25,
    priced: true,
    prompt: 1,
    completion: 2,
    cacheRead: 0.5,
    cacheCreation: 0,
    days: 1,
  }],
  series: rows,
});

const report = (overrides: Record<string, unknown> = {}) => normalizeAgentUsageReport({
  schemaVersion: 2,
  generatedAt: '2026-11-01T12:00:00Z',
  lastSyncAt: '2026-11-01T11:00:00Z',
  syncing: false,
  bucket: 'day',
  rangeStart: '2026-10-26',
  rangeEnd: '2026-11-01',
  totals: totals(300, 1.5),
  sources: [source('codex', 'ok', [bucket('2026-10-31', 100), bucket('2026-11-01', 200)])],
  timeline: [bucket('2026-10-31', 100), bucket('2026-11-01', 200)],
  calendar: [{ date: '2026-10-31', totalTokens: 100, costUSD: 0.5 }, { date: '2026-11-01', totalTokens: 200, costUSD: 1 }],
  hourly: [{ weekday: 0, hour: 9, totalTokens: 42, samples: 2 }],
  ...overrides,
});

describe('Agent usage report normalization', () => {
  it('keeps totals, sources, series and timeline rows', () => {
    const parsed = report();
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.bucket).toBe('day');
    expect(parsed.totals.totalTokens).toBe(300);
    expect(parsed.totals.costUSD).toBe(1.5);
    expect(parsed.sources[0].series).toHaveLength(2);
    expect(parsed.timeline[1].bucket).toBe('2026-11-01');
    expect(parsed.calendar).toHaveLength(2);
    expect(parsed.hourly[0]).toEqual({ weekday: 0, hour: 9, totalTokens: 42, samples: 2 });
    expect(parsed.previous).toBeNull();
    expect(report({ previous: { totalTokens: 120, costUSD: 0.5 } }).previous).toEqual({ totalTokens: 120, costUSD: 0.5 });
  });

  it('rejects unknown buckets, statuses and missing timelines', () => {
    expect(() => report({ bucket: 'decade' })).toThrow();
    expect(() => report({ sources: [source('codex', 'unknown', [])] })).toThrow();
    const { timeline: _timeline, ...withoutTimeline } = report() as unknown as Record<string, unknown>;
    expect(() => normalizeAgentUsageReport(withoutTimeline)).toThrow();
  });

  it('normalizes negative and non-finite counters to zero', () => {
    const parsed = report({
      totals: { inputTokens: -5, outputTokens: Infinity, cacheReadTokens: 3, totalTokens: 3, costUSD: Infinity },
    });
    expect(parsed.totals.inputTokens).toBe(0);
    expect(parsed.totals.outputTokens).toBe(0);
    expect(parsed.totals.costUSD).toBe(0);
  });

  it('formats full token counts with separators', () => {
    expect(formatAgentUsageNumber(1_234_567, 'en')).toBe('1,234,567');
    expect(formatAgentUsageNumber(Number.NaN, 'en')).toBe('0');
  });

  it('formats compact axis labels per granularity', () => {
    expect(formatAgentUsageAxisLabel('2026-11-01T09', 'hour')).toBe('11-01 09:00');
    expect(formatAgentUsageAxisLabel('2026-11-01', 'day')).toBe('11-01');
    expect(formatAgentUsageAxisLabel('2026-10', 'month')).toBe('2026-10');
  });
});

describe('Agent usage chart helpers', () => {
  const inputs = [
    { key: 'codex', label: 'codex', rows: [bucket('2026-10-31', 100), bucket('2026-11-01', 200)] },
    { key: 'claude', label: 'claude', rows: [bucket('2026-11-01', 50)] },
  ];

  it('stacks series per bucket and merges duplicates', () => {
    const stack = buildStackedSeries(inputs, 'totalTokens');
    expect(stack.keys).toEqual(['codex', 'claude']);
    expect(stack.points.map((point) => point.bucket)).toEqual(['2026-10-31', '2026-11-01']);
    expect(stack.points[1].total).toBe(250);
    expect(stack.max).toBe(250);

    const duplicated = buildStackedSeries([{ key: 'codex', label: 'codex', rows: [bucket('2026-11-01', 10), bucket('2026-11-01', 5)] }], 'totalTokens');
    expect(duplicated.points[0].total).toBe(15);
  });

  it('keeps empty buckets from the timeline as zero-height bars', () => {
    const stack = buildStackedSeries(inputs, 'totalTokens', ['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(stack.points.map((point) => [point.bucket, point.total])).toEqual([
      ['2026-10-30', 0],
      ['2026-10-31', 100],
      ['2026-11-01', 250],
    ]);
  });

  it('groups low ranking series into an other segment', () => {
    const many = ['a', 'b', 'c'].map((key, index) => ({
      key,
      label: key,
      rows: [bucket('2026-11-01', 100 - index * 10)],
    }));
    const stack = buildStackedSeries(many, 'totalTokens', [], 2);
    expect(stack.keys).toEqual(['a', 'b', '__other__']);
    expect(stack.points[0].total).toBe(270);
  });

  it('lays out calendar weeks starting on Monday', () => {
    const grid = buildCalendarGrid([{ date: '2026-11-01', totalTokens: 12, costUSD: 1 }], '2026-11-01', 7);
    expect(grid).toHaveLength(1);
    expect(grid[0][0].date).toBe('2026-10-26');
    expect(grid[0][6]).toEqual({ date: '2026-11-01', value: 12 });
    expect(buildCalendarGrid([], 'not-a-date', 7)).toEqual([]);
  });

  it('builds the weekday by hour grid and token structure', () => {
    const grid = buildHourGrid([{ weekday: 0, hour: 9, totalTokens: 5, samples: 1 }, { weekday: 0, hour: 9, totalTokens: 5, samples: 1 }]);
    expect(grid[0][9]).toBe(10);
    expect(grid[6][23]).toBe(0);

    const structure = buildTokenStructure([{
      bucket: '2026-11-01',
      inputTokens: 50,
      outputTokens: 25,
      cacheCreationTokens: 25,
      cacheReadTokens: 50,
      reasoningTokens: 0,
      totalTokens: 150,
      costUSD: 0,
      samples: 1,
    }]);
    expect(structure[0].cacheHitRate).toBeCloseTo(50 / 125);
  });

  it('ranks models across sources', () => {
    const parsed: AgentUsageReport = report({
      sources: [
        source('codex', 'ok', [bucket('2026-11-01', 100)]),
        source('pi', 'archived', [bucket('2026-11-01', 50)], '2026-10-20T00:00:00Z'),
      ],
    });
    const ranking = buildModelRanking(parsed.sources);
    expect(ranking.map((row) => row.model)).toEqual(['codex-model', 'pi-model']);
    expect(ranking[0].sources).toEqual(['codex']);
    expect(ranking[0].priced).toBe(true);
  });

  it('computes period change and cache hit rate', () => {
    expect(periodChange(150, 100)).toBeCloseTo(0.5);
    expect(periodChange(50, 100)).toBeCloseTo(-0.5);
    expect(periodChange(50, 0)).toBeNull();
    expect(cacheHitRate({ ...totals(0), inputTokens: 30, cacheReadTokens: 60, cacheCreationTokens: 10 })).toBeCloseTo(0.6);
    expect(cacheHitRate(totals(0))).toBe(0);
  });
});

describe('Agent usage browser mock', () => {
  it('serves the report contract for every supported source', async () => {
    const mock = createBrowserMockRuntime('running');
    const parsed = normalizeAgentUsageReport(await mock.invoke('get_agent_usage', { query: { range: '7d' } }));
    expect(parsed.sources).toHaveLength(11);
    expect(parsed.timeline.length).toBeGreaterThan(0);
    expect(parsed.sources.find((entry) => entry.source === 'pi')?.status).toBe('archived');
    expect(parsed.sources.find((entry) => entry.source === 'codex')?.series.length).toBeGreaterThan(0);
  });

  it('filters by several sources and groups series by model', async () => {
    const mock = createBrowserMockRuntime('running');
    const filtered = normalizeAgentUsageReport(await mock.invoke('get_agent_usage', { query: { range: '7d', sources: ['claude', 'pi'], groupBy: 'model' } }));
    expect(filtered.sources.filter((entry) => entry.series.length > 0).map((entry) => entry.source)).toEqual(['claude', 'pi']);
    expect(filtered.sources.find((entry) => entry.source === 'codex')?.totals.totalTokens).toBeGreaterThan(0);
    expect(filtered.sources.find((entry) => entry.source === 'claude')?.series[0].bucket).toContain('|');
  });

  it('honours granularity and keeps empty buckets', async () => {
    const mock = createBrowserMockRuntime('running');
    const daily = normalizeAgentUsageReport(await mock.invoke('get_agent_usage', { query: { range: 'all', granularity: 'day' } }));
    expect(daily.bucket).toBe('day');
    expect(daily.timeline).toHaveLength(120);
    expect(daily.previous).toBeNull();
    const hourly = normalizeAgentUsageReport(await mock.invoke('get_agent_usage', { query: { range: 'all', granularity: 'hour' } }));
    expect(hourly.bucket).toBe('day');
    const week = normalizeAgentUsageReport(await mock.invoke('get_agent_usage', { query: { range: '7d' } }));
    expect(week.timeline).toHaveLength(7);
    expect(week.previous?.totalTokens).toBeGreaterThan(0);
  });

  it('serves a custom date range ending before today', async () => {
    const mock = createBrowserMockRuntime('running');
    const now = new Date();
    const day = (offset: number) => agentUsageDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset));
    const custom = normalizeAgentUsageReport(await mock.invoke('get_agent_usage', { query: { range: 'custom', start: day(9), end: day(3) } }));
    expect(custom.bucket).toBe('day');
    expect(custom.rangeStart).toBe(day(9));
    expect(custom.rangeEnd).toBe(day(3));
    expect(custom.timeline.map((row) => row.bucket)).toEqual([9, 8, 7, 6, 5, 4, 3].map(day));
    expect(custom.previous?.totalTokens).toBeGreaterThan(0);
    const single = normalizeAgentUsageReport(await mock.invoke('get_agent_usage', { query: { range: 'custom', start: day(2), end: day(2) } }));
    expect(single.bucket).toBe('hour');
    expect(single.timeline).toHaveLength(24);
    const old = normalizeAgentUsageReport(await mock.invoke('get_agent_usage', { query: { range: 'custom', start: day(60), end: day(1), granularity: 'hour' } }));
    expect(old.bucket).toBe('day');
  });

  it('supports syncing, storage inspection and clearing history', async () => {
    const mock = createBrowserMockRuntime('running');
    const synced = await mock.invoke('sync_agent_usage') as { changedFiles: number };
    expect(synced.changedFiles).toBeGreaterThan(0);
    const storage = await mock.invoke('get_agent_usage_storage') as { dailyRows: number };
    expect(storage.dailyRows).toBeGreaterThan(0);
    await mock.invoke('clear_agent_usage_history');
    const cleared = normalizeAgentUsageReport(await mock.invoke('get_agent_usage', { query: { range: '7d' } }));
    expect(cleared.totals.totalTokens).toBe(0);
  });
});

describe('local usage refresh preferences', () => {
  it('defaults missing, blank, retired and invalid intervals to five minutes', () => {
    const read = spyOn(usagePreferences, 'getItem');
    try {
      for (const stored of [null, '', ' ', 'invalid', '-1', '1234', '60000']) {
        read.mockReturnValue(stored);
        expect(loadAgentUsageRefreshInterval()).toBe(DEFAULT_AGENT_USAGE_REFRESH_INTERVAL);
      }
      for (const interval of AGENT_USAGE_REFRESH_INTERVALS) {
        read.mockReturnValue(String(interval));
        expect(loadAgentUsageRefreshInterval()).toBe(interval);
      }
      read.mockReturnValue('0');
      expect(loadAgentUsageRefreshInterval()).toBe(0);
    } finally { read.mockRestore(); }
  });

  it('skips the sync on open only when background sync is off and history exists', () => {
    expect(shouldSyncAgentUsageOnOpen(300_000, '2026-11-01T00:00:00Z')).toBe(true);
    expect(shouldSyncAgentUsageOnOpen(0, '2026-11-01T00:00:00Z')).toBe(false);
    expect(shouldSyncAgentUsageOnOpen(0, '')).toBe(true);
    expect(shouldSyncAgentUsageOnOpen(0)).toBe(true);
  });

  it('persists selected intervals', () => {
    const save = spyOn(usagePreferences, 'setItem').mockImplementation(() => {});
    try {
      saveAgentUsageRefreshInterval(3_600_000);
      expect(save).toHaveBeenCalledWith('cpa-gui.usage-agent-refresh-interval.v1', '3600000');
    } finally { save.mockRestore(); }
  });
});

describe('agent usage chart geometry', () => {
  it('formats token counts with K, M and B units', () => {
    expect(formatAgentUsageCompact(950)).toBe('950');
    expect(formatAgentUsageCompact(12_340)).toBe('12.3K');
    expect(formatAgentUsageCompact(128_400_000)).toBe('128.4M');
    expect(formatAgentUsageCompact(2_000_000_000)).toBe('2B');
    expect(formatAgentUsageCompact(Number.NaN)).toBe('0');
  });

  it('maps a pointer position to the bar slot under it', () => {
    expect(slotIndexAt(40, 44, 600, 30)).toBeNull();
    expect(slotIndexAt(44, 44, 600, 30)).toBe(0);
    expect(slotIndexAt(44 + 600, 44, 600, 30)).toBe(29);
    expect(slotIndexAt(44 + 305, 44, 600, 30)).toBe(15);
    expect(slotIndexAt(100, 44, 600, 0)).toBeNull();
  });

  it('thins axis labels to the available width', () => {
    expect(labelStep(7, 600, 64)).toBe(1);
    expect(labelStep(720, 600, 96)).toBe(120);
    expect(labelStep(30, 0, 64)).toBe(30);
  });

  it('widens the axis gutter to fit the widest tick label', () => {
    expect(axisLabelWidth('$250.00')).toBeGreaterThan(axisLabelWidth('$0.00'));
    expect(axisLabelWidth('999.9万')).toBeGreaterThan(axisLabelWidth('500K'));
    expect(axisGutter(['$0.00', '$9.99'], 44, 8)).toBe(44);
    expect(axisGutter(['0', '1000万'], 40, 10)).toBe(axisLabelWidth('1000万') + 10);
    expect(axisGutter(['$0.00', '$250.00'], 44, 8)).toBe(axisLabelWidth('$250.00') + 8);
    expect(axisGutter(['0', '20K'], 44, 8)).toBe(44);
    expect(axisGutter([], 44, 8)).toBe(44);
  });

  it('scales sparkline points to the peak value', () => {
    expect(sparklinePoints([], 100, 20)).toBe('');
    expect(sparklinePoints([0, 5, 10], 100, 20)).toBe('0,20 50,10 100,0');
    expect(sparklinePoints([3], 100, 20)).toBe('50,0');
    expect(sparklinePoints([0, 0], 100, 20)).toBe('0,20 100,20');
  });
});

describe('agent usage chart scales', () => {
  it('fits the value axis tightly above the peak', () => {
    expect(axisScale(101_000_000)).toEqual({ ceiling: 125_000_000, step: 25_000_000 });
    expect(axisScale(4_100_000_000)).toEqual({ ceiling: 5_000_000_000, step: 1_000_000_000 });
    expect(axisScale(3)).toEqual({ ceiling: 3, step: 1 });
    expect(axisScale(57_000)).toEqual({ ceiling: 60_000, step: 20_000 });
    expect(axisScale(0)).toEqual({ ceiling: 4, step: 1 });
  });

  it('splits heatmap values into quartile levels', () => {
    const thresholds = heatThresholds([0, 1, 2, 3, 4, 100]);
    expect(thresholds).toEqual([2, 3, 4]);
    expect([0, 1, 2, 3, 4, 100].map((value) => heatLevel(value, thresholds))).toEqual([0, 1, 2, 3, 4, 4]);
    expect(heatLevel(7, heatThresholds([7, 7]))).toBe(4);
    expect(heatThresholds([0, 0])).toEqual([]);
    expect(heatLevel(5, [])).toBe(1);
  });
});

describe('agent usage range changes and year boundaries', () => {
  it('keeps the chosen granularity unless hourly data is unavailable', () => {
    expect(rangeGranularity('week', true)).toBe('week');
    expect(rangeGranularity('hour', true)).toBe('hour');
    expect(rangeGranularity('hour', false)).toBe('day');
    expect(rangeGranularity('month', false)).toBe('month');
    expect(rangeGranularity('', true)).toBe('');
  });

  it('allows hourly buckets only where hourly history is kept', () => {
    const now = new Date(2026, 10, 5, 10);
    expect(agentUsageHourAvailable('today', '', now)).toBe(true);
    expect(agentUsageHourAvailable('30d', '', now)).toBe(true);
    expect(agentUsageHourAvailable('all', '', now)).toBe(false);
    expect(agentUsageHourAvailable('custom', '2026-10-07', now)).toBe(true);
    expect(agentUsageHourAvailable('custom', '2026-10-06', now)).toBe(false);
  });

  it('resolves quick picks to local calendar dates', () => {
    const now = new Date(2026, 0, 7, 10);
    const ranges = Object.fromEntries(AGENT_USAGE_PRESETS.map((preset) => [preset, agentUsagePresetRange(preset, now)]));
    expect(ranges).toEqual({
      yesterday: { start: '2026-01-06', end: '2026-01-06' },
      thisWeek: { start: '2026-01-05', end: '2026-01-07' },
      lastWeek: { start: '2025-12-29', end: '2026-01-04' },
      thisMonth: { start: '2026-01-01', end: '2026-01-07' },
      lastMonth: { start: '2025-12-01', end: '2025-12-31' },
      last90Days: { start: '2025-10-10', end: '2026-01-07' },
      thisYear: { start: '2026-01-01', end: '2026-01-07' },
      lastYear: { start: '2025-01-01', end: '2025-12-31' },
    });
    expect(agentUsagePresetRange('thisWeek', new Date(2026, 10, 8, 23))).toEqual({ start: '2026-11-02', end: '2026-11-08' });
    expect(agentUsagePresetRange('lastMonth', new Date(2026, 2, 31))).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('shows the year on axis labels that cross into a new year', () => {
    expect(formatAgentUsageAxisLabel('2027-01-04', 'week', '2026-12-28')).toBe('2027-01-04');
    expect(formatAgentUsageAxisLabel('2027-01-01T00', 'hour', '2026-12-31T23')).toBe('2027-01-01 00:00');
    expect(formatAgentUsageAxisLabel('2026-12-28', 'day', '2026-12-21')).toBe('12-28');
    expect(formatAgentUsageAxisLabel('2027-01', 'month', '2026-12')).toBe('2027-01');
  });

  it('sizes the calendar to the available columns unless history is longer', () => {
    const fit = buildCalendarGrid([], '2026-11-05', calendarSpanDays('2026-10-20', '2026-11-05', 40));
    expect(fit).toHaveLength(40);
    expect(fit.at(-1)?.some((day) => day.date === '2026-11-05')).toBe(true);
    const long = calendarSpanDays('2025-01-01', '2026-11-05', 40);
    expect(long).toBe(674);
    expect(buildCalendarGrid([], '2026-11-05', long).length).toBeGreaterThan(40);
    const yearSpan = buildCalendarGrid([], '2027-01-03', calendarSpanDays('2026-12-01', '2027-01-03', 10));
    expect(yearSpan).toHaveLength(10);
    expect(yearSpan.at(-1)?.at(-1)?.date).toBe('2027-01-03');
    expect(calendarSpanDays('bad', '2026-11-05', 0)).toBe(4);
  });

  it('labels each month at the week that contains its first day, never in the future', () => {
    const grid = buildCalendarGrid([], '2027-01-03', calendarSpanDays('2026-11-20', '2027-01-03', 8));
    const starts = calendarMonthStarts(grid, '2027-01-03');
    expect(starts.filter(Boolean)).toEqual(['2026-12-01', '2027-01-01']);
    expect(starts.at(-1)).toBe('2027-01-01');
    const before = buildCalendarGrid([], '2026-12-31', calendarSpanDays('2026-12-01', '2026-12-31', 6));
    expect(calendarMonthStarts(before, '2026-12-31').filter(Boolean)).toEqual(['2026-12-01']);
  });

  it('reserves calendar columns for the recorded history between a floor and a cap', () => {
    expect(calendarMinColumns('2026-11-04', '2026-11-05')).toBe(8);
    expect(calendarMinColumns('2026-08-01', '2026-11-05')).toBe(15);
    expect(calendarMinColumns('2024-01-01', '2026-11-05')).toBe(26);
  });
});
