export type ConfigText = string | { zh: string; en: string; ja?: string };
export type ConfigShape = {
  type: 'string' | 'number' | 'boolean' | 'select' | 'object' | 'array' | 'map' | 'any';
  label?: ConfigText;
  hint?: ConfigText;
  optional?: boolean;
  secret?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
  options?: readonly (string | boolean | number)[];
  fields?: Record<string, ConfigShape>;
  item?: ConfigShape;
  initial?: unknown;
  validate?: (value: unknown) => ConfigText | null;
};

export const configRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const defaultStructuredValue = (shape: ConfigShape): unknown => {
  if (shape.initial !== undefined) return structuredClone(shape.initial);
  switch (shape.type) {
    case 'array': return [];
    case 'object': return Object.fromEntries(Object.entries(shape.fields ?? {})
      .filter(([, field]) => !field.optional).map(([key, field]) => [key, defaultStructuredValue(field)]));
    case 'map': return {};
    case 'boolean': return false;
    case 'number': return shape.min ?? 0;
    case 'select': return shape.options?.[0] ?? '';
    default: return '';
  }
};

type ValidationLanguage = 'zh' | 'en' | 'ja';
const validationText = (text: ConfigText, language: ValidationLanguage) => typeof text === 'string' ? text : text[language] ?? text.en;

export const validateStructuredValue = (shape: ConfigShape, value: unknown, path = '', language: ValidationLanguage = 'en'): string | null => {
  if (shape.optional && value == null) return null;
  const error = (detail: ConfigText) => `${path || validationText({ zh: '值', en: 'Value', ja: '値' }, language)}: ${validationText(detail, language)}`;
  if (shape.type === 'string' && typeof value !== 'string') return error({ zh: '请输入文本', en: 'expected text', ja: 'テキストを入力してください' });
  if (shape.type === 'boolean' && typeof value !== 'boolean') return error({ zh: '请选择启用或禁用', en: 'expected true or false', ja: '有効または無効を選択してください' });
  if (shape.type === 'number' && (typeof value !== 'number' || (shape.integer === false ? !Number.isFinite(value) : !Number.isSafeInteger(value))
    || (shape.min !== undefined && value < shape.min) || (shape.max !== undefined && value > shape.max))) {
    const bounds = `${shape.min !== undefined ? ` ≥ ${shape.min}` : ''}${shape.max !== undefined ? ` ≤ ${shape.max}` : ''}`;
    return error({ zh: `请输入${shape.integer === false ? '有效数值' : '整数'}${bounds}`, en: `expected ${shape.integer === false ? 'a number' : 'an integer'}${bounds}`, ja: `${shape.integer === false ? '有効な数値' : '整数'}を入力してください${bounds}` });
  }
  if (shape.type === 'select' && !shape.options?.includes(value as string | boolean | number)) return error({ zh: '请选择支持的选项', en: 'select a supported value', ja: '対応する値を選択してください' });
  if (shape.type === 'array') {
    if (!Array.isArray(value)) return error({ zh: '应为列表', en: 'expected a list', ja: 'リストを指定してください' });
    for (const [index, entry] of value.entries()) {
      const invalid = validateStructuredValue(shape.item ?? { type: 'any' }, entry, `${path}[${index + 1}]`, language);
      if (invalid) return invalid;
    }
  }
  if (shape.type === 'object' || shape.type === 'map') {
    if (!configRecord(value)) return error({ zh: '应为对象', en: 'expected an object', ja: 'オブジェクトを指定してください' });
    if (shape.type === 'map') {
      for (const [key, entry] of Object.entries(value)) {
        if (!key.trim() || ['__proto__', 'prototype', 'constructor'].includes(key)) return error({ zh: '字段名称无效或为空', en: 'invalid or empty key', ja: 'キーが無効または空です' });
        const invalid = validateStructuredValue(shape.item ?? { type: 'any' }, entry, `${path}.${key}`, language);
        if (invalid) return invalid;
      }
    } else {
      for (const [key, field] of Object.entries(shape.fields ?? {})) {
        const invalid = validateStructuredValue(field, value[key], `${path}.${key}`, language);
        if (invalid) return invalid;
      }
    }
  }
  const invalid = shape.validate?.(value);
  return invalid ? validationText(invalid, language) : null;
};

export const validateStructuredValueText = (shape: ConfigShape, value: unknown, path = ''): ConfigText | null => {
  const en = validateStructuredValue(shape, value, path);
  return en === null ? null : { en, zh: validateStructuredValue(shape, value, path, 'zh') ?? en, ja: validateStructuredValue(shape, value, path, 'ja') ?? en };
};

export const textShape = (label?: ConfigText, optional = true): ConfigShape => ({ type: 'string', label, optional });
export const boolShape = (label?: ConfigText): ConfigShape => ({ type: 'boolean', label, optional: true });
export const stringsShape = (label?: ConfigText): ConfigShape => ({ type: 'array', label, optional: true, item: { type: 'string' } });
export const nonemptyText: ConfigShape = { type: 'string', validate: value => typeof value === 'string' && value.trim() ? null : { zh: '请输入内容', en: 'Please enter a value', ja: '値を入力してください' } };
export const errorRulesShape: ConfigShape = {
  type: 'array', item: { type: 'object', fields: {
    status: { type: 'number', min: 100, max: 599, initial: 400, label: { zh: 'HTTP 状态码', en: 'HTTP status', ja: 'HTTP ステータス' } },
    match: stringsShape({ zh: '包含的文本', en: 'Text patterns', ja: 'テキストパターン' }),
    'match-regexr': stringsShape({ zh: '正则表达式', en: 'Regular expressions', ja: '正規表現' }),
    action: { type: 'select', options: ['stop', 'stop-and-cooldown', 'continue', 'continue-and-cooldown'], label: { zh: '处理方式', en: 'Action', ja: '処理' } },
  } },
};
