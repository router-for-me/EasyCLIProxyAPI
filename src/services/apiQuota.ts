import {
  apiCallErrorMessage,
  isRecord,
  managementApi,
  readBoolean,
  readString,
  responseList,
} from './managementApi';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentLocale, translate } from '../i18n';
import type { QuotaAmount, QuotaRow, QuotaState } from './quotaService';
import { API_QUOTA_CACHE_PREFIX } from './quotaCache';

export type ApiQuotaProtocol =
  | 'codex-api-key'
  | 'openai-compatibility'
  | 'claude-api-key'
  | 'gemini-api-key';

export type ApiQuotaVendor = 'deepseek' | 'stepfun' | 'siliconflow' | 'openrouter' | 'novita';

export type ApiQuotaAdapter = Readonly<{
  vendor: ApiQuotaVendor;
  hostname: string;
  endpoint: string;
  unit: string;
}>;

export type ApiQuotaSource = {
  id: string;
  protocol: ApiQuotaProtocol;
  recordIndex: number;
  entryIndex: number;
  entryCount: number;
  recordName: string;
  recordApiKeys?: string[];
  recordOrdinal: number;
  recordCount: number;
  baseUrl: string;
  balanceUrl: string;
  authIndex: string;
  apiKey: string;
  adapter: ApiQuotaAdapter | null;
  configurationError?: string;
  label: string;
  disabled: boolean;
};

export type ApiQuotaDiscovery = {
  sources: ApiQuotaSource[];
  failedProtocols: ApiQuotaProtocol[];
};

export type ApiAccessRecordIdentity = {
  providerSection: ApiQuotaProtocol;
  recordName: string;
  baseUrl: string;
  apiKeys: string[];
};

type ApiQuotaSectionDefinition = {
  protocol: ApiQuotaProtocol;
  responseKey: string;
};

const apiQuotaSections: ApiQuotaSectionDefinition[] = [
  { protocol: 'codex-api-key', responseKey: 'codex-api-key' },
  { protocol: 'openai-compatibility', responseKey: 'openai-compatibility' },
  { protocol: 'claude-api-key', responseKey: 'claude-api-key' },
  { protocol: 'gemini-api-key', responseKey: 'gemini-api-key' },
];

const adaptersByHostname: Record<string, ApiQuotaAdapter> = {
  'api.deepseek.com': {
    vendor: 'deepseek',
    hostname: 'api.deepseek.com',
    endpoint: 'https://api.deepseek.com/user/balance',
    unit: 'CNY',
  },
  'api.stepfun.ai': {
    vendor: 'stepfun',
    hostname: 'api.stepfun.ai',
    endpoint: 'https://api.stepfun.com/v1/accounts',
    unit: 'CNY',
  },
  'api.stepfun.com': {
    vendor: 'stepfun',
    hostname: 'api.stepfun.com',
    endpoint: 'https://api.stepfun.com/v1/accounts',
    unit: 'CNY',
  },
  'api.siliconflow.cn': {
    vendor: 'siliconflow',
    hostname: 'api.siliconflow.cn',
    endpoint: 'https://api.siliconflow.cn/v1/user/info',
    unit: 'CNY',
  },
  'api.siliconflow.com': {
    vendor: 'siliconflow',
    hostname: 'api.siliconflow.com',
    endpoint: 'https://api.siliconflow.com/v1/user/info',
    unit: 'USD',
  },
  'openrouter.ai': {
    vendor: 'openrouter',
    hostname: 'openrouter.ai',
    endpoint: 'https://openrouter.ai/api/v1/credits',
    unit: 'USD',
  },
  'api.novita.ai': {
    vendor: 'novita',
    hostname: 'api.novita.ai',
    endpoint: 'https://api.novita.ai/v3/user/balance',
    unit: 'USD',
  },
};

const vendorLabelKeys: Record<ApiQuotaVendor, Parameters<typeof translate>[1]> = {
  deepseek: 'quota.api.provider.deepseek',
  stepfun: 'quota.api.provider.stepfun',
  siliconflow: 'quota.api.provider.siliconflow',
  openrouter: 'quota.api.provider.openrouter',
  novita: 'quota.api.provider.novita',
};

const protocolLabelKeys: Record<ApiQuotaProtocol, Parameters<typeof translate>[1]> = {
  'codex-api-key': 'quota.api.protocol.codex',
  'openai-compatibility': 'quota.api.protocol.openaiCompatibility',
  'claude-api-key': 'quota.api.protocol.claude',
  'gemini-api-key': 'quota.api.protocol.gemini',
};

