import { captureQuotaCacheGeneration } from './quotaCache';
import {
  apiCallErrorMessage,
  isRecord,
  managementApi,
  normalizeAuthIndex,
  readString,
} from './managementApi';
import { providerKeyIsDisabled } from './providerGroups';
import { getCurrentLocale, translate, type AppLocale } from '../i18n';

type AuthFile = Record<string, unknown>;
type QuotaRow = {
  label: string;
  remainingPercent: number | null;
  resetAtMs?: number;
  detail?: string;
};

// Hosts a z.ai Coding Plan account is served from. The same key is rejected by
// the other host, so the quota monitor uses the credential base URL's host.
// dev.bigmodel.cn is recognized the same way credential resolution does.
const ZAI_HOSTS = new Set(['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn']);

export const ZAI_CODING_PLAN_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
export const ZAI_CODING_PLAN_BASE_URL_CN = 'https://open.bigmodel.cn/api/coding/paas/v4';
const ZAI_DEFAULT_ORIGIN = 'https://api.z.ai';
const ZAI_QUOTA_PATH = '/api/monitor/usage/quota/limit';
const ZAI_SUBSCRIPTION_PATH = '/api/biz/subscription/list';

const zaiText = (
  key: Parameters<typeof translate>[1],
  variables?: Parameters<typeof translate>[2],
  locale: AppLocale = getCurrentLocale(),
) => translate(locale, key, variables);

const aliases = new Set([
  'zai', 'z-ai', 'z.ai', 'zhipu', 'zhipuai', 'glm', 'bigmodel', 'glm-cn',
  'openai-compatible-zai', 'openai-compatible-z.ai', 'openai-compatible-zhipu',
  'openai-compatible-zhipuai', 'openai-compatible-glm', 'openai-compatible-bigmodel',
  'openai-compatible-glm-cn',
]);

export const isZaiProviderAlias = (value: string): boolean => aliases.has(value);

/** Coding-plan monitor origin for a base URL, or null when the host is not a z.ai plan host. */
export function zaiMonitorOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!ZAI_HOSTS.has(url.hostname.toLowerCase())) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export const isZaiCodingPlanRecord = (record: Record<string, unknown>): boolean => {
  if (zaiMonitorOrigin(readString(record, 'base-url', 'baseUrl', 'base_url'))) return true;
  const keys = [
    ...(Array.isArray(record.keys) ? record.keys : []),
    ...(Array.isArray(record['api-key-entries']) ? record['api-key-entries'] : []),
  ];
  return keys.some((key) => isRecord(key) && Boolean(zaiMonitorOrigin(readString(key, 'base-url', 'baseUrl', 'base_url'))));
};

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const integerCode = (value: unknown): number | null => {
  const parsed = finiteNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
};

const parseBody = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const envelope = (payload: unknown): Record<string, unknown> | null => {
  const parsed = parseBody(payload);
  return isRecord(parsed) ? parsed : null;
};

const quotaData = (payload: unknown): Record<string, unknown> | null => {
  const body = envelope(payload);
  if (!body) return null;
  if (isRecord(body.data)) return body.data;
  return Array.isArray(body.limits) ? body : null;
};

const quotaSucceeded = (payload: unknown): boolean => {
  const body = envelope(payload);
  if (!body) return false;
  if (!('success' in body) && !('code' in body) && quotaData(payload)) return true;
  return body.success === true && integerCode(body.code) === 200;
};

const failureMessage = (payload: unknown, locale: AppLocale = getCurrentLocale()): string => {
  const body = envelope(payload);
  const message = body ? readString(body, 'msg', 'message') : '';
  return message || zaiText('quota.service.zai.invalidResponse', undefined, locale);
};

// unit 3 is hours and unit 6 is weeks. The weekly row arrives with number 1 or 7,
// and a team account's five-hour row can carry number 0 or no number at all, so
// the unit fixes the window length and the number only refines an hour count.
const windowSeconds = (unit: number | null, number: number | null): number | null => {
  if (unit === 3) return (number !== null && number > 0 ? number : 5) * 3_600;
  if (unit === 6) return 604_800;
  return null;
};

const countText = (value: number): string => Number.isInteger(value) ? String(value) : String(value);

const usageDetail = (limit: Record<string, unknown>): string => {
  if (!Array.isArray(limit.usageDetails)) return '';
  return limit.usageDetails.flatMap((item) => {
    if (!isRecord(item)) return [];
    const name = readString(item, 'modelCode', 'model_code', 'model');
    const usage = finiteNumber(item.usage);
    return name && usage !== null ? [`${name} ${countText(usage)}`] : [];
  }).slice(0, 6).join(', ');
};

