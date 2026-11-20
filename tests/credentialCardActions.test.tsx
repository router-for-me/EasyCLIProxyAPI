import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CredentialCardActions, type CredentialCardActionsProps } from '../src/components/CredentialCardActions';
import { I18nProvider } from '../src/i18n';
const noop = () => {};
const base: CredentialCardActionsProps = {
  identity: 'test account', disabled: false, busy: false, resettingCooldown: false,
  oauth: true, runtimeOnly: false, hasProvider: true, canRefresh: true, refreshing: false,
  copied: false, expanded: false, detailsId: 'test-details', onRefresh: noop, onSettings: noop,
  onExclusions: noop, onModels: noop, onCopy: noop, onDelete: noop, onToggle: noop, onDetails: noop,
};
const render = (props: Partial<CredentialCardActionsProps> = {}) => renderToStaticMarkup(<I18nProvider><CredentialCardActions {...base} {...props} /></I18nProvider>);
describe('credential card actions', () => {
  it('keeps secondary and destructive actions behind a labelled menu', () => {
    const html = render();
    expect(html.match(/<button/g)).toHaveLength(4);
    expect(html).toContain('aria-label="Refresh Quota"');
    expect(html).toContain('aria-haspopup="menu" aria-expanded="false"');
    expect(html).toContain('More');
    expect(html).toMatch(/auth-list-icon-actions.*auth-list-details-button.*auth-card-more.*More.*auth-list-main-actions.*role="switch"/);
    expect(html.split('auth-list-main-actions')[1]).not.toContain('<button');
    expect(html).not.toContain('Delete');
    expect(html).not.toContain('Exclude Models');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Disable test account"');
    expect(html).toContain('aria-controls="test-details"');
  });
  it('preserves refresh, settings and toggle guards and loading feedback', () => {
    for (const props of [{ busy: true }, { oauth: false, canRefresh: false }, { resettingCooldown: true, disabled: true }]) {
      const html = render(props);
      expect(html).toMatch(/<input[^>]*disabled=""/);
      expect(html).toMatch(/<button[^>]*auth-action-settings[^>]*disabled=""/);
    }
    expect(render({ refreshing: true })).toContain('spin');
    expect(render({ disabled: true })).toContain('aria-label="Enable test account"');
    expect(render({ expanded: true })).toContain('aria-expanded="true" aria-controls="test-details"');
  });
});
