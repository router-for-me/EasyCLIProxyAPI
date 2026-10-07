// Legacy fixtures used to verify migration into native v8 provider groups.
import { normalizeProviderModels } from '../../src/services/providerModels';
import { isRecord, readString } from '../../src/services/managementApi';

const SHARED_PROVIDER_FIELDS = new Set([
  'priority',
  'prefix',
  'proxy-url',
  'headers',
  'models',
  'excluded-models',
  'disable-cooling',
  'request-retry',
  'request-scoped-errors',
]);

export function flattenV8ProviderGroups(provider: string, payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isRecord).flatMap((group) => {
    const keys = Array.isArray(group.keys) ? group.keys.filter(isRecord) : [];
    if (provider === 'openai-compatibility') {
      const record: Record<string, unknown> = { ...group };
      delete record.keys;
      delete record['test-model'];
      delete record.testModel;
      if (keys.length > 0) record['api-key-entries'] = keys.map((key) => ({ ...key }));
      return [normalizeProviderModels(record)];
    }
    const shared = Object.fromEntries(
      Object.entries(group).filter(([key]) => key === 'base-url' || SHARED_PROVIDER_FIELDS.has(key)),
    );
    const name = readString(group, 'name');
    const generatedName = name.startsWith(`${provider}-`) && /^[0-9]+$/.test(name.slice(provider.length + 1));
    if (name && !generatedName) shared.name = name;
    return keys.map((key) => {
      const overrides = Object.fromEntries(Object.entries(key).filter(([, value]) => value !== null));
      return normalizeProviderModels({ ...shared, ...overrides });
    });
  });
}

export function groupLegacyProviderRecords(provider: string, payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isRecord).map((input, index) => {
    const record = normalizeProviderModels(input);
    if (provider === 'openai-compatibility') {
      const group: Record<string, unknown> = {
        ...record,
        keys: Array.isArray(record['api-key-entries'])
          ? record['api-key-entries'].filter(isRecord).map((key) => ({ ...key }))
          : [],
      };
      delete group['api-key-entries'];
      delete group['test-model'];
      delete group.testModel;
      return group;
    }
    const group: Record<string, unknown> = { name: readString(record, 'name') || `${provider}-${index + 1}` };
    const key: Record<string, unknown> = {};
    Object.entries(record).forEach(([field, value]) => {
      if (field === 'name') return;
      if (field === 'base-url' || SHARED_PROVIDER_FIELDS.has(field)) group[field] = value;
      else key[field] = value;
    });
    group.keys = [key];
    return group;
  });
}