const apiQuotaText = (
  key: Parameters<typeof translate>[1],
  variables?: Parameters<typeof translate>[2],
) => translate(getCurrentLocale(), key, variables);

export const apiQuotaVendorLabel = (vendor: ApiQuotaVendor) =>
  apiQuotaText(vendorLabelKeys[vendor]);

export const apiQuotaProtocolLabel = (protocol: ApiQuotaProtocol) =>
  apiQuotaText(protocolLabelKeys[protocol]);

export const apiQuotaAdapterFor = (baseUrl: string): ApiQuotaAdapter | null => {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return adaptersByHostname[parsed.hostname.toLowerCase()] ?? null;
  } catch {
    return null;
  }
};

const isLoopbackHostname = (hostname: string) => {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
};

const parseSafeBalanceUrl = (value: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(apiQuotaText('quota.api.balanceUrl.invalid'));
  }
  if (parsed.username || parsed.password) {
    throw new Error(apiQuotaText('quota.api.balanceUrl.credentials'));
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(apiQuotaText('quota.api.balanceUrl.httpsRequired'));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(apiQuotaText('quota.api.balanceUrl.invalid'));
  }
  parsed.hash = '';
  return parsed;
};

export const safeBalanceUrlValue = (value: string): string => {
  if (!value.trim()) return '';
  return parseSafeBalanceUrl(value).toString();
};

export const resolveApiQuotaAdapter = (
  baseUrl: string,
  balanceUrl: string,
): { adapter: ApiQuotaAdapter | null; value: string; error?: string } => {
  const inferenceAdapter = apiQuotaAdapterFor(baseUrl);
  if (!balanceUrl.trim()) return { adapter: inferenceAdapter, value: '' };
  try {
    const parsed = parseSafeBalanceUrl(balanceUrl);
    const value = parsed.toString();
    const configuredAdapter = apiQuotaAdapterFor(value);
    if (inferenceAdapter && configuredAdapter && inferenceAdapter.vendor !== configuredAdapter.vendor) {
      return { adapter: null, value, error: apiQuotaText('quota.api.balanceUrl.conflict') };
    }
    if (!configuredAdapter && (!inferenceAdapter || !isLoopbackHostname(parsed.hostname))) {
      return { adapter: null, value, error: apiQuotaText('quota.api.balanceUrl.unsupported') };
    }
    const selected = configuredAdapter ?? inferenceAdapter;
    return {
      adapter: selected ? { ...selected, endpoint: value } : null,
      value,
    };
  } catch (error) {
    return { adapter: null, value: balanceUrl.trim(), error: error instanceof Error ? error.message : String(error) };
  }
};

export const validateBalanceUrl = (balanceUrl: string, baseUrl: string): string => {
  const resolved = resolveApiQuotaAdapter(baseUrl, balanceUrl);
  if (resolved.error) throw new Error(resolved.error);
  return resolved.value;
};

export const detectApiQuotaVendor = (baseUrl: string): ApiQuotaVendor | null =>
  apiQuotaAdapterFor(baseUrl)?.vendor ?? null;

export const apiQuotaEndpointFor = (baseUrl: string): string | null =>
  apiQuotaAdapterFor(baseUrl)?.endpoint ?? null;