export function zaiQuotaRows(payload: unknown, locale: AppLocale = getCurrentLocale()): QuotaRow[] {
  const data = quotaData(payload);
  const limits = data && Array.isArray(data.limits) ? data.limits : [];
  const indexed = limits.flatMap((item, index) => isRecord(item) ? [{ item, index }] : []);
  indexed.sort((left, right) => {
    const leftSeconds = windowSeconds(integerCode(left.item.unit), finiteNumber(left.item.number));
    const rightSeconds = windowSeconds(integerCode(right.item.unit), finiteNumber(right.item.number));
    if (leftSeconds === null || rightSeconds === null) {
      if (leftSeconds !== rightSeconds) return leftSeconds === null ? 1 : -1;
    } else if (leftSeconds !== rightSeconds) return leftSeconds - rightSeconds;
    const leftReset = finiteNumber(left.item.nextResetTime) ?? 0;
    const rightReset = finiteNumber(right.item.nextResetTime) ?? 0;
    return leftReset - rightReset || left.index - right.index;
  });
  const text = (
    key: Parameters<typeof translate>[1],
    variables?: Parameters<typeof translate>[2],
  ) => zaiText(key, variables, locale);
  return indexed.flatMap(({ item, index }): QuotaRow[] => {
    const allowance = finiteNumber(item.usage);
    const consumed = finiteNumber(item.currentValue);
    const remaining = finiteNumber(item.remaining);
    const used = finiteNumber(item.percentage);
    const counted = allowance !== null && allowance > 0 && (remaining !== null || consumed !== null);
    const remainingPercent = counted
      ? Math.max(0, Math.min(100, ((remaining ?? Math.max(0, allowance - (consumed ?? 0))) / allowance) * 100))
      : used === null ? null : Math.max(0, Math.min(100, 100 - Math.max(0, Math.min(100, used))));
    if (remainingPercent === null && allowance === null) return [];
    const type = readString(item, 'type').toUpperCase();
    const unit = integerCode(item.unit);
    const number = finiteNumber(item.number);
    const seconds = windowSeconds(unit, number);
    const duration = seconds === null ? ''
      : seconds % 604_800 === 0
        ? text('quota.service.duration.days', { count: seconds / 86_400 })
        : seconds % 3_600 === 0
          ? text('quota.service.duration.hours', { count: seconds / 3_600 })
          : '';
    const label = type === 'TIME_LIMIT'
      ? text('quota.service.zai.mcp')
      : unit === 3
        ? text('quota.service.limit.fiveHours')
        : unit === 6
          ? text('quota.service.weekly')
          : duration
            ? text('quota.service.limit.duration', { duration })
            : text('quota.service.limit.numbered', { index: index + 1 });
    const resetAtMs = finiteNumber(item.nextResetTime);
    const counts = allowance === null ? '' : `${countText(consumed ?? (remaining !== null ? allowance - remaining : 0))} / ${countText(allowance)}`;
    const tools = type === 'TIME_LIMIT' ? usageDetail(item) : '';
    const detail = [counts, tools].filter(Boolean).join(' · ') || undefined;
    return [{
      label,
      remainingPercent,
      ...(resetAtMs !== null && resetAtMs > 0 ? { resetAtMs } : {}),
      ...(detail ? { detail } : {}),
    }];
  });
}

export function zaiPlanFromPayloads(quotaPayload: unknown, subscriptionPayload: unknown): string | undefined {
  const subscription = envelope(subscriptionPayload);
  const entries = subscription && Array.isArray(subscription.data) ? subscription.data : [];
  const first = entries.find(isRecord);
  const product = first ? readString(first, 'productName', 'product_name') : '';
  if (product) return product;
  const level = readString(quotaData(quotaPayload) ?? {}, 'level');
  return level || undefined;
}

const requestJson = async (authIndex: string, url: string): Promise<unknown> => {
  const response = await managementApi.post<Record<string, unknown>>('/requests/api-call', {
    authIndex,
    method: 'GET',
    url,
    header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' },
  });
  const status = Number(response.status_code ?? response.statusCode ?? 0);
  if (status < 200 || status >= 300) throw new Error(apiCallErrorMessage(response));
  return parseBody(response.body ?? response.bodyText);
};

const assertCurrent = (generation: number, locale: AppLocale = getCurrentLocale()) => {
  if (captureQuotaCacheGeneration() !== generation) throw new Error(zaiText('quota.service.zai.staleRequest', undefined, locale));
};

