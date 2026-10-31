import { getCurrentLocale, translate } from '../i18n';
import { isRecord, managementApi } from './managementApi';
import {
  normalizeOAuthExcludedRules,
  oauthExcludedRulesFromPayload,
  oauthModelCandidates,
  oauthModelsFromPayload,
  type OAuthModelDefinition,
} from './oauthModels';

export type OAuthModelTarget = { provider: string; label: string } & (
  | { scope: 'credential'; name: string }
  | { scope: 'provider' }
);

export type OAuthModelSettings = {
  target: OAuthModelTarget;
  models: OAuthModelDefinition[];
  excludedRules: string[];
  catalogError: string;
};

type OAuthModelSettingsApi = {
  get: (path: string, query?: Record<string, string>) => Promise<unknown>;
  patch: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  put: (path: string, body: Record<string, unknown>) => Promise<unknown>;
};

const exclusionsPath = '/config/oauth/excluded-models';
const exclusionWrites = new WeakMap<OAuthModelSettingsApi, Promise<void>>();

async function readExclusions(api: OAuthModelSettingsApi): Promise<Record<string, unknown>> {
  try {
    const value = await api.get(exclusionsPath);
    if (!isRecord(value)) throw new Error('Invalid OAuth exclusion configuration');
    return value;
  } catch (error) {
    if ((error instanceof Error ? error.message : error) === 'Management API error (404): not_found') return {};
    throw error;
  }
}

// v8 accepts the provider map directly. Serialize read/modify/write operations
// so simultaneous edits to different providers preserve each other's changes.
export function saveOAuthProviderExclusions(
  provider: string, models: string[] | undefined, api: OAuthModelSettingsApi = managementApi,
): Promise<void> {
  const key = provider.trim().toLowerCase();
  if (!key) return Promise.reject(new Error('Invalid OAuth provider'));
  const pending = (exclusionWrites.get(api) ?? Promise.resolve()).then(async () => {
    const current = await readExclusions(api);
    const next = Object.fromEntries(Object.entries(current).filter(([name]) => name.trim().toLowerCase() !== key));
    if (models !== undefined) Object.defineProperty(next, key, { value: models, enumerable: true });
    await api.put(exclusionsPath, next);
  });
  const settled = pending.catch(() => {});
  exclusionWrites.set(api, settled);
  void settled.then(() => {
    if (exclusionWrites.get(api) === settled) exclusionWrites.delete(api);
  });
  return pending;
}

export const authFileExcludedRulesFromPayload = (payload: unknown): string[] => {
  let metadata = payload;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      throw new Error(translate(getCurrentLocale(), 'authFiles.models.invalidMetadata'));
    }
  }
  if (!isRecord(metadata)) {
    throw new Error(translate(getCurrentLocale(), 'authFiles.models.invalidMetadata'));
  }
  const rules = Object.prototype.hasOwnProperty.call(metadata, 'excluded_models')
    ? metadata.excluded_models
    : metadata['excluded-models'];
  if (rules === undefined || rules === null) return [];
  if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string')) {
    throw new Error(translate(getCurrentLocale(), 'authFiles.models.invalidExclusions'));
  }
  return normalizeOAuthExcludedRules(rules);
};

export const loadOAuthModelSettings = async (
  target: OAuthModelTarget,
  api: OAuthModelSettingsApi = managementApi,
): Promise<OAuthModelSettings> => {
  const [catalog, payload] = await Promise.all([
    (target.scope === 'credential'
      ? api.get('/credentials/models', { name: target.name })
      : api.get(`/routing/model-definitions/${encodeURIComponent(target.provider)}`))
      .then((definitions) => ({ models: oauthModelsFromPayload(definitions), error: '' }))
      .catch((error: unknown) => ({ models: [] as OAuthModelDefinition[], error: String(error) })),
    target.scope === 'credential'
      ? api.get('/credentials/download', { name: target.name })
      : readExclusions(api),
  ]);
  const excludedRules = target.scope === 'credential'
    ? authFileExcludedRulesFromPayload(payload)
    : oauthExcludedRulesFromPayload(payload, target.provider);
  return {
    target,
    models: oauthModelCandidates(catalog.models, excludedRules),
    excludedRules,
    catalogError: catalog.error,
  };
};

export const saveOAuthModelSettings = async (
  settings: OAuthModelSettings,
  rules: Iterable<string>,
  api: OAuthModelSettingsApi = managementApi,
): Promise<void> => {
  const excludedModels = normalizeOAuthExcludedRules(rules);
  if (excludedModels.length === settings.excludedRules.length
    && excludedModels.every((rule) => settings.excludedRules.includes(rule))) return;
  if (settings.target.scope === 'credential') {
    await api.patch('/credentials/fields', {
      name: settings.target.name,
      excluded_models: excludedModels,
    });
  } else if (excludedModels.length > 0) {
    await saveOAuthProviderExclusions(settings.target.provider, excludedModels, api);
  } else if (settings.excludedRules.length > 0) {
    await saveOAuthProviderExclusions(settings.target.provider, undefined, api);
  }
};
