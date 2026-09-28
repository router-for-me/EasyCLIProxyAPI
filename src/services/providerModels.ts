const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function normalizeThinkingConfig(value: Record<string, unknown>, discovered = false) {
  const next = { ...value };
  for (const [json, yaml] of [['zero_allowed', 'zero-allowed'], ['dynamic_allowed', 'dynamic-allowed']]) {
    if (!(yaml in next) && json in next) next[yaml] = next[json];
    delete next[json];
  }
  if (!discovered) return next;
  return Object.fromEntries(Object.entries(next).filter(([key, item]) => {
    if (key === 'min' || key === 'max') return Number.isSafeInteger(item) && Number(item) >= 0;
    if (key === 'zero-allowed' || key === 'dynamic-allowed') return typeof item === 'boolean';
    return key === 'levels' && Array.isArray(item) && item.every((level) => typeof level === 'string');
  }));
}

export function normalizeProviderModels(record: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(record.models)) return { ...record };
  return { ...record, models: record.models.map((model) => (
    isObject(model) && isObject(model.thinking)
      ? { ...model, thinking: normalizeThinkingConfig(model.thinking) }
      : model
  )) };
}
