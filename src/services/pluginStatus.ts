import type { PluginListEntry } from './plugins';

type PluginPresence = Pick<PluginListEntry, 'path' | 'registered'>;
type PluginRuntime = PluginPresence & Pick<PluginListEntry, 'enabled' | 'effectiveEnabled'>;

// /plugins also includes configuration-only entries. A saved configuration is
// not evidence that a binary was discovered or loaded into the running core.
export function isPluginInstalled(plugin: PluginPresence): boolean {
  return Boolean(plugin.path.trim()) || plugin.registered;
}

export function getPluginStatus(plugin: PluginRuntime, pluginsEnabled: boolean) {
  if (!isPluginInstalled(plugin)) return 'missingFile';
  if (!pluginsEnabled) return 'globalDisabled';
  if (!plugin.enabled) return 'inactive';
  if (plugin.effectiveEnabled) return 'active';
  // The API exposes registration, not loading progress or a failure reason.
  return 'notLoaded';
}
