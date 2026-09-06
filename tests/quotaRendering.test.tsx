import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { QuotaCard } from '../src/pages/QuotaPage';
import type { QuotaState } from '../src/services/quotaService';

const render = (quota: QuotaState, provider = 'codex') => renderToStaticMarkup(
  <I18nProvider><QuotaCard file={{ name: 'test.json', provider }} quota={quota} onRefresh={() => {}} onReset={() => {}} /></I18nProvider>,
);

describe('quota card rendering', () => {
  it('即使当前适用次数为零，仍显示可用重置按钮、详情错误和订阅时间', () => {
    const html = render({
      status: 'success', rows: [], resetCredits: 2, resetCreditsApplicable: 0,
      resetCreditsError: 'temporary failure', subscriptionActiveUntil: '2030-01-01T00:00:00Z',
    });
    expect(html).toContain('重置额度');
    expect(html).toContain('当前适用：0 次');
    expect(html).toContain('temporary failure');
    expect(html).toContain('订阅到期');
  });

  it('付费 API 健康状态不画成 0% 或 100% 的额度条', () => {
    const html = render({ status: 'success', rows: [{ label: '付费 API 可用', remainingPercent: null, detail: '上游未提供剩余额度' }] }, 'xai');
    expect(html).toContain('上游未提供剩余额度');
    expect(html).not.toContain('real-quota-track');
  });

  it('缓存中的原始重置时间提供动态提示，过期额度不伪造为已恢复', () => {
    const html = render({ status: 'success', rows: [{ label: '5h', remainingPercent: 0, resetAtMs: Date.parse('2020-01-01T00:00:00Z') }] });
    expect(html).toContain('重置时间已到，请刷新确认');
    expect(html).toContain('剩余 0%');
  });
});
