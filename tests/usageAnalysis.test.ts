import { describe, expect, test } from 'bun:test';
import {
  categoryMetricValue,
  failureRatePercent,
  sortCategoriesByMetric,
} from '../src/services/usageAnalysis';

const categories = [
  { key: 'steady', requests: 100, failures: 2, tokens: 500 },
  { key: 'busy', requests: 200, failures: 1, tokens: 2_000 },
  { key: 'unhealthy', requests: 20, failures: 5, tokens: 100 },
];

describe('usage analysis metrics', () => {
  test('calculates an absolute failure-rate percentage', () => {
    expect(failureRatePercent(categories[2])).toBe(25);
  });

  test('returns zero failure rate when there are no requests', () => {
    expect(failureRatePercent({ key: 'empty', requests: 0, failures: 3, tokens: 0 })).toBe(0);
  });

  test.each([
    ['tokens', 500],
    ['requests', 100],
    ['failureRate', 2],
  ] as const)('returns the %s metric value', (metric, expected) => {
    expect(categoryMetricValue(categories[0], metric)).toBe(expected);
  });

  test.each([
    ['tokens', ['busy', 'steady', 'unhealthy']],
    ['requests', ['busy', 'steady', 'unhealthy']],
    ['failureRate', ['unhealthy', 'steady', 'busy']],
  ] as const)('sorts categories by %s without mutating input', (metric, expected) => {
    const original = [...categories];
    expect(sortCategoriesByMetric(categories, metric).map((item) => item.key)).toEqual(expected);
    expect(categories).toEqual(original);
  });
});
