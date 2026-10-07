import { describe, expect, test } from 'bun:test';
import {
  calculateCacheReadRate,
  calculateGenerationSpeed,
  calculateTokenComposition,
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

describe('token composition', () => {
  test('splits cached input without double counting cache or reasoning', () => {
    const tokens = {
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 600,
      cacheCreationTokens: 100,
      reasoningTokens: 80,
    };
    const composition = calculateTokenComposition(tokens);
    expect(composition.total).toBe(1_200);
    expect(composition.segments.map((segment) => segment.value)).toEqual([300, 600, 100, 200]);
    expect(composition.cacheShare).toBe(50);
    expect(composition.segments.reduce((total, segment) => total + segment.percent, 0)).toBeCloseTo(100);
    expect(composition.segments[1].offset).toBe(25);
  });

  test('keeps an empty chart finite and free of colored segments', () => {
    const composition = calculateTokenComposition({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(composition.total).toBe(0);
    expect(composition.cacheShare).toBe(0);
    expect(composition.segments.every((segment) => segment.value === 0 && segment.percent === 0 && segment.offset === 0)).toBe(true);
  });

  test('avoids negative uncached input when legacy cache counts exceed input', () => {
    const composition = calculateTokenComposition({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 600, cacheCreationTokens: 0 });
    expect(composition.total).toBe(600);
    expect(composition.segments[0].value).toBe(0);
    expect(composition.cacheShare).toBe(100);
  });

  test('normalizes invalid counts before calculating chart proportions', () => {
    const composition = calculateTokenComposition({ inputTokens: Number.NaN, outputTokens: 100, cacheReadTokens: -10, cacheCreationTokens: Number.POSITIVE_INFINITY });
    expect(composition.total).toBe(100);
    expect(composition.segments.map((segment) => segment.percent)).toEqual([0, 0, 0, 100]);
  });
});
