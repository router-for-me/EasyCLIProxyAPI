import { describe, expect, test } from 'bun:test';
import { claudeResponseLanguageMode, claudeResponseLanguageOptions, claudeResponseLanguagePresets } from '../src/services/claudeResponseLanguage';
import { sameAgentModelMappings, resolveAgentModelMappingsDraftSourceForClient } from '../src/services/agentConfigurationDraft';

const mappings = { opus: 'one', sonnet: 'one', haiku: 'one' };

describe('Claude Code response language', () => {
  test('presets are broad suggestions with unique stable values and localized labels', () => {
    expect(claudeResponseLanguagePresets.length).toBeGreaterThan(100);
    expect(new Set(claudeResponseLanguagePresets.map(([, value]) => value)).size).toBe(claudeResponseLanguagePresets.length);
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja']) {
      const options = claudeResponseLanguageOptions(locale);
      expect(options.length).toBe(claudeResponseLanguagePresets.length);
      expect(options.every((option) => option.label && option.value)).toBe(true);
      const japaneseLabels: Record<string, string> = { en: 'Japanese', ja: '日本語', 'zh-CN': '日语', 'zh-TW': '日文' };
      expect(options.find((option) => option.value === 'Japanese')?.label).toBe(japaneseLabels[locale]);
    }
  });

  test('unmanaged, reset, preset and unknown values stay distinct', () => {
    expect(claudeResponseLanguageMode(undefined)).toBe('unmanaged');
    expect(claudeResponseLanguageMode(null)).toBe('unmanaged');
    expect(claudeResponseLanguageMode('')).toBe('default');
    expect(claudeResponseLanguageMode('Japanese')).toBe('Japanese');
    expect(claudeResponseLanguageMode('日本語（関西弁）')).toBe('custom');
    expect(sameAgentModelMappings(mappings, { ...mappings, responseLanguage: null })).toBe(true);
    expect(sameAgentModelMappings(mappings, { ...mappings, responseLanguage: '' })).toBe(false);
    expect(sameAgentModelMappings({ ...mappings, responseLanguage: 'English' }, { ...mappings, responseLanguage: 'english' })).toBe(false);
  });

  test('reload and unrelated edits preserve custom values independently from Desktop', () => {
    const custom = { ...mappings, responseLanguage: '  日本語（関西弁）  ' };
    const current = { 'claude-code': custom, 'claude-desktop': mappings };
    const loaded = JSON.parse(JSON.stringify(custom));
    expect(resolveAgentModelMappingsDraftSourceForClient(current, 'claude-code', loaded, mappings, false)).toEqual(custom);
    expect(resolveAgentModelMappingsDraftSourceForClient(current, 'claude-code', mappings, mappings, true)).toEqual(custom);
    expect(resolveAgentModelMappingsDraftSourceForClient(current, 'claude-desktop', undefined, mappings, false)).toEqual(mappings);
    expect(sameAgentModelMappings(custom, { ...custom, sonnet: 'two' })).toBe(false);
  });
});
