import { expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthFileQuotaPanel } from '../src/components/AuthFileQuotaPanel';
import { I18nProvider } from '../src/i18n';
import type { AuthFile, QuotaState } from '../src/services/quotaService';

const renderDense = (quota: QuotaState, file: AuthFile = { name: 'test.json', provider: 'codex' }, busy = false) =>
  renderToStaticMarkup(<I18nProvider><AuthFileQuotaPanel file={file} quota={quota}
    compact dense disabled={busy || file.disabled === true} onRefresh={() => {}} onReset={() => {}} /></I18nProvider>);

it('keeps window percentages, reset times and additional windows available in dense mode', () => {
  const html = renderDense({ status: 'success', rows: [
    { label: '5h', remainingPercent: 140, reset: '10:30', detail: 'Window detail' },
    { label: 'weekly', remainingPercent: null, reset: 'Friday' },
    { label: 'extra', remainingPercent: 0, reset: 'Monday' },
  ] });
  expect(html).toContain('credential-quota-dense');
  expect(html).toContain('aria-valuenow="100"');
  expect(html).not.toContain('140%');
  expect(html).toContain('credential-quota-row unknown');
  expect(html).toContain('title="10:30">10:30</small>');
  expect(html).toContain('Window detail');
  expect(html).toContain('<details class="credential-quota-more">');
  expect(html).toContain('extra');
});

it('shows reset credits beside the button while preserving applicability and expiry', () => {
  const html = renderDense({ status: 'success', rows: [{ label: '5h', remainingPercent: 0 }],
    resetCredits: 2, resetCreditsApplicable: 0, subscriptionActiveUntil: '2030-01-01T00:00:00Z',
  });
  const resetButton = html.match(/<button[^>]*credential-quota-reset[^>]*>[\s\S]*?<\/button>/)?.[0];
  expect(resetButton).toContain('Reset');
  expect(html).toMatch(/credential-quota-reset-credits[^>]*>[^<]*2/);
  expect(resetButton).not.toContain('disabled=""');
  expect(html).toContain('Currently applicable: 0');
  expect(html).toContain('Subscription expires');
});

it('does not confuse a busy list with a disabled credential or discard cached quota', () => {
  const idle = renderDense({ status: 'idle', rows: [] }, undefined, true);
  expect(idle).toContain('Quota has not been fetched');
  expect(idle).not.toContain('Disabled');
  const disabled = renderDense({ status: 'idle', rows: [] }, { name: 'test.json', disabled: true });
  expect(disabled).toContain('Disabled');
  const cached = renderDense({ status: 'success', rows: [{ label: '5h', remainingPercent: 75 }] },
    { name: 'test.json', disabled: true }, true);
  expect(cached).toContain('aria-valuenow="75"');
});

it('keeps raw failures accessible without manufacturing progress in dense error and loading states', () => {
  const failed = renderDense({ status: 'error', rows: [], error: 'upstream diagnostic details' });
  expect(failed).toContain('<details class="credential-quota-error-details">');
  expect(failed).toContain('title="upstream diagnostic details"');
  expect(failed).toContain('<small>upstream diagnostic details</small>');
  expect(failed).not.toContain('role="progressbar"');
  const pending = renderDense({ status: 'loading', rows: [], pendingAction: 'reset' });
  expect(pending).toContain('aria-busy="true"');
  expect(pending).toContain('indeterminate');
  expect(pending).not.toContain('aria-valuenow');
});
