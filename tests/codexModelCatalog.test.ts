import { describe, expect, test } from 'bun:test';
import {
  cloneCodexModelConfiguration,
  codexContextSourceHint,
  reviewModelPickerModels,
  sameCodexModelConfiguration,
  toggleCodexReasoningLevel,
  validateCodexModelConfiguration,
  type CodexModelConfiguration,
  type CodexCatalogEditorModel,
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
  auto_review_model_override: null,
});

describe('Codex 模型列表编辑', () => {
  test('Codex 默认独立于继承，序列化重载后仍保持相同选择', () => {
    const inherited = configuration();
    const codexDefault: CodexModelConfiguration = { ...inherited, auto_review_model_override: { mode: 'codex_default' } };
    expect(sameCodexModelConfiguration(inherited, codexDefault)).toBeFalse();
    expect(sameCodexModelConfiguration(codexDefault, JSON.parse(JSON.stringify(codexDefault)))).toBeTrue();
  });
  test('选择器保留隐藏模型、失效 ID 和与特殊选项同名的真实模型', () => {
    const model: CodexCatalogEditorModel = {
      slug: 'codex_default', hasOfficialTemplate: false, customized: false,
      contextSource: 'template', configuration: { ...configuration(), visibility: 'hide' }, defaults: configuration(),
    };
    expect(reviewModelPickerModels([model], 'review-gone').map((option) => option.name)).toEqual(['review-gone', 'codex_default']);
    expect(reviewModelPickerModels([model], { mode: 'codex_default' }).map((option) => option.name)).toEqual(['codex_default']);
  });
  test('审批模型显式选择与继承状态不同，恢复默认不会固化统一默认值', () => {
    const inherited = configuration();
    const selected = { ...inherited, auto_review_model_override: 'team/Codex Auto Review' };
    expect(sameCodexModelConfiguration(inherited, selected)).toBeFalse();
    expect(cloneCodexModelConfiguration(selected).auto_review_model_override).toBe('team/Codex Auto Review');
    expect(cloneCodexModelConfiguration(inherited).auto_review_model_override).toBeNull();
  });
  test("区分内核模型定义与兼容目录的后备上下文", () => {
    const model: CodexCatalogEditorModel = {
      slug: "model-a", hasOfficialTemplate: true, customized: false,
      contextSource: "definition", configuration: configuration(), defaults: configuration(),
    };
    expect(codexContextSourceHint(model)).toBe("agents.catalog.contextSource.definition");
    expect(codexContextSourceHint({ ...model, contextSource: "compatibility" }))
      .toBe("agents.catalog.contextSource.compatibility");
    model.configuration.context_window = 64_000;
    expect(codexContextSourceHint(model)).toBe("agents.catalog.contextSource.customized");
    model.configuration = cloneCodexModelConfiguration(model.defaults);
    expect(codexContextSourceHint(model)).toBe("agents.catalog.contextSource.definition");
  });

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
