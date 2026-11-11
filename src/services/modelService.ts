import { apiCallErrorMessage, isRecord, managementApi, readString } from './managementApi';
import { getCurrentLocale, translate } from '../i18n';
import { normalizeThinkingConfig } from './providerModels';

const modelText = (key: Parameters<typeof translate>[1]) => translate(getCurrentLocale(), key);

export type ModelOption = {
  config?: Record<string, unknown>;
  name: string;
  alias?: string;
  displayName?: string;
  isAlias?: boolean;
  contextWindow?: number;
  inputModalities?: Array<'text' | 'image'>;
  thinking?: Record<string, unknown>;
};
export type ModelProvider = 'gemini' | 'interactions' | 'vertex' | 'xai' | 'meta' | 'codex' | 'deepseek' | 'claude' | 'openai';

export type ModelSelectionMode = 'initial' | 'refresh';

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com';
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
// Meta's native executor sends this client identity on both model and inference requests.
export function providerDefaultHeaders(provider: ModelProvider): Record<string, string> {
  return provider === 'meta' ? {
    'User-Agent': 'muse-build/1.3.0 (interactive; macos-aarch64; build ac7280f2aca67769d1455a8847bb502b617d50f6)',
    'X-Client-Id': 'tbh:tui',
  } : {};
}
export const defaultProviderBaseUrl = (provider: ModelProvider): string => {
  if (provider === 'gemini' || provider === 'interactions') return DEFAULT_GEMINI_BASE_URL;
  if (provider === 'vertex') return 'https://aiplatform.googleapis.com';
  if (provider === 'xai') return 'https://api.x.ai/v1';
  if (provider === 'meta') return 'https://api.meta.ai/v1';
  if (provider === 'claude') return DEFAULT_CLAUDE_BASE_URL;
  if (provider === 'deepseek') return DEEPSEEK_BASE_URL;
  return '';
};

const modelKey = (name: string) => name.trim().toLowerCase();

export function usableModelAlias(value: string | undefined | null): string {
  const alias = value?.trim() ?? '';
  if (!alias || alias.length > 240) return '';
  for (const character of alias) {
    const code = character.charCodeAt(0);
    if (character.trim() === '' || code < 32 || code === 127) return '';
  }
  return alias;
}

export function modelSearchText(
  model: Pick<ModelOption, 'name' | 'alias' | 'displayName'>,
): string {
  return [model.name, model.alias, model.displayName].filter(Boolean).join(' ').toLowerCase();
}

export function mergeModelOptions(...groups: ModelOption[][]): ModelOption[] {
  const merged = new Map<string, ModelOption>();
  groups.flat().forEach((model) => {
    const name = model.name.trim();
    if (!name) return;
    const previous = merged.get(modelKey(name));
    const next: ModelOption = { ...previous, ...model, name };
    const alias = (model.alias ?? '').trim() || previous?.alias;
    const displayName = (model.displayName ?? '').trim() || previous?.displayName;
    if (alias && alias !== name) next.alias = alias;
    else delete next.alias;
    if (displayName && displayName !== name) next.displayName = displayName;
    else delete next.displayName;
    merged.set(modelKey(name), next);
  });
  return Array.from(merged.values());
}

export function reconcileModelSelection(
  discoveredModels: ModelOption[],
  configuredModels: ModelOption[],
  selectedModelNames: Iterable<string>,
  mode: ModelSelectionMode,
): Set<string> {
  const availableNames = new Set(
    mergeModelOptions(discoveredModels, configuredModels).map((model) => modelKey(model.name)),
  );
  const configuredNames = new Set(
    configuredModels.map((model) => modelKey(model.name)).filter(Boolean),
  );
  const previousSelection = new Set(
    Array.from(selectedModelNames, modelKey).filter(Boolean),
  );
  const requestedSelection = mode === 'refresh'
    ? previousSelection
    : configuredNames.size > 0
      ? configuredNames
      : new Set(discoveredModels.map((model) => modelKey(model.name)).filter(Boolean));

  return new Set(Array.from(requestedSelection).filter((name) => availableNames.has(name)));
}

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

