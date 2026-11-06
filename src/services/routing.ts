import { isRecord, managementApi, readString, type ManagementJson } from './managementApi';
import { providerEntries } from './providerEntries';
import { cleanProviderGroup } from './providerGroups';
import { resolveApiAccessRemarks, type ApiAccessRemarkQuery, type ProviderSection } from './apiAccessRemarks';
import { getCurrentLocale, translate } from '../i18n';

export const routingFamilies = ['codex', 'claude', 'gemini', 'interactions', 'vertex', 'xai', 'meta', 'openai-compatibility'] as const;
export const routingSettingPaths = {
  strategy: 'strategy', session_affinity: 'session-affinity', session_affinity_ttl: 'session-affinity-ttl',
  request_retry: 'retry/request-retry', max_retry_credentials: 'retry/max-retry-credentials',
  max_retry_interval: 'retry/max-retry-interval', disable_cooling: 'cooldown/disable-cooling',
  transient_error_cooldown_seconds: 'cooldown/transient-error-cooldown-seconds',
} as const;
export type RoutingSettings = {
  strategy: 'round-robin' | 'weighted-round-robin' | 'fill-first';
  session_affinity: boolean; session_affinity_ttl: string;
  request_retry: number; max_retry_credentials: number; max_retry_interval: number;
  disable_cooling: boolean; transient_error_cooldown_seconds: number;
};
export type RoutingMember = {
  key: string; name: string; family: string; priority: number; weights: (number | null)[];
  disabled: boolean; unavailable: boolean; runtimeOnly: boolean;
  kind?: 'provider' | 'credential'; keyCount?: number; prefix?: string;
  familyIndex?: number; groupIndex?: number; keyIndex?: number; credentialName?: string;
  remark?: string;
};
export type RoutingBoard = {
  revision: string; settings: RoutingSettings; members: RoutingMember[]; partial: string[];
  groups: Record<string, Record<string, unknown>[]>;
};
export type RoutingPlan = Pick<RoutingBoard, 'revision' | 'settings' | 'members'>;
type RoutingApi = Pick<typeof managementApi, 'get' | 'put' | 'patch'>;
const number = (value: unknown) => Number.isSafeInteger(value) ? value as number : 0;
const weight = (value: unknown) => value == null ? null : number(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  isRecord(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const message = (key: 'conflict' | 'invalid' | 'partial' | 'writeFailed') => translate(getCurrentLocale(), `routing.${key}`);

export type RemarkResolver = (queries: ApiAccessRemarkQuery[]) => Promise<string[]>;

export async function readRoutingBoard(
  api: RoutingApi = managementApi,
  remarkResolver: RemarkResolver = queries => resolveApiAccessRemarks({ queries }),
): Promise<RoutingBoard> {
  const partial: string[] = [];
  const groups: RoutingBoard['groups'] = {};
  const sources = await Promise.all(routingFamilies.map(async family => {
    try {
      const payload = await api.get<unknown>(`/config/api-keys/${family}`);
      if (!Array.isArray(payload) || !payload.every(isRecord)) throw new Error('Invalid configuration');
      groups[family] = payload;
      return providerEntries(family === 'openai-compatibility' ? family : `${family}-api-key`, payload).map(({ record, source }): RoutingMember => {
        const weights = source.keyIndex === undefined && Array.isArray(record.keys)
          ? record.keys.filter(isRecord).map(key => weight(key.weight)) : [weight(record.weight)];
        return {
          key: `provider:${family}:${source.groupIndex}:${source.keyIndex ?? 'group'}`,
          name: readString(source.group, 'name') || family, family,
          priority: number(record.priority),
          weights, kind: 'provider', keyCount: weights.length,
          prefix: readString(record, 'prefix'),
          disabled: source.group.disabled === true || record.disabled === true
            || (Array.isArray(record['excluded-models']) && record['excluded-models'].includes('*')),
          unavailable: false, runtimeOnly: false, groupIndex: source.groupIndex, keyIndex: source.keyIndex,
        };
      });
    } catch (error) {
      if (String(error).includes('Management API error (404): not_found')) { groups[family] = []; return []; }
      partial.push(family); return [];
    }
  }));
  const flatProviders = sources.flat();
  if (flatProviders.length > 0) {
    const remarkQueries: ApiAccessRemarkQuery[] = [];
    for (const member of flatProviders) {
      const family = member.family;
      const section = (family === 'openai-compatibility' ? family : `${family}-api-key`) as ProviderSection;
      const group = groups[family]?.[member.groupIndex!];
      const keys = group && Array.isArray(group.keys) ? group.keys.filter(isRecord) : [];
      const record = member.keyIndex === undefined ? group : keys[member.keyIndex];
      const singleKey = record ? readString(record, 'api-key', 'apiKey') : '';
      const groupKeys = keys.map(k => readString(k, 'api-key', 'apiKey')).filter(Boolean);
      const apiKeys = singleKey ? [singleKey] : groupKeys;
      const baseUrl = (record ? readString(record, 'base-url', 'baseUrl') : '') || (group ? readString(group, 'base-url', 'baseUrl') : '');
      const groupBaseUrl = group ? readString(group, 'base-url', 'baseUrl') : '';
      const providerName = group ? readString(group, 'name') : '';

      remarkQueries.push(
        { providerSection: section, providerName, baseUrl, apiKeys },
        { providerSection: section, providerName: '', baseUrl, apiKeys },
        { providerSection: section, providerName, baseUrl: groupBaseUrl, apiKeys: groupKeys },
        { providerSection: section, providerName: '', baseUrl: groupBaseUrl, apiKeys: groupKeys },
      );
    }

    try {
      const resolvedRemarks = await remarkResolver(remarkQueries);
      flatProviders.forEach((member, index) => {
        const memberQueries = resolvedRemarks.slice(index * 4, index * 4 + 4);
        const remark = (memberQueries.find(r => r && r.trim()) || '').trim();
        if (remark) member.remark = remark;
      });
    } catch {
      // Graceful fallback for non-Tauri or test environments
    }
  }

  const credentials = await api.get<unknown>('/credentials');
  if (!isRecord(credentials) || !Array.isArray(credentials.files) || !credentials.files.every(isRecord)) throw new Error(message('invalid'));
  const members = [...flatProviders, ...credentials.files.map((file, index): RoutingMember => {
    const name = readString(file, 'name');
    return {
      key: `credential:${name || readString(file, 'auth_index') || index}`, name: name || readString(file, 'provider'),
      credentialName: name, family: readString(file, 'provider', 'type'), priority: number(file.priority), weights: [weight(file.weight)],
      kind: 'credential', keyCount: 1, prefix: readString(file, 'prefix'),
      disabled: file.disabled === true, unavailable: file.unavailable === true,
      runtimeOnly: file.runtime_only === true || !name,
    };
  })];
  let raw: unknown;
  try { raw = await api.get('/config/routing'); }
  catch (error) {
    if (!String(error).includes('Management API error (404): not_found')) throw error;
    raw = {};
  }
  if (!isRecord(raw)) throw new Error(message('invalid'));
  const retry = isRecord(raw.retry) ? raw.retry : {};
  const cooldown = isRecord(raw.cooldown) ? raw.cooldown : {};
  const strategy = raw.strategy;
  const settings: RoutingSettings = {
    strategy: strategy === 'fill-first' || strategy === 'weighted-round-robin' ? strategy : 'round-robin',
    session_affinity: raw['session-affinity'] === true, session_affinity_ttl: readString(raw, 'session-affinity-ttl'),
    request_retry: number(retry['request-retry']), max_retry_credentials: number(retry['max-retry-credentials']),
    max_retry_interval: number(retry['max-retry-interval']), disable_cooling: cooldown['disable-cooling'] === true,
    transient_error_cooldown_seconds: number(cooldown['transient-error-cooldown-seconds']),
  };
  partial.sort();
  const sealed = canonical({ groups, raw, members, partial });
  const revision = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sealed))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { revision, members, settings, groups, partial };
}

