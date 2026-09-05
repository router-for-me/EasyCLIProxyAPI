import { invoke } from '@tauri-apps/api/core';
import { normalizeBaseUrl, type ModelOption, type ModelProvider } from './modelService';

export const PROVIDER_HEALTH_TIMEOUT_MS = 15_000;
export const PROVIDER_HEALTH_CONCURRENCY = 4;

export type ProviderHealthProbe = {
  url: string;
  header: Record<string, string>;
  data: string;
  protocol: 'openai-chat' | 'openai-responses' | 'claude' | 'gemini';
  model: string;
  source: string;
  authIndex: string;
};

export type ProviderHealthProbeResult = {
  success: boolean;
  firstTokenLatencyMs?: number;
  responseLatencyMs?: number;
  error?: string;
  timedOut?: boolean;
  errorCode?: 'missing-direct-key';
};

export type ProviderModelHealthResult = ProviderHealthProbeResult & {
  model: string;
  status: 'healthy' | 'failed';
};

export type ProviderHealthCheckOptions = {
  provider: ModelProvider;
  baseUrl: string;
  apiKeys: string[];
  authIndex?: string;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
};

const defaultBaseUrl = (provider: ModelProvider) => {
  if (provider === 'claude') return 'https://api.anthropic.com';
  if (provider === 'gemini') return 'https://generativelanguage.googleapis.com';
  return '';
};

const endpointRoot = (provider: ModelProvider, baseUrl: string) => {
  const normalized = normalizeBaseUrl(baseUrl.trim() || defaultBaseUrl(provider));
  return normalized.replace(/\/(?:v1beta|v1)$/i, '');
};

const openAIChatCompletionsEndpoint = (baseUrl: string) => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return '';
  return `${normalized}/chat/completions`;
};

const hasHeader = (headers: Record<string, string>, name: string) =>
  Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

const headerValue = (headers: Record<string, string>, name: string) =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? '';

const setHeaderIfMissing = (
  headers: Record<string, string>,
  name: string,
  value: string,
) => {
  if (!hasHeader(headers, name)) headers[name] = value;
};

export function primaryProviderHealthCredential(apiKeys: string[]): string {
  return apiKeys.map((key) => key.trim()).find(Boolean) ?? '';
}

export function mergeProviderHealthModels(
  discoveredModels: ModelOption[],
  configuredModels: ModelOption[],
): ModelOption[] {
  const configured = new Map<string, ModelOption>();
  configuredModels.forEach((model) => {
    const name = model.name.trim();
    if (!name) return;
    const key = name.toLowerCase();
    configured.set(key, { ...configured.get(key), ...model, name });
  });
  discoveredModels.forEach((model) => {
    const key = model.name.trim().toLowerCase();
    const selected = configured.get(key);
    if (!selected) return;
    configured.set(key, { ...model, ...selected });
  });
  return Array.from(configured.values()).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
  );
}

export function buildProviderHealthProbe(
  provider: ModelProvider,
  baseUrl: string,
  model: string,
  apiKey: string,
  authIndex = '',
  customHeaders: Record<string, string> = {},
): ProviderHealthProbe {
  const root = endpointRoot(provider, baseUrl);
  const headers = { ...customHeaders };
  const key = apiKey.trim();
  const normalizedModel = provider === 'gemini'
    ? model.trim().replace(/^models\//i, '')
    : model.trim();
  const metadata = {
    model: normalizedModel,
    source: key,
    authIndex: authIndex.trim(),
  };
  setHeaderIfMissing(headers, 'Content-Type', 'application/json');

  if (provider === 'gemini') {
    if (key) setHeaderIfMissing(headers, 'x-goog-api-key', key);
    else if (authIndex) setHeaderIfMissing(headers, 'x-goog-api-key', '$TOKEN$');
    return {
      ...metadata,
      url: `${root}/v1beta/models/${encodeURIComponent(normalizedModel)}:generateContent?alt=sse`,
      header: headers,
      protocol: 'gemini',
      data: JSON.stringify({
        contents: [{ parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
    };
  }

  if (provider === 'claude') {
    const bearerToken = headerValue(headers, 'authorization').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
    if (key) setHeaderIfMissing(headers, 'x-api-key', key);
    else if (bearerToken) setHeaderIfMissing(headers, 'x-api-key', bearerToken);
    else if (authIndex) setHeaderIfMissing(headers, 'x-api-key', '$TOKEN$');
    setHeaderIfMissing(headers, 'anthropic-version', '2023-06-01');
    return {
      ...metadata,
      url: `${root}/v1/messages`,
      header: headers,
      protocol: 'claude',
      data: JSON.stringify({
        model: normalizedModel,
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    };
  }

  if (key) setHeaderIfMissing(headers, 'Authorization', `Bearer ${key}`);
  else if (authIndex) setHeaderIfMissing(headers, 'Authorization', 'Bearer $TOKEN$');

  if (provider === 'codex') {
    return {
      ...metadata,
      url: `${root}/v1/responses`,
      header: headers,
      protocol: 'openai-responses',
      data: JSON.stringify({
        model: normalizedModel,
        input: 'hi',
        stream: true,
      }),
    };
  }

  return {
    ...metadata,
    url: openAIChatCompletionsEndpoint(baseUrl),
    header: headers,
    protocol: 'openai-chat',
    data: JSON.stringify({
      model: normalizedModel,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }),
  };
}

const isTimeoutError = (message: string) =>
  /timed?\s*out|timeout|deadline has elapsed|超时/i.test(message);

const errorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message.trim() || error.name;
  return String(error).replace(/^Error:\s*/i, '').trim();
};

export async function checkProviderHealthProbe(
  provider: ModelProvider,
  baseUrl: string,
  model: string,
  apiKey: string,
  authIndex = '',
  customHeaders: Record<string, string> = {},
  timeoutMs = PROVIDER_HEALTH_TIMEOUT_MS,
): Promise<ProviderHealthProbeResult> {
  try {
    const probe = buildProviderHealthProbe(
      provider,
      baseUrl,
      model,
      apiKey,
      authIndex,
      customHeaders,
    );
    if (Object.values(probe.header).some((value) => value.includes('$TOKEN$'))) {
      return {
        success: false,
        errorCode: 'missing-direct-key',
      };
    }
    const response = await invoke<{
      firstTokenLatencyMs?: number;
      responseLatencyMs: number;
    }>('provider_health_probe', {
      request: {
        protocol: probe.protocol,
        timeoutMs,
        data: probe.data,
        header: probe.header,
        url: probe.url,
        model: probe.model,
        source: probe.source,
        authIndex: probe.authIndex,
      },
    });
    const firstTokenLatencyMs = Number.isFinite(response.firstTokenLatencyMs)
      ? Math.max(1, Math.round(response.firstTokenLatencyMs as number))
      : undefined;
    const responseLatencyMs = Number.isFinite(response.responseLatencyMs)
      ? Math.max(1, Math.round(response.responseLatencyMs))
      : firstTokenLatencyMs;
    return {
      success: true,
      ...(firstTokenLatencyMs === undefined ? {} : { firstTokenLatencyMs }),
      ...(responseLatencyMs === undefined ? {} : { responseLatencyMs }),
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      success: false,
      error: message,
      timedOut: isTimeoutError(message),
    };
  }
}

export async function checkProviderModelHealth(
  options: ProviderHealthCheckOptions,
  model: string,
): Promise<ProviderModelHealthResult> {
  const result = await checkProviderHealthProbe(
    options.provider,
    options.baseUrl,
    model,
    primaryProviderHealthCredential(options.apiKeys),
    options.authIndex,
    options.customHeaders,
    options.timeoutMs,
  );
  return {
    ...result,
    model,
    status: result.success ? 'healthy' : 'failed',
  };
}

export async function runProviderModelHealthChecks(
  models: ModelOption[],
  checkModel: (model: ModelOption, index: number) => Promise<ProviderModelHealthResult>,
  onModelChecked?: (result: ProviderModelHealthResult, index: number) => void,
  concurrency = PROVIDER_HEALTH_CONCURRENCY,
  signal?: AbortSignal,
): Promise<ProviderModelHealthResult[]> {
  const results: ProviderModelHealthResult[] = new Array(models.length);
  let nextIndex = 0;
  const workerCount = Math.min(models.length, Math.max(1, Math.floor(concurrency)));

  const runWorker = async () => {
    while (nextIndex < models.length && !signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const model = models[index];
      if (!model) continue;
      const result = await checkModel(model, index);
      if (signal?.aborted) break;
      results[index] = result;
      onModelChecked?.(result, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results.filter((result) => result !== undefined);
}

export async function checkProviderModelsHealth(
  options: ProviderHealthCheckOptions,
  models: ModelOption[],
  onModelChecked?: (result: ProviderModelHealthResult, index: number) => void,
  concurrency = PROVIDER_HEALTH_CONCURRENCY,
  signal?: AbortSignal,
): Promise<ProviderModelHealthResult[]> {
  return runProviderModelHealthChecks(
    models,
    (model) => checkProviderModelHealth(options, model.name),
    onModelChecked,
    concurrency,
    signal,
  );
}
