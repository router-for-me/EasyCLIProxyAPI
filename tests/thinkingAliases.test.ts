import { describe, expect, test } from 'bun:test';
import { thinkingAliasSourceKindLabel } from '../src/pages/ThinkingAliasesPage';

describe('思考别名', () => {
  test('区分同名模型的接入来源', () => {
    expect(thinkingAliasSourceKindLabel('codex-oauth')).toBe('Codex OAuth');
    expect(thinkingAliasSourceKindLabel('codex-api')).toBe('Codex API');
    expect(thinkingAliasSourceKindLabel('openai-compatible')).toBe('OpenAI 兼容');
    expect(thinkingAliasSourceKindLabel('custom')).toBe('其他来源');
  });
});
