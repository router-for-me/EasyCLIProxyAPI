import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CredentialAdvancedFields } from '../src/components/CredentialAdvancedFields';
import { I18nProvider } from '../src/i18n';

const html = renderToStaticMarkup(
  <I18nProvider>
    <CredentialAdvancedFields name="codex-user.json" advanced={{ model_aliases: [{ name: 'gpt-5', alias: 'public-gpt' }] }} onChange={() => {}} />
  </I18nProvider>,
);

describe('credential alias editor', () => {
  it('uses plain inputs for the upstream model and client alias', () => {
    expect(html).not.toContain('role="combobox"');
    expect(html).toContain('aria-label="Model name"');
    expect(html).toContain('aria-label="Model alias"');
    expect(html).toContain('value="gpt-5"');
    expect(html).toContain('value="public-gpt"');
    expect(html).toContain('aria-label="Expand"');
    expect(html).not.toContain('Display name');
    expect(html).not.toContain('Search or enter a model');
  });
});
