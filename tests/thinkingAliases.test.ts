import { describe, expect, test } from 'bun:test';
import {
  combineModelAliasSources,
  defaultModelAlias,
  thinkingAliasSourceKindLabel,
  uniqueModelAlias,
} from '../src/pages/ThinkingAliasesPage';

describe('模型别名默认名称', () => {
  test('按思考强度生成可编辑的默认名称', () => {
    expect(defaultModelAlias('gpt-5.6-sol', 'XHigh')).toBe('gpt-5.6-sol-xhigh');
    expect(defaultModelAlias('gpt-5.6-sol', '')).toBe('gpt-5.6-sol-alias');
  });

  test('默认别名与现有模型重名时递增数字后缀', () => {
    expect(uniqueModelAlias('gpt-5.6-sol-high', ['gpt-5.6-sol-high'])).toBe('gpt-5.6-sol-high-2');
    expect(uniqueModelAlias('gpt-5.6-sol-high', [
      'gpt-5.6-sol-high',
      'gpt-5.6-sol-high-2',
    ])).toBe('gpt-5.6-sol-high-3');
    expect(uniqueModelAlias('gpt-5.6-sol-high', ['GPT-5.6-SOL-HIGH'])).toBe('gpt-5.6-sol-high-2');
  });
});

describe('思考别名来源', () => {
  test('区分同名模型的接入来源', () => {
    expect(thinkingAliasSourceKindLabel('codex-oauth')).toBe('Codex OAuth');
    expect(thinkingAliasSourceKindLabel('claude-api')).toBe('Claude API');
    expect(thinkingAliasSourceKindLabel('openai-compatible')).toBe('OpenAI 兼容');
  });

  test('仅把内核报告了思考等级的来源标为可覆写', () => {
    const baseSource = {
      model: 'shared-model',
      displayName: 'Shared Model',
      provider: 'Provider',
      kind: 'codex-api',
      protocol: 'codex',
      reasoningLevels: [] as string[],
    };
    const sources = combineModelAliasSources(
      [
        { ...baseSource, id: 'reasoning' },
        { ...baseSource, id: 'plain', model: 'plain-model' },
      ],
      [{ ...baseSource, id: 'reasoning', reasoningLevels: ['low', 'high'] }],
    );

    expect(sources).toHaveLength(2);
    expect(sources.find((source) => source.id === 'reasoning')).toMatchObject({
      supportsReasoning: true,
      reasoningLevels: ['low', 'high'],
    });
    expect(sources.find((source) => source.id === 'plain')?.supportsReasoning).toBe(false);
  });
});
