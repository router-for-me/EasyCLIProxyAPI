import { describe, expect, test } from 'bun:test';
import {
  calculateCacheReadRate,
  calculateGenerationSpeed,
  formatCacheReadRate,
  formatGenerationSpeed,
} from '../src/services/usageMetrics';

describe('generation speed', () => {
  test('uses only the generation interval after the first token', () => {
    const input = { outputTokens: 344, latencyMs: 10_600, ttftMs: 2_770 };
    expect(calculateGenerationSpeed(input)).toBeCloseTo(43.9336, 4);
    expect(formatGenerationSpeed(input)).toBe('43.9 t/s');
  });

  test.each([
    { outputTokens: 344, latencyMs: 10_600, ttftMs: 0 },
    { outputTokens: 344, latencyMs: 10_600, ttftMs: null },
    { outputTokens: 344, latencyMs: 2_770, ttftMs: 2_770 },
    { outputTokens: 344, latencyMs: 2_000, ttftMs: 2_770 },
    { outputTokens: 0, latencyMs: 10_600, ttftMs: 2_770 },
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

  test('does not clamp values over 100 percent', () => {
    const input = { inputTokens: 400, cacheReadTokens: 600 };
    expect(calculateCacheReadRate(input)).toBe(150);
    expect(formatCacheReadRate(input)).toBe('150.00%');
  });

  test.each([0, -1])('returns an em dash when input tokens are %s', (inputTokens) => {
    const input = { inputTokens, cacheReadTokens: 250 };
    expect(calculateCacheReadRate(input)).toBeNull();
    expect(formatCacheReadRate(input)).toBe('—');
  });
});
