import { describe, expect, it } from 'bun:test';
import {
  codexResetCreditDetailsFor,
  codexResetCreditsFor,
  quotaRowsFor,
} from '../src/services/quotaService';

describe('quotaRowsFor', () => {
  it('把 Codex 的已用百分比转换为剩余额度', () => {
    const rows = quotaRowsFor('codex', {
      rate_limit: {
        allowed: true,
        primary_window: {
          used_percent: 97,
          limit_window_seconds: 604800,
          reset_at: 1784698723,
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('周限额');
    expect(rows[0].remainingPercent).toBe(3);
    expect(rows[0].reset).toBeTruthy();
  });

  it('区分 Codex 的 5 小时、周和月限额', () => {
    const rows = quotaRowsFor('codex', {
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 18_000,
        },
        secondary_window: {
          used_percent: 20,
          limit_window_seconds: 2_592_000,
        },
      },
      additional_rate_limits: [
        {
          limit_name: '代码审查增强',
          rate_limit: {
            primary_window: {
              used_percent: 30,
              limit_window_seconds: 604_800,
            },
          },
        },
      ],
    });

    expect(rows.map((row) => row.label)).toEqual([
      '5 小时限额',
      '月限额',
      '代码审查增强 周限额',
    ]);
  });

  it('Team 次级窗口缺少时长时按月限额处理', () => {
    const rows = quotaRowsFor('codex', {
      plan_type: 'team',
      rate_limit: {
        primary_window: { used_percent: 10 },
        secondary_window: { used_percent: 20 },
      },
    });

    expect(rows.map((row) => row.label)).toEqual(['5 小时限额', '月限额']);
  });

  it('读取 Codex 可用重置额度', () => {
    expect(codexResetCreditsFor({
      rate_limit_reset_credits: { available_count: '2' },
    })).toBe(2);
  });

  it('读取 Codex 重置次数和最早有效过期时间', () => {
    const result = codexResetCreditDetailsFor({
      available_count: '2',
      credits: [
        {
          id: 'later',
          reset_type: 'codex_rate_limits',
          status: 'available',
          expires_at: '2026-08-20T00:00:00Z',
        },
        {
          id: 'earlier',
          reset_type: 'codex_rate_limits',
          status: 'available',
          expires_at: '2026-08-12T18:06:25Z',
        },
        {
          id: 'used',
          reset_type: 'codex_rate_limits',
          status: 'used',
          expires_at: '2026-07-20T00:00:00Z',
        },
        {
          id: 'expired',
          reset_type: 'codex_rate_limits',
          status: 'available',
          expires_at: '2026-07-15T00:00:00Z',
        },
      ],
    }, Date.parse('2026-07-16T00:00:00Z'));

    expect(result).toEqual({
      availableCount: 2,
      earliestExpiry: '2026-08-12T18:06:25Z',
    });
  });

  it('不会把小于 1 的上游百分比错误放大 100 倍', () => {
    const codex = quotaRowsFor('codex', {
      rate_limit: { primary_window: { used_percent: 0.63 } },
    });
    const claude = quotaRowsFor('claude', {
      five_hour: { utilization: 0.44 },
    });

    expect(codex[0].remainingPercent).toBeCloseTo(99.37);
    expect(claude[0].remainingPercent).toBeCloseTo(99.56);
  });

  it('显示 Claude 按模型限定的周窗口（如 Fable）', () => {
    const rows = quotaRowsFor('claude', {
      five_hour: { utilization: 15, resets_at: '2027-01-01T00:00:00Z' },
      seven_day: { utilization: 18, resets_at: '2027-01-02T00:00:00Z' },
      seven_day_opus: null,
      limits: [
        { kind: 'session', group: 'session', percent: 15, is_active: false },
        { kind: 'weekly_all', group: 'weekly', percent: 18, is_active: false },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
          percent: 36,
          is_active: true,
          resets_at: '2027-01-02T00:00:00Z',
        },
      ],
    });

    expect(rows.map((row) => row.label)).toEqual(['5 小时窗口', '7 天窗口', '7 天 Fable 窗口']);
    expect(rows[2]).toMatchObject({ remainingPercent: 64, detail: '当前生效限制' });
    expect(rows[2].reset).toBeTruthy();
  });

  it('显示 Claude 已启用的额外用量', () => {
    const rows = quotaRowsFor('claude', {
      five_hour: { utilization: 20, resets_at: '2027-01-01T00:00:00Z' },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 1250,
        utilization: 25,
      },
    });

    expect(rows.at(-1)).toMatchObject({
      label: '额外用量',
      remainingPercent: 75,
    });
    expect(rows.at(-1)?.detail).toContain('$12.50');
    expect(rows.at(-1)?.detail).toContain('$50.00');
  });

  it('按剩余量计算 Kimi 和 Antigravity 百分比', () => {
    const kimi = quotaRowsFor('kimi', {
      usage: { used: 99.5, limit: 100 },
    });
    const antigravity = quotaRowsFor('antigravity', {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [{ remainingFraction: 0.03 }],
        },
      ],
    });

    expect(kimi[0].remainingPercent).toBeCloseTo(0.5);
    expect(antigravity[0].remainingPercent).toBe(3);
  });

  it('区分 Antigravity 同一分组中的不同窗口', () => {
    const rows = quotaRowsFor('antigravity', {
      groups: [{
        displayName: 'Gemini Pro',
        buckets: [
          { window: '5h', remainingFraction: 0.8 },
          { window: 'weekly', remainingFraction: 0.4 },
        ],
      }],
    });

    expect(rows.map((row) => row.label)).toEqual([
      'Gemini Pro · 5h',
      'Gemini Pro · weekly',
    ]);
  });

  it('合并 xAI 每周、月度和按量付费额度', () => {
    const rows = quotaRowsFor('xai', {
      weekly: {
        config: {
          currentPeriod: { type: 'weekly', end: '2027-01-01T00:00:00Z' },
          creditUsagePercent: 25,
          productUsage: [{ product: 'grok-code', usagePercent: 40 }],
        },
      },
      monthly: {
        config: {
          monthlyLimit: { val: 1000 },
          used: { val: 1200 },
          onDemandCap: { val: 500 },
          billingPeriodEnd: '2027-01-31T00:00:00Z',
        },
      },
    });

    expect(rows.find((row) => row.label === '每周额度')?.remainingPercent).toBe(75);
    expect(rows.find((row) => row.label === 'grok-code')?.remainingPercent).toBe(60);
    expect(rows.find((row) => row.label === '月度包含额度')?.remainingPercent).toBe(0);
    expect(rows.find((row) => row.label === '按量付费额度')?.remainingPercent).toBe(60);
  });
});
