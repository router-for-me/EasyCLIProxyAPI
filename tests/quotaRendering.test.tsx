import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { QuotaCard } from '../src/pages/QuotaPage';
import { quotaRowsFor } from '../src/services/quotaService';
import type { QuotaState } from '../src/services/quotaService';

const render = (quota: QuotaState, provider = 'codex') => renderToStaticMarkup(
  <I18nProvider><QuotaCard file={{ name: 'test.json', provider }} quota={quota} onRefresh={() => {}} onReset={() => {}} /></I18nProvider>,
);

describe('quota card rendering', () => {
  it('当前适用次数为零时禁用重置按钮，并保留额度详情', () => {
    const html = render({
      status: 'success', rows: [], resetCredits: 2, resetCreditsApplicable: 0,
      resetCreditsError: 'temporary failure', subscriptionActiveUntil: '2030-01-01T00:00:00Z',
    });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重置额度<\/button>/);
    expect(html).toContain('当前适用：0 次');
    expect(html).toContain('temporary failure');
    expect(html).toContain('订阅到期');
  });

  it('xAI 付费账号保留额度说明和刷新入口，不显示可用性测试', () => {
    const html = render({ status: 'success', rows: [{ label: '付费 API 账号', remainingPercent: null, detail: '上游未提供剩余额度' }] }, 'xai');
    expect(html).toContain('上游未提供剩余额度');
    expect(html).not.toContain('real-quota-track');
    expect(html).not.toContain('测试可用性');
    expect(html).toContain('获取/刷新额度');
  });

  it('xAI 探测成功显示可用说明，100% 额度保留刷新按钮', () => {
    const healthy = render({
      status: 'success', rows: quotaRowsFor('xai', { mode: 'paid-health' }),
    }, 'xai');
    expect(healthy).toContain('付费 API 对话可用');
    expect(healthy).not.toContain('real-quota-track');
    const full = render({
      status: 'success', rows: quotaRowsFor('xai', { config: { creditUsagePercent: 0 } }),
    }, 'xai');
    expect(full).toContain('剩余 100%');
    expect(full).toContain('width:100%');
    expect(full).not.toContain('disabled=""');
  });
  it('缓存中的原始重置时间提供动态提示，过期额度不伪造为已恢复', () => {
    const html = render({ status: 'success', rows: [{ label: '5h', remainingPercent: 0, resetAtMs: Date.parse('2020-01-01T00:00:00Z') }] });
    expect(html).toContain('重置时间已到，请刷新确认');
    expect(html).toContain('剩余 0%');
  });
});
