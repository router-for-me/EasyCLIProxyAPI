import { describe, expect, test } from 'bun:test';
import {
  OTHER_TREND_MODEL_KEY,
  buildUsageTrendSeries,
  chooseTrendBucket,
  findTrendPointIndex,
  formatLocalHourKey,
  formatTrendAxisLabel,
  formatTrendRangeLabel,
  niceCeiling,
  parseLocalHourKey,
  stackModelTokens,
  startOfBucket,
  trendAxisTicks,
  trendTimeAxisTicks,
  trendTimePosition,
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
    expect(date?.getMinutes()).toBe(0);
    expect(formatLocalHourKey(date as Date)).toBe('2026-09-14-15-00');
    expect(parseLocalHourKey('2026-09-14-15-30')?.getMinutes()).toBe(30);
    expect(parseLocalHourKey('2026-02-30-10')).toBeNull();
  });

  test('chooses coarser buckets as the range grows', () => {
    const hourStart = new Date(2026, 8, 14, 12, 0, 0);
    expect(chooseTrendBucket(hourStart, new Date(2026, 8, 14, 16, 0, 0))).toBe('30m');
    expect(chooseTrendBucket(hourStart, new Date(2026, 8, 15, 12, 0, 0))).toBe('hour');
    expect(chooseTrendBucket(new Date(2026, 8, 1, 0, 0, 0), new Date(2026, 8, 4, 0, 0, 0))).toBe('3h');
    expect(chooseTrendBucket(new Date(2026, 8, 1, 0, 0, 0), new Date(2026, 8, 8, 0, 0, 0))).toBe('day');
    expect(chooseTrendBucket(new Date(2026, 8, 1, 0, 0, 0), new Date(2026, 8, 16, 0, 0, 0))).toBe('day');
    expect(chooseTrendBucket(new Date(2026, 8, 1, 0, 0, 0), new Date(2026, 9, 1, 0, 0, 0))).toBe('day');
    expect(chooseTrendBucket(new Date(2025, 0, 1, 0, 0, 0), new Date(2026, 6, 1, 0, 0, 0))).toBe('week');
    expect(chooseTrendBucket(new Date(2022, 0, 1, 0, 0, 0), new Date(2026, 0, 1, 0, 0, 0))).toBe('month');
    expect(chooseTrendBucket(new Date(2010, 0, 1, 0, 0, 0), new Date(2026, 0, 1, 0, 0, 0))).toBe('year');
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

    expect(series.bucket).toBe('30m');
    expect(series.points.map((item) => item.hour)).toEqual([
      '2026-09-14-10-00',
      '2026-09-14-10-30',
      '2026-09-14-11-00',
      '2026-09-14-11-30',
      '2026-09-14-12-00',
      '2026-09-14-12-30',
      '2026-09-14-13-00',
      '2026-09-14-13-30',
    ]);
    expect(series.points[1]).toMatchObject({ requests: 0, tokens: 0 });
    expect(series.points[4]).toMatchObject({ requests: 1, failure: 1, tokens: 10 });
    expect(series.totals).toMatchObject({ requests: 3, tokens: 30, failures: 1 });
    expect(series.peak?.hour).toBe('2026-09-14-10-00');
    expect(series.peak?.tokens).toBe(20);
  });

  test('fills idle hours before the first event in the selected range', () => {
    const start = new Date(2026, 8, 14, 8, 0, 0);
    const end = new Date(2026, 8, 14, 12, 0, 0);
    const series = buildUsageTrendSeries(
      [point('2026-09-14-10', 2, 20)],
      { start: start.toISOString(), end: end.toISOString() },
    );

    expect(series.bucket).toBe('30m');
    expect(series.points.map((item) => item.hour)).toEqual([
      '2026-09-14-08-00',
      '2026-09-14-08-30',
      '2026-09-14-09-00',
      '2026-09-14-09-30',
      '2026-09-14-10-00',
      '2026-09-14-10-30',
      '2026-09-14-11-00',
      '2026-09-14-11-30',
    ]);
    expect(series.points[0]).toMatchObject({ requests: 0, tokens: 0 });
    expect(series.points[4]).toMatchObject({ requests: 2, tokens: 20 });
  });

  test('aggregates sparse hours into 3-hour buckets', () => {
    const start = new Date(2026, 8, 1, 0, 0, 0);
    const end = new Date(2026, 8, 4, 0, 0, 0);
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
    expect(series.points.length).toBe(24);
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

  test.each([
    [4, '30m', 8],
    [24, 'hour', 24],
    [7 * 24, 'day', 7],
    [30 * 24, 'day', 30],
  ] as const)('divides a %i-hour range by time, including empty slots', (hours, bucket, count) => {
    const start = new Date(2026, 8, 1);
    const end = new Date(start.getTime() + hours * 3_600_000);
    const series = buildUsageTrendSeries([], { start: start.toISOString(), end: end.toISOString() });
    expect(series.bucket).toBe(bucket);
    expect(series.points).toHaveLength(count);
    expect(series.points[0].start).toEqual(start);
    expect(series.points.at(-1)?.end).toEqual(end);
    expect(series.points.every((item) => item.tokens === 0)).toBe(true);
  });

  test('clips partial boundary slots without dropping prefiltered tokens', () => {
    const start = new Date(2026, 8, 14, 10, 17);
    const end = new Date(2026, 8, 14, 14, 17);
    const series = buildUsageTrendSeries([
      point('2026-09-14-09-30', 1, 100),
      point('2026-09-14-10-00', 1, 10),
      point('2026-09-14-14-00', 2, 20),
      point('2026-09-14-14-30', 1, 200),
    ], { start: start.toISOString(), end: end.toISOString() });
    expect(series.points[0].start).toEqual(start);
    expect(series.points.at(-1)?.end).toEqual(end);
    expect(series.points[0].tokens).toBe(10);
    expect(series.points.at(-1)?.tokens).toBe(20);
    expect(series.totals.tokens).toBe(30);
    expect(series.points.reduce((sum, item) => sum + item.tokens, 0)).toBe(30);
    expect(trendTimePosition(series.points[0].end, start, end)).toBeCloseTo(13 / 240);
    expect(findTrendPointIndex(series.points, new Date(2026, 8, 14, 10, 29))).toBe(0);
    expect(findTrendPointIndex(series.points, new Date(2026, 8, 14, 10, 30))).toBe(1);
    expect(findTrendPointIndex(series.points, end)).toBe(series.points.length - 1);
    expect(formatTrendRangeLabel(series.points[0], 'zh-CN', '30m')).toContain('10:17-10:30');
  });

  test('keeps an inclusive end request in the final bar without extending the range', () => {
    const start = new Date(2026, 8, 14, 10);
    const end = new Date(2026, 8, 14, 14);
    const series = buildUsageTrendSeries([point('2026-09-14-14-00', 1, 50)], {
      start: start.toISOString(), end: end.toISOString(),
    });
    expect(series.points).toHaveLength(8);
    expect(series.points.at(-1)?.end).toEqual(end);
    expect(series.points.at(-1)?.tokens).toBe(50);
  });

  test('uses the selected open range and handles reversed ranges', () => {
    const start = new Date(2026, 8, 14, 10, 17);
    const now = new Date(2026, 8, 14, 14, 17);
    const series = buildUsageTrendSeries([point('2026-09-14-11-00', 1, 10)], { start: start.toISOString() }, now);
    expect(series.points[0].start).toEqual(start);
    expect(series.points.at(-1)?.end).toEqual(now);
    expect(buildUsageTrendSeries([], { start: now.toISOString(), end: start.toISOString() }).points).toEqual([]);
    expect(buildUsageTrendSeries([]).points).toEqual([]);
  });

  test('scales months by their elapsed duration instead of equal point indexes', () => {
    const start = new Date(2023, 0, 1);
    const end = new Date(2026, 0, 1);
    const series = buildUsageTrendSeries([], { start: start.toISOString(), end: end.toISOString() });
    expect(series.bucket).toBe('month');
    const widths = series.points.slice(0, 2).map((item) =>
      trendTimePosition(item.end, start, end) - trendTimePosition(item.start, start, end),
    );
    expect(widths[0] / widths[1]).toBeCloseTo(31 / 28);
  });

  test('adapts time ticks to duration and width while retaining exact endpoints', () => {
    const start = new Date(2026, 8, 14, 10, 17);
    const end = new Date(2026, 8, 14, 14, 17);
    const wide = trendTimeAxisTicks(start, end, 1000);
    const narrow = trendTimeAxisTicks(start, end, 320);
    expect(wide[0]).toEqual(start);
    expect(wide.at(-1)).toEqual(end);
    expect(wide.length).toBeGreaterThan(narrow.length);
    const interval = wide[1].getTime() - wide[0].getTime();
    for (let index = 2; index < wide.length; index++) {
      expect(wide[index].getTime() - wide[index - 1].getTime()).toBe(interval);
    }
    expect(trendTimePosition(wide[1], start, end)).toBeCloseTo(interval / (end.getTime() - start.getTime()));
    expect(trendTimeAxisTicks(start, start, 800)).toEqual([start]);
    const months = trendTimeAxisTicks(new Date(2023, 0, 1), new Date(2026, 0, 1), 1000);
    expect(months.every((date) => date.getDate() === 1)).toBe(true);
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
    expect(series.models[0].color).not.toBe(series.models[1].color);
    const stacked = stackModelTokens(series.points[0], series.models);
    expect(stacked[0]).toMatchObject({ key: 'model-0', tokens: 80, y0: 0, y1: 80 });
    expect(stacked[stacked.length - 1].key).toBe(OTHER_TREND_MODEL_KEY);
    expect(stacked[stacked.length - 1].y1).toBe(series.points[0].tokens);
    const hidden = stackModelTokens(series.points[0], series.models, new Set(['model-0']));
    expect(hidden[0].key).toBe('model-1');
    expect(hidden[hidden.length - 1].y1).toBe(series.points[0].tokens - 80);
  });

  test('builds readable axis ticks and labels', () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(12)).toBe(20);
    expect(trendAxisTicks(20)).toEqual([0, 5, 10, 15, 20]);
    expect(trendAxisTicks(5)).toEqual([0, 1, 2, 3, 4, 5]);

    const hourPoint = {
      ...point('2026-09-14-15', 1, 1),
      start: new Date(2026, 8, 14, 15, 0, 0),
      end: new Date(2026, 8, 14, 16, 0, 0),
    };
    expect(formatTrendAxisLabel(hourPoint, 'hour', 'en', { compactSameDay: true })).toMatch(/15:00|3:00/);
    expect(formatTrendAxisLabel(hourPoint, 'day', 'en', { showTime: true })).toMatch(/15:00|3:00/);
    const rangeLabel = formatTrendRangeLabel(hourPoint, 'en', 'hour');
    expect(rangeLabel).toMatch(/9\/14|14\/9/);
    expect(rangeLabel).toMatch(/15:00|3:00/);
    expect(formatTrendRangeLabel({ ...hourPoint, end: new Date(2026, 8, 15, 0, 0, 0) }, 'en', 'day')).toMatch(/9\/14|14\/9/);
  });
});
