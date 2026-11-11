import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthFileHealthStatus } from '../src/components/AuthFileHealthStatus';
import { I18nProvider } from '../src/i18n';

const receivedAtMs = Date.now();
const cooldown = {
  scope: 'model', model_key: 'model-a', reason: 'quota',
  retry_at: '2026-01-01T10:00:32Z', remaining_seconds: 32, http_status: 429,
};
const render = (file: Record<string, unknown>, options: {
  receivedAtMs?: number; resetting?: boolean; resetDisabled?: boolean; onReset?: () => void; compact?: boolean;
} = {}) => renderToStaticMarkup(<I18nProvider>
  <AuthFileHealthStatus file={file} receivedAtMs={receivedAtMs} onReset={() => {}} {...options} />
</I18nProvider>);

describe('upstream TOS suspension status', () => {
  it('shows the TOS reason on the summary and the appeal link when open', () => {
    const html = render({ status: 'disabled', status_message: 'tos_violation', tos_appeal_url: 'https://example.com/appeal' });
    const summary = html.slice(0, html.indexOf('</summary>'));
    expect(summary).toContain('<strong>Suspended by upstream terms-of-service violation</strong>');
    expect(summary).not.toContain('<strong>Disabled</strong>');
    expect(html).toContain('Open appeal page');
  });

  it('marks a link-only record as historical and offers no appeal prompt', () => {
    const stale = render({ status: 'disabled', disabled: true, tos_appeal_url: 'https://example.com/appeal', tos_appeal_url_text: 'Submit Appeal' });
    expect(stale).toContain('<strong>Previously suspended for a terms-of-service violation</strong>');
    expect(stale).not.toContain('Submit Appeal');
    expect(stale).not.toContain('Open appeal page');
  });

  it('offers the appeal link while the core still reports the suspension', () => {
    const live = render({ status: 'disabled', disabled: true, status_message: 'tos_violation', tos_appeal_url: 'https://example.com/appeal', tos_appeal_url_text: 'Submit Appeal' });
    expect(live).toContain('<strong>Suspended by upstream terms-of-service violation</strong>');
    expect(live).toContain('Submit Appeal');
  });

  it('ignores non-HTTPS appeal links and leaves plain disables unchanged', () => {
    const unsafe = render({ status: 'disabled', status_message: 'tos_violation', tos_appeal_url: 'javascript:alert(1)' });
    expect(unsafe).not.toContain('javascript:');
    expect(unsafe).not.toContain('Open appeal page');
    const plain = render({ status: 'disabled' });
    expect(plain).toContain('<strong>Disabled</strong>');
    expect(plain).not.toContain('appeal');
    expect(plain).not.toContain('<details');
  });
});

describe('credential cooldown actions', () => {
  it('makes model cooldowns and the clear action visible without opening details', () => {
    const html = render({ status: 'error', cooldowns: [cooldown] });
    const summary = html.slice(0, html.indexOf('</summary>'));
    expect(summary).toContain('<strong>1 model cooling down</strong>');
    expect(summary).toContain('Quota or rate limit');
    expect(html.slice(html.indexOf('</details>'))).toContain('Clear cooldown</button>');
    expect(html).toContain('HTTP 429');
  });

  it.each([undefined, null, [], {}, [null], [{ ...cooldown, remaining_seconds: 0 }]].map((cooldowns) => ({ cooldowns })))(
    'does not expose clear for absent, empty or unknown cooldowns: %j', ({ cooldowns }) => {
      expect(render({ status: 'error', cooldowns })).not.toContain('Clear cooldown</button>');
    },
  );

  it('keeps elapsed cooldowns resettable without reporting restored availability', () => {
    const html = render({ status: 'active', cooldowns: [cooldown] }, { receivedAtMs: receivedAtMs - 60_000 });
    expect(html).toContain('Cooldown timer elapsed');
    expect(html).toContain('Elapsed · confirmation needed');
    expect(html).toContain('Clear cooldown</button>');
    expect(html).not.toContain('Available');
  });

  it('honors unavailable and pending reset actions', () => {
    const file = { status: 'error', cooldowns: [cooldown] };
    expect(render(file, { onReset: undefined })).not.toContain('<button');
    expect(render(file, { resetDisabled: true })).toMatch(/<button[^>]*disabled=""/);
    const pending = render(file, { resetting: true });
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"/);
    expect(pending).toContain('Clearing…</button>');
  });

  it('keeps cooldown scope visible for disabled credentials in the compact strip', () => {
    const html = render({ disabled: true, cooldowns: [
      { ...cooldown, scope: 'credential', model_key: undefined, reason: 'credential_quota' },
      cooldown,
      { ...cooldown, model_key: 'model-b' },
    ] }, { compact: true });
    const summary = html.slice(0, html.indexOf('</summary>'));
    expect(summary).toContain('auth-file-health-compact');
    expect(summary).toContain('Credential and 2 models cooling down');
    expect(summary).not.toContain('<strong>Disabled</strong>');
    expect(html).toContain('HTTP 429');
    expect(html.slice(html.indexOf('</details>'))).toContain('Clear cooldown</button>');
  });

  it('does not report unknown snapshots as a known clear cooldown state', () => {
    const unknown = render({ status: 'active', cooldowns: null }, { compact: true });
    expect(unknown).toContain('auth-file-health-compact');
    expect(unknown).toContain('Cooldown state is unknown');
    expect(unknown).not.toContain('Clear cooldown</button>');
    expect(render({ status: 'active', cooldowns: [] }, { compact: true })).not.toContain('auth-file-health');
    expect(render({ status: 'active' }, { compact: true })).not.toContain('auth-file-health');
  });
});
