import { describe, expect, it } from 'bun:test';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { ApiBalanceUrlDialog, ApiQuotaCard, QuotaCard } from '../src/pages/QuotaPage';
import { apiQuotaAdapterFor, type ApiQuotaSource } from '../src/services/apiQuota';
import { quotaRowsFor } from '../src/services/quotaService';
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
    expect(html).toMatch(/<button[^>]*title="重置额度"[^>]*>重置额度<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>重置额度<\/button>/);
    expect(html).not.toContain('当前没有适用的重置次数');
    expect(html).toContain('当前适用：0 次');
    expect(html).toContain('temporary failure');
    expect(html).toContain('订阅到期');
  });

  it.each(['error', 'refresh-error'] as const)('重置结果为 %s 时仍可再次点击重置', (status) => {
    const html = render({
      status: 'success', rows: [], resetCredits: 2,
      actionResult: { action: 'reset', status, error: 'temporary failure' },
    });
    expect(html).toMatch(/<button[^>]*title="重置额度"[^>]*>重置额度<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>重置额度<\/button>/);
    expect(html).toContain('temporary failure');
  });

  it('xAI 付费账号保留额度说明和刷新入口，不显示可用性测试', () => {
    const html = render({ status: 'success', rows: [{ label: '付费 API 账号', remainingPercent: null, detail: '上游未提供剩余额度' }] }, 'xai');
    expect(html).toContain('上游未提供剩余额度');
    expect(html).not.toContain('real-quota-track');
    expect(html).not.toContain('测试可用性');
    expect(html).toContain('获取/刷新额度');
    expect(html).toContain('OAuth');
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

  it('renders API monetary balances without fabricating a percentage meter', () => {
    const source: ApiQuotaSource = {
      id: 'safe-source',
      protocol: 'openai-compatibility',
      recordIndex: 0,
      entryIndex: 0,
      entryCount: 1,
      recordName: 'ignored-record-name',
      recordOrdinal: 1,
      recordCount: 1,
      baseUrl: 'https://openrouter.ai/v1',
      balanceUrl: '',
      authIndex: 'auth-index',
      apiKey: 'secret-key',
      adapter: apiQuotaAdapterFor('https://openrouter.ai/v1'),
      label: 'ignored-safe-label',
      disabled: false,
    };
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ApiQuotaCard
          source={source}
          quota={{
            status: 'success',
            rows: [{
              label: 'OpenRouter',
              remainingPercent: null,
              amount: { remaining: 65, used: 35, total: 100, unit: 'USD' },
            }],
          }}
          onRefresh={() => {}}
          onConfigure={() => {}}
        />
      </I18nProvider>,
    );
    expect(html).toContain('剩余');
    expect(html).toContain('已用');
    expect(html).toContain('总量');
    expect(html).toContain('65 USD');
    expect(html).toContain('API Key');
    expect(html).toContain('余额接口');
    expect(html).toContain('provider-logo quota-card-provider-logo');
    expect(html).toContain('openai-light');
    expect(html).not.toContain('real-quota-track');
    expect(html).not.toContain('secret-key');
  });

  const interactionTest = typeof document === 'undefined' ? it.skip : it;

  interactionTest('opens the balance endpoint dialog and handles close and save actions', async () => {
    const source: ApiQuotaSource = {
      id: 'interactive-source',
      protocol: 'openai-compatibility',
      recordIndex: 0,
      entryIndex: 0,
      entryCount: 1,
      recordName: 'Interactive provider',
      recordOrdinal: 1,
      recordCount: 1,
      baseUrl: 'https://custom.example/v1',
      balanceUrl: 'https://api.deepseek.com/user/balance?test=1',
      authIndex: 'auth-index',
      apiKey: 'secret-key',
      adapter: apiQuotaAdapterFor('https://custom.example/v1'),
      label: 'Interactive provider',
      disabled: false,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    window.localStorage.setItem('easy-cli-proxy-api.locale', 'en');
    let savedValue = '';

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <ApiQuotaCard source={source} quota={{ status: 'idle', rows: [] }} onRefresh={() => {}} onConfigure={() => setOpen(true)} />
          {open ? (
            <ApiBalanceUrlDialog
              source={source}
              busy={false}
              error=""
              onClose={() => setOpen(false)}
              onSave={(value) => { savedValue = value; setOpen(false); }}
            />
          ) : null}
        </>
      );
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(<I18nProvider><Harness /></I18nProvider>);
    });
    const endpointButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Balance endpoint');
    expect(endpointButton).toBeDefined();
    await act(async () => {
      endpointButton?.click();
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    const input = dialog?.querySelector('input[type="url"]') as HTMLInputElement | null;
    expect(dialog).not.toBeNull();
    expect(input?.className).toBe('config-dialog-text-input');
    expect(input?.parentElement?.className).toBe('config-dialog-field');
    expect(input?.value).toBe(source.balanceUrl);

    const closeButton = dialog?.querySelector('button.icon-button') as HTMLButtonElement | null;
    expect(closeButton).not.toBeNull();
    await act(async () => {
      closeButton?.click();
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      endpointButton?.click();
    });
    const reopenedInput = document.body.querySelector('input[type="url"]') as HTMLInputElement;
    await act(async () => {
      const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setInputValue?.call(reopenedInput, 'https://api.deepseek.com/user/balance?updated=1');
      reopenedInput.dispatchEvent(new Event('input', { bubbles: true }));
      reopenedInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const saveButton = document.body.querySelector('button.primary-button') as HTMLButtonElement | null;
    await act(async () => {
      saveButton?.click();
    });
    expect(savedValue).toBe('https://api.deepseek.com/user/balance?updated=1');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    root.unmount();
    container.remove();
  });
});
