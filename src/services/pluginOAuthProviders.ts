import type { PluginListEntry } from './plugins';

/** OAuth providers are declared by the running plugins, independently of their IDs or menus. */
export function collectPluginOAuthProviders(
  plugins: PluginListEntry[],
  builtInProviderIds: readonly string[] = [],
): PluginListEntry[] {
  const seen = new Set(builtInProviderIds);
  return plugins.filter(plugin => {
    const provider = plugin.oauthProvider;
    if (!plugin.effectiveEnabled || !plugin.supportsOAuth || !provider
      || !/^[a-z0-9-]+$/.test(provider) || seen.has(provider)) return false;
    seen.add(provider);
    return true;
  });
}
