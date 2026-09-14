import { describe, expect, test } from 'bun:test';
import {
  OTHER_TREND_MODEL_KEY,
  buildUsageTrendSeries,
  chooseTrendBucket,
  formatLocalHourKey,
  formatTrendAxisLabel,
  formatTrendRangeLabel,
  niceCeiling,
  parseLocalHourKey,
  selectTrendAxisLabels,
  smoothAreaPath,
  smoothLinePath,
  stackModelTokens,
  startOfBucket,
  trendAxisTicks,
  type UsageTimelinePoint,
} from '../src/services/usageTrend';

const point = (
  hour: string,
  requests: number,
  tokens: number,
  extras: Partial<UsageTimelinePoint> = {},
): UsageTimelinePoint => ({
  hour,
  requests,
  tokens,
  success: extras.success ?? requests,
  failure: extras.failure ?? 0,
  canceled: extras.canceled ?? 0,
});

describe('usage trend helpers', () => {
  test('parses and formats local hour keys', () => {
    const date = parseLocalHourKey('2026-09-14-15');
    expect(date).not.toBeNull();
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(8);
    expect(date?.getDate()).toBe(14);
    expect(date?.getHours()).toBe(15);
    expect(formatLocalHourKey(date as Date)).toBe('2026-09-14-15');
    expect(parseLocalHourKey('2026-02-30-10')).toBeNull();
  });

  test('chooses coarser buckets as the range grows', () => {
    const hourStart = new Date(2026, 8, 14, 12, 0, 0);
    expect(chooseTrendBucket(hourStart, new Date(2026, 8, 15, 12, 0, 0))).toBe('hour');
    expect(chooseTrendBucket(new Date(2026, 8, 1, 0, 0, 0), new Date(2026, 8, 8, 0, 0, 0))).toBe('3h');
    expect(chooseTrendBucket(new Date(2026, 8, 1, 0, 0, 0), new Date(2026, 8, 16, 0, 0, 0))).toBe('day');
    expect(chooseTrendBucket(new Date(2026, 8, 1, 0, 0, 0), new Date(2026, 9, 1, 0, 0, 0))).toBe('day');
    expect(chooseTrendBucket(new Date(2025, 0, 1, 0, 0, 0), new Date(2026, 6, 1, 0, 0, 0))).toBe('week');
    expect(chooseTrendBucket(new Date(2022, 0, 1, 0, 0, 0), new Date(2026, 0, 1, 0, 0, 0))).toBe('month');
    expect(chooseTrendBucket(new Date(2018, 0, 1, 0, 0, 0), new Date(2026, 0, 1, 0, 0, 0))).toBe('year');
  });

  test('fills idle hours inside the selected range', () => {
    const start = new Date(2026, 8, 14, 10, 0, 0);
    const end = new Date(2026, 8, 14, 14, 0, 0);
    const series = buildUsageTrendSeries(
      [
        point('2026-09-14-10', 2, 20),
        point('2026-09-14-12', 1, 10, { success: 0, failure: 1 }),
      ],
      { start: start.toISOString(), end: end.toISOString() },
    );

    expect(series.bucket).toBe('hour');
    expect(series.points.map((item) => item.hour)).toEqual([
      '2026-09-14-10',
      '2026-09-14-11',
      '2026-09-14-12',
      '2026-09-14-13',
    ]);
    expect(series.points[1]).toMatchObject({ requests: 0, tokens: 0 });
    expect(series.points[2]).toMatchObject({ requests: 1, failure: 1, tokens: 10 });
    expect(series.totals).toMatchObject({ requests: 3, tokens: 30, failures: 1 });
    expect(series.peak?.hour).toBe('2026-09-14-10');
    expect(series.peak?.tokens).toBe(20);
  });

  test('fills idle hours before the first event in the selected range', () => {
    const start = new Date(2026, 8, 14, 8, 0, 0);
    const end = new Date(2026, 8, 14, 12, 0, 0);
    const series = buildUsageTrendSeries(
      [point('2026-09-14-10', 2, 20)],
      { start: start.toISOString(), end: end.toISOString() },
    );

    expect(series.bucket).toBe('hour');
    expect(series.points.map((item) => item.hour)).toEqual([
      '2026-09-14-08',
      '2026-09-14-09',
      '2026-09-14-10',
      '2026-09-14-11',
    ]);
    expect(series.points[0]).toMatchObject({ requests: 0, tokens: 0 });
    expect(series.points[2]).toMatchObject({ requests: 2, tokens: 20 });
  });

  test('aggregates sparse hours into 3-hour buckets', () => {
    const start = new Date(2026, 8, 1, 0, 0, 0);
    const end = new Date(2026, 8, 8, 0, 0, 0);
    const series = buildUsageTrendSeries(
      [
        point('2026-09-01-01', 1, 5),
        point('2026-09-01-02', 3, 7, { success: 2, failure: 1 }),
      ],
      { start: start.toISOString(), end: end.toISOString() },
    );

    expect(series.bucket).toBe('3h');
    const first = series.points[0];
    expect(startOfBucket(first.start, '3h').getHours()).toBe(0);
    expect(first).toMatchObject({ requests: 4, tokens: 12, failure: 1, success: 3 });
    expect(series.points.length).toBeGreaterThan(40);
  });

  test('uses daily buckets and fills idle days for a 30-day range', () => {
    const start = new Date(2026, 7, 15, 8, 0, 0);
    const end = new Date(2026, 8, 14, 18, 0, 0);
    const series = buildUsageTrendSeries(
      [
        point('2026-08-15-09', 2, 8),
        point('2026-09-14-10', 5, 20, { success: 4, failure: 1 }),
      ],
      { start: start.toISOString(), end: end.toISOString() },
    );

    expect(series.bucket).toBe('day');
    expect(series.points[0]).toMatchObject({ requests: 2, tokens: 8 });
    expect(series.points[series.points.length - 1]).toMatchObject({ requests: 5, tokens: 20, failure: 1 });
    expect(series.points.some((item) => item.requests === 0)).toBe(true);
    expect(series.points.length).toBeGreaterThan(20);
  });

  test('starts week buckets on Monday', () => {
    const thursday = new Date(2026, 0, 1, 12, 0, 0);
    const monday = startOfBucket(thursday, 'week');
    expect(monday.getDay()).toBe(1);
    expect(monday.getFullYear()).toBe(2025);
    expect(monday.getMonth()).toBe(11);
    expect(monday.getDate()).toBe(29);
  });

  test('stacks model tokens and groups overflow models', () => {
    const start = new Date(2026, 8, 14, 10, 0, 0);
    const end = new Date(2026, 8, 14, 12, 0, 0);
    const models = Array.from({ length: 8 }, (_, index) => ({
      key: `model-${index}`,
      label: `Model ${index}`,
      tokens: (8 - index) * 10,
    }));
    const series = buildUsageTrendSeries(
      [
        {
          hour: '2026-09-14-10',
          requests: 1,
          success: 1,
          failure: 0,
          canceled: 0,
          tokens: models.reduce((sum, model) => sum + model.tokens, 0),
          models,
        },
      ],
      { start: start.toISOString(), end: end.toISOString() },
    );

    expect(series.models.map((model) => model.key)).toEqual([
      'model-0',
      'model-1',
      'model-2',
      'model-3',
      'model-4',
      'model-5',
      OTHER_TREND_MODEL_KEY,
    ]);
    expect(series.models[0].star).toBe(true);
    expect(series.models[1].star).toBe(false);
    expect(series.models[0].color).not.toBe(series.models[1].color);
    const stacked = stackModelTokens(series.points[0], series.models);
    expect(stacked[0]).toMatchObject({ key: 'model-0', tokens: 80, y0: 0, y1: 80 });
    expect(stacked[stacked.length - 1].key).toBe(OTHER_TREND_MODEL_KEY);
    expect(stacked[stacked.length - 1].y1).toBe(series.points[0].tokens);
    const hidden = stackModelTokens(series.points[0], series.models, new Set(['model-0']));
    expect(hidden[0].key).toBe('model-1');
    expect(hidden[hidden.length - 1].y1).toBe(series.points[0].tokens - 80);
  });

  test('builds a monotone cubic path that stays inside the value range', () => {
    const line = smoothLinePath([
      { x: 0, y: 10 },
      { x: 10, y: 0 },
      { x: 20, y: 10 },
    ]);
    expect(line).toContain('C');
    const numbers = [...line.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    const ys = numbers.filter((_, index) => index % 2 === 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(10);
    expect(smoothAreaPath(
      [{ x: 0, y: 4 }, { x: 10, y: 8 }],
      [{ x: 0, y: 10 }, { x: 10, y: 10 }],
    )).toContain('Z');
  });

  test('builds readable axis ticks and labels', () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(12)).toBe(20);
    expect(trendAxisTicks(20)).toEqual([0, 10, 20]);
    expect(selectTrendAxisLabels(24, 6)[0]).toBe(0);
    expect(selectTrendAxisLabels(24, 6).at(-1)).toBe(23);
    expect(selectTrendAxisLabels(24, 6)).toHaveLength(6);

    const hourPoint = {
      ...point('2026-09-14-15', 1, 1),
      start: new Date(2026, 8, 14, 15, 0, 0),
      end: new Date(2026, 8, 14, 16, 0, 0),
    };
    expect(formatTrendAxisLabel(hourPoint, 'hour', 'en', { compactSameDay: true })).toMatch(/15:00|3:00/);
    const rangeLabel = formatTrendRangeLabel(hourPoint, 'en', 'hour');
    expect(rangeLabel).toMatch(/9\/14|14\/9/);
    expect(rangeLabel).toMatch(/15:00|3:00/);
    expect(formatTrendRangeLabel({ ...hourPoint, end: new Date(2026, 8, 15, 0, 0, 0) }, 'en', 'day')).toMatch(/9\/14|14\/9/);
  });
});
