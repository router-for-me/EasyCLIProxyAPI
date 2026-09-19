import { expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthFileQuotaPanel } from '../src/components/AuthFileQuotaPanel';
import { I18nProvider } from '../src/i18n';
import type { QuotaState } from '../src/services/quotaService';
import { QuotaCard } from '../src/pages/QuotaPage';

const render = (quota: QuotaState) => renderToStaticMarkup(<I18nProvider><AuthFileQuotaPanel file={{ name: 'test.json' }} quota={quota} disabled={false} onRefresh={() => {}} /></I18nProvider>);

it('renders real quota values with bounded bars and keeps unknown distinct from zero', () => {
  const html = render({ status: 'success', rows: [
    { label: 'empty', remainingPercent: 0 }, { label: 'full', remainingPercent: 100 },
    { label: 'too high', remainingPercent: 140 }, { label: 'too low', remainingPercent: -20 },
    { label: 'unknown', remainingPercent: null }, { label: 'invalid', remainingPercent: NaN },
  ] });
  expect(html.match(/role="progressbar"/g)).toHaveLength(4);
  expect(html.match(/aria-valuenow="0"/g)).toHaveLength(2);
  expect(html.match(/aria-valuenow="100"/g)).toHaveLength(2);
  expect(html.match(/credential-quota-row unknown/g)).toHaveLength(2);
  expect(html).not.toContain('NaN');
  expect(html).not.toContain('140%');
});

it('does not fabricate progress percentages while loading or on failure', () => {
  const loading = render({ status: 'loading', rows: [] });
  expect(loading).toContain('indeterminate');
  expect(loading).not.toContain('aria-valuenow');
  const error = render({ status: 'error', rows: [], error: 'upstream failed' });
  expect(error).toContain('upstream failed');
  expect(error).not.toContain('role="progressbar"');
});

it.each([
  { credits: undefined, visible: false, disabled: false },
  { credits: 0, visible: false, disabled: false },
  { credits: 2, visible: true, disabled: false },
  { credits: 2, applicable: 0, remaining: 100, visible: true, disabled: false },
  { credits: 2, loading: true, visible: true, disabled: true },
  { credits: 2, fileDisabled: true, visible: true, disabled: true },
  { credits: 2, provider: 'claude', visible: false, disabled: false },
  { credits: 2, result: 'error', visible: true, disabled: false },
  { credits: 2, result: 'refresh-error', visible: true, disabled: false },
] as const)('matches quota-page reset visibility and availability: %j', (scenario) => {
  const values = scenario as { credits?: number; applicable?: number; remaining?: number; loading?: boolean; fileDisabled?: boolean; provider?: string; result?: 'error' | 'refresh-error'; visible: boolean; disabled: boolean };
  const file = { name: 'test.json', provider: values.provider ?? 'codex', disabled: values.fileDisabled ?? false };
  const quota: QuotaState = {
    status: values.loading ? 'loading' : 'success', rows: [{ label: '5h', remainingPercent: values.remaining ?? 0 }],
    resetCredits: values.credits, resetCreditsApplicable: values.applicable,
    pendingAction: values.loading ? 'reset' : undefined,
    actionResult: values.result ? { action: 'reset', status: values.result, error: 'test error' } : undefined,
  };
  const onReset = file.provider === 'codex' ? () => {} : undefined;
  const credentialHtml = renderToStaticMarkup(<I18nProvider><AuthFileQuotaPanel file={file} quota={quota} disabled={file.disabled} onRefresh={() => {}} onReset={onReset} /></I18nProvider>);
  const quotaHtml = renderToStaticMarkup(<I18nProvider><QuotaCard file={file} quota={quota} onRefresh={() => {}} onReset={onReset} /></I18nProvider>);
  const buttonState = (html: string) => {
    const button = html.match(/<button[^>]*title="重置额度"[^>]*>重置额度<\/button>/)?.[0];
    return { visible: Boolean(button), disabled: Boolean(button?.includes('disabled=""')) };
  };
  expect(buttonState(credentialHtml)).toEqual({ visible: values.visible, disabled: values.disabled });
  expect(buttonState(credentialHtml)).toEqual(buttonState(quotaHtml));
  if (values.loading) expect(credentialHtml).toContain('正在提交重置并刷新额度');
});
