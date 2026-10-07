import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthFileUsageSummary } from '../src/components/AuthFileUsageSummary';
import { I18nProvider } from '../src/i18n';

const renderSummary = (file: Record<string, unknown>) => renderToStaticMarkup(
  <I18nProvider><AuthFileUsageSummary file={file} /></I18nProvider>,
);

describe('credential cumulative usage', () => {
  it('uses cumulative counters even when recent requests have a different success rate', () => {
    const html = renderSummary({ success: 1900, failed: 100, recent_requests: [{ success: 0, failed: 20 }] });
    expect(html).toContain('aria-label="Total Requests: 2,000"');
    expect(html).toContain('aria-label="Success rate 95%"');
    expect(html).toContain('aria-label="Success 1,900"');
    expect(html).toContain('aria-label="Failed 100"');
    expect(html).toContain('Totals since the core started; reset on restart.');
    expect(html).toContain('Core session totals');
    expect(html).not.toContain('tokens');
  });

  it('preserves unavailable counters instead of treating a recent-only window or partial count as totals', () => {
    const recentOnly = renderSummary({ recent_requests: [{ success: 12, failed: 0 }] });
    expect(recentOnly).toContain('aria-label="Total Requests: —"');
    expect(recentOnly).toContain('aria-label="Success rate —"');
    const partial = renderSummary({ success: 12 });
    expect(partial).toContain('aria-label="Success 12"');
    expect(partial).toContain('aria-label="Failed —"');
    expect(partial).toContain('aria-label="Total Requests: —"');
    expect(partial).toContain('aria-label="Success rate —"');
  });

  it('shows zero requests without inventing a success percentage', () => {
    const html = renderSummary({ success: 0, failed: 0 });
    expect(html).toContain('aria-label="Total Requests: 0"');
    expect(html).toContain('aria-label="Success rate —"');
  });
});
