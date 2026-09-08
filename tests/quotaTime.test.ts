import { describe, expect, it } from 'bun:test';
import { formatQuotaReset, quotaResetFor, quotaResetInstant } from '../src/services/quotaTime';
import { formatQuotaTimestamp } from '../src/services/quotaService';

const resetMs = Date.parse('2030-01-01T00:00:00Z');

describe('quota reset instants', () => {
  it('兼容秒、毫秒、数字字符串与高精度 ISO 时间', () => {
    for (const input of [resetMs, resetMs / 1000, String(resetMs), String(resetMs / 1000), '2030-01-01T00:00:00.000000000Z']) {
      expect(quotaResetInstant(input)).toBe(resetMs);
    }
    for (const input of [null, undefined, '', ' ', 0, -1, false, [], {}, NaN, Infinity, 'invalid']) {
      expect(quotaResetInstant(input)).toBeUndefined();
    }
    expect(formatQuotaTimestamp(String(resetMs / 1000), 'en')).not.toBe('—');
  });

  it('跳过坏绝对时间后使用有效别名或相对秒数，仅在获取时计算倒计时', () => {
    expect(quotaResetFor({ reset_at: 'bad', resetAt: resetMs }, ['reset_at', 'resetAt'])).toBe(resetMs);
    expect(quotaResetFor({ ttl: '3600' }, ['reset_at'], ['ttl'], resetMs)).toBe(resetMs + 3600000);
    expect(quotaResetFor({ ttl: 0 }, [], ['ttl'], resetMs)).toBe(resetMs);
    expect(quotaResetFor({ ttl: false }, [], ['ttl'], resetMs)).toBeUndefined();
  });

  it('同一个重置时间显示随时钟更新，过期后提示刷新而不是伪造已恢复额度', () => {
    expect(formatQuotaReset(resetMs, undefined, 'zh-CN', resetMs - 60000)).toContain('1分钟后');
    expect(formatQuotaReset(resetMs, undefined, 'en', resetMs - 60000)).toContain('in 1 minute');
    expect(formatQuotaReset(resetMs, undefined, 'zh-CN', resetMs)).toContain('重置时间已到，请刷新确认');
    expect(formatQuotaReset(undefined, 'legacy', 'en', resetMs)).toBe('legacy');
  });
});
