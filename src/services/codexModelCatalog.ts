import type { MessageKey } from '../i18n/resources';
import type { ModelOption } from './modelService';

// null 继承全局；对象明确使用 Codex 默认；字符串保留原样作为模型 ID。
export type CodexReviewModelSelection = string | null | { mode: 'codex_default' };

export function reviewModelPickerModels(models: CodexCatalogEditorModel[], selected: CodexReviewModelSelection): ModelOption[] {
  const options = models.map((model) => ({ name: model.slug }));
  // 隐藏模型也可选；失效 ID 保留显示，避免静默改写选择。
  if (typeof selected === 'string' && !options.some((model) => model.name === selected)) {
    options.unshift({ name: selected });
  }
  return options;
}

export const codexReasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type CodexReasoningEffort = typeof codexReasoningEfforts[number];

export type CodexReasoningLevel = {
  effort: CodexReasoningEffort;
  description: string;
};

export type CodexModelConfiguration = {
  display_name: string;
  description: string | null;
  context_window: number;
  max_context_window: number;
  effective_context_window_percent: number;
  auto_compact_token_limit: number | null;
  default_reasoning_level: CodexReasoningEffort | null;
  supported_reasoning_levels: CodexReasoningLevel[];
  input_modalities: Array<'text' | 'image'>;
  visibility: 'list' | 'hide' | 'none';
  supports_parallel_tool_calls: boolean;
  auto_review_model_override: CodexReviewModelSelection;
};

export type CodexCatalogEditorModel = {
  slug: string;
  hasOfficialTemplate: boolean;
  contextSource: "definition" | "configuration" | "compatibility" | "template";
  customized: boolean;
  configuration: CodexModelConfiguration;
  defaults: CodexModelConfiguration;
};

export type CodexCatalogEditorSnapshot = {
  revision: string;
  defaultAutoReviewModel: string | null;
  models: CodexCatalogEditorModel[];
};

export function codexContextSourceHint(model: CodexCatalogEditorModel): MessageKey {
  if (model.configuration.context_window !== model.defaults.context_window
    || model.configuration.max_context_window !== model.defaults.max_context_window) {
    return "agents.catalog.contextSource.customized";
  }
  return `agents.catalog.contextSource.${model.contextSource ?? "template"}`;
}

export type CodexCatalogEditorSaveResult = {
  snapshot: CodexCatalogEditorSnapshot;
  synchronizationError: string | null;
};

export function cloneCodexModelConfiguration(configuration: CodexModelConfiguration): CodexModelConfiguration {
  return {
    ...configuration,
    supported_reasoning_levels: configuration.supported_reasoning_levels.map((level) => ({ ...level })),
    input_modalities: [...configuration.input_modalities],
  };
}

export function sameCodexModelConfiguration(left: CodexModelConfiguration, right: CodexModelConfiguration): boolean {
  return left.display_name === right.display_name
    && left.description === right.description
    && Object.is(left.context_window, right.context_window)
    && Object.is(left.max_context_window, right.max_context_window)
    && Object.is(left.effective_context_window_percent, right.effective_context_window_percent)
    && Object.is(left.auto_compact_token_limit, right.auto_compact_token_limit)
    && left.default_reasoning_level === right.default_reasoning_level
    && left.visibility === right.visibility
    && left.supports_parallel_tool_calls === right.supports_parallel_tool_calls
    && JSON.stringify(left.auto_review_model_override) === JSON.stringify(right.auto_review_model_override)
    && left.input_modalities.join(',') === right.input_modalities.join(',')
    && left.supported_reasoning_levels.length === right.supported_reasoning_levels.length
    && left.supported_reasoning_levels.every((level, index) => level.effort === right.supported_reasoning_levels[index].effort
      && level.description === right.supported_reasoning_levels[index].description);
}

export function toggleCodexReasoningLevel(
  configuration: CodexModelConfiguration,
  effort: CodexReasoningEffort,
  enabled: boolean,
  defaults: CodexReasoningLevel[],
): CodexModelConfiguration {
  const levels = new Map(configuration.supported_reasoning_levels.map((level) => [level.effort, level]));
  if (enabled) {
    levels.set(effort, levels.get(effort) ?? defaults.find((level) => level.effort === effort)
      ?? { effort, description: `${effort} reasoning effort` });
  } else {
    levels.delete(effort);
  }
  const supported = codexReasoningEfforts.flatMap((level) => levels.has(level) ? [{ ...levels.get(level)! }] : []);
  const currentDefault = configuration.default_reasoning_level;
  const nextDefault = currentDefault && !levels.has(currentDefault)
    ? levels.has('medium') ? 'medium' : supported[0]?.effort ?? null
    : currentDefault;
  return { ...configuration, supported_reasoning_levels: supported, default_reasoning_level: nextDefault };
}

export function validateCodexModelConfiguration(configuration: CodexModelConfiguration): MessageKey | null {
  if (!configuration.display_name.trim() || configuration.display_name.length > 4_000
    || (configuration.description?.length ?? 0) > 4_000) return 'agents.catalog.invalidText';
  if (![configuration.context_window, configuration.max_context_window].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return 'agents.catalog.invalidContext';
  }
  if (configuration.max_context_window < configuration.context_window) return 'agents.catalog.invalidMaximum';
  const percent = configuration.effective_context_window_percent;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) return 'agents.catalog.invalidPercent';
  const compact = configuration.auto_compact_token_limit;
  if (compact !== null && (!Number.isSafeInteger(compact) || compact < 1 || compact > configuration.context_window)) {
    return 'agents.catalog.invalidCompact';
  }
  const levels = configuration.supported_reasoning_levels.map((level) => level.effort);
  if (new Set(levels).size !== levels.length || levels.some((level) => !codexReasoningEfforts.includes(level))
    || (configuration.default_reasoning_level !== null && !levels.includes(configuration.default_reasoning_level))) {
    return 'agents.catalog.invalidReasoning';
  }
  if (!configuration.input_modalities.length) return 'agents.catalog.invalidModalities';
  return null;
}
