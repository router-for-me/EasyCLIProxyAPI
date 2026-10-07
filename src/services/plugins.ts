import { invoke } from '@tauri-apps/api/core';
import { isRecord, managementApi } from './managementApi';

export type PluginConfigFieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'array'
  | 'object';

export interface PluginConfigField {
  name: string;
  type: PluginConfigFieldType | string;
  enumValues: string[];
  description: string;
}

export type PluginConfigObject = Record<string, unknown>;

export interface PluginMetadata {
  name: string;
  version: string;
  author: string;
  githubRepository: string;
  logo: string;
  configFields: PluginConfigField[];
}

export interface PluginMenu {
  path: string;
  menu: string;
  description: string;
  originalIndex?: number;
}

export interface PluginListEntry {
  id: string;
  path: string;
  configured: boolean;
  registered: boolean;
  enabled: boolean;
  effectiveEnabled: boolean;
  supportsOAuth: boolean;
  oauthProvider?: string;
  supportsQuota: boolean;
  quotaProvider?: string;
  logo: string;
  configFields: PluginConfigField[];
  menus: PluginMenu[];
  metadata: PluginMetadata | null;
}

export interface PluginListResponse {
  pluginsEnabled: boolean;
  pluginsDir: string;
  plugins: PluginListEntry[];
}

export interface PluginDeleteResult {
  status: string;
  id: string;
  path: string;
  fileDeleted: boolean;
  configuredRemoved: boolean;
  restartRequired: boolean;
}

export interface PluginStoreEntry {
  storeId: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  repository: string;
  installType: string;
  authRequired: boolean;
  authConfigured: boolean;
  platforms: PluginStorePlatform[];
  logo: string;
  homepage: string;
  license: string;
  tags: string[];
  installed: boolean;
  installedVersion: string;
  installedSourceId: string;
  installSourceStatus: string;
  path: string;
  configured: boolean;
  registered: boolean;
  enabled: boolean;
  effectiveEnabled: boolean;
  updateAvailable: boolean;
}

export interface PluginStorePlatform {
  goos: string;
  goarch: string;
}

export interface PluginStoreSourceError {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  message: string;
}

export interface PluginStoreResponse {
  pluginsEnabled: boolean;
  pluginsDir: string;
  sourceErrors: PluginStoreSourceError[];
  plugins: PluginStoreEntry[];
}

export interface PluginStoreInstallResult {
  status: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  id: string;
  version: string;
  installType: string;
  path: string;
  pluginsEnabled: boolean;
  restartRequired: boolean;
}

export interface PluginSettings {
  enabled: boolean;
  dir: string;
  storeSources: string[];
  storeAuth: Record<string, unknown>[];
}

export interface PluginStoreInstallOptions {
  sourceId?: string;
  version?: string;
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];

function configFields(value: unknown): PluginConfigField[] {
  return records(value).filter((field) => text(field.name)).map((field) => ({
    name: text(field.name),
    type: text(field.type) || 'string',
    enumValues: strings(field.enum_values),
    description: text(field.description),
  }));
}

function metadata(value: unknown): PluginMetadata | null {
  if (!isRecord(value)) return null;
  return {
    name: text(value.name), version: text(value.version), author: text(value.author),
    githubRepository: text(value.github_repository), logo: text(value.logo),
    configFields: configFields(value.config_fields),
  };
}

function providerKey(value: unknown): string | undefined {
  const key = text(value).toLowerCase().replace(/_/g, '-');
  return /^[a-z0-9-]+$/.test(key) ? key : undefined;
}

function responseObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label} response`);
  return value;
}

export function normalizePluginList(value: unknown): PluginListResponse {
  const source = responseObject(value, 'plugin list');
  if (!Array.isArray(source.plugins)) throw new Error('Invalid plugin list response');
  return {
    pluginsEnabled: source.plugins_enabled === true,
    pluginsDir: text(source.plugins_dir) || 'plugins',
    plugins: records(source.plugins).filter((entry) => text(entry.id)).map((entry) => {
      const info = metadata(entry.metadata);
      const fields = configFields(entry.config_fields);
      return {
        id: text(entry.id), path: text(entry.path), configured: entry.configured === true,
        registered: entry.registered === true, enabled: entry.enabled === true,
        effectiveEnabled: entry.effective_enabled === true,
        supportsOAuth: entry.supports_oauth === true, oauthProvider: providerKey(entry.oauth_provider),
        supportsQuota: entry.supports_quota === true, quotaProvider: providerKey(entry.quota_provider),
        logo: text(entry.logo) || info?.logo || '',
        configFields: fields.length ? fields : info?.configFields ?? [],
        menus: Array.isArray(entry.menus) ? entry.menus.flatMap((menu, originalIndex) =>
          isRecord(menu) && text(menu.path) ? [{
            path: text(menu.path), menu: text(menu.menu), description: text(menu.description), originalIndex,
          }] : []) : [],
        metadata: info,
      };
    }),
  };
}

export function normalizePluginStore(value: unknown): PluginStoreResponse {
  const source = responseObject(value, 'plugin store');
  if (!Array.isArray(source.plugins)) throw new Error('Invalid plugin store response');
  return {
    pluginsEnabled: source.plugins_enabled === true,
    pluginsDir: text(source.plugins_dir) || 'plugins',
    sourceErrors: records(source.source_errors).map((entry) => ({
      sourceId: text(entry.source_id), sourceName: text(entry.source_name),
      sourceUrl: text(entry.source_url), message: text(entry.message),
    })),
    plugins: records(source.plugins).filter((entry) => text(entry.id)).map((entry) => ({
      storeId: text(entry.store_id) || [text(entry.source_id), text(entry.id)].filter(Boolean).join('/'),
      sourceId: text(entry.source_id), sourceName: text(entry.source_name), sourceUrl: text(entry.source_url),
      id: text(entry.id), name: text(entry.name), description: text(entry.description),
      author: text(entry.author), version: text(entry.version), repository: text(entry.repository),
      installType: text(entry.install_type), authRequired: entry.auth_required === true,
      authConfigured: entry.auth_configured === true,
      platforms: records(entry.platforms).map((platform) => ({
        goos: text(platform.goos), goarch: text(platform.goarch),
      })),
      logo: text(entry.logo), homepage: text(entry.homepage), license: text(entry.license), tags: strings(entry.tags),
      installed: entry.installed === true, installedVersion: text(entry.installed_version),
      installedSourceId: text(entry.installed_source_id), installSourceStatus: text(entry.install_source_status),
      path: text(entry.path), configured: entry.configured === true, registered: entry.registered === true,
      enabled: entry.enabled === true, effectiveEnabled: entry.effective_enabled === true,
      updateAvailable: entry.update_available === true,
    })),
  };
}

function pluginPathID(id: string): string {
  const value = id.trim();
  // Match the core's plugin ID contract (pluginhost/platform.go and pluginstore/registry.go).
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('Invalid plugin ID');
  }
  // Dots inside valid IDs are data; encode them so the native generic path guard
  // does not mistake a name such as sample..provider for traversal.
  return encodeURIComponent(value).replace(/\./g, '%2E');
}

async function getOptionalConfig(path: string): Promise<Record<string, unknown>> {
  try {
    return responseObject(await managementApi.get(path), 'plugin configuration');
  } catch (error) {
    const message = error instanceof Error ? error.message : error;
    if (message === 'Management API error (404): not_found') return {};
    throw error;
  }
}

export interface PluginConfigPatchOptions {
  nullMeansDelete?: boolean;
  removeKeys?: string[];
}

/** A patch contains complete top-level values; raw JSON can retain literal nulls. */
export function mergePluginConfigPatch(
  current: PluginConfigObject, changes: PluginConfigObject, options: PluginConfigPatchOptions = {},
): PluginConfigObject {
  const entries = new Map(Object.entries(current));
  for (const [key, value] of Object.entries(changes)) {
    if (value === null && options.nullMeansDelete !== false) entries.delete(key);
    else entries.set(key, value);
  }
  for (const key of options.removeKeys ?? []) entries.delete(key);
  return Object.fromEntries(entries);
}

export const pluginsApi = {
  list: async (): Promise<PluginListResponse> => normalizePluginList(await managementApi.get('/plugins')),

  updateEnabled: (id: string, enabled: boolean) =>
    managementApi.put(`/config/plugins/configs/${pluginPathID(id)}/enabled`, enabled),

  async deletePlugin(id: string): Promise<PluginDeleteResult> {
    const value = responseObject(await managementApi.delete(`/plugins/${pluginPathID(id)}`), 'plugin deletion');
    return {
      status: text(value.status), id: text(value.id), path: text(value.path),
      fileDeleted: value.file_deleted === true, configuredRemoved: value.configured_removed === true,
      restartRequired: value.restart_required === true,
    };
  },

  getConfig: (id: string): Promise<PluginConfigObject> =>
    getOptionalConfig(`/config/plugins/configs/${pluginPathID(id)}`),

  putConfig: (id: string, config: PluginConfigObject) =>
    managementApi.put(`/config/plugins/configs/${pluginPathID(id)}`, config),

  async patchConfig(id: string, changes: PluginConfigObject, options: PluginConfigPatchOptions = {}) {
    // The core recursively merges PATCH objects and retains nulls. Read the latest
    // instance and PUT only this instance to support field removal and replacement.
    const current = await pluginsApi.getConfig(id);
    return pluginsApi.putConfig(id, mergePluginConfigPatch(current, changes, options));
  },

  async getSettings(): Promise<PluginSettings> {
    const value = await getOptionalConfig('/config/plugins');
    return {
      enabled: value.enabled === true, dir: text(value.dir) || 'plugins',
      storeSources: strings(value['store-sources']), storeAuth: records(value['store-auth']),
    };
  },

  updateSettings(changes: Partial<PluginSettings>) {
    const body: Record<string, unknown> = {};
    if (changes.enabled !== undefined) body.enabled = changes.enabled;
    if (changes.dir !== undefined) body.dir = changes.dir.trim() || 'plugins';
    if (changes.storeSources !== undefined) body['store-sources'] = changes.storeSources;
    if (changes.storeAuth !== undefined) body['store-auth'] = changes.storeAuth;
    // PATCH preserves per-plugin configuration, auth-revision and future fields.
    return managementApi.patch('/config/plugins', body);
  },
};

export const pluginStoreApi = {
  list: async (): Promise<PluginStoreResponse> => normalizePluginStore(await managementApi.get('/plugins/store')),

  async install(id: string, options: PluginStoreInstallOptions = {}): Promise<PluginStoreInstallResult> {
    const source = options.sourceId?.trim();
    const version = options.version?.trim();
    const query = Object.fromEntries([
      ...(source ? [['source', source]] : []),
      ...(version ? [['version', version]] : []),
    ]);
    // Native request has a separate query field: source identity survives even
    // when multiple registries expose the same plugin ID.
    const value = responseObject(await invoke<unknown>('management_request', {
      request: {
        method: 'POST', path: `/plugins/store/${pluginPathID(id)}/install`, query,
        body: version ? { version } : undefined, timeoutMs: 120_000,
      },
    }), 'plugin installation');
    return {
      status: text(value.status), sourceId: text(value.source_id), sourceName: text(value.source_name),
      sourceUrl: text(value.source_url), id: text(value.id), version: text(value.version),
      installType: text(value.install_type), path: text(value.path),
      pluginsEnabled: value.plugins_enabled === true, restartRequired: value.restart_required === true,
    };
  },
};