async function resolveZaiOrigin(file: AuthFile, generation: number, locale: AppLocale = getCurrentLocale()): Promise<string> {
  const direct = zaiMonitorOrigin(readString(file, 'base_url', 'base-url', 'baseUrl'));
  if (direct) return direct;
  const runtimeOnly = [file.runtimeOnly, file.runtime_only].some((value) => value === true || value === 'true');
  const name = readString(file, 'name');
  if (!runtimeOnly && name) {
    try {
      const downloaded = parseBody(await managementApi.get('/credentials/download', { name }));
      assertCurrent(generation, locale);
      if (isRecord(downloaded)) {
        const origin = zaiMonitorOrigin(readString(downloaded, 'base_url', 'base-url', 'baseUrl'));
        if (origin) return origin;
      }
    } catch (error) {
      assertCurrent(generation, locale);
      if (error instanceof Error && error.message === zaiText('quota.service.zai.staleRequest', undefined, locale)) throw error;
    }
  }
  return ZAI_DEFAULT_ORIGIN;
}

export async function callZaiQuota(
  file: AuthFile,
  locale: AppLocale = getCurrentLocale(),
): Promise<{ payload: unknown; plan?: string }> {
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) throw new Error(zaiText('quota.service.error.missingAuthIndex', undefined, locale));
  const generation = captureQuotaCacheGeneration();
  const origin = await resolveZaiOrigin(file, generation, locale);
  assertCurrent(generation, locale);
  const payload = await requestJson(authIndex, `${origin}${ZAI_QUOTA_PATH}`);
  assertCurrent(generation, locale);
  if (!quotaSucceeded(payload)) throw new Error(zaiText('quota.service.zai.rejected', { message: failureMessage(payload, locale) }, locale));
  if (zaiQuotaRows(payload, locale).length === 0) throw new Error(zaiText('quota.service.zai.empty', undefined, locale));
  let plan = readString(quotaData(payload) ?? {}, 'level') || undefined;
  try {
    const subscription = await requestJson(authIndex, `${origin}${ZAI_SUBSCRIPTION_PATH}`);
    assertCurrent(generation, locale);
    if (quotaSucceeded(subscription)) plan = zaiPlanFromPayloads(payload, subscription) ?? plan;
  } catch (error) {
    assertCurrent(generation, locale);
    if (error instanceof Error && error.message === zaiText('quota.service.zai.staleRequest', undefined, locale)) throw error;
  }
  return { payload, plan };
}

const credentialKeys = (group: Record<string, unknown>): Record<string, unknown>[] => {
  if (Array.isArray(group.keys) && group.keys.some(isRecord)) return group.keys.filter(isRecord);
  if (Array.isArray(group['api-key-entries']) && group['api-key-entries'].some(isRecord)) {
    return group['api-key-entries'].filter(isRecord);
  }
  return [];
};

const CONFIG_FAMILIES = ['openai-compatibility', 'claude'] as const;

export function zaiCodingPlanFilesFromGroups(groupsByFamily: Record<string, unknown>): AuthFile[] {
  const files: AuthFile[] = [];
  for (const family of CONFIG_FAMILIES) {
    const groups = groupsByFamily[family];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || group.disabled === true) continue;
      const groupOrigin = zaiMonitorOrigin(readString(group, 'base-url', 'baseUrl', 'base_url'));
      const keys = credentialKeys(group);
      const entries = keys.length ? keys : [group];
      const matched = entries.flatMap((key) => {
        const keyBase = readString(key, 'base-url', 'baseUrl', 'base_url');
        const origin = keyBase ? zaiMonitorOrigin(keyBase) : groupOrigin;
        if (!origin) return [];
        if (key !== group && providerKeyIsDisabled(group, key)) return [];
        const authIndex = normalizeAuthIndex(key.auth_index ?? key.authIndex ?? key['auth-index']);
        return authIndex ? [{ origin, authIndex }] : [];
      });
      const groupName = readString(group, 'name') || 'z.ai';
      matched.forEach((entry, index) => {
        files.push({
          name: matched.length > 1 ? `${groupName} · ${index + 1}` : groupName,
          provider: 'zai',
          type: 'zai',
          auth_index: entry.authIndex,
          base_url: entry.origin,
          label: groupName,
          runtime_only: true,
          source: `config:${family}`,
        });
      });
    }
  }
  return files;
}

export async function loadZaiCodingPlanFiles(
  api: Pick<typeof managementApi, 'get'> = managementApi,
): Promise<AuthFile[]> {
  const groupsByFamily: Record<string, unknown> = {};
  await Promise.all(CONFIG_FAMILIES.map(async (family) => {
    try {
      groupsByFamily[family] = await api.get(`/config/api-keys/${family}`);
    } catch {
      groupsByFamily[family] = [];
    }
  }));
  return zaiCodingPlanFilesFromGroups(groupsByFamily);
}
