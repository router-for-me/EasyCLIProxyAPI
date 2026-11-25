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

// PT-BR entries are optional. When present they must be nonempty, use only known
// keys and keep the English placeholders; missing entries fall back to English.
function expectTable(english: Record<string, string>, portuguese: Partial<Record<string, string>>) {
  expect(Object.keys(portuguese).filter((key) => !(key in english))).toEqual([]);
  for (const [key, value] of Object.entries(portuguese)) {
    expect(value?.trim()).toBeTruthy();
    expect(placeholders(value ?? '')).toEqual(placeholders(english[key]));
  }
}

function expectLookup<Key extends string>(
  table: Partial<Record<Key, string>>,
  lookup: (key: Key, locale: 'en' | 'pt-BR') => string,
) {
  for (const key of Object.keys(table) as Key[]) {
    const value = table[key] ?? '';
    expect(value.trim()).not.toBe('');
    expect(lookup(key, 'pt-BR')).toBe(value);
    expect(placeholders(value)).toEqual(placeholders(lookup(key, 'en')));
  }
}

function expectFallback<Key extends string>(
  table: Partial<Record<Key, string>>,
  lookup: (key: Key, locale: 'en' | 'pt-BR') => string,
) {
  const key = Object.keys(table)[0] as Key;
  const value = table[key];
  delete table[key];
  try {
    expect(lookup(key, 'pt-BR')).toBe(lookup(key, 'en'));
  } finally {
    table[key] = value;
  }
}

function expectTemplate(value: TemplateText | undefined) {
  if (value === undefined || typeof value === 'string' || value.ptBR === undefined) return;
  expect(value.ptBR.trim()).toBeTruthy();
  expect(placeholders(value.ptBR)).toEqual(placeholders(value.en));
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

  it('falls back to English when a PT-BR auxiliary entry is missing', () => {
    expectFallback(mcpSkillsPtBR, mcpSkillsText);
    expectFallback(pluginConfigPtBR, pluginConfigText);
    expectFallback(pluginOAuthPtBR, pluginOAuthText);
    expectFallback(pluginsPtBR, pluginText);
    expectFallback(providerTemplatePtBR, providerText);
    expect(templateText({ zh: '中文', en: 'English only' }, 'pt-BR')).toBe('English only');
  });

  it('keeps PT-BR settings values and labels consistent when present', () => {
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