const numberValue = (value: unknown): number | null => {
  if (isRecord(value) && 'val' in value) return numberValue(value.val);
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseBody = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const monetaryRow = (
  label: string,
  amount: QuotaAmount,
  detail?: string,
): QuotaRow => ({
  label,
  remainingPercent: null,
  amount,
  detail,
});

const parseDeepSeekBalance = (payload: unknown): QuotaRow[] => {
  const value = parseBody(payload);
  if (!isRecord(value) || !Array.isArray(value.balance_infos)) return [];
  const available = value.is_available !== false;
  return value.balance_infos.filter(isRecord).flatMap((info) => {
    const remaining = numberValue(info.total_balance);
    if (remaining === null) return [];
    const currency = readString(info, 'currency') || 'CNY';
    return [monetaryRow(
      `${apiQuotaVendorLabel('deepseek')} · ${currency}`,
      { remaining, used: null, total: null, unit: currency },
      available ? undefined : apiQuotaText('quota.api.balanceUnavailable'),
    )];
  });
};

const parseStepFunBalance = (payload: unknown): QuotaRow[] => {
  const value = parseBody(payload);
  if (!isRecord(value)) return [];
  const remaining = numberValue(value.balance);
  return remaining === null
    ? []
    : [monetaryRow(apiQuotaVendorLabel('stepfun'), {
      remaining,
      used: null,
      total: null,
      unit: 'CNY',
    })];
};

const parseSiliconFlowBalance = (payload: unknown, adapter: ApiQuotaAdapter): QuotaRow[] => {
  const value = parseBody(payload);
  if (!isRecord(value) || !isRecord(value.data)) return [];
  const remaining = numberValue(value.data.totalBalance) ?? numberValue(value.data.balance);
  return remaining === null
    ? []
    : [monetaryRow(apiQuotaVendorLabel('siliconflow'), {
      remaining,
      used: null,
      total: null,
      unit: adapter.unit,
    })];
};

const parseOpenRouterBalance = (payload: unknown): QuotaRow[] => {
  const value = parseBody(payload);
  if (!isRecord(value)) return [];
  const data = isRecord(value.data) ? value.data : value;
  const total = numberValue(data.total_credits);
  const used = numberValue(data.total_usage);
  const remaining = total === null || used === null ? null : total - used;
  if (remaining === null && total === null && used === null) return [];
  return [monetaryRow(apiQuotaVendorLabel('openrouter'), {
    remaining,
    used,
    total,
    unit: 'USD',
  })];
};

const parseNovitaBalance = (payload: unknown): QuotaRow[] => {
  const value = parseBody(payload);
  if (!isRecord(value)) return [];
  const available = numberValue(value.availableBalance);
  if (available === null) return [];
  return [monetaryRow(apiQuotaVendorLabel('novita'), {
    remaining: available / 10_000,
    used: null,
    total: null,
    unit: 'USD',
  })];
};

export const parseDeepSeekQuota = parseDeepSeekBalance;
export const parseStepFunQuota = parseStepFunBalance;
export const parseSiliconFlowQuota = parseSiliconFlowBalance;
export const parseOpenRouterQuota = parseOpenRouterBalance;
export const parseNovitaQuota = parseNovitaBalance;

export const parseApiQuotaResponse = (
  adapter: ApiQuotaAdapter,
  payload: unknown,
): QuotaRow[] => {
  switch (adapter.vendor) {
    case 'deepseek': return parseDeepSeekBalance(payload);
    case 'stepfun': return parseStepFunBalance(payload);
    case 'siliconflow': return parseSiliconFlowBalance(payload, adapter);
    case 'openrouter': return parseOpenRouterBalance(payload);
    case 'novita': return parseNovitaBalance(payload);
    default: return [];
  }
};

const hashIdentity = (value: string): string => {
  let hash = 2166136261;
  let secondary = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
    secondary ^= value.charCodeAt(index) + index;
    secondary = Math.imul(secondary, 2246822519);
  }
  return `${(hash >>> 0).toString(36)}-${(secondary >>> 0).toString(36)}`;
};

const sourceIdFor = (
  protocol: ApiQuotaProtocol,
  record: Record<string, unknown>,
  recordIndex: number,
  entryIndex: number,
  baseUrl: string,
  authIndex: string,
  apiKey: string,
) => {
  const name = readString(record, 'name');
  const identity = `${protocol}\u0000${name}\u0000${baseUrl}\u0000record:${recordIndex}\u0000entry:${entryIndex}${authIndex ? `\u0000auth:${authIndex}` : `\u0000key:${apiKey}`}`;
  return hashIdentity(identity);
};

const safeRecordNameLabel = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return parsed.hostname.toLowerCase();
    return parsed.hostname.toLowerCase() || trimmed;
  } catch {
    return trimmed;
  }
};

