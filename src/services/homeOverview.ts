import { invoke } from '@tauri-apps/api/core';
import { dedupeAuthFiles, isOAuthCredentialFile } from './authFiles';
import { authFileHealth, normalizeAuthFileCooldowns } from './authFileHealth';
import type { CoreHealthModel } from './coreHealthCheck';
import { isRecord, managementApi, readBoolean, readString } from './managementApi';

export type HomeUsageSummary = {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  canceledCount: number;
  successRate: number | null;
};

export type HomeCredentialSummary = {
  total: number;
  available: number;
  unavailable: number;
  unknown: number;
};

export type HomeOverviewMetric = 'usage' | 'credentials' | 'providerKeys' | 'models';

export type HomeOverviewSnapshot = {
  usage: HomeUsageSummary | null;
  credentials: HomeCredentialSummary | null;
  providerKeys: number | null;
  models: CoreHealthModel[] | null;
  errors: Partial<Record<HomeOverviewMetric, string>>;
};

export function summarizeHomeUsage(payload: unknown): HomeUsageSummary {
  if (!isRecord(payload)) throw new Error('Invalid usage overview response');
  const count = (key: string): number => {
    const value = payload[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid usage overview response');
    }
    return value;
  };
  const totalRequests = count('totalRequests');
  const successCount = count('successCount');
  const failureCount = count('failureCount');
  const canceledCount = count('canceledCount');
  const completed = successCount + failureCount;
  if (completed + canceledCount > totalRequests) throw new Error('Invalid usage overview response');
  return {
    totalRequests, successCount, failureCount, canceledCount,
    // Canceled requests do not indicate provider failure. With no completed
    // requests there is no measured success rate, including an empty window.
    successRate: completed > 0 ? successCount / completed * 100 : null,
  };
}

export function summarizeHomeCredentials(payload: unknown): HomeCredentialSummary {
  if (!isRecord(payload) || !Array.isArray(payload.files) || !payload.files.every(isRecord)) {
    throw new Error('Invalid credential list response');
  }
  const files = dedupeAuthFiles(payload.files).filter(isOAuthCredentialFile);
  const summary: HomeCredentialSummary = { total: files.length, available: 0, unavailable: 0, unknown: 0 };
  for (const file of files) {
    const health = authFileHealth(file);
    const cooldowns = normalizeAuthFileCooldowns(file.cooldowns, 0);
    if (health.disabled || readBoolean(file, 'unavailable')
      || cooldowns?.records?.some((entry) => entry.scope === 'credential')) {
      summary.unavailable += 1;
    } else if (health.tone === 'success' && cooldowns?.records !== null) {
      summary.available += 1;
    } else {
      // A model-specific error is not evidence that the whole credential has
      // stopped participating; incomplete/refreshing states remain unknown.
      summary.unknown += 1;
    }
  }
  return summary;
}

// Takes only the raw v8 /config/api-keys subtree. Access keys for clients live
// under /config/access/api-keys and must never contribute to this count.
export function countHomeProviderKeys(payload: unknown): number {
  if (!isRecord(payload)) throw new Error('Invalid provider key configuration response');
  let count = 0;
  for (const groups of Object.values(payload)) {
    if (!Array.isArray(groups) || !groups.every(isRecord)) {
      throw new Error('Invalid provider key configuration response');
    }
    for (const group of groups) {
      if (group.keys === undefined || group.keys === null) continue;
      if (!Array.isArray(group.keys) || !group.keys.every(isRecord)) {
        throw new Error('Invalid provider key configuration response');
      }
      count += group.keys.filter((key) => typeof key['api-key'] === 'string' && key['api-key'].trim()).length;
    }
  }
  return count;
}

export function normalizeHomeModels(payload: unknown): CoreHealthModel[] {
  if (!Array.isArray(payload)) throw new Error('Invalid core model list response');
  const models = new Map<string, CoreHealthModel>();
  for (const item of payload) {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) {
      throw new Error('Invalid core model list response');
    }
    const name = item.name.trim();
    if (models.has(name)) continue;
    const displayName = readString(item, 'displayName');
    models.set(name, { name, ...(displayName ? { displayName } : {}) });
  }
  return [...models.values()];
}

async function loadProviderKeys(): Promise<number> {
  try {
    return countHomeProviderKeys(await managementApi.get('/config/api-keys'));
  } catch (error) {
    const message = error instanceof Error ? error.message : error;
    // The config accessor reports an omitted optional node with this exact
    // response. Endpoint/authentication/connectivity errors stay unknown.
    if (message === 'Management API error (404): not_found') return 0;
    throw error;
  }
}

export async function loadHomeOverview(coreReady: boolean, nowMs = Date.now()): Promise<HomeOverviewSnapshot> {
  const query = {
    start: new Date(nowMs - 24 * 60 * 60_000).toISOString(),
    end: new Date(nowMs).toISOString(),
  };
  const [usage, credentials, providerKeys, models] = await Promise.allSettled([
    // Usage is stored locally and remains meaningful while the core is stopped.
    invoke<unknown>('get_usage_overview', { query }).then(summarizeHomeUsage),
    coreReady ? managementApi.get('/credentials').then(summarizeHomeCredentials) : Promise.resolve(null),
    coreReady ? loadProviderKeys() : Promise.resolve(null),
    coreReady ? invoke<unknown>('get_core_models').then(normalizeHomeModels) : Promise.resolve(null),
  ]);
  const errors: HomeOverviewSnapshot['errors'] = {};
  const result = <T>(key: HomeOverviewMetric, settled: PromiseSettledResult<T>): T | null => {
    if (settled.status === 'fulfilled') return settled.value;
    errors[key] = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
    return null;
  };
  return {
    usage: result('usage', usage),
    credentials: result('credentials', credentials),
    providerKeys: result('providerKeys', providerKeys),
    models: result('models', models),
    errors,
  };
}