export function validateRoutingPlan(board: RoutingBoard, plan: RoutingPlan) {
  if (board.partial.length) throw new Error(message('partial'));
  if (board.revision !== plan.revision) throw new Error(message('conflict'));
  if (plan.members.length !== board.members.length || new Set(plan.members.map(member => member.key)).size !== board.members.length) throw new Error(message('invalid'));
  for (const member of plan.members) {
    const original = board.members.find(item => item.key === member.key);
    if (!original || !Number.isSafeInteger(member.priority) || member.priority < -2147483648 || member.priority > 2147483647
      || member.weights.length !== original.weights.length
      || member.weights.some(value => value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000))
      || (original.runtimeOnly && (member.priority !== original.priority || canonical(member.weights) !== canonical(original.weights)))) throw new Error(message('invalid'));
  }
  if (!['round-robin', 'weighted-round-robin', 'fill-first'].includes(plan.settings.strategy)
    || typeof plan.settings.session_affinity !== 'boolean' || typeof plan.settings.disable_cooling !== 'boolean'
    || typeof plan.settings.session_affinity_ttl !== 'string'
    || (plan.settings.session_affinity_ttl !== '' && !/^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(plan.settings.session_affinity_ttl))) throw new Error(message('invalid'));
  for (const key of ['request_retry', 'max_retry_credentials', 'max_retry_interval', 'transient_error_cooldown_seconds'] as const) {
    if (!Number.isSafeInteger(plan.settings[key]) || plan.settings[key] < (key === 'transient_error_cooldown_seconds' ? -1 : 0) || plan.settings[key] > 2147483647) throw new Error(message('invalid'));
  }
}

