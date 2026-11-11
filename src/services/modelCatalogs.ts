import { invoke } from '@tauri-apps/api/core';
import { getCurrentLocale, translate } from '../i18n';
import { isRecord, managementApi, readString } from './managementApi';

export type RefreshModelCatalogsResponse = {
  ok: true;
  status: 'ok';
  changed_providers?: string[] | null;
  catalog?: unknown[] | null;
  codex_catalog?: unknown[] | null;
  devin_catalog?: unknown[] | null;
  sources?: unknown[] | null;
  catalogs?: unknown[] | null;
};

export async function refreshModelCatalogs(): Promise<RefreshModelCatalogsResponse> {
  let response: unknown;
  try {
    response = await managementApi.post('/models/refresh', undefined, { timeoutMs: 120_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Management API error \((404|405)\)/.test(message)) {
      throw new Error(translate(getCurrentLocale(), 'home.catalog.unsupported'));
    }
    throw error;
  }
  if (!isRecord(response) || response.ok !== true || response.status !== 'ok'
    || (response.changed_providers != null
      && (!Array.isArray(response.changed_providers)
        || !response.changed_providers.every((provider) => typeof provider === 'string' && provider.trim())))) {
    throw new Error(readString(response, 'error')
      || translate(getCurrentLocale(), 'home.catalog.invalidResponse'));
  }
  try {
    await invoke<boolean>('refresh_managed_codex_model_catalog');
  } catch (error) {
    throw new Error(translate(getCurrentLocale(), 'home.catalog.codexSyncFailed', {
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return response as RefreshModelCatalogsResponse;
}
