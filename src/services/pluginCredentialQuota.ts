import { isRecord, managementApi, normalizeAuthIndex, readString } from './managementApi';
import { pluginsApi, type PluginListEntry } from './plugins';
import { captureQuotaCacheGeneration } from './quotaCache';
import type { AuthFile, QuotaRow, QuotaState } from './quotaService';

export const credentialQuotaPlugin = (file: AuthFile): string =>
  file.supports_quota === false || file.supportsQuota === false ? '' : readString(file, 'quota_plugin_id', 'quotaPluginId');

export const supportsPluginCredentialQuota = (file: AuthFile): boolean => {
  const supported = file.supportsQuota ?? file.supports_quota;
  return supported === true || supported === 'true' || supported === '1';
};

export function resolveQuotaPluginId(plugins: PluginListEntry[], provider: string): string | undefined {
  const normalize = (value: string | undefined) => (value ?? '').trim().toLowerCase().replace(/_/g, '-');
  const target = normalize(provider);
  if (!target) return undefined;
  const candidates = plugins.filter(plugin => plugin.registered && plugin.supportsQuota);
  return (candidates.find(plugin => normalize(plugin.quotaProvider) === target)
    ?? candidates.find(plugin => normalize(plugin.id) === target)
    ?? candidates.find(plugin => normalize(plugin.oauthProvider) === target)
    ?? (candidates.length === 1 ? candidates[0] : undefined))?.id;
}

// Share concurrent lookups, but never retain a plugin list across connection generations.
let pluginLookup: { generation: number; promise: Promise<PluginListEntry[]> } | undefined;
async function quotaPlugins(): Promise<PluginListEntry[]> {
  const generation = captureQuotaCacheGeneration();
  if (pluginLookup?.generation === generation) return pluginLookup.promise;
  const entry = { generation, promise: pluginsApi.list().then(result => result.plugins) };
  pluginLookup = entry;
  try { return await entry.promise; }
  finally { if (pluginLookup === entry) pluginLookup = undefined; }
}

export function parsePluginCredentialQuota(payload: unknown): QuotaState {
  if (!isRecord(payload)) throw new Error('Invalid plugin quota response');
  if (payload.groups !== undefined && !Array.isArray(payload.groups)) throw new Error('Invalid plugin quota groups');
  const rows: QuotaRow[] = [];
  for (const group of (payload.groups ?? []) as unknown[]) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const label = readString(group, 'displayName', 'display_name');
    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) continue;
      const fraction = bucket.remainingFraction ?? bucket.remaining_fraction;
      const reset = readString(bucket, 'resetTime', 'reset_time');
      const resetAtMs = Date.parse(reset);
      rows.push({ label: [label, readString(bucket, 'window')].filter(Boolean).join(' · ') || 'Quota',
        remainingPercent: typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(100, Math.max(0, fraction * 100)) : null,
        ...(reset ? { reset } : {}), ...(Number.isFinite(resetAtMs) ? { resetAtMs } : {}),
        detail: readString(bucket, 'description') || undefined,
      });
    }
  }
  for (const metric of Array.isArray(payload.summary) ? payload.summary : []) {
    if (!isRecord(metric) || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) continue;
    let detail = String(metric.value);
    if (metric.format === 'currency' && typeof metric.currency === 'string') {
      try { detail = new Intl.NumberFormat(undefined, { style: 'currency', currency: metric.currency }).format(metric.value); } catch { /* Retain the numeric amount for unknown currencies. */ }
    } else if (typeof metric.unit === 'string') detail += ` ${metric.unit}`;
    rows.push({ label: readString(metric, 'label', 'key'), remainingPercent: null, detail });
  }
  const offset = payload.serverTimeOffsetMs ?? payload.server_time_offset_ms;
  return { status: 'success', rows, plan: readString(payload.subscription, 'plan', 'tierName', 'tier_name') || undefined,
    ...(typeof offset === 'number' && Number.isFinite(offset) ? { serverTimeOffsetMs: offset } : {}), fetchedAt: Date.now() };
}

export async function loadPluginCredentialQuota(file: AuthFile): Promise<QuotaState> {
  try {
    const generation = captureQuotaCacheGeneration();
    let plugin = credentialQuotaPlugin(file);
    if (!plugin && supportsPluginCredentialQuota(file)) {
      const provider = readString(file, 'quotaProvider', 'quota_provider');
      if (!provider) throw new Error('This credential has no supported plugin quota route');
      plugin = resolveQuotaPluginId(await quotaPlugins(), provider) ?? '';
    }
    if (generation !== captureQuotaCacheGeneration()) throw new Error('Connection changed during quota lookup');
    const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
    if (!plugin || !authIndex || file.disabled === true) throw new Error('Plugin quota is unavailable for this credential');
    return parsePluginCredentialQuota(await managementApi.post(`/plugins/${encodeURIComponent(plugin)}/quota`, { auth_index: authIndex }));
  } catch (reason) { return { status: 'error', rows: [], error: reason instanceof Error ? reason.message : String(reason) }; }
}