export const modelEndpointCandidates = (provider: ModelProvider, baseUrl: string): string[] => {
  const resolvedBaseUrl = baseUrl.trim() || defaultProviderBaseUrl(provider);
  const normalized = normalizeBaseUrl(resolvedBaseUrl);
  if (!normalized) return [];
  if (provider === 'openai' || provider === 'xai' || provider === 'meta') {
    return [/\/models$/i.test(normalized) ? normalized : `${normalized}/models`];
  }
  const base = stripKnownSuffix(normalized);
  const withoutVersion = base.replace(/\/(?:v1beta|v1)$/i, '');
  if (provider === 'gemini' || provider === 'interactions') return [`${withoutVersion}/v1beta/models`];
  if (provider === 'vertex') return [`${withoutVersion}/v1/publishers/google/models`, `${base}/models`, `${withoutVersion}/v1/models`];
  if (provider === 'claude') return [`${withoutVersion}/v1/models`];
  if (provider === 'deepseek') return [`${base}/models`];
  return [/\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`];
};

const parseModelPayload = (payload: unknown): unknown => {
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload) as unknown; } catch { return null; }
};

const modelListFromPayload = (payload: unknown): unknown[] | null => {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return null;
  for (const field of ['data', 'models', 'publisherModels']) {
    if (Array.isArray(payload[field])) return payload[field];
  }
  return null;
};

const normalizeModelList = (source: unknown[], preserveExistingAlias = false, preserveConfiguration = false): ModelOption[] => {
  const seen = new Set<string>();
  return source.map((item): ModelOption | null => {
    const name = typeof item === 'string' ? item : isRecord(item) ? readString(item, 'id', 'name', 'model', 'value') : '';
    if (!name || seen.has(name.toLowerCase())) return null;
    seen.add(name.toLowerCase());
    const record = typeof item === 'object' && isRecord(item) ? item : null;
    const rawAlias = record ? readString(record, 'alias') : '';
    const alias = preserveExistingAlias ? rawAlias : usableModelAlias(rawAlias);
    const displayName = record ? readString(record, 'display-name', 'display_name', 'displayName') : '';
    const thinking = record && isRecord(record.thinking)
      ? normalizeThinkingConfig(record.thinking, !preserveExistingAlias)
      : undefined;
    return {
      name,
      ...(preserveConfiguration && record ? { config: { ...record, ...(thinking ? { thinking } : {}) } } : {}),
      ...(alias && alias !== name ? { alias } : {}),
      ...(displayName && displayName !== name ? { displayName } : {}),
      ...(thinking && (preserveExistingAlias || Object.keys(thinking).length > 0) ? { thinking } : {}),
    };
  }).filter((item): item is ModelOption => item !== null);
};

export function modelsFromRecord(value: unknown, preserveConfiguration = false): ModelOption[] {
  if (!Array.isArray(value)) return [];
  return normalizeModelList(value, true, preserveConfiguration);
}

export function modelsFromDiscoveredPayload(payload: unknown): ModelOption[] {
  return normalizeModelList(modelListFromPayload(parseModelPayload(payload)) ?? []);
}

export async function fetchModels(
  provider: ModelProvider,
  baseUrl: string,
  apiKey: string,
  authIndex?: string,
  customHeaders: Record<string, string> = {},
  timeoutMs?: number,
  proxyUrl?: string,
): Promise<ModelOption[]> {
  const normalized = baseUrl.trim() ? normalizeBaseUrl(baseUrl) : '';
  const candidates = modelEndpointCandidates(provider, normalized);
  if (candidates.length === 0) throw new Error(modelText('model.error.baseUrlRequired'));
  const headers: Record<string, string> = { ...customHeaders };
  const hasHeader = (name: string) =>
    Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
  for (const [name, value] of Object.entries(providerDefaultHeaders(provider))) if (!hasHeader(name)) headers[name] = value;
  const headerValue = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? '';
  const key = apiKey.trim();
  if (provider === 'gemini' || provider === 'interactions' || provider === 'vertex') {
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

  const paginated = ['gemini', 'interactions', 'vertex'].includes(provider);
  const listModels = async (url: string, authenticated: boolean): Promise<ModelOption[]> => {
    const collected: ModelOption[] = [];
    const seen = new Set<string>();
    let pageToken = '';
    for (let page = 0; page < (paginated ? 20 : 1); page += 1) {
      const pageUrl = new URL(url);
      if (pageToken) pageUrl.searchParams.set('pageToken', pageToken);
      const response = await managementApi.post<Record<string, unknown>>('/requests/api-call', {
        authIndex: authenticated ? authIndex?.trim() || undefined : undefined,
        proxy_url: proxyUrl?.trim() || undefined,
        method: 'GET',
        url: pageUrl.toString(),
        header: authenticated && Object.keys(headers).length ? headers : undefined,
      }, { timeoutMs });
      const status = Number(response.status_code ?? response.statusCode ?? 0);
      if (!(status >= 200 && status < 300)) throw new Error(apiCallErrorMessage(response));

      const payload = parseModelPayload(response.body ?? response.bodyText);
      const source = modelListFromPayload(payload);
      if (!source) throw new Error(modelText('model.error.noResponse'));
      const models = normalizeModelList(source);
      if (source.length > 0 && models.length === 0) {
        throw new Error(modelText('model.error.noResponse'));
      }
      models.forEach((model) => {
        const name = (paginated ? model.name.replace(/^(?:publishers\/google\/)?models\//i, '') : model.name).trim();
        const dedupeKey = modelKey(name);
        if (!name || seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        collected.push(
          name === model.name
            ? model
            : { ...model, name, alias: model.alias === model.name ? undefined : model.alias },
        );
      });
      pageToken = paginated && isRecord(payload) ? readString(payload, 'nextPageToken') : '';
      // An empty but complete list is valid; a failed or truncated list is not.
      if (!pageToken) return collected;
    }
    throw new Error(modelText('model.error.noResponse'));
  };

  let lastError: unknown;
  for (const url of candidates) {
    try {
      return await listModels(url, true);
    } catch (error) {
      lastError = error;
      if (provider === 'openai' && Object.keys(headers).length > 0) {
        try {
          const models = await listModels(url, false);
          // An empty public list cannot confirm omissions for a failed authenticated request.
          if (models.length) return models;
        } catch {
          // Report the error from the original request if the fallback also fails.
        }
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? modelText('model.error.noResponse')));
}
