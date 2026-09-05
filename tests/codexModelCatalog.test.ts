import { describe, expect, test } from 'bun:test';
import {
  cloneCodexModelConfiguration,
  sameCodexModelConfiguration,
  toggleCodexReasoningLevel,
  validateCodexModelConfiguration,
  type CodexModelConfiguration,
} from '../src/services/codexModelCatalog';

const configuration = (): CodexModelConfiguration => ({
  display_name: 'Third Party',
  description: null,
  context_window: 128_000,
  max_context_window: 128_000,
  effective_context_window_percent: 95,
  auto_compact_token_limit: null,
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'low', description: 'Low' },
    { effort: 'medium', description: 'Medium' },
    { effort: 'high', description: 'High' },
  ],
  input_modalities: ['text', 'image'],
  visibility: 'list',
  supports_parallel_tool_calls: false,
});

describe('Codex 模型列表编辑', () => {
  test('克隆配置时隔离数组字段', () => {
    const original = configuration();
    const cloned = cloneCodexModelConfiguration(original);
    cloned.supported_reasoning_levels[0].description = 'Changed';
    cloned.input_modalities.pop();

    expect(original.supported_reasoning_levels[0].description).toBe('Low');
    expect(original.input_modalities).toEqual(['text', 'image']);
    expect(sameCodexModelConfiguration(original, cloned)).toBeFalse();
  });

  test('移除默认思考等级时选择剩余可用等级', () => {
    const updated = toggleCodexReasoningLevel(configuration(), 'medium', false, []);
    expect(updated.supported_reasoning_levels.map((level) => level.effort)).toEqual(['low', 'high']);
    expect(updated.default_reasoning_level).toBe('low');
  });

  test('校验上下文、压缩阈值和输入类型', () => {
    expect(validateCodexModelConfiguration(configuration())).toBeNull();
    expect(validateCodexModelConfiguration({ ...configuration(), max_context_window: 64_000 }))
      .toBe('agents.catalog.invalidMaximum');
    expect(validateCodexModelConfiguration({ ...configuration(), auto_compact_token_limit: 200_000 }))
      .toBe('agents.catalog.invalidCompact');
    expect(validateCodexModelConfiguration({ ...configuration(), input_modalities: [] }))
      .toBe('agents.catalog.invalidModalities');
  });
});
