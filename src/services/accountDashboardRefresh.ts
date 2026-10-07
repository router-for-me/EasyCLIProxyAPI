import { accountSummary } from './accountDashboard';
import { captureQuotaCacheGeneration, commitQuotaCacheIfCurrent, getQuotaCacheSnapshot, quotaResultUpdater, updateQuotaCache } from './quotaCache';
import { loadQuota, quotaKey, type AuthFile, type QuotaState } from './quotaService';

const QUOTA_TTL = 5 * 60_000;

export async function refreshDashboardQuotas(
  files: AuthFile[], force: boolean, lastAttempt: Record<string, number>, isCurrent: () => boolean,
  load: (file: AuthFile) => Promise<QuotaState> = loadQuota,
) {
  const generation = captureQuotaCacheGeneration();
  const current = () => isCurrent() && captureQuotaCacheGeneration() === generation;
  const pending = files.filter((file) => {
    const key = quotaKey(file);
    const cached = getQuotaCacheSnapshot()[key];
    return !accountSummary(file).health.disabled && cached?.status !== 'loading'
      && (force || Date.now() - (lastAttempt[key] ?? cached?.fetchedAt ?? 0) >= QUOTA_TTL);
  });
  for (let i = 0; i < pending.length && current(); i += 2) {
    await Promise.all(pending.slice(i, i + 2).map(async (file) => {
      if (!current()) return;
      const key = quotaKey(file);
      const started = commitQuotaCacheIfCurrent(generation, () => updateQuotaCache((cache) => ({
        ...cache, [key]: { ...cache[key], status: 'loading', rows: cache[key]?.rows ?? [] },
      })));
      if (!started) return;
      lastAttempt[key] = Date.now();
      let result: QuotaState;
      try { result = await load(file); }
      catch { result = { status: 'error', rows: [] }; }
      // Finish already-started entries on unmount; pruning invalidates their generation.
      commitQuotaCacheIfCurrent(generation, () => updateQuotaCache(quotaResultUpdater(key, result)));
    }));
  }
}
