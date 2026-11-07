import type { PluginListEntry } from './plugins';

/** Only plain http(s) URLs may be loaded as remote plugin logos (no javascript:, data:, file:, ...). */
export function safePluginLogoUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

const normalizeId = (value: string | undefined) => (value ?? '').trim().toLowerCase().replace(/_/g, '-');

/** Logo of the plugin that owns a credential provider (matched by quota plugin id, then provider/id). */
export function findPluginLogo(plugins: readonly PluginListEntry[], provider: string, pluginId = ''): string {
  const target = normalizeId(provider);
  const owner = normalizeId(pluginId);
  const plugin = (owner && plugins.find(entry => normalizeId(entry.id) === owner))
    || (target && plugins.find(entry => normalizeId(entry.oauthProvider) === target
      || entry.oauthProviders?.some(p => normalizeId(p) === target)
      || entry.oauthProviderEntries?.some(e => normalizeId(e.identifier) === target)
      || normalizeId(entry.quotaProvider) === target || normalizeId(entry.id) === target));
  return plugin ? safePluginLogoUrl(plugin.logo || plugin.metadata?.logo) : '';
}

export type ProviderIcon =
  | { kind: 'builtin'; src: string }
  | { kind: 'plugin'; src: string }
  | { kind: 'generic' };

/**
 * Built-in provider icon first, then the plugin logo, otherwise a neutral generic icon
 * (never another vendor's logo).
 */
export function resolveProviderIcon(
  provider: string,
  builtInIcons: Readonly<Record<string, string>>,
  pluginLogo = '',
): ProviderIcon {
  const builtin = Object.prototype.hasOwnProperty.call(builtInIcons, provider) ? builtInIcons[provider] : '';
  if (builtin) return { kind: 'builtin', src: builtin };
  const src = safePluginLogoUrl(pluginLogo);
  return src ? { kind: 'plugin', src } : { kind: 'generic' };
}
