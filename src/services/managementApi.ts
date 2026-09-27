import { invoke } from '@tauri-apps/api/core';
import { getCurrentLocale, translate } from '../i18n';

export type ManagementJson = Record<string, unknown> | unknown[] | string | number | boolean | null;

type ManagementRequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: ManagementJson;
  timeoutMs?: number;
};

const PROVIDER_PATHS = {
  '/gemini-api-key': { provider: 'gemini', legacy: 'gemini-api-key' },
  '/interactions-api-key': { provider: 'interactions', legacy: 'interactions-api-key' },
  '/vertex-api-key': { provider: 'vertex', legacy: 'vertex-api-key' },
  '/codex-api-key': { provider: 'codex', legacy: 'codex-api-key' },
  '/claude-api-key': { provider: 'claude', legacy: 'claude-api-key' },
  '/xai-api-key': { provider: 'xai', legacy: 'xai-api-key' },
  '/meta-api-key': { provider: 'meta', legacy: 'meta-api-key' },
  '/openai-compatibility': { provider: 'openai-compatibility', legacy: 'openai-compatibility' },
} as const;

type ProviderPath = keyof typeof PROVIDER_PATHS;

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

const providerDefinition = (path: string) => PROVIDER_PATHS[path as ProviderPath];

async function optionalConfigValue(
  path: string, fallback: ManagementJson, options: ManagementRequestOptions,
): Promise<unknown> {
  try {
    return await invoke<unknown>('management_request', {
      request: { method: 'GET', path, query: normalizeQuery(options.query), timeoutMs: options.timeoutMs },
    });
  } catch (error) {
    // Only an absent v8 config node is optional, not an unavailable endpoint or server.
    const message = error instanceof Error ? error.message : error;
    if (message === 'Management API error (404): not_found') return fallback;
    throw error;
  }
}

export function flattenV8ProviderGroups(provider: string, payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isRecord).flatMap((group) => {
    const keys = Array.isArray(group.keys) ? group.keys.filter(isRecord) : [];
    if (provider === 'openai-compatibility') {
      const record: Record<string, unknown> = { ...group };
      delete record.keys;
      if (keys.length > 0) record['api-key-entries'] = keys.map((key) => ({ ...key }));
      return [record];
    }
    const shared = Object.fromEntries(
      Object.entries(group).filter(([key]) => key === 'base-url' || SHARED_PROVIDER_FIELDS.has(key)),
    );
    return keys.map((key) => {
      const overrides = Object.fromEntries(Object.entries(key).filter(([, value]) => value !== null));
      return { ...shared, ...overrides };
    });
  });
}

export function groupLegacyProviderRecords(provider: string, payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isRecord).map((record, index) => {
    if (provider === 'openai-compatibility') {
      const group: Record<string, unknown> = {
        ...record,
        keys: Array.isArray(record['api-key-entries'])
          ? record['api-key-entries'].filter(isRecord).map((key) => ({ ...key }))
          : [],
      };
      delete group['api-key-entries'];
      return group;
    }
    const group: Record<string, unknown> = { name: `${provider}-${index + 1}` };
    const key: Record<string, unknown> = {};
    Object.entries(record).forEach(([field, value]) => {
      if (field === 'base-url' || SHARED_PROVIDER_FIELDS.has(field)) group[field] = value;
      else key[field] = value;
    });
    group.keys = [key];
    return group;
  });
}

export function legacyManagementConfigView(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const legacy: Record<string, unknown> = { ...payload };
  const upstream = isRecord(payload['api-keys']) ? payload['api-keys'] : {};
  Object.values(PROVIDER_PATHS).forEach(({ provider, legacy: legacyKey }) => {
    legacy[legacyKey] = flattenV8ProviderGroups(provider, upstream[provider]);
  });
  const access = isRecord(payload.access) ? payload.access : null;
  if (access && Array.isArray(access['api-keys'])) legacy['api-keys'] = access['api-keys'];
  const oauth = isRecord(payload.oauth) ? payload.oauth : null;
  if (oauth && oauth['model-alias'] !== undefined) legacy['oauth-model-alias'] = oauth['model-alias'];
  const requests = isRecord(payload.requests) ? payload.requests : null;
  if (requests && requests.payload !== undefined) legacy.payload = requests.payload;
  return legacy;
}

