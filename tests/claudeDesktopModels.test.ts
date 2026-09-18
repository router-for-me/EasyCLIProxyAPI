import { describe, expect, test } from 'bun:test';
import { claudeDesktopAliasSuggestions, createDefaultDesktopModels, desktopAliasNotice, desktopModelEntries, desktopModelValidation, isClaudeDesktopModel, selectedDesktopModelEntries, validClaudeDesktopAlias } from '../src/services/claudeDesktopModels';
import { sameAgentModelMappings } from '../src/services/agentConfigurationDraft';

const legacy = { opus: 'gpt-one', sonnet: 'gpt-two', haiku: 'claude-haiku-4-5', opus1m: true };
const models = [{ name: 'gpt-one' }, { name: 'gpt-two' }];
const entry = { model: 'gpt-one', alias: 'claude-sonnet-4-6', context1m: false };

describe('Claude Desktop custom models', () => {
  test('migrates old slots without filling an empty configuration', () => {
    expect(desktopModelEntries(legacy)).toEqual([
      { model: 'gpt-one', alias: 'claude-opus-4-6', context1m: true },
      { model: 'gpt-two', alias: 'claude-sonnet-4-6', context1m: false },
      { model: 'claude-haiku-4-5', alias: '', context1m: false },
    ]);
    expect(desktopModelEntries({ opus: '', sonnet: '', haiku: '' })).toEqual([]);
    expect(desktopModelEntries({ ...legacy, desktopModels: [] })).toEqual([]);
    expect(claudeDesktopAliasSuggestions.some((id) => id.includes('cpa'))).toBeFalse();
  });

  test('an empty alias keeps the original ID, even outside the available model list', () => {
    expect(desktopModelValidation([{ ...entry, alias: '' }], [])).toBeNull();
    expect(desktopModelValidation([{ ...entry, alias: '  ' }], [])).toBeNull();
    expect(desktopModelValidation([{ ...entry, model: '' }], models)).toBe('empty');
    expect(desktopModelValidation([{ ...entry, model: '  ', alias: '' }], [])).toBe('empty');
    expect(desktopModelValidation([{ ...entry, model: 'two words', alias: '' }], [])).toBe('modelFormat');
    expect(desktopModelValidation([{ ...entry, alias: '' }, entry], models)).toBeNull();
    expect(desktopModelValidation([{ ...entry, model: entry.alias, alias: '' }, entry], models)).toBe('duplicate');
  });

  test('only selected originals participate in validation and configuration', () => {
    const defaults = createDefaultDesktopModels();
    expect(desktopModelValidation(defaults, models)).toBe('empty');
    const partial = defaults.map((row, index) => index === 1 ? { ...row, model: 'gpt-one' } : row);
    expect(desktopModelValidation(partial, models)).toBeNull();
    expect(selectedDesktopModelEntries(partial)).toEqual([partial[1]]);
    const unused = { ...entry, model: '  ' };
    expect(desktopModelValidation([unused, entry], models)).toBeNull();
    const available = [...models, { name: defaults[0].alias }];
    expect(desktopAliasNotice(partial[0], partial, available)).toBe('aliasExists');
    expect(desktopModelValidation(partial, available)).toBeNull();
    expect(desktopModelValidation([{ ...partial[0], model: 'gpt-two' }, partial[1]], available)).toBe('aliasExists');
  });

  test('migrates saved alias-only and unchanged-ID entries to an original model with no alias', () => {
    const direct = { model: 'claude-sonnet-4-6', alias: '', context1m: false };
    expect(desktopModelEntries({ ...legacy, desktopModels: [{ ...entry, model: '' }] })).toEqual([direct]);
    expect(desktopModelEntries({ ...legacy, desktopModels: [{ ...direct, alias: direct.model }] })).toEqual([direct]);
    expect(desktopModelEntries({ ...legacy, desktopModels: [direct, entry] })).toEqual([direct, entry]);
  });

  test('accepts custom source IDs outside the loaded list and requires unique compatible aliases', () => {
    expect(desktopModelValidation([entry], models)).toBeNull();
    expect(desktopModelValidation([], models)).toBe('empty');
    expect(desktopModelValidation([{ ...entry, model: 'manual-model' }], models)).toBeNull();
    expect(desktopModelValidation([entry], [])).toBeNull();
    expect(desktopModelValidation([{ ...entry, alias: 'gpt-test' }], models)).toBe('alias');
    expect(desktopModelValidation([entry, { ...entry, model: 'gpt-two', alias: ` ${entry.alias} ` }], models)).toBe('duplicate');
    expect(desktopModelValidation(Array.from({ length: 5 }, (_, i) => ({ ...entry, alias: `claude-sonnet-4-6-${i}` })), models)).toBeNull();
    for (const alias of ['claude-', 'claude-FOO', 'claude-a/b', 'claude-a..b', 'claude-a-']) expect(validClaudeDesktopAlias(alias)).toBeFalse();
  });

  test('detects Claude model IDs without accepting other-family names with a Claude prefix', () => {
    for (const id of ['claude-opus-5', ' CLAUDE-SONNET-4-6 ', 'anthropic/claude-fable-5.1',
      'us.anthropic.claude-sonnet-4-6-v1:0', 'sonnet', 'haiku-4.5']) expect(isClaudeDesktopModel(id)).toBeTrue();
    for (const id of ['', 'gpt-one', 'claude-grok-4.6', 'claude-gemini', 'claude- two']) expect(isClaudeDesktopModel(id)).toBeFalse();
  });

  test('rejects other model families in aliases while keeping ordinary custom suffixes', () => {
    for (const alias of ['claude-grok-4.6', 'claude-opus-gpt-5', 'claude-gemini',
      'claude-deepseek', 'claude-opus-phi4', 'claude-opus-k2.5', 'claude-m2.1',
      'claude-ling', 'claude-unic', 'claude-ds-test']) {
      expect(validClaudeDesktopAlias(alias)).toBeFalse();
      expect(desktopModelValidation([{ ...entry, alias }], models)).toBe('alias');
    }
    for (const alias of [...claudeDesktopAliasSuggestions, 'claude-opus-personal',
      'claude-linguist', 'claude-unicorn', 'claude-ranking2.1']) {
      expect(validClaudeDesktopAlias(alias)).toBeTrue();
    }
  });

  test('treats an alias matching its own original as a notice, and another original as a conflict', () => {
    const direct = { ...entry, model: 'claude-opus-5', alias: ' CLAUDE-OPUS-5 ' };
    expect(desktopAliasNotice(direct, [direct], [])).toBe('sameModel');
    expect(desktopModelValidation([direct], [])).toBeNull();
    const renamed = { ...entry, alias: 'claude-opus-5' };
    const available = [...models, { name: 'CLAUDE-OPUS-5' }];
    expect(desktopAliasNotice(renamed, [renamed], available)).toBe('aliasExists');
    expect(desktopModelValidation([renamed], available)).toBe('aliasExists');
    expect(desktopAliasNotice(renamed, [renamed, { ...direct, alias: 'claude-haiku-4-5' }], models)).toBe('aliasExists');
    expect(desktopAliasNotice(renamed, [renamed], [{ name: 'claude-opus-5', isAlias: true }])).toBe('aliasExists');
  });

  test('allows existing Desktop aliases but still warns about unrelated aliases or real models', () => {
    const configured = { ...entry, alias: 'claude-opus-5' };
    const available = [...models, { name: 'claude-opus-5', isAlias: true }];
    expect(desktopAliasNotice(configured, [configured], available, [configured])).toBeNull();
    expect(desktopModelValidation([configured], available, [configured])).toBeNull();
    expect(desktopModelValidation([configured], available, [])).toBe('aliasExists');
    expect(desktopModelValidation([configured], [{ name: 'claude-opus-5', isAlias: false }], [configured])).toBe('aliasExists');
  });

  test('tracks alias edits, row removal and context changes independently of legacy fields', () => {
    const before = { ...legacy, desktopModels: [entry] };
    expect(sameAgentModelMappings(before, { ...before, opus: 'ignored' })).toBeTrue();
    expect(sameAgentModelMappings(before, { ...before, desktopModels: [{ ...entry, alias: 'claude-opus-4-6' }] })).toBeFalse();
    expect(sameAgentModelMappings(before, { ...before, desktopModels: [{ ...entry, context1m: true }] })).toBeFalse();
    expect(sameAgentModelMappings(before, { ...before, desktopModels: [] })).toBeFalse();
  });
});
