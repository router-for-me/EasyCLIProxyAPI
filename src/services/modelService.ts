import { apiCallErrorMessage, isRecord, managementApi, readString } from './managementApi';
import { getCurrentLocale, translate } from '../i18n';

const modelText = (key: Parameters<typeof translate>[1]) => translate(getCurrentLocale(), key);

export type ModelOption = {
  name: string;
  alias?: string;
  thinking?: Record<string, unknown>;
};
export type ModelProvider = 'gemini' | 'codex' | 'claude' | 'openai';

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com';

export function normalizeBaseUrl(value: string): string {
  let raw = value.trim();
  if (!raw) return '';
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(modelText('model.error.invalidBaseUrl'));
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(modelText('model.error.unsupportedBaseUrl'));
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString()
    .replace(/\/(?:chat\/completions|messages|responses|generateContent)$/i, '')
    .replace(/\/+$/, '');
}

const stripKnownSuffix = (baseUrl: string) =>
  normalizeBaseUrl(baseUrl)
    .replace(/\/(?:v1beta|v1)\/models$/i, '')
    .replace(/\/models$/i, '');

const endpointCandidates = (provider: ModelProvider, baseUrl: string): string[] => {
  const resolvedBaseUrl = baseUrl.trim()
    || (provider === 'gemini'
      ? DEFAULT_GEMINI_BASE_URL
      : provider === 'claude'
        ? DEFAULT_CLAUDE_BASE_URL
        : '');
  const base = stripKnownSuffix(resolvedBaseUrl);
  if (!base) return [];
  const withoutVersion = base.replace(/\/(?:v1beta|v1)$/i, '');
  if (provider === 'gemini') return [`${withoutVersion}/v1beta/models`];
  if (provider === 'claude') return [`${withoutVersion}/v1/models`];
  const first = /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
  const fallback = `${base}/models`;
  return first === fallback ? [first] : [first, fallback];
};

const normalizeModelList = (payload: unknown): ModelOption[] => {
  const parsed = typeof payload === 'string' ? (() => {
    try { return JSON.parse(payload) as unknown; } catch { return payload; }
  })() : payload;
  const source = isRecord(parsed)
    ? (Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [])
    : Array.isArray(parsed) ? parsed : [];
  const seen = new Set<string>();
  return source.map((item): ModelOption | null => {
    const name = typeof item === 'string' ? item : isRecord(item) ? readString(item, 'id', 'name', 'model', 'value') : '';
    if (!name || seen.has(name.toLowerCase())) return null;
    seen.add(name.toLowerCase());
    const alias = typeof item === 'object' && isRecord(item) ? readString(item, 'alias', 'display_name', 'displayName') : '';
    const thinking = typeof item === 'object' && isRecord(item) && isRecord(item.thinking)
      ? { ...item.thinking }
      : undefined;
    return {
      name,
      ...(alias && alias !== name ? { alias } : {}),
      ...(thinking ? { thinking } : {}),
    };
  }).filter((item): item is ModelOption => item !== null);
};

export function modelsFromRecord(value: unknown): ModelOption[] {
  if (!Array.isArray(value)) return [];
  return normalizeModelList(value);
}

export async function fetchModels(
  provider: ModelProvider,
  baseUrl: string,
  apiKey: string,
  authIndex?: string,
  customHeaders: Record<string, string> = {},
): Promise<ModelOption[]> {
  const normalized = baseUrl.trim() ? normalizeBaseUrl(baseUrl) : '';
  const candidates = endpointCandidates(provider, normalized);
  if (candidates.length === 0) throw new Error(modelText('model.error.baseUrlRequired'));
  const headers: Record<string, string> = { ...customHeaders };
  const hasHeader = (name: string) =>
    Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
  const headerValue = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? '';
  const key = apiKey.trim();
  if (provider === 'gemini') {
    if (key && !hasHeader('x-goog-api-key')) headers['x-goog-api-key'] = key;
    else if (authIndex && !hasHeader('x-goog-api-key')) headers['x-goog-api-key'] = '$TOKEN$';
  } else if (provider === 'claude') {
    const bearerToken = headerValue('authorization').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
    if (key && !hasHeader('x-api-key')) headers['x-api-key'] = key;
    else if (bearerToken && !hasHeader('x-api-key')) headers['x-api-key'] = bearerToken;
    else if (authIndex && !hasHeader('x-api-key')) headers['x-api-key'] = '$TOKEN$';
    if (!hasHeader('anthropic-version')) headers['anthropic-version'] = '2023-06-01';
  } else if (key && !hasHeader('authorization')) {
    headers.Authorization = `Bearer ${key}`;
  } else if (authIndex && !hasHeader('authorization')) {
    headers.Authorization = 'Bearer $TOKEN$';
  }

  let lastError = '';
  for (const url of candidates) {
    try {
      const collected: ModelOption[] = [];
      const seen = new Set<string>();
      let pageToken = '';

      for (let page = 0; page < (provider === 'gemini' ? 20 : 1); page += 1) {
        const pageUrl = new URL(url);
        if (pageToken) pageUrl.searchParams.set('pageToken', pageToken);
        const response = await managementApi.post<Record<string, unknown>>('/api-call', {
          authIndex: authIndex?.trim() || undefined,
          method: 'GET',
          url: pageUrl.toString(),
          header: Object.keys(headers).length ? headers : undefined,
        });
        const status = Number(response.status_code ?? response.statusCode ?? 0);
        if (status < 200 || status >= 300) {
          lastError = apiCallErrorMessage(response);
          break;
        }

        const payload = response.body ?? response.bodyText;
        normalizeModelList(payload).forEach((model) => {
          const name = provider === 'gemini' ? model.name.replace(/^models\//i, '') : model.name;
          const dedupeKey = name.toLowerCase();
          if (!name || seen.has(dedupeKey)) return;
          seen.add(dedupeKey);
          collected.push(
            name === model.name
              ? model
              : { ...model, name, alias: model.alias === model.name ? undefined : model.alias },
          );
        });

        const parsedPayload = typeof payload === 'string'
          ? (() => {
              try { return JSON.parse(payload) as unknown; } catch { return null; }
            })()
          : payload;
        pageToken = isRecord(parsedPayload) ? readString(parsedPayload, 'nextPageToken') : '';
        if (!pageToken) break;
      }

      if (collected.length) return collected;

      if (provider === 'openai' && Object.keys(headers).length > 0) {
        const response = await managementApi.post<Record<string, unknown>>('/api-call', {
          method: 'GET',
          url,
        });
        const status = Number(response.status_code ?? response.statusCode ?? 0);
        if (status >= 200 && status < 300) {
          const models = normalizeModelList(response.body ?? response.bodyText);
          if (models.length) return models;
        }
      }
    } catch (error) {
      lastError = String(error);
      if (provider === 'openai' && Object.keys(headers).length > 0) {
        try {
          const response = await managementApi.post<Record<string, unknown>>('/api-call', {
            method: 'GET',
            url,
          });
          const status = Number(response.status_code ?? response.statusCode ?? 0);
          if (status >= 200 && status < 300) {
            const models = normalizeModelList(response.body ?? response.bodyText);
            if (models.length) return models;
          }
        } catch {
          // Keep the authenticated request error as the useful failure reason.
        }
      }
    }
  }
  throw new Error(lastError || modelText('model.error.noResponse'));
}
