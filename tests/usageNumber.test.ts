import { describe, expect, test } from 'bun:test';
import { formatDuration, formatUsageNumber } from '../src/services/usageNumber';

describe('使用统计数量单位', () => {
  test('按数量级自动切换 K、M、B', () => {
    expect(formatUsageNumber(999, 'en-US')).toBe('999');
    expect(formatUsageNumber(1_000, 'en-US')).toBe('1K');
    expect(formatUsageNumber(132_000, 'en-US')).toBe('132K');
    expect(formatUsageNumber(486_500, 'en-US')).toBe('486.5K');
    expect(formatUsageNumber(999_949, 'en-US')).toBe('999.9K');
    expect(formatUsageNumber(999_950, 'en-US')).toBe('1M');
    expect(formatUsageNumber(Number.NaN, 'en-US')).toBe('0');
  });

  test('延迟在毫秒和秒之间自动切换', () => {
    expect(formatDuration(842, 'en-US')).toBe('842 ms');
    expect(formatDuration(1_284, 'en-US')).toBe('1.28 s');
    expect(formatDuration(12_840, 'en-US')).toBe('12.8 s');
    expect(formatDuration(Number.NaN, 'en-US')).toBe('0 ms');
  });

  test('百万级使用 M 并在达到阈值时自动切换为 B', () => {
    expect(formatUsageNumber(1_000_000, 'en-US')).toBe('1M');
    expect(formatUsageNumber(12_340_000, 'en-US')).toBe('12.3M');
    expect(formatUsageNumber(999_949_999, 'en-US')).toBe('999.9M');
    expect(formatUsageNumber(999_950_000, 'en-US')).toBe('1B');
    expect(formatUsageNumber(1_250_000_000, 'en-US')).toBe('1.3B');
  });
});
