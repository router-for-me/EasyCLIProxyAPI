import { getPluginSupport, pluginStoreApi, pluginsApi, type PluginListEntry, type PluginStoreResponse } from './services/plugins';
import {
  filterInstalledStorePlugins, isNewerPluginRelease, refreshPluginReleaseVersions,
} from './services/pluginReleaseVersions';
import { isPluginInstalled } from './services/pluginStatus';

/**
 * Known update targets survive transient store or release failures: a failed
 * check never proves an update disappeared. Only a successful check, a
 * completed update, or an uninstall removes a known target.
 */
const knownUpdates = new Map<string, string>();
/**
 * Plugin IDs finished (updated or uninstalled) while a check was already
 * running. A check drops their results because they were read before that
 * change; the entry is consumed by that check so later checks report normally.
 */
const staleCheckTargets = new Set<string>();
let startupCheckStarted = false;
const listeners = new Set<() => void>();

/** Notifies the sidebar when known plugin updates change. */
export function subscribePluginUpdates(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyPluginUpdates() {
  for (const listener of [...listeners]) listener();
}

export const readKnownPluginUpdates = (): Record<string, string> => Object.fromEntries(knownUpdates);

export function clearKnownPluginUpdate(pluginID: string) {
  knownUpdates.delete(pluginID);
  notifyPluginUpdates();
}

export function resetPluginUpdateNotifications() {
  knownUpdates.clear();
  staleCheckTargets.clear();
  startupCheckStarted = false;
  notifyPluginUpdates();
}

/** A finished update is no longer pending, whatever the next check says. */
export function forgetUpdatedPlugins(pluginIDs: Iterable<string>) {
  const ids = [...pluginIDs];
  for (const id of ids) knownUpdates.delete(id);
  // A check that started before this update or uninstall still carries the old
  // store rows; its stale targets must not raise the light again.
  for (const id of ids) staleCheckTargets.add(id);
  notifyPluginUpdates();
}

/** Drop targets for plugins that are no longer installed. */
export function pruneKnownPluginUpdates(installedIDs: Iterable<string>) {
  const installed = new Set(installedIDs);
  let changed = false;
  for (const id of [...knownUpdates.keys()]) {
    if (installed.has(id)) continue;
    knownUpdates.delete(id);
    changed = true;
  }
  if (changed) notifyPluginUpdates();
}

/** Equal, older and unparsable tags are never reported as a new version. */
const isNewer = (latest: string | undefined, installed: string): boolean =>
  Boolean(installed.trim() && latest) && isNewerPluginRelease(installed, latest ?? '');

/**
 * Records a successful check. Targets from sources that failed to answer are
 * kept so a transient outage does not hide a real update, and a store row from
 * a source that failed neither invents nor erases any target.
 */
export function mergeCheckedPluginUpdates(result: PluginStoreResponse, superseded: ReadonlySet<string> = new Set()) {
  const failed = new Set(result.sourceErrors.map((error) => error.sourceId).filter(Boolean));
  const next = new Map<string, string>();
  for (const entry of result.plugins) {
    const known = knownUpdates.get(entry.id);
    const trusted = !failed.has(entry.sourceId) && Boolean(entry.version);
    if (!trusted) {
      if (known && !superseded.has(entry.id)) next.set(entry.id, known);
    } else if (entry.updateAvailable && !superseded.has(entry.id) && isNewer(entry.version, entry.installedVersion)) {
      next.set(entry.id, entry.version);
    }
  }
  const unchanged = next.size === knownUpdates.size
    && [...next].every(([id, version]) => knownUpdates.get(id) === version);
  if (unchanged) return;
  knownUpdates.clear();
  for (const [id, version] of next) knownUpdates.set(id, version);
  notifyPluginUpdates();
}

/**
 * Checks installed plugins against their store source, including disabled
 * ones. Store and release lookups are single batched requests.
 */
export async function checkInstalledPluginUpdates(
  installedPlugins: PluginListEntry[],
): Promise<PluginStoreResponse | null> {
  const installed = installedPlugins.filter(isPluginInstalled);
  if (!installed.length || !(await getPluginSupport())) return null;
  return refreshInstalledStoreEntries(await pluginStoreApi.list(), installed);
}

function refreshInstalledStoreEntries(store: PluginStoreResponse, installed: PluginListEntry[]) {
  const filtered = filterInstalledStorePlugins(store, installed);
  if (!filtered.plugins.length) return null;
  return refreshPluginReleaseVersions(filtered);
}

/**
 * Startup check runs once per session, is never awaited by rendering, and
 * stays silent on failure. Known updates decide the sidebar indicator alone,
 * so a store row that cannot be re-read never invents or drops a light.
 */
export function runStartupPluginUpdateCheck() {
  if (startupCheckStarted) return;
  startupCheckStarted = true;
  void (async () => {
    try {
      const list = await pluginsApi.list();
      if (!list.pluginsEnabled) return;
      const installed = list.plugins.filter(isPluginInstalled);
      if (!installed.length) return;
      pruneKnownPluginUpdates(installed.map((plugin) => plugin.id));
      const checked = await refreshInstalledStoreEntries(await pluginStoreApi.list(), installed);
      if (!checked || !staleCheckTargets.size) {
        if (checked) mergeCheckedPluginUpdates(checked);
        return;
      }
      const superseded = new Set(staleCheckTargets);
      staleCheckTargets.clear();
      mergeCheckedPluginUpdates(checked, superseded);
    } catch {
      // Offline or unavailable sources must not surface errors at startup.
    }
  })();
}

export type PluginUpdateIndicatorState = 'available' | null;

export const pluginUpdateIndicatorState = (
  known: Map<string, string> | Record<string, string> = knownUpdates,
): PluginUpdateIndicatorState =>
  (known instanceof Map ? known.size : Object.keys(known).length) > 0 ? 'available' : null;