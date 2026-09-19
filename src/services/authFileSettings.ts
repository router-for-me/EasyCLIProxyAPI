import { getCurrentLocale, translate } from '../i18n';
import { isRecord, managementApi } from './managementApi';
import { normalizeAuthFilePriorityInput } from './authFiles';
import { authFileExcludedRulesFromPayload } from './oauthModelSettings';
import { normalizeOAuthExcludedRules } from './oauthModels';

export type BooleanOverride = '' | 'true' | 'false';
export type AuthFileSettingsDraft = {
  prefix: string;
  proxy_url: string;
  priority: string;
  weight: string;
  disable_cooling: BooleanOverride;
  websockets: BooleanOverride;
  excluded_models: string;
  headers: string;
  note: string;
};

const fail = (key: 'metadata' | 'headers' | 'weight' | 'priority') => {
  throw new Error(translate(getCurrentLocale(), `authFiles.settings.invalid.${key}`));
};

const override = (value: unknown, allowNumber = false): BooleanOverride => {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (allowNumber && typeof value === 'number' && Number.isFinite(value)) return value !== 0 ? 'true' : 'false';
  if (typeof value === 'string') {
    if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(value.trim())) return 'true';
    if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(value.trim())) return 'false';
  }
  return '';
};

const headersFromText = (text: string): Record<string, string> => {
  let value: unknown;
  try { value = JSON.parse(text.trim() || '{}'); } catch { return fail('headers'); }
  if (!isRecord(value)) return fail('headers');
  const names = new Set<string>();
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const name = key.trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || typeof item !== 'string'
      || /[\r\n\0]/.test(item) || names.has(name.toLowerCase())) return fail('headers');
    names.add(name.toLowerCase());
    if (item.trim()) result[name] = item.trim();
  }
  return result;
};

export const authFileSettingsFromPayload = (payload: unknown): AuthFileSettingsDraft => {
  let metadata = payload;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { return fail('metadata'); }
  }
  if (!isRecord(metadata)) return fail('metadata');
  const read = (key: string, legacy?: string) => Object.prototype.hasOwnProperty.call(metadata, key)
    ? metadata[key] : legacy ? metadata[legacy] : undefined;
  const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const headers = metadata.headers == null ? {} : metadata.headers;
  if (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== 'string')) return fail('headers');
  return {
    prefix: text(metadata.prefix),
    proxy_url: text(read('proxy_url', 'proxy-url')),
    priority: text(metadata.priority),
    weight: text(metadata.weight),
    disable_cooling: override(read('disable_cooling', 'disable-cooling'), true),
    websockets: override(read('websockets', 'websocket')),
    excluded_models: authFileExcludedRulesFromPayload(metadata).join('\n'),
    headers: JSON.stringify(headers, null, 2),
    note: text(metadata.note),
  };
};

export const buildAuthFileSettingsPatch = (
  original: AuthFileSettingsDraft,
  draft: AuthFileSettingsDraft,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  for (const key of ['prefix', 'proxy_url', 'note'] as const) {
    if (draft[key].trim() !== original[key].trim()) patch[key] = draft[key].trim();
  }
  if (draft.priority !== original.priority) {
    const value = normalizeAuthFilePriorityInput(draft.priority);
    if (value === null) return fail('priority');
    if (value !== normalizeAuthFilePriorityInput(original.priority)) patch.priority = value;
  }
  if (draft.weight !== original.weight) {
    const text = draft.weight.trim();
    const value = text ? Number(text) : null;
    if (value !== null && (!/^-?\d+$/.test(text) || !Number.isSafeInteger(value) || value > 1_000_000)) return fail('weight');
    const normalized = value === null ? null : Math.max(0, value);
    const previous = original.weight.trim() ? Math.max(0, Number(original.weight)) : null;
    if (normalized !== previous) patch.weight = normalized;
  }
  for (const key of ['disable_cooling', 'websockets'] as const) {
    if (draft[key] !== original[key]) patch[key] = draft[key] === '' ? null : draft[key] === 'true';
  }
  const rules = (text: string) => normalizeOAuthExcludedRules(text.split(/\r?\n/));
  const nextRules = rules(draft.excluded_models);
  if (JSON.stringify([...nextRules].sort()) !== JSON.stringify(rules(original.excluded_models).sort())) {
    patch.excluded_models = nextRules;
  }
  if (draft.headers !== original.headers) {
    const previous = headersFromText(original.headers);
    const next = headersFromText(draft.headers);
    const headers: Record<string, string> = Object.create(null);
    for (const name of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (previous[name] !== next[name]) headers[name] = next[name] ?? '';
    }
    if (Object.keys(headers).length) patch.headers = headers;
  }
  return patch;
};

type SettingsApi = {
  get: (path: string, query: Record<string, string>) => Promise<unknown>;
  patch: (path: string, body: Record<string, unknown>) => Promise<unknown>;
};

export const loadAuthFileSettings = async (name: string, api: SettingsApi = managementApi) =>
  authFileSettingsFromPayload(await api.get('/auth-files/download', { name }));

export const saveAuthFileSettings = async (
  name: string, original: AuthFileSettingsDraft, draft: AuthFileSettingsDraft,
  api: SettingsApi = managementApi,
) => {
  const patch = buildAuthFileSettingsPatch(original, draft);
  if (!Object.keys(patch).length) return false;
  await api.patch('/auth-files/fields', { name, ...patch });
  return true;
};
