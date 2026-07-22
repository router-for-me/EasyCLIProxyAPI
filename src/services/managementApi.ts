import { invoke } from '@tauri-apps/api/core';
import { getCurrentLocale, translate } from '../i18n';

export type ManagementJson = Record<string, unknown> | unknown[] | string | number | boolean | null;

type ManagementRequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: ManagementJson;
};

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
    },
  });
}

export const managementApi = {
  get: <T = ManagementJson>(path: string, query?: ManagementRequestOptions['query']) =>
    request<T>('GET', path, { query }),
  post: <T = ManagementJson>(path: string, body?: ManagementJson) =>
    request<T>('POST', path, { body }),
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
  downloadAuthFile: (name: string) => invoke<string>('download_auth_file', { name }),
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
      // The response is plain text rather than JSON.
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