const normalizeQuery = (
  query?: Record<string, string | number | boolean | undefined>,
): Record<string, string> | undefined => {
  if (!query) {
    return undefined;
  }
  const normalized = Object.entries(query).reduce<Record<string, string>>((result, [key, value]) => {
    if (value !== undefined) {
      result[key] = String(value);
    }
    return result;
  }, {});
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

async function request<T = ManagementJson>(
  method: string,
  path: string,
  options: ManagementRequestOptions = {},
): Promise<T> {
  if (path === '/oauth-excluded-models') {
    if (method === 'PATCH' && isRecord(options.body)) {
      const provider = readString(options.body, 'provider');
      if (!provider || !Array.isArray(options.body.models)) {
        throw new Error('Invalid OAuth model exclusion update');
      }
      return invoke<T>('management_request', {
        request: {
          method: 'PUT',
          path: `/config/oauth/excluded-models/${encodeURIComponent(provider)}`,
          body: options.body.models,
        },
      });
    }
    if (method === 'DELETE') {
      const provider = options.query?.provider;
      if (typeof provider !== 'string' || !provider.trim()) {
        throw new Error('Invalid OAuth model exclusion delete');
      }
      return invoke<T>('management_request', {
        request: {
          method: 'DELETE',
          path: `/config/oauth/excluded-models/${encodeURIComponent(provider.trim())}`,
        },
      });
    }
    if (method === 'GET') {
      const exclusions = await optionalConfigValue('/config/oauth/excluded-models', {}, options);
      return { 'oauth-excluded-models': exclusions } as T;
    }
  }
  const definition = providerDefinition(path);
  if (method === 'GET' && definition) {
    const groups = await optionalConfigValue(`/config/api-keys/${definition.provider}`, [], options);
    return { [definition.legacy]: flattenV8ProviderGroups(definition.provider, groups) } as T;
  }
  if (method === 'PATCH' && path === '/openai-compatibility' && isRecord(options.body)) {
    const index = Number(options.body.index);
    const value = options.body.value;
    if (!Number.isInteger(index) || index < 0 || !isRecord(value)) {
      throw new Error('Invalid OpenAI compatibility update');
    }
    const groups = await invoke<unknown>('management_request', {
      request: { method: 'GET', path: '/config/api-keys/openai-compatibility' },
    });
    const records = flattenV8ProviderGroups('openai-compatibility', groups);
    if (!records[index]) throw new Error('OpenAI compatibility entry no longer exists');
    records[index] = { ...records[index], ...value };
    return invoke<T>('management_request', {
      request: {
        method: 'PUT',
        path: '/config/api-keys/openai-compatibility',
        body: groupLegacyProviderRecords('openai-compatibility', records),
      },
    });
  }

  let apiPath = path;
  let body = options.body;
  if (definition) {
    apiPath = `/config/api-keys/${definition.provider}`;
    if (method === 'PUT' || method === 'PATCH') {
      body = groupLegacyProviderRecords(definition.provider, body);
    }
  } else if (path === '/api-call') {
    apiPath = '/requests/api-call';
  } else if (path === '/oauth-session') {
    apiPath = '/oauth/session';
  } else if (path.startsWith('/auth-files')) {
    apiPath = `/credentials${path.slice('/auth-files'.length)}`;
  } else if (path.startsWith('/model-definitions/')) {
    apiPath = `/routing${path}`;
  }

  const payload = await invoke<unknown>('management_request', {
    request: {
      method,
      path: apiPath,
      query: normalizeQuery(options.query),
      body,
      timeoutMs: options.timeoutMs,
    },
  });
  if (method === 'GET' && path === '/config') {
    return legacyManagementConfigView(payload) as T;
  }
  return payload as T;
}

export const managementApi = {
  get: <T = ManagementJson>(path: string, query?: ManagementRequestOptions['query']) =>
    request<T>('GET', path, { query }),
  post: <T = ManagementJson>(
    path: string,
    body?: ManagementJson,
    options: Pick<ManagementRequestOptions, 'timeoutMs'> = {},
  ) => request<T>('POST', path, { ...options, body }),
  put: <T = ManagementJson>(path: string, body?: ManagementJson) =>
    request<T>('PUT', path, { body }),
  patch: <T = ManagementJson>(path: string, body?: ManagementJson) =>
    request<T>('PATCH', path, { body }),
  delete: <T = ManagementJson>(
    path: string,
    options: ManagementRequestOptions = {},
  ) => request<T>('DELETE', path, options),
  uploadAuthFile: async (file: File) => {
    const data = Array.from(new Uint8Array(await file.arrayBuffer()));
    return invoke<ManagementJson>('upload_auth_file', {
      name: file.name,
      data,
    });
  },
  openAuthFilesDirectory: () => invoke<void>('open_auth_files_directory'),
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(value: unknown, ...keys: string[]): string {
  if (!isRecord(value)) {
    return '';
  }
  for (const key of keys) {
    const candidate = value[key];
    if (candidate === undefined || candidate === null) {
      continue;
    }
    const text = String(candidate).trim();
    if (text) {
      return text;
    }
  }
  return '';
}

export function readBoolean(value: unknown, ...keys: string[]): boolean {
  if (!isRecord(value)) {
    return false;
  }
  for (const key of keys) {
    if (typeof value[key] === 'boolean') {
      return value[key] as boolean;
    }
  }
  return false;
}

export function readNumber(value: unknown, ...keys: string[]): number | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const key of keys) {
    const candidate = value[key];
    const parsed = typeof candidate === 'number' ? candidate : Number(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function responseList(payload: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload[key])) {
    return [];
  }
  return payload[key].filter(isRecord);
}

export function maskSecret(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return translate(getCurrentLocale(), 'management.notConfigured');
  }
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}••••`;
  }
  return `${normalized.slice(0, 4)}••••${normalized.slice(-4)}`;
}

export function formatDate(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '—';
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat(getCurrentLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function normalizeAuthIndex(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

const messageFromPayload = (value: unknown, depth = 0): string => {
  if (value === null || value === undefined || depth > 3) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text) as unknown;
      const nested = messageFromPayload(parsed, depth + 1);
      if (nested) return nested;
    } catch {
    }
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = messageFromPayload(item, depth + 1);
      if (nested) return nested;
    }
    return '';
  }
  if (isRecord(value)) {
    for (const key of ['message', 'error', 'detail', 'error_description', 'title']) {
      const nested = messageFromPayload(value[key], depth + 1);
      if (nested) return nested;
    }
  }
  return '';
};

export function apiCallErrorMessage(
  response: Record<string, unknown>,
  fallback = translate(getCurrentLocale(), 'management.error.upstream'),
): string {
  const status = Number(response.status_code ?? response.statusCode ?? 0);
  const message = messageFromPayload(response.body ?? response.bodyText);
  if (message) return message;
  return status > 0
    ? translate(getCurrentLocale(), 'management.error.upstreamHttp', { status })
    : fallback;
}
