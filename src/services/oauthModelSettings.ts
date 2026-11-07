import { getCurrentLocale, translate } from '../i18n';
import { isRecord, managementApi, readString } from './managementApi';
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

export async function syncOAuthProviderExclusionsToCredentials(
  provider: string,
  rules: Iterable<string>,
  api: OAuthModelSettingsApi = managementApi,
): Promise<number> {
  const key = provider.trim().toLowerCase();
  if (!key) return 0;
  const normalizedRules = normalizeOAuthExcludedRules(rules);
  try {
    const creds = await api.get('/credentials');
    if (!isRecord(creds) || !Array.isArray(creds.files)) return 0;
    let count = 0;
    for (const file of creds.files) {
      if (!isRecord(file)) continue;
      const fileProvider = (readString(file, 'provider', 'oauth_provider') || '').trim().toLowerCase();
      const fileName = readString(file, 'name', 'id');
      if (fileName && (fileProvider === key || fileName.toLowerCase().startsWith(key))) {
        await api.patch('/credentials/fields', {
          name: fileName,
          excluded_models: normalizedRules,
        });
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
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
  options?: { syncCredentials?: boolean },
): Promise<void> => {
  const excludedModels = normalizeOAuthExcludedRules(rules);
  const unchanged = excludedModels.length === settings.excludedRules.length
    && excludedModels.every((rule) => settings.excludedRules.includes(rule));
  if (settings.target.scope === 'credential') {
    if (!unchanged) {
      await api.patch('/credentials/fields', {
        name: settings.target.name,
        excluded_models: excludedModels,
      });
    }
  } else {
    if (!unchanged) {
      if (excludedModels.length > 0) {
        await saveOAuthProviderExclusions(settings.target.provider, excludedModels, api);
      } else if (settings.excludedRules.length > 0) {
        await saveOAuthProviderExclusions(settings.target.provider, undefined, api);
      }
    }
    if (options?.syncCredentials) {
      await syncOAuthProviderExclusionsToCredentials(settings.target.provider, excludedModels, api);
    }
  }
};