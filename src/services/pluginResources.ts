import type { PluginListEntry, PluginMenu, PluginStoreEntry } from './plugins';

export const PLUGIN_RESOURCES_REFRESH_EVENT = 'plugin-resources-refresh';
export const OFFICIAL_PLUGIN_REPO_PREFIX = 'https://github.com/router-for-me/';
export const DEFAULT_PLUGIN_STORE_SOURCE_ID = 'official';

export function notifyPluginResourcesChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PLUGIN_RESOURCES_REFRESH_EVENT));
}

export interface PluginResourceEntry {
  pluginID: string;
  pluginTitle: string;
  pluginLogo: string;
  menuIndex: number;
  menu: PluginMenu;
  label: string;
  description: string;
  route: string;
}

export const getPluginTitle = (plugin: PluginListEntry): string => plugin.metadata?.name.trim() || plugin.id;

export const buildPluginResourceRoute = (pluginID: string, menuIndex: number): string =>
  `/plugin-pages/${encodeURIComponent(pluginID)}/${menuIndex}`;

export function safePluginWebURL(value: string): string {
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href : '';
  } catch {
    return '';
  }
}

/** Resource paths are backend-owned; never rewrite /v0/resource to /v8/management. */
export function resolvePluginAssetURL(value: string, coreOrigin: string): string {
  const candidate = value.trim();
  if (/^https?:\/\//i.test(candidate)) return safePluginWebURL(candidate);
  if (!candidate.startsWith('/') || candidate.startsWith('//') || /[\\\u0000-\u001f]/.test(candidate)) return '';
  const origin = safePluginWebURL(coreOrigin);
  if (!origin) return '';
  return `${new URL(origin).origin}${candidate}`;
}

export function buildRepositoryURL(repository: string): string {
  const candidate = repository.trim();
  if (/^https?:\/\//i.test(candidate)) return safePluginWebURL(candidate);
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(candidate)
    && !candidate.endsWith('/.') && !candidate.endsWith('/..')
    ? `https://github.com/${candidate}` : '';
}

export function getPluginRepositorySlug(repository: string): string {
  const value = buildRepositoryURL(repository);
  if (!value) return '';
  const url = new URL(value);
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) return '';
  return `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`;
}

export function isOfficialRepository(repository: string): boolean {
  const value = buildRepositoryURL(repository);
  if (!value) return false;
  const url = new URL(value);
  const slug = getPluginRepositorySlug(repository);
  return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com'
    && !url.port && !url.search && !url.hash
    && slug.toLowerCase().startsWith('router-for-me/') && slug.split('/')[1].length > 0;
}

// A third-party registry can copy official repository metadata. Both the
// backend-assigned source identity and repository must match the official source.
export const isOfficialPlugin = (entry: Pick<PluginStoreEntry, 'sourceId' | 'repository'>): boolean =>
  entry.sourceId.trim().toLowerCase() === DEFAULT_PLUGIN_STORE_SOURCE_ID
  && isOfficialRepository(entry.repository);

export const isDefaultPluginStoreSource = (entry: Pick<PluginStoreEntry, 'sourceId'>): boolean =>
  entry.sourceId.trim().toLowerCase() === DEFAULT_PLUGIN_STORE_SOURCE_ID;

export const getPluginConfirmToken = (entry: Pick<PluginStoreEntry, 'repository' | 'id'>): string =>
  getPluginRepositorySlug(entry.repository) || entry.id;

export function collectPluginResourceEntries(plugins: PluginListEntry[]): PluginResourceEntry[] {
  return plugins.flatMap((plugin) => {
    if (!plugin.effectiveEnabled) return [];
    const pluginTitle = getPluginTitle(plugin);
    return plugin.menus.flatMap((menu, index) => {
      const path = menu.path.trim();
      if (!path) return [];
      const menuIndex = menu.originalIndex ?? index;
      return [{
        pluginID: plugin.id, pluginTitle, pluginLogo: plugin.logo || plugin.metadata?.logo || '',
        menuIndex, menu: { ...menu, path }, label: menu.menu.trim() || pluginTitle,
        description: menu.description.trim() || pluginTitle,
        route: buildPluginResourceRoute(plugin.id, menuIndex),
      }];
    });
  });
}
