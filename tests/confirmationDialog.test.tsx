import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmationDialog } from '../src/components/ConfirmationDialog';
import { QuotaActionFeedback } from '../src/components/QuotaActionFeedback';
import { I18nProvider } from '../src/i18n';

describe('application confirmation and quota feedback', () => {
  it('renders an accessible in-app confirmation with explicit reset and cancel actions', () => {
    const html = renderToStaticMarkup(<I18nProvider><ConfirmationDialog title="重置额度" message="确认重置测试账号？" confirmText="确认重置" warning="消耗 1 次重置机会" onDecision={() => {}} /></I18nProvider>);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('确认重置');
    expect(html).toContain('取消');
    expect(html).toContain('消耗 1 次重置机会');
  });

  it('keeps reset feedback out of the card layout (message checked in browser)', () => {
    const html = renderToStaticMarkup(<I18nProvider><QuotaActionFeedback quota={{ status: 'success', rows: [], actionResult: { action: 'reset', status: 'refresh-error', error: 'query failed' } }} /></I18nProvider>);
    expect(html).toBe('');
  });
});