export async function applyRoutingPlan(plan: RoutingPlan, api: RoutingApi = managementApi): Promise<RoutingBoard> {
  const current = await readRoutingBoard(api);
  validateRoutingPlan(current, plan);
  const groups = structuredClone(current.groups);
  const changedFamilies = new Set<string>();
  const writes: (() => Promise<unknown>)[] = [];
  for (const original of current.members) {
    const edited = plan.members.find(member => member.key === original.key)!;
    if (original.priority === edited.priority && canonical(original.weights) === canonical(edited.weights)) continue;
    if (original.credentialName) {
      const fields: Record<string, ManagementJson> = { name: original.credentialName };
      if (original.priority !== edited.priority) fields.priority = edited.priority;
      if (original.weights[0] !== edited.weights[0]) fields.weight = edited.weights[0];
      writes.push(() => api.patch('/credentials/fields', fields));
    } else {
      const group = groups[original.family][original.groupIndex!];
      const keys = Array.isArray(group.keys) ? group.keys.filter(isRecord) : [];
      const target = original.keyIndex === undefined ? group : keys[original.keyIndex];
      if (original.priority !== edited.priority) target.priority = edited.priority;
      edited.weights.forEach((value, index) => {
        if (value === original.weights[index]) return;
        const key = original.keyIndex === undefined ? keys[index] ?? target : target;
        if (value === null) delete key.weight; else key.weight = value;
      });
      changedFamilies.add(original.family);
    }
  }
  for (const family of changedFamilies) writes.push(() => api.put(`/config/api-keys/${family}`, groups[family].map(cleanProviderGroup) as ManagementJson));
  for (const key of Object.keys(routingSettingPaths) as (keyof RoutingSettings)[]) {
    if (plan.settings[key] !== current.settings[key]) writes.push(() => api.put(`/config/routing/${routingSettingPaths[key]}`, plan.settings[key]));
  }
  try { for (const write of writes) await write(); }
  catch (error) { throw new Error(`${message('writeFailed')} ${String(error)}`); }
  return readRoutingBoard(api);
}
