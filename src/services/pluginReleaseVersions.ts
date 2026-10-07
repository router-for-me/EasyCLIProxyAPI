import { buildRepositoryURL, getPluginRepositorySlug } from './pluginResources';

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
