import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CredentialAdvancedFields, CredentialHeadersEditor } from '../src/components/CredentialAdvancedFields';
import { I18nProvider } from '../src/i18n';

const renderAdvanced = (name: string, advanced: Record<string, unknown>, provider = '') => renderToStaticMarkup(
  <I18nProvider>
    <CredentialAdvancedFields name={name} provider={provider} advanced={advanced} onChange={() => {}} />
  </I18nProvider>,
);

describe('credential settings interaction', () => {
  it('lets a Codex credential edit aliases directly and hides Claude cloaking', () => {
    const html = renderAdvanced('codex-cbb7bd85-user-team.json', {});
    expect(html).toContain('Add alias');
    expect(html).toContain('Credential timezone');
    expect(html).toContain('Asia/Shanghai');
    expect(html).not.toContain('Request cloaking');
    expect(html).not.toContain('Inherit / not set');
    expect(html).not.toContain('Model aliases and Claude compatibility');
  });

  it('shows Claude controls as normal fields, including an existing override on another provider', () => {
    expect(renderAdvanced('claude-user.json', {})).toContain('Request cloaking');
    const overridden = renderAdvanced('codex-user.json', { cloak_mode: 'always' });
    expect(overridden).toContain('Request cloaking');
    expect(overridden).toContain('value="always" selected');
  });

  it('edits headers as rows instead of an empty JSON object', () => {
    const html = renderToStaticMarkup(<I18nProvider><CredentialHeadersEditor value="{}" onChange={() => {}} /></I18nProvider>);
    expect(html).toContain('No custom headers.');
    expect(html).toContain('Add header');
    expect(html).not.toContain('<textarea');
  });
});