import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CredentialAdvancedFields } from '../src/components/CredentialAdvancedFields';
import { I18nProvider } from '../src/i18n';

const html = renderToStaticMarkup(
  <I18nProvider>
    <CredentialAdvancedFields name="codex-user.json" advanced={{ model_aliases: [{ name: 'gpt-5', alias: 'public-gpt' }] }}
      models={[{ name: 'gpt-5', alias: 'GPT 5' }]} onChange={() => {}} />
  </I18nProvider>,
);

describe('credential alias model picker', () => {
  it('uses the credential model list for the upstream model and a plain input for the alias', () => {
    expect(html.match(/role="combobox"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Model name"');
    expect(html).toContain('aria-label="Model alias"');
    expect(html).toContain('value="gpt-5"');
    expect(html).toContain('value="public-gpt"');
    expect(html).toContain('Search or enter a model');
  });
});
