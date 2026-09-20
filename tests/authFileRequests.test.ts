import { describe, expect, it } from 'bun:test';
import { authFileRequestStats, requestRateColor } from '../src/services/authFileRequests';

describe('credential request statistics', () => {
  it('keeps cumulative counts separate from the recent success rate and preserves server times', () => {
    const stats = authFileRequestStats({
      success: 900,
      failed: 100,
      recent_requests: [
        { time: '23:50-00:00', success: 3, failed: 1 },
        { time: '00:00-00:10', success: 0, failed: 2 },
      ],
    });
    expect(stats.success).toBe(900);
    expect(stats.failure).toBe(100);
    expect(stats.recentSuccess).toBe(3);
    expect(stats.recentFailure).toBe(3);
    expect(stats.recentRate).toBe(0.5);
    expect(stats.buckets).toHaveLength(20);
    expect(stats.buckets[18]).toEqual({ time: '23:50-00:00', success: 3, failure: 1, rate: 0.75 });
    expect(stats.buckets[19].rate).toBe(0);
    expect(stats.buckets[0].rate).toBeNull();
  });

  it('distinguishes unsupported statistics from an empty interval, without inventing a success rate', () => {
    const missing = authFileRequestStats({});
    expect(missing.recentAvailable).toBe(false);
    expect(missing.success).toBeNull();
    expect(missing.failure).toBeNull();
    expect(missing.recentRate).toBeNull();
    const empty = authFileRequestStats({ success: 0, failed: 0, recent_requests: [] });
    expect(empty.recentAvailable).toBe(true);
    expect(empty.success).toBe(0);
    expect(empty.failure).toBe(0);
    expect(empty.recentRate).toBeNull();
    expect(empty.buckets.every((bucket) => bucket.rate === null)).toBe(true);
  });

  it('accepts numeric strings and camelCase fields while rejecting malformed counts', () => {
    const stats = authFileRequestStats({
      successCount: ' 12 ', failureCount: '2',
      recentRequests: [
        null,
        { success: -2, failed: true },
        { success: Infinity, failed: 'NaN' },
        { success: 1.2, failed: [] },
        { time: '10:00-10:10', success: '3', failed: '1' },
      ],
    });
    expect(stats.success).toBe(12);
    expect(stats.failure).toBe(2);
    expect(stats.recentRate).toBe(0.75);
    expect(stats.buckets.slice(0, 19).every((bucket) => bucket.rate === null)).toBe(true);
    for (const value of ['', ' ', -1, true, [], {}, NaN, Infinity, 1.5]) {
      expect(authFileRequestStats({ success: value }).success).toBeNull();
    }
  });

  it('shows only the latest twenty intervals in chronological order', () => {
    const recent = Array.from({ length: 25 }, (_, index) => ({
      time: `bucket-${index}`, success: index, failed: 0,
    }));
    const stats = authFileRequestStats({ recent_requests: recent });
    expect(stats.buckets).toHaveLength(20);
    expect(stats.buckets[0].time).toBe('bucket-5');
    expect(stats.buckets[19].time).toBe('bucket-24');
    expect(stats.recentRate).toBe(1);
    expect(recent).toHaveLength(25);
  });

  it('maps failure, mixed and success rates onto the red-yellow-green scale', () => {
    expect(requestRateColor(0)).toBe('rgb(239, 68, 68)');
    expect(requestRateColor(0.5)).toBe('rgb(250, 204, 21)');
    expect(requestRateColor(1)).toBe('rgb(34, 197, 94)');
  });
});
