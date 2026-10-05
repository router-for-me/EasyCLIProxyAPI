import { invoke } from '@tauri-apps/api/core';
import { getCurrentLocale, translate } from '../i18n';

export type ManagementJson = Record<string, unknown> | unknown[] | string | number | boolean | null;

type ManagementRequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: ManagementJson;
  timeoutMs?: number;
};

// Native v8 groups: callers keep keys and overrides intact through every edit.
export const providerGroupsApi = {
  get: async (section: string): Promise<Record<string, unknown>[]> => {
    const value = await optionalConfigValue(`/config/api-keys/${section.replace(/-api-key$/, '')}`, [], {});
    if (!Array.isArray(value) || !value.every(isRecord)) throw new Error('Invalid provider group response');
    return value;
  },
  put: (section: string, groups: Record<string, unknown>[]) =>
    request('PUT', `/config/api-keys/${section.replace(/-api-key$/, '')}`, { body: groups }),
};

async function optionalConfigValue(
  path: string, fallback: ManagementJson, options: ManagementRequestOptions = {},
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
  return invoke<T>('management_request', {
    request: {
      method,
      path,
      query: normalizeQuery(options.query),
      body: options.body,
      timeoutMs: options.timeoutMs,
    },
  });
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

type ApiErrorDetail = { message: string; code: string };

const emptyApiErrorDetail = (): ApiErrorDetail => ({ message: '', code: '' });

const mergeApiErrorDetail = (current: ApiErrorDetail, next: ApiErrorDetail): ApiErrorDetail => ({
  message: current.message || next.message,
  code: current.code || next.code,
});

const errorCodeFromRecord = (value: Record<string, unknown>): string => {
  for (const key of ['code', 'error_code', 'errorCode']) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(Math.trunc(candidate));
    if (typeof candidate === 'string') {
      const text = candidate.trim();
      if (text && text.length <= 64) return text;
    }
  }
  return '';
};

const detailFromPayload = (value: unknown, depth = 0): ApiErrorDetail => {
  if (value === null || value === undefined || depth > 3) return emptyApiErrorDetail();
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return emptyApiErrorDetail();
    try {
      const parsed = JSON.parse(text) as unknown;
      const nested = detailFromPayload(parsed, depth + 1);
      if (nested.message || nested.code) return nested;
    } catch {
    }
    return { message: text, code: '' };
  }
  if (typeof value === 'number' || typeof value === 'boolean') return { message: String(value), code: '' };
  if (Array.isArray(value)) {
    let detail = emptyApiErrorDetail();
    for (const item of value) {
      detail = mergeApiErrorDetail(detail, detailFromPayload(item, depth + 1));
      if (detail.message && detail.code) break;
    }
    return detail;
  }
  if (isRecord(value)) {
    let detail: ApiErrorDetail = { message: '', code: errorCodeFromRecord(value) };
    for (const key of ['message', 'error', 'detail', 'error_description', 'title']) {
      detail = mergeApiErrorDetail(detail, detailFromPayload(value[key], depth + 1));
      if (detail.message && detail.code) break;
    }
    return detail;
  }
  return emptyApiErrorDetail();
};

const httpStatusFromResponse = (response: Record<string, unknown>): number => {
  const status = Number(response.status_code ?? response.statusCode ?? response.status ?? 0);
  return Number.isFinite(status) && status > 0 ? Math.trunc(status) : 0;
};

const mentionsHttpStatus = (text: string, status: number): boolean => {
  if (!status) return false;
  if (text.trim() === String(status)) return true;
  return new RegExp(`(?:\\bhttp\\s*|\\(|\\[|^|\\s)${status}(?:\\b|\\)|\\]|\\s|$)`, 'i').test(text);
};

export function apiCallErrorMessage(
  response: Record<string, unknown>,
  fallback = translate(getCurrentLocale(), 'management.error.upstream'),
): string {
  const locale = getCurrentLocale();
  const status = httpStatusFromResponse(response);
  const detail = detailFromPayload(response.body ?? response.bodyText);
  const message = status > 0 && detail.message.trim() === String(status) ? '' : detail.message;
  const code = detail.code.trim();
  const showCode = Boolean(
    code
    && code !== String(status)
    && code.toLowerCase() !== message.toLowerCase()
    && !message.toLowerCase().includes(code.toLowerCase()),
  );
  const text = message ? (showCode ? `${message} (${code})` : message) : code;
  const httpError = status > 0 && (status < 200 || status >= 300);
  if (httpError && text && !mentionsHttpStatus(text, status)) {
    return translate(locale, 'management.error.upstreamHttpDetail', { status, message: text });
  }
  if (text) return text;
  return status > 0
    ? translate(locale, 'management.error.upstreamHttp', { status })
    : fallback;
}
