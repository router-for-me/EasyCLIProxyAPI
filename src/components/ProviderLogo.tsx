import { useEffect, useState } from 'react';
import { Puzzle } from 'lucide-react';
import { pluginsApi, type PluginListEntry } from '../services/plugins';
import { safePluginLogoUrl } from '../services/pluginLogos';

let pluginLookup: Promise<PluginListEntry[]> | undefined;

/** Installed plugins, shared by concurrent callers; failures yield no logos. */
export function usePluginList(): PluginListEntry[] {
  const [plugins, setPlugins] = useState<PluginListEntry[]>([]);
  useEffect(() => {
    let active = true;
    const lookup = pluginLookup ??= pluginsApi.list().then(result => result.plugins).catch(() => []);
    void lookup.then(list => { if (active) setPlugins(list); }).finally(() => { pluginLookup = undefined; });
    return () => { active = false; };
  }, []);
  return plugins;
}

type ProviderLogoProps = { src?: string; size: number; className?: string; };

/** Remote plugin logo with a generic icon when it is missing, unsafe or fails to load. */
export function PluginLogo({ src, size, className = 'provider-logo' }: ProviderLogoProps) {
  const safe = safePluginLogoUrl(src);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [safe]);
  if (!safe || failed) return <Puzzle className={className} size={size} aria-hidden="true" />;
  return <img src={safe} alt="" className={className} width={size} height={size}
    referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(true)} />;
}
