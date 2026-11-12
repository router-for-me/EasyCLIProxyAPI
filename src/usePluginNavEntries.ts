import { getPluginSupport, pluginsApi, type PluginListEntry } from './services/plugins';
import { useEffect, useRef, useState } from 'react';
import { collectPluginResourceEntries, PLUGIN_RESOURCES_REFRESH_EVENT } from './services/pluginResources';
import {
  readCachedPluginNavEntries,
  toPluginNavEntry,
  writeCachedPluginNavEntries,
  type PluginNavEntry,
} from './services/pluginNavigation';
import { isPluginInstalled } from './services/pluginStatus';
import { readKnownPluginUpdates, runStartupPluginUpdateCheck, subscribePluginUpdates } from './pluginUpdateModel';

export function usePluginNavEntries(coreReady: boolean) {
  const [entries, setEntries] = useState<PluginNavEntry[]>(readCachedPluginNavEntries);
  const [plugins, setPlugins] = useState<PluginListEntry[]>([]);
  const [fetched, setFetched] = useState(false);
  const [revision, setRevision] = useState(0);
  const [pluginUpdates, setPluginUpdates] = useState(readKnownPluginUpdates);
  const mounted = useRef(true);

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, refresh);
    mounted.current = true;
    const unsubscribe = subscribePluginUpdates(() => {
      if (mounted.current) setPluginUpdates(readKnownPluginUpdates());
    });
    return () => {
      mounted.current = false;
      window.removeEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, refresh);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!coreReady) {
      setFetched(false);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const supported = await getPluginSupport();
        const data = supported ? await pluginsApi.list() : null;
        if (cancelled) return;
        const next = data?.pluginsEnabled ? collectPluginResourceEntries(data.plugins).map(toPluginNavEntry) : [];
        setEntries(next);
        setPlugins(data?.pluginsEnabled ? data.plugins : []);
        writeCachedPluginNavEntries(next);
        setFetched(true);
        // Start once installed plugins are actually known, never from a rerender.
        if (data?.pluginsEnabled && data.plugins.some(isPluginInstalled)) {
          runStartupPluginUpdateCheck();
        }
        setPluginUpdates(readKnownPluginUpdates());
      } catch {
        return;
      }
    })();
    return () => { cancelled = true; };
  }, [coreReady, revision]);

  return { entries, plugins, fetched, pluginUpdates };
}