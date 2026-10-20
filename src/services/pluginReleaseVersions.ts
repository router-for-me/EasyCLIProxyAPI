import { buildRepositoryURL, getPluginRepositorySlug } from './pluginResources';
import { invoke } from '@tauri-apps/api/core';
import type { PluginStoreResponse } from './plugins';

export type PluginRelease = {
  version: string;
  name: string;
  notes: string;
  publishedAt: string;
  prerelease: boolean;
};

const releaseCache = new Map<string, { expiresAt: number; releases: PluginRelease[] }>();
const RELEASE_CACHE_MS = 5 * 60_000;

export const supportsPluginVersionSelection = (installType: string): boolean =>
  installType.trim().toLowerCase() === 'github-release';

export const isValidManualReleaseTag = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value.trim());

export function getGitHubRepositorySlug(repository: string): string {
  const normalized = repository.trim().replace(/^github\.com\//i, '');
  const value = buildRepositoryURL(normalized);
  if (!value) return '';
  const url = new URL(value);
  if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return '';
  return getPluginRepositorySlug(normalized);
}

export function buildGitHubReleasesPageURL(repository: string): string {
  const slug = getGitHubRepositorySlug(repository);
  return slug ? `https://github.com/${slug}/releases` : '';
}

export function formatPluginVersion(version: string): string {
  const value = version.trim().replace(/^v/i, '');
  return value ? `v${value}` : '';
}

export function comparePluginReleaseVersions(installed: string, target: string): number {
  const current = installed.trim().replace(/^v/i, '');
  const next = target.trim().replace(/^v/i, '');
  if (current === next) return 0;
  if (!/^\d+(\.\d+)*$/.test(current) || !/^\d+(\.\d+)*$/.test(next)) return 0;
  const a = current.split('.').map(Number);
  const b = next.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0) ? -1 : 1;
  }
  return 0;
}

export function isPluginReleaseDowngrade(installed: string, target: string): boolean {
  return Boolean(installed.trim() && target.trim()) && comparePluginReleaseVersions(installed, target) > 0;
}

export function isNewerPluginRelease(installed: string, latest: string): boolean {
  const current = installed.trim().replace(/^[vV]/, '');
  const next = latest.trim().replace(/^[vV]/, '');
  if (!current || !next || current === next) return false;
  if (!/^\d+(\.\d+)*$/.test(current) || !/^\d+(\.\d+)*$/.test(next)) return true;
  return comparePluginReleaseVersions(current, next) < 0;
}

function releaseText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizePluginRelease(value: unknown): PluginRelease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const version = releaseText(entry.version).trim().replace(/^v/i, '');
  if (!isValidManualReleaseTag(version)) return null;
  return {
    version,
    name: releaseText(entry.name).trim() || `v${version}`,
    notes: releaseText(entry.notes),
    publishedAt: releaseText(entry.published_at).trim(),
    prerelease: entry.prerelease === true,
  };
}

export async function loadPluginReleases(
  repository: string,
  options: { refresh?: boolean } = {},
): Promise<PluginRelease[]> {
  const slug = getGitHubRepositorySlug(repository);
  if (!slug) throw new Error('Invalid GitHub repository');
  const cached = releaseCache.get(slug);
  if (!options.refresh && cached && cached.expiresAt > Date.now()) return cached.releases;
  const value = await invoke<unknown>('get_plugin_releases', { repository: slug });
  if (!Array.isArray(value)) throw new Error('Invalid GitHub releases response');
  const releases = value.map(normalizePluginRelease).filter((release): release is PluginRelease => Boolean(release));
  const unique = releases.filter((release, index) => releases.findIndex(candidate => candidate.version === release.version) === index);
  if (!unique.length) throw new Error('No GitHub releases found');
  releaseCache.set(slug, { expiresAt: Date.now() + RELEASE_CACHE_MS, releases: unique });
  return unique;
}

export function clearPluginReleaseCache(): void {
  releaseCache.clear();
}

export async function refreshPluginReleaseVersions(store: PluginStoreResponse): Promise<PluginStoreResponse> {
  const repositories = [...new Set(store.plugins.filter(entry =>
    supportsPluginVersionSelection(entry.installType) && !entry.authRequired,
  ).map(entry => getGitHubRepositorySlug(entry.repository)).filter(Boolean))];
  if (!repositories.length) return store;
  const releases = await invoke<{ repository: string; version?: string | null; error?: string | null }[]>('get_plugin_latest_releases', { repositories });
  const versions = new Map(releases.flatMap(release => release.version ? [[release.repository, release.version] as const] : []));
  const sourceErrors = [...store.sourceErrors, ...releases.flatMap(release => {
    if (!release.error) return [];
    const entry = store.plugins.find(entry => getGitHubRepositorySlug(entry.repository) === release.repository);
    return [{ sourceId: entry?.sourceId ?? '', sourceName: entry?.name || entry?.id || release.repository, sourceUrl: entry?.sourceUrl ?? '', message: release.error }];
  })];
  const plugins = store.plugins.map(entry => {
    if (!supportsPluginVersionSelection(entry.installType) || entry.authRequired) return entry;
    const version = versions.get(getGitHubRepositorySlug(entry.repository));
    return version ? { ...entry, version, updateAvailable: entry.installed
      && ['matched', 'assumed'].includes(entry.installSourceStatus)
      && isNewerPluginRelease(entry.installedVersion, version) } : entry;
  });
  return { ...store, plugins, sourceErrors };
}