const sourceLabelFor = (
  source: Pick<ApiQuotaSource, 'adapter' | 'entryIndex' | 'entryCount' | 'recordName' | 'recordOrdinal' | 'recordCount' | 'baseUrl' | 'protocol'>,
) => {
  const entryOrdinal = source.entryCount > 1 ? source.entryIndex + 1 : null;
  const safeRecordName = safeRecordNameLabel(source.recordName);
  const recordLabel = safeRecordName && source.recordCount > 1
    ? apiQuotaText('quota.api.namedRecordOrdinalLabel', {
      name: safeRecordName,
      index: source.recordOrdinal,
    })
    : safeRecordName;
  const ordinal = entryOrdinal ?? (source.recordCount > 1 ? source.recordOrdinal : null);
  if (recordLabel) {
    return entryOrdinal === null
      ? recordLabel
      : apiQuotaText('quota.api.namedCredentialLabel', {
        name: recordLabel,
        index: entryOrdinal,
      });
  }
  if (source.adapter) {
    return ordinal === null
      ? apiQuotaVendorLabel(source.adapter.vendor)
      : apiQuotaText('quota.api.credentialLabel', {
        provider: apiQuotaVendorLabel(source.adapter.vendor),
        index: ordinal,
      });
  }
  const safeHost = safeApiQuotaHostname(source.baseUrl);
  const fallback = safeHost || apiQuotaProtocolLabel(source.protocol);
  return ordinal === null
    ? apiQuotaText('quota.api.unsupportedHostLabel', { host: fallback })
    : apiQuotaText('quota.api.unsupportedCredentialOrdinal', { host: fallback, index: ordinal });
};

export const safeApiQuotaHostname = (baseUrl: string): string => {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    return parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
};

export const apiQuotaSourceLabel = (source: Pick<ApiQuotaSource, 'adapter' | 'entryIndex' | 'entryCount' | 'recordName' | 'recordOrdinal' | 'recordCount' | 'baseUrl' | 'protocol'>) =>
  sourceLabelFor(source);

/*
 * API sources are queryable only when they map to a supported adapter and are enabled.
 */
export const isApiQuotaSourceQueryable = (source: Pick<ApiQuotaSource, 'adapter' | 'disabled' | 'configurationError'>) =>
  Boolean(source.adapter) && !source.configurationError && !source.disabled;

export const isApiQuotaSourceUnsupported = (source: Pick<ApiQuotaSource, 'adapter' | 'configurationError'>) =>
  !source.adapter || Boolean(source.configurationError);

export const countApiQuotaCards = (sources: Pick<ApiQuotaSource, 'adapter' | 'configurationError'>[]) =>
  sources.length;

export const countApiQuotaUnsupported = (sources: Pick<ApiQuotaSource, 'adapter' | 'configurationError'>[]) =>
  sources.filter(isApiQuotaSourceUnsupported).length;

export const countApiQuotaSources = (sources: Pick<ApiQuotaSource, 'adapter' | 'disabled' | 'configurationError'>[]) =>
  sources.filter(isApiQuotaSourceQueryable).length;

const recordsForEntry = (
  protocol: ApiQuotaProtocol,
  record: Record<string, unknown>,
): Record<string, unknown>[] => {
  if (protocol !== 'openai-compatibility') return [record];
  const entries = Array.isArray(record['api-key-entries'])
    ? record['api-key-entries'].filter(isRecord)
    : [];
  return entries.length > 0 ? entries : [record];
};

export const flattenApiQuotaRecords = (
  protocol: ApiQuotaProtocol,
  records: Record<string, unknown>[],
): ApiQuotaSource[] => {
  const recordNames = records.map((record) => readString(record, 'name'));
  const recordNameCounts = new Map<string, number>();
  recordNames.forEach((name) => recordNameCounts.set(name, (recordNameCounts.get(name) ?? 0) + 1));
  return records.flatMap((record, recordIndex) => (
  recordsForEntry(protocol, record).map((entry, entryIndex, entries) => {
    const baseUrl = readString(entry, 'base-url', 'baseUrl')
      || readString(record, 'base-url', 'baseUrl');
    const authIndex = readString(entry, 'auth-index', 'authIndex', 'auth_index')
      || readString(record, 'auth-index', 'authIndex', 'auth_index');
    const apiKey = readString(entry, 'api-key', 'apiKey')
      || (entry === record ? readString(record, 'api-key', 'apiKey') : '');
    const recordApiKeys = protocol === 'openai-compatibility'
      ? recordsForEntry(protocol, record).map((item) => readString(item, 'api-key', 'apiKey')).filter(Boolean)
      : [readString(record, 'api-key', 'apiKey')].filter(Boolean);
    const resolvedAdapter = resolveApiQuotaAdapter(baseUrl, '');
    const adapter = resolvedAdapter.adapter;
    const recordName = readString(record, 'name');
    const recordCount = recordName ? recordNameCounts.get(recordName) ?? 1 : 1;
    const recordOrdinal = recordCount > 1
      ? records.slice(0, recordIndex + 1).filter((item) => readString(item, 'name') === recordName).length
      : recordIndex + 1;
    const disabled = readBoolean(entry, 'disabled')
      || readBoolean(record, 'disabled')
      || (Array.isArray(record['excluded-models'])
        && record['excluded-models'].some((item) => String(item).trim() === '*'));
    const source: ApiQuotaSource = {
      id: sourceIdFor(protocol, record, recordIndex, entryIndex, baseUrl, authIndex, apiKey),
      protocol,
      recordIndex,
      entryIndex,
      entryCount: entries.length,
      recordName,
      recordApiKeys,
      recordOrdinal,
      recordCount,
      baseUrl,
      balanceUrl: resolvedAdapter.value,
      authIndex,
      apiKey,
      adapter,
      configurationError: resolvedAdapter.error,
      label: '',
      disabled,
    };
    source.label = sourceLabelFor(source);
    return source;
  })
  ));
};

