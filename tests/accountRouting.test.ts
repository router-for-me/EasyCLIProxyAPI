import { describe, expect, it } from 'bun:test';
import {
  accountQuotaScore,
  currentPreferredAccountId,
  nextAccountSwitchPriority,
  preferredQuotaAccountId,
} from '../src/services/accountRouting';

const quota = (...remaining: Array<number | null>) => ({
  status: 'success' as const,
  rows: remaining.map((remainingPercent, index) => ({
    label: `window-${index}`,
    remainingPercent,
  })),
});

describe('额度感知账号选择', () => {
  it('优先比较最紧张的额度窗口，再比较平均剩余额度', () => {
    expect(preferredQuotaAccountId([
      { id: 'high-average', priority: 0, quota: quota(80, 50) },
      { id: 'balanced', priority: 0, quota: quota(60, 60) },
    ])).toBe('balanced');

    expect(preferredQuotaAccountId([
      { id: 'lower-average', priority: 0, quota: quota(60, 70) },
      { id: 'higher-average', priority: 0, quota: quota(60, 90) },
    ])).toBe('higher-average');
  });

  it('忽略未知窗口和查询失败账号，并以当前优先级打破额度并列', () => {
    expect(accountQuotaScore(quota(null, 120, -10))).toEqual({
      bottleneckRemaining: 0,
      averageRemaining: 50,
      knownWindows: 2,
    });
    expect(preferredQuotaAccountId([
      { id: 'failed', priority: 99, quota: { status: 'error', rows: [], error: 'offline' } },
      { id: 'priority-1', priority: 1, quota: quota(75) },
      { id: 'priority-2', priority: 2, quota: quota(75) },
    ])).toBe('priority-2');
  });

  it('生成高于同组现有值的安全优先级', () => {
    expect(nextAccountSwitchPriority([
      { id: 'first', priority: 0, quota: quota(10) },
      { id: 'second', priority: 12, quota: quota(20) },
    ])).toBe(13);
    expect(nextAccountSwitchPriority([
      { id: 'overflow', priority: Number.MAX_SAFE_INTEGER, quota: quota(20) },
    ])).toBeNull();
  });

  it('额度不可比较时只保留唯一的当前优先账号', () => {
    expect(currentPreferredAccountId([
      { id: 'first', priority: 0, quota: quota(10) },
      { id: 'second', priority: 2, quota: quota(20) },
    ])).toBe('second');
    expect(currentPreferredAccountId([
      { id: 'first', priority: 0, quota: quota(10) },
      { id: 'second', priority: 0, quota: quota(20) },
    ])).toBeNull();
    expect(currentPreferredAccountId([])).toBeNull();
  });
});
