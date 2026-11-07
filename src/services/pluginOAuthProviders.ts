import type { PluginListEntry } from './plugins';

/** OAuth providers are declared by the running plugins, independently of their IDs or menus. */
export function collectPluginOAuthProviders(
  plugins: PluginListEntry[],
  builtInProviderIds: readonly string[] = [],
): PluginListEntry[] {
  const seen = new Set(builtInProviderIds);
  const result: PluginListEntry[] = [];
  for (const plugin of plugins) {
    if (!plugin.effectiveEnabled || !plugin.supportsOAuth) continue;
    if (plugin.oauthProviderEntries && plugin.oauthProviderEntries.length > 0) {
      for (const entry of plugin.oauthProviderEntries) {
        const id = entry.identifier;
        if (!id || !/^[a-z0-9-]+$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        result.push({
          ...plugin,
          oauthProvider: id,
          logo: entry.logo || plugin.logo,
          metadata: {
            name: entry.name || plugin.metadata?.name || plugin.id,
            version: plugin.metadata?.version ?? '',
            author: plugin.metadata?.author ?? '',
            githubRepository: plugin.metadata?.githubRepository ?? '',
            logo: entry.logo || plugin.metadata?.logo || plugin.logo,
            configFields: plugin.metadata?.configFields ?? plugin.configFields,
          },
        });
      }
      continue;
    }
    if (plugin.oauthProviders && plugin.oauthProviders.length > 0) {
      for (const id of plugin.oauthProviders) {
        if (!id || !/^[a-z0-9-]+$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        result.push({
          ...plugin,
          oauthProvider: id,
        });
      }
      continue;
    }
    const provider = plugin.oauthProvider;
    if (!provider || !/^[a-z0-9-]+$/.test(provider) || seen.has(provider)) continue;
    seen.add(provider);
    result.push(plugin);
  }
  return result;
}