export const apiQuotaCacheKey = (source: Pick<ApiQuotaSource, 'id'>) =>
  `${API_QUOTA_CACHE_PREFIX}${source.id}`;

export const apiAccessRecordIdentityFor = (
  source: Pick<ApiQuotaSource, 'protocol' | 'recordName' | 'baseUrl' | 'recordApiKeys'>,
): ApiAccessRecordIdentity => ({
  providerSection: source.protocol,
  recordName: source.recordName,
  baseUrl: source.baseUrl,
  apiKeys: [...(source.recordApiKeys ?? [])],
});

export const apiAccessRecordIdentityKey = (identity: ApiAccessRecordIdentity): string => JSON.stringify([
  identity.providerSection,
  identity.recordName,
  identity.baseUrl,
  [...identity.apiKeys].sort(),
]);

export const apiAccessRecordIdentityFromRecord = (
  protocol: ApiQuotaProtocol,
  record: Record<string, unknown>,
): ApiAccessRecordIdentity => ({
  providerSection: protocol,
  recordName: readString(record, 'name'),
  baseUrl: readString(record, 'base-url', 'baseUrl'),
  apiKeys: protocol === 'openai-compatibility'
    ? (Array.isArray(record['api-key-entries']) ? record['api-key-entries'].filter(isRecord).map((entry) => readString(entry, 'api-key', 'apiKey')).filter(Boolean) : [])
    : [readString(record, 'api-key', 'apiKey')].filter(Boolean),
});

export const resolveApiAccessBalanceUrls = async (
  queries: ApiAccessRecordIdentity[],
): Promise<Array<string | null>> => invoke<Array<string | null>>('resolve_api_access_balance_urls', { queries });

export const saveApiAccessBalanceEndpoint = async (
  previousIdentity: ApiAccessRecordIdentity | null,
  nextIdentity: ApiAccessRecordIdentity | null,
  balanceUrl: string,
): Promise<void> => {
  await invoke('save_api_access_balance_endpoint', {
    update: { previousIdentity, nextIdentity, balanceUrl },
  });
};

export const apiQuotaSourcesFromRecords = (
  recordsByProtocol: Partial<Record<ApiQuotaProtocol, Record<string, unknown>[]>>,
): ApiQuotaDiscovery => {
  const sources: ApiQuotaSource[] = [];
  apiQuotaSections.forEach((definition) => {
    sources.push(...flattenApiQuotaRecords(
      definition.protocol,
      recordsByProtocol[definition.protocol] ?? [],
    ));
  });
  return { sources, failedProtocols: [] };
};

export const apiQuotaSourcesFromConfig = (config: unknown): ApiQuotaDiscovery => {
  const records = Object.fromEntries(apiQuotaSections.map((definition) => [
    definition.protocol,
    responseList(config, definition.responseKey),
  ])) as Partial<Record<ApiQuotaProtocol, Record<string, unknown>[]>>;
  return apiQuotaSourcesFromRecords(records);
};

export async function loadApiAccessRecords(
  get: (path: string) => Promise<unknown> = managementApi.get,
): Promise<Record<ApiQuotaProtocol, Record<string, unknown>[]>> {
  await get('/config');
  const records = {} as Record<ApiQuotaProtocol, Record<string, unknown>[]>;
  for (const definition of apiQuotaSections) {
    const response = await get(`/${definition.protocol}`);
    records[definition.protocol] = Array.isArray(response)
      ? response.filter(isRecord)
      : responseList(response, definition.responseKey);
  }
  return records;
}

