import { enrichXaiQuotaPlan, providerForFile, quotaKey, type AuthFile, type QuotaState } from './quotaService';
import { commitQuotaCacheIfCurrent, getQuotaCacheSnapshot, updateQuotaCache } from './quotaCache';

export function commitFetchedQuota(generation: number, file: AuthFile, quota: QuotaState) {
  const key = quotaKey(file);
  const committed = commitQuotaCacheIfCurrent(generation, () => {
    updateQuotaCache((current) => ({ ...current, [key]: quota }));
  });
  if (committed && quota.status === 'success' && providerForFile(file) === 'xai') {
    void enrichXaiQuotaPlan(file, quota).then((enriched) => {
      if (enriched === quota || getQuotaCacheSnapshot()[key] !== quota) return;
      commitQuotaCacheIfCurrent(generation, () => {
        updateQuotaCache((current) => ({ ...current, [key]: enriched }));
      });
    }).catch(() => { /* Optional plan failures preserve the original quota. */ });
  }
}
