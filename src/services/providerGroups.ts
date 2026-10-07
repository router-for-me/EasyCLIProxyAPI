import { isRecord, readString } from './managementApi';
import { normalizeProviderModels } from './providerModels';

export type ProviderKeyDraft = { id: string; value: Record<string, unknown>; text?: Record<string, string> };
export const providerGroupKeys = (group: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(group.keys) ? group.keys.filter(isRecord) : [];

export function providerKeyDraft(value: Record<string, unknown> = {}): ProviderKeyDraft {
  return { id: crypto.randomUUID(), value: structuredClone(value) };
}

export function cleanProviderGroup(group: Record<string, unknown>): Record<string, unknown> {
  const clean = normalizeProviderModels(group);
  for (const field of ['auth-index', 'authIndex', 'auth_index', 'test-model', 'testModel']) delete clean[field];
  if (Array.isArray(clean.keys)) clean.keys = clean.keys.filter(isRecord).map(cleanProviderGroup);
  return clean;
}

export function providerGroupIdentity(group: Record<string, unknown>): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
  return JSON.stringify(sort(cleanProviderGroup(group)));
}

// Lists and maps replace the group setting; null and absent fields inherit it.
export function effectiveProviderKey(group: Record<string, unknown>, key: Record<string, unknown>) {
  const { keys: _keys, ...shared } = group;
  return { ...shared, ...Object.fromEntries(Object.entries(key).filter(([, value]) => value !== null)) };
}

export const providerKeyIsDisabled = (group: Record<string, unknown>, key: Record<string, unknown>) => {
  const effective = effectiveProviderKey(group, key);
  return group.disabled === true || effective.disabled === true
    || (Array.isArray(effective['excluded-models']) && effective['excluded-models'].some((item) => String(item).trim() === '*'));
};

export function providerGroupStatus(group: Record<string, unknown>): 'enabled' | 'partial' | 'disabled' {
  const keys = providerGroupKeys(group);
  if (!keys.length) return group.disabled === true ? 'disabled' : 'enabled';
  const active = keys.filter((key) => !providerKeyIsDisabled(group, key)).length;
  return active === 0 ? 'disabled' : active === keys.length ? 'enabled' : 'partial';
}

export function providerKeyOverrides(key: Record<string, unknown>): string[] {
  return Object.keys(key).filter((field) => !['api-key', 'auth-index', 'authIndex', 'auth_index', 'weight'].includes(field)
    && key[field] != null);
}

export function validateProviderGroupKeys(keys: ProviderKeyDraft[]): string | null {
  for (const { value } of keys) {
    if (!readString(value, 'api-key').trim()) return 'key';
    if (Array.isArray(value.models) && value.models.some((model) => !isRecord(model) || !readString(model, 'name').trim())) return 'models';
    for (const field of ['priority', 'weight', 'request-retry']) {
      const valueField = value[field];
      if (valueField == null) continue;
      if (typeof valueField !== 'number' || !Number.isSafeInteger(valueField)) return field;
      if (field === 'weight' && valueField > 1_000_000) return field;
    }
  }
  return null;
}

// Validate only known editable fields. Unknown provider extensions survive edits.
export function validateProviderTemplateRecord(value: Record<string, unknown>, path = ''): string | null {
  const at = (field: string) => path ? `${path}.${field}` : field;
  for (const field of ['priority', 'weight', 'request-retry']) {
    const item = value[field];
    if (item == null) continue;
    if (!Number.isSafeInteger(item) || (field === 'weight' && Number(item) > 1_000_000)) return at(field);
  }
  const rules = value['request-scoped-errors'];
  if (rules != null) {
    if (!Array.isArray(rules)) return at('request-scoped-errors');
    for (const [index, rule] of rules.entries()) {
      const rulePath = at(`request-scoped-errors[${index + 1}]`);
      if (!isRecord(rule) || !Number.isSafeInteger(rule.status) || Number(rule.status) < 100 || Number(rule.status) > 599) return `${rulePath}.status`;
      if (!['stop', 'stop-and-cooldown', 'continue', 'continue-and-cooldown'].includes(String(rule.action))) return `${rulePath}.action`;
      for (const field of ['match', 'match-regexr']) {
        if (rule[field] != null && (!Array.isArray(rule[field]) || rule[field].some((pattern: unknown) => typeof pattern !== 'string'))) return `${rulePath}.${field}`;
      }
    }
  }
  if (Array.isArray(value.models)) {
    for (const [index, model] of value.models.entries()) {
      const modelPath = at(`models[${index + 1}]`);
      if (!isRecord(model) || !readString(model, 'name').trim()) return `${modelPath}.name`;
      if (model['max-context-length'] != null && (!Number.isSafeInteger(model['max-context-length']) || Number(model['max-context-length']) < 0)) return `${modelPath}.max-context-length`;
      for (const field of ['input-modalities', 'output-modalities']) {
        if (model[field] != null && (!Array.isArray(model[field]) || model[field].some((item: unknown) => typeof item !== 'string' || !item.trim()))) return `${modelPath}.${field}`;
      }
      if (model.thinking != null) {
        if (!isRecord(model.thinking)) return `${modelPath}.thinking`;
        const thinking = model.thinking;
        for (const field of ['min', 'max']) if (thinking[field] != null && (!Number.isSafeInteger(thinking[field]) || Number(thinking[field]) < 0)) return `${modelPath}.thinking.${field}`;
        if (typeof thinking.min === 'number' && typeof thinking.max === 'number' && thinking.min > thinking.max) return `${modelPath}.thinking.max`;
        if (thinking.levels != null && (!Array.isArray(thinking.levels) || thinking.levels.some((item: unknown) => typeof item !== 'string' || !item.trim()))) return `${modelPath}.thinking.levels`;
      }
    }
  }
  if (Array.isArray(value.keys)) for (const [index, key] of value.keys.entries()) {
    if (!isRecord(key)) return at(`keys[${index + 1}]`);
    const error = validateProviderTemplateRecord(key, at(`keys[${index + 1}]`));
    if (error) return error;
  }
  return null;
}

export function appendNativeProviderGroup(groups: Record<string, unknown>[], group: Record<string, unknown>): Record<string, unknown>[] {
  const base = readString(group, 'name').trim() || 'provider';
  let name = base;
  let suffix = 2;
  const names = new Set(groups.map((item) => readString(item, 'name')));
  while (names.has(name)) name = `${base} (${suffix++})`;
  return [...groups.map(cleanProviderGroup), cleanProviderGroup({ ...group, name })];
}

export function serializeProviderKey(draft: ProviderKeyDraft): Record<string, unknown> {
  const value = cleanProviderGroup(draft.value);
  for (const [field, text] of Object.entries(draft.text ?? {})) {
    if (field === 'cloak-words') value.cloak = { ...(isRecord(value.cloak) ? value.cloak : {}),
      'sensitive-words': text.split(/[\n,]/).map((line) => line.trim()).filter(Boolean) };
    if (field === 'excluded-models') value[field] = text.split(/[\n,]/).map((line) => line.trim()).filter(Boolean);
    if (field === 'headers') {
      const headers: Record<string, string> = {};
      for (const line of text.split('\n').filter((line) => line.trim())) {
        const colon = line.indexOf(':');
        if (colon <= 0 || !/^[!#$%&'*+.^_`|~\w-]+$/.test(line.slice(0, colon).trim())) throw new Error('Invalid key header');
        headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }
      value[field] = headers;
    }
  }
  value['api-key'] = readString(value, 'api-key').trim();
  return value;
}
