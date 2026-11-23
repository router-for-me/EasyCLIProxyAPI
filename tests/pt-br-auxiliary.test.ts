import { describe, expect, it } from 'bun:test';
import { autoUpdateEn, autoUpdatePtBR } from '../src/i18n/autoUpdate';
import { homeEn, homePtBR } from '../src/i18n/home';
import { mcpSkillsPtBR, mcpSkillsText } from '../src/i18n/mcpSkills';
import { pluginConfigPtBR, pluginConfigText } from '../src/i18n/pluginConfig';
import { pluginOAuthPtBR, pluginOAuthText } from '../src/i18n/pluginOAuth';
import { pluginsPtBR, pluginText } from '../src/i18n/plugins';
import { providerTemplatePtBR, providerText } from '../src/i18n/providerTemplate';
import { remoteCpaEn, remoteCpaPtBR } from '../src/i18n/remoteCpa';
import { sensitiveWordsMessages } from '../src/i18n/sensitiveWords';
import { templateMessages, templateText } from '../src/i18n/templateConfig';
import { themeDiyEn, themeDiyPtBR } from '../src/i18n/themeDiy';
import { generalTemplateGroups, requestTemplateGroups, routingTemplateGroups } from '../src/services/generalTemplateFields';
import { settingsCategories, settingsMessages } from '../src/services/settingsNavigation';
import { validateStructuredValueText } from '../src/services/structuredConfig';
import { templateFieldValidation, type TemplateText } from '../src/services/templateConfig';

const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();

function expectTable(english: Record<string, string>, portuguese: Record<string, string>) {
  expect(Object.keys(portuguese).sort()).toEqual(Object.keys(english).sort());
  for (const [key, value] of Object.entries(portuguese)) {
    expect(value.trim()).not.toBe('');
    expect(placeholders(value)).toEqual(placeholders(english[key]));
  }
}

function expectLookup<Key extends string>(
  table: Record<Key, string>,
  lookup: (key: Key, locale: 'en' | 'pt-BR') => string,
) {
  for (const key of Object.keys(table) as Key[]) {
    expect(table[key].trim()).not.toBe('');
    expect(lookup(key, 'pt-BR')).toBe(table[key]);
    expect(placeholders(table[key])).toEqual(placeholders(lookup(key, 'en')));
  }
}

function expectTemplate(value: TemplateText | undefined) {
  if (value === undefined || typeof value === 'string') return;
  expect(value.ptBR?.trim()).toBeTruthy();
  expect(placeholders(value.ptBR ?? '')).toEqual(placeholders(value.en));
}

describe('PT-BR auxiliary dictionaries', () => {
  it('preserves primary extension keys and placeholders', () => {
    expectTable(autoUpdateEn, autoUpdatePtBR);
    expectTable(homeEn, homePtBR);
    expectTable(remoteCpaEn, remoteCpaPtBR);
    expectTable(themeDiyEn, themeDiyPtBR);
  });

  it('selects the explicit auxiliary dictionaries rather than fallback text', () => {
    expectLookup(mcpSkillsPtBR, mcpSkillsText);
    expectLookup(pluginConfigPtBR, pluginConfigText);
    expectLookup(pluginOAuthPtBR, pluginOAuthText);
    expectLookup(pluginsPtBR, pluginText);
    expectLookup(providerTemplatePtBR, providerText);
    expect(mcpSkillsText('serverCount', 'pt-BR', { count: 2, total: 4 })).toBe('Mostrando 2 de 4 servidores');
  });

  it('includes raw Portuguese settings values and labels', () => {
    for (const value of Object.values({ ...sensitiveWordsMessages, ...templateMessages, ...settingsMessages })) {
      expectTemplate(value);
    }
    for (const category of settingsCategories) expectTemplate(category.title);
    for (const group of [...generalTemplateGroups, ...routingTemplateGroups, ...requestTemplateGroups]) {
      expectTemplate(group.title);
      expectTemplate(group.description);
      for (const field of group.fields) {
        expectTemplate(field.label);
        expectTemplate(field.description);
        expectTemplate(field.link?.label);
        expectTemplate(field.link?.hint);
        for (const option of field.options ?? []) expectTemplate(option.label);
      }
    }
  });

  it('localizes calculated validation errors without dropping numeric bounds', () => {
    expect(templateText(validateStructuredValueText({ type: 'number', min: 1 }, 0) ?? undefined, 'pt-BR'))
      .toBe('Valor: esperava-se um inteiro ≥ 1');
    expect(templateText(templateFieldValidation({ path: [], label: '', type: 'number', max: 10 }, 11) ?? undefined, 'pt-BR'))
      .toBe('Insira um número válido, máximo 10');
  });
});
