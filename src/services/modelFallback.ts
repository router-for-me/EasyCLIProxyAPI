import { isRecord, managementApi, type ManagementJson } from './managementApi';
import { getCurrentLocale, translate } from '../i18n';

export const MODEL_FALLBACK_PATH = '/config/routing/model-fallback';
export const MODEL_FALLBACK_MAX_HOPS = 8;
export const MODEL_FALLBACK_DEFAULT_HOPS = 2;
export const modelFallbackKeywords = ['quota_exhausted', 'auth_unavailable', '5xx'] as const;
export const defaultModelFallbackOn = ['429', 'quota_exhausted', 'auth_unavailable', '529'];

export type ModelFallbackChain = { model: string; targets: string[] };
export type ModelFallbackSettings = {
  enabled: boolean;
  maxHops: number;
  on: string[];
  chains: ModelFallbackChain[];
};
type ModelFallbackApi = Pick<typeof managementApi, 'get' | 'put'>;

type FallbackMessage = 'invalidHops' | 'invalidCondition' | 'emptyModel' | 'duplicateModel' | 'emptyTarget' | 'selfTarget';
const message = (key: FallbackMessage, params?: Record<string, string | number>) => translate(getCurrentLocale(), `routing.fallback.${key}` as const, params);

export const defaultModelFallbackSettings = (): ModelFallbackSettings => ({
  enabled: false, maxHops: MODEL_FALLBACK_DEFAULT_HOPS, on: [...defaultModelFallbackOn], chains: [],
});

/** Mirrors the core rule: request faults (400/401/403/404/413/422, ...) never trigger fallback. */
export function normalizeModelFallbackCondition(raw: string): string | null {
  const token = raw.trim().toLowerCase();
  if ((modelFallbackKeywords as readonly string[]).includes(token)) return token;
  if (!/^\d{3}$/.test(token)) return null;
  const status = Number(token);
  return status === 408 || status === 429 || (status >= 500 && status <= 599) ? String(status) : null;
}

export function modelFallbackFromConfig(raw: unknown): ModelFallbackSettings {
  const settings = defaultModelFallbackSettings();
  if (!isRecord(raw)
    || ('enabled' in raw && typeof raw.enabled !== 'boolean')
    || ('max-hops' in raw && !Number.isSafeInteger(raw['max-hops']))
    || ('on' in raw && (!Array.isArray(raw.on) || raw.on.some(item => typeof item !== 'string' && typeof item !== 'number')))
    || ('chains' in raw && (!isRecord(raw.chains) || Object.values(raw.chains).some(targets => !Array.isArray(targets) || targets.some(target => typeof target !== 'string'))))) {
    throw new Error(translate(getCurrentLocale(), 'routing.invalid'));
  }
  settings.enabled = raw.enabled === true;
  if (Number.isSafeInteger(raw['max-hops']) && (raw['max-hops'] as number) > 0) settings.maxHops = raw['max-hops'] as number;
  if (Array.isArray(raw.on)) {
    settings.on = [...new Set(raw.on.map(item => normalizeModelFallbackCondition(String(item))).filter((item): item is string => !!item))];
  }
  if (isRecord(raw.chains)) {
    settings.chains = Object.entries(raw.chains)
      .map(([model, targets]) => ({ model, targets: Array.isArray(targets) ? targets.map(String) : [] }))
      .sort((left, right) => left.model.localeCompare(right.model));
  }
  return settings;
}

/** Returns a translated error for the first invalid field, or an empty string. */
export function validateModelFallback(settings: ModelFallbackSettings): string {
  if (!Number.isSafeInteger(settings.maxHops) || settings.maxHops < 1 || settings.maxHops > MODEL_FALLBACK_MAX_HOPS) {
    return message('invalidHops', { max: MODEL_FALLBACK_MAX_HOPS });
  }
  for (const condition of settings.on) {
    if (!normalizeModelFallbackCondition(condition)) return message('invalidCondition', { condition });
  }
  const seen = new Set<string>();
  for (const chain of settings.chains) {
    const model = chain.model.trim();
    if (!model) return message('emptyModel');
    if (seen.has(model.toLowerCase())) return message('duplicateModel', { model });
    seen.add(model.toLowerCase());
    const targets = chain.targets.map(target => target.trim());
    if (!targets.length || targets.some(target => !target)) return message('emptyTarget', { model });
    if (targets.some(target => target.toLowerCase() === model.toLowerCase())) return message('selfTarget', { model });
  }
  return '';
}

export function modelFallbackToConfig(settings: ModelFallbackSettings): Record<string, ManagementJson> {
  const chains = Object.fromEntries(settings.chains.map(chain => [chain.model.trim(), chain.targets.map(target => target.trim())]));
  const on = settings.on.map(item => normalizeModelFallbackCondition(item) ?? item);
  return { enabled: settings.enabled, 'max-hops': settings.maxHops, on: on.map(item => /^\d+$/.test(item) ? Number(item) : item), chains };
}

async function readModelFallbackConfig(api: ModelFallbackApi): Promise<Record<string, unknown>> {
  let raw: unknown;
  try { raw = await api.get<unknown>(MODEL_FALLBACK_PATH); }
  catch (error) {
    // A missing section means the feature was never configured.
    const detail = error instanceof Error ? error.message : error;
    if (detail !== 'Management API error (404): not_found') throw error;
    raw = {};
  }
  modelFallbackFromConfig(raw);
  return raw as Record<string, unknown>;
}

export async function readModelFallback(api: ModelFallbackApi = managementApi): Promise<ModelFallbackSettings> {
  return modelFallbackFromConfig(await readModelFallbackConfig(api));
}

export async function saveModelFallback(
  settings: ModelFallbackSettings, expected: ModelFallbackSettings, api: ModelFallbackApi = managementApi,
): Promise<ModelFallbackSettings> {
  const invalid = validateModelFallback(settings);
  if (invalid) throw new Error(invalid);
  const current = await readModelFallbackConfig(api);
  const baseline = modelFallbackFromConfig(modelFallbackToConfig(expected));
  // This UI transport does not expose ETag/If-Match; reject known stale drafts before writing.
  if (JSON.stringify(modelFallbackFromConfig(current)) !== JSON.stringify(baseline)) {
    throw new Error(translate(getCurrentLocale(), 'routing.conflict'));
  }
  const payload = { ...current, ...modelFallbackToConfig(settings) };
  await api.put(MODEL_FALLBACK_PATH, payload);
  // A confirmed PUT is saved even if a subsequent read would fail.
  return modelFallbackFromConfig(payload);
}

/** Parses a comma-separated list of models typed in a single field. */
export function parseModelList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}
