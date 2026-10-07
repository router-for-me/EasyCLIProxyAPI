import { expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthFileRequestStatus } from '../src/components/AuthFileRequestStatus';
import { I18nProvider } from '../src/i18n';

const render = (file: Record<string, unknown>, summary = true, compact = false) =>
  renderToStaticMarkup(<I18nProvider><AuthFileRequestStatus file={file} summary={summary} compact={compact} /></I18nProvider>);

it('keeps cumulative counters separate from the recent rate and preserves interval labels', () => {
  const html = render({ success: 900, failed: 100, recent_requests: [
    { time: '23:50-00:00', success: 3, failed: 1 },
    { time: '00:00-00:10', success: 0, failed: 2 },
  ] });
  expect(html).toContain('auth-file-requests-summary');
  expect(html).toContain('>Success 900</span>');
  expect(html).toContain('>Failed 100</span>');
  expect(html).toContain('aria-label="Success rate 50%"');
  expect(html.match(/<button /g)).toHaveLength(20);
  expect(html).toContain('aria-label="23:50-00:00 · Success 3 · Failed 1 · Success rate 75%"');
  expect(html).toContain('aria-label="00:00-00:10 · Success 0 · Failed 2 · Success rate 0%"');
  expect(html).not.toContain('class="auth-file-requests-window"');
});

it('distinguishes missing statistics, known zero counters, and an actual zero percent success rate', () => {
  const unknown = render({});
  expect(unknown).toContain('>Success —</span>');
  expect(unknown).toContain('>Failed —</span>');
  expect(unknown).toContain('The core did not provide recent request statistics');
  expect(unknown).toContain('aria-label="Success rate —"');
  expect(unknown).not.toContain('<button ');

  const empty = render({ success: 0, failed: 0, recent_requests: [] });
  expect(empty).toContain('>Success 0</span>');
  expect(empty).toContain('>Failed 0</span>');
  expect(empty).toContain('aria-label="Success rate —"');
  expect(empty.match(/<button /g)).toHaveLength(20);

  const failed = render({ success: 0, failed: 2, recent_requests: [{ time: '10:00-10:10', success: 0, failed: 2 }] });
  expect(failed).toContain('aria-label="Success rate 0%"');
  expect(failed).toContain('background-color:rgb(239, 68, 68)');
});

it('preserves existing full and compact layouts while making summary take precedence', () => {
  const file = { success: 2, failed: 0, recent_requests: [{ time: '10:00-10:10', success: 2, failed: 0 }] };
  const full = render(file, false);
  expect(full).toContain('class="auth-file-requests-window"');
  expect(full).toContain('auth-file-requests-rate success');
  const compact = render(file, false, true);
  expect(compact).toContain('auth-file-requests-compact');
  expect(compact).toContain('auth-file-requests-latest');
  expect(compact).not.toContain('auth-file-requests-rate');
  const summary = render(file, true, true);
  expect(summary).toContain('auth-file-requests-summary');
  expect(summary).not.toContain('auth-file-requests-compact');
  expect(summary).toContain('aria-label="Success rate 100%"');
});
