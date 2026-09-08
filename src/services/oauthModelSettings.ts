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
  delete: (path: string, options?: { query?: Record<string, string> }) => Promise<unknown>;
};

export const authFileExcludedRulesFromPayload = (payload: unknown): string[] => {
  let metadata = payload;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      // Parser errors can quote credential contents; show a fixed message instead.
      throw new Error(translate(getCurrentLocale(), 'authFiles.models.invalidMetadata'));
    }
  }
  if (!isRecord(metadata)) {
    throw new Error(translate(getCurrentLocale(), 'authFiles.models.invalidMetadata'));
  }
  // CPA gives the canonical key precedence, including an explicit empty array or null.
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
      ? api.get('/auth-files/models', { name: target.name })
      : api.get(`/model-definitions/${encodeURIComponent(target.provider)}`))
      .then((definitions) => ({ models: oauthModelsFromPayload(definitions), error: '' }))
      .catch((error: unknown) => ({ models: [] as OAuthModelDefinition[], error: String(error) })),
    target.scope === 'credential'
      ? api.get('/auth-files/download', { name: target.name })
      : api.get('/oauth-excluded-models'),
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
    // Patch only this field: never upload a stale copy of tokens or other metadata.
    await api.patch('/auth-files/fields', {
      name: settings.target.name,
      excluded_models: excludedModels,
    });
  } else if (excludedModels.length > 0) {
    await api.patch('/oauth-excluded-models', {
      provider: settings.target.provider,
      models: excludedModels,
    });
  } else if (settings.excludedRules.length > 0) {
    await api.delete('/oauth-excluded-models', { query: { provider: settings.target.provider } });
  }
};
