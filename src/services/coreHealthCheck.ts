import { invoke } from '@tauri-apps/api/core';
import {
  PROVIDER_HEALTH_CONCURRENCY,
  PROVIDER_HEALTH_TIMEOUT_MS,
  runProviderModelHealthChecks,
  type ProviderModelHealthResult,
} from './providerHealthCheck';

export type CoreHealthModel = { name: string; displayName?: string };
export type CoreModelHealthResult = ProviderModelHealthResult;

export async function checkCoreModelHealth(model: string): Promise<CoreModelHealthResult> {
  try {
    // The native command chooses the local endpoint and its current credential.
    // Preserve the exposed model ID, including aliases and provider prefixes.
    const response = await invoke<{
      firstTokenLatencyMs?: number;
      responseLatencyMs: number;
    }>('core_health_probe', { model, timeoutMs: PROVIDER_HEALTH_TIMEOUT_MS });
    const latency = (value: number | undefined) => Number.isFinite(value)
      ? Math.max(1, Math.round(value as number)) : undefined;
    return {
      model,
      success: true,
      status: 'healthy',
      firstTokenLatencyMs: latency(response.firstTokenLatencyMs),
      responseLatencyMs: latency(response.responseLatencyMs),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      model,
      success: false,
      status: 'failed',
      error: message.replace(/^Error:\s*/i, '').trim(),
      timedOut: /timed?\s*out|timeout|deadline has elapsed|超时/i.test(message),
    };
  }
}

export function checkCoreModelsHealth(
  models: CoreHealthModel[],
  onModelChecked?: (result: CoreModelHealthResult) => void,
  signal?: AbortSignal,
  onModelStarted?: (model: CoreHealthModel) => void,
): Promise<CoreModelHealthResult[]> {
  const unique = Array.from(new Map(models.filter((model) => model.name.trim())
    .map((model) => [model.name, model])).values());
  return runProviderModelHealthChecks(unique, async (model) => {
    onModelStarted?.(model);
    return checkCoreModelHealth(model.name);
  }, onModelChecked, PROVIDER_HEALTH_CONCURRENCY, signal);
}
