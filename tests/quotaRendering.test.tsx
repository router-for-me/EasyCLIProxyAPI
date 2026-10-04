import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { QuotaCard } from '../src/pages/QuotaPage';
import { quotaRowsFor, formatQuotaTimestamp } from '../src/services/quotaService';
import type { QuotaState } from '../src/services/quotaService';

const render = (quota: QuotaState, provider = 'codex') => renderToStaticMarkup(
  <I18nProvider><QuotaCard file={{ name: 'test.json', provider }} quota={quota} onRefresh={() => {}} onReset={() => {}} /></I18nProvider>,
);

describe('quota card rendering', () => {
  it('当前适用次数为零时仍可重置，并保留额度详情', () => {
    const html = render({
      status: 'success', rows: [], resetCredits: 2, resetCreditsApplicable: 0,
      resetCreditsError: 'temporary failure', subscriptionActiveUntil: '2030-01-01T00:00:00Z',
    });
    expect(html).toMatch(/<button[^>]*title="Reset Quota"[^>]*>Reset Quota<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Reset Quota<\/button>/);
    expect(html).not.toContain('No applicable reset credits');
    expect(html).not.toContain('Currently applicable: 0');
    expect(html).not.toContain('temporary failure');
    expect(html).toContain('Expires 01/01/2030, 00:00');
    expect(html).not.toContain('Subscription expires:');
  });

  it.each(['error', 'refresh-error'] as const)('重置结果为 %s 时仍可再次点击重置', (status) => {
    const html = render({
      status: 'success', rows: [], resetCredits: 2,
      actionResult: { action: 'reset', status, error: 'temporary failure' },
    });
    expect(html).toMatch(/<button[^>]*title="Reset Quota"[^>]*>Reset Quota<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Reset Quota<\/button>/);
    expect(html).not.toContain('temporary failure');
  });

  it('xAI 付费账号保留额度说明和刷新入口，不显示可用性测试', () => {
    const html = render({ status: 'success', rows: [{ label: 'Paid API account', remainingPercent: null, detail: 'Upstream did not provide remaining quota' }] }, 'xai');
    expect(html).toContain('Upstream did not provide remaining quota');
    expect(html).not.toContain('real-quota-track');
    expect(html).not.toContain('Test availability');
    expect(html).toContain('Fetch or refresh quota');
  });

  it('xAI 探测成功显示可用说明，100% 额度保留刷新按钮', () => {
    const healthy = render({
      status: 'success', rows: quotaRowsFor('xai', { mode: 'paid-health' }),
    }, 'xai');
    expect(healthy).toContain('Paid API chat is available');
    expect(healthy).not.toContain('real-quota-track');
    const full = render({
      status: 'success', rows: quotaRowsFor('xai', { config: { creditUsagePercent: 0 } }),
    }, 'xai');
    expect(full).toContain('100% remaining');
    expect(full).toContain('width:100%');
    expect(full).not.toContain('disabled=""');
  });
  it('缓存中的原始重置时间提供动态提示，过期额度不伪造为已恢复', () => {
    const html = render({ status: 'success', rows: [{ label: '5h', remainingPercent: 0, resetAtMs: Date.parse('2020-01-01T00:00:00Z') }] });
    expect(html).toContain('Reset time reached; refresh to verify');
    expect(html).toContain('0% remaining');
  });

  it('Kimi 免费账号取不到额度时只显示卡片内失败状态', () => {
    const html = render({ status: 'error', rows: [], error: 'free account cannot access quota' }, 'kimi');
    expect(html).toContain('quota-card-error');
    expect(html).not.toContain('app-notice-entry');
  });
});
