import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CredentialAdvancedFields } from '../src/components/CredentialAdvancedFields';
import { I18nProvider } from '../src/i18n';

const html = renderToStaticMarkup(
  <I18nProvider>
    <CredentialAdvancedFields name="codex-user.json" advanced={{ model_aliases: [{ name: 'gpt-5', alias: '' }] }}
      models={[{ name: 'gpt-5', displayName: 'GPT 5' }]} onChange={() => {}} />
  </I18nProvider>,
);

describe('credential alias model picker', () => {
  it('uses the searchable model picker for both model fields', () => {
    expect(html.match(/role="combobox"/g)).toHaveLength(2);
    expect(html).toContain('value="gpt-5"');
    expect(html).toContain('Search or enter a model');
    expect(html).not.toContain('<textarea');
  });
});