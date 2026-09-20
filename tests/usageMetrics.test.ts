import { describe, expect, test } from 'bun:test';
import {
  calculateCacheReadRate,
  calculateGenerationSpeed,
  formatCacheReadRate,
  formatGenerationSpeed,
} from '../src/services/usageMetrics';

describe('generation speed', () => {
  test('uses the total request latency without requiring TTFT', () => {
    const input = { outputTokens: 344, latencyMs: 10_600 };
    expect(calculateGenerationSpeed(input)).toBeCloseTo(32.4528, 4);
    expect(formatGenerationSpeed(input)).toBe('32.5 t/s');
  });

  test.each([
    { outputTokens: 344, latencyMs: 0 },
    { outputTokens: 344, latencyMs: -1 },
    { outputTokens: 0, latencyMs: 10_600 },
    { outputTokens: -1, latencyMs: 10_600 },
    { outputTokens: Number.NaN, latencyMs: 10_600 },
    { outputTokens: 344, latencyMs: Number.POSITIVE_INFINITY },
  ])('returns an em dash when generation speed cannot be calculated', (input) => {
    expect(calculateGenerationSpeed(input)).toBeNull();
    expect(formatGenerationSpeed(input)).toBe('—');
  });
});

describe('cache read rate', () => {
  test('calculates the percentage from cache-read and input tokens', () => {
    const input = { inputTokens: 1_000, cacheReadTokens: 250 };
    expect(calculateCacheReadRate(input)).toBe(25);
    expect(formatCacheReadRate(input)).toBe('25.00%');
  });

  test('clamps inconsistent values to 100 percent', () => {
    const input = { inputTokens: 400, cacheReadTokens: 600 };
    expect(calculateCacheReadRate(input)).toBe(100);
    expect(formatCacheReadRate(input)).toBe('100.00%');
  });

  test.each([0, -1])('returns an em dash when input tokens are %s', (inputTokens) => {
    const input = { inputTokens, cacheReadTokens: 250 };
    expect(calculateCacheReadRate(input)).toBeNull();
    expect(formatCacheReadRate(input)).toBe('—');
  });
});