export async function discoverApiQuotaSources(
  get: (path: string) => Promise<unknown> = managementApi.get,
  resolveBalanceUrls: (queries: ApiAccessRecordIdentity[]) => Promise<Array<string | null>> = resolveApiAccessBalanceUrls,
): Promise<ApiQuotaDiscovery> {
  const records = await loadApiAccessRecords(get);
  const discovery = apiQuotaSourcesFromRecords(records);
  const balanceUrls = discovery.sources.length > 0
    ? await resolveBalanceUrls(discovery.sources.map(apiAccessRecordIdentityFor))
    : [];
  return {
    ...discovery,
    sources: discovery.sources.map((source, index) => {
      const balanceUrl = balanceUrls[index] ?? '';
      const resolvedAdapter = resolveApiQuotaAdapter(source.baseUrl, balanceUrl);
      return {
        ...source,
        balanceUrl: resolvedAdapter.value,
        adapter: resolvedAdapter.adapter,
        configurationError: resolvedAdapter.error,
      };
    }),
  };
}

export async function loadQuotaSourceStages(
  loadApiSources: () => Promise<ApiQuotaDiscovery>,
  loadOAuthSources: () => Promise<void>,
  onApiSources?: (discovery: ApiQuotaDiscovery) => void | Promise<void>,
): Promise<ApiQuotaDiscovery> {
  const apiSources = await loadApiSources();
  await onApiSources?.(apiSources);
  await loadOAuthSources();
  return apiSources;
}

export const saveApiQuotaBalanceUrl = async (
  source: Pick<ApiQuotaSource, 'protocol' | 'recordName' | 'baseUrl' | 'recordApiKeys'>,
  balanceUrl: string,
  saveBalanceEndpoint: typeof saveApiAccessBalanceEndpoint = saveApiAccessBalanceEndpoint,
): Promise<string> => {
  const normalizedBalanceUrl = validateBalanceUrl(balanceUrl, source.baseUrl);
  await saveBalanceEndpoint(
    apiAccessRecordIdentityFor(source),
    apiAccessRecordIdentityFor(source),
    normalizedBalanceUrl,
  );
  return normalizedBalanceUrl;
};

const redactedError = (error: unknown, secret: string) => {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedSecret = secret.trim();
  return normalizedSecret ? message.split(normalizedSecret).join('[redacted]') : message;
};

const requestApiQuotaPayload = async (source: ApiQuotaSource): Promise<unknown> => {
  if (!source.adapter) throw new Error(apiQuotaText('quota.api.unsupported'));
  if (!source.authIndex && !source.apiKey.trim()) {
    throw new Error(apiQuotaText('quota.api.missingCredential'));
  }
  const token = source.authIndex ? '$TOKEN$' : source.apiKey.trim();
  const response = await managementApi.post<Record<string, unknown>>('/api-call', {
    authIndex: source.authIndex || undefined,
    method: 'GET',
    url: source.adapter.endpoint,
    header: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  }, { timeoutMs: 15_000 });
  const status = Number(response.status_code ?? response.statusCode ?? 0);
  if (status < 200 || status >= 300) {
    throw new Error(apiCallErrorMessage(response));
  }
  return parseBody(response.body ?? response.bodyText);
};

export const queryApiQuotaSource = async (source: ApiQuotaSource): Promise<QuotaState> => {
  if (source.disabled) return { status: 'idle', rows: [] };
  if (source.configurationError) {
    return { status: 'error', rows: [], error: source.configurationError };
  }
  if (!source.adapter) {
    return { status: 'error', rows: [], error: apiQuotaText('quota.api.unsupported') };
  }
  try {
    const rows = parseApiQuotaResponse(
      source.adapter,
      await requestApiQuotaPayload(source),
    );
    if (rows.length === 0) throw new Error(apiQuotaText('quota.api.unrecognizedResponse'));
    return {
      status: 'success',
      rows,
      plan: apiQuotaVendorLabel(source.adapter.vendor),
      fetchedAt: Date.now(),
    };
  } catch (error) {
    return {
      status: 'error',
      rows: [],
      error: redactedError(error, source.apiKey),
      fetchedAt: Date.now(),
    };
  }
};
