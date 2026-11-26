import { saveCodexSubscription, syncCodexSubscriptionToCredentialFile } from './codexSubscription';
import { enrichXaiQuotaPlan, providerForFile, quotaKey, type AuthFile, type QuotaState } from './quotaService';
import { commitQuotaCacheIfCurrent, getQuotaCacheSnapshot, updateQuotaCache } from './quotaCache';

export function persistVerifiedCodexSubscription(file: AuthFile, quota: QuotaState) {
  if (providerForFile(file) !== 'codex' || quota.status !== 'success' || quota.subscriptionSyncedAt === undefined) {
    return;
  }
  const snapshot = {
    ...(quota.codexAccountId ? { accountId: quota.codexAccountId } : {}),
    ...(quota.plan ? { plan: quota.plan } : {}),
    ...(quota.subscriptionActiveUntil ? { subscriptionActiveUntil: quota.subscriptionActiveUntil } : {}),
    ...(quota.subscriptionConfirmedFree ? { confirmedFree: true } : {}),
    updatedAt: quota.subscriptionSyncedAt,
  };
  saveCodexSubscription(file, snapshot);
  void syncCodexSubscriptionToCredentialFile(file, snapshot);
}

export function commitFetchedQuota(generation: number, file: AuthFile, quota: QuotaState) {
  const key = quotaKey(file);
  const committed = commitQuotaCacheIfCurrent(generation, () => {
    updateQuotaCache((current) => ({ ...current, [key]: quota }));
  });
  if (committed) persistVerifiedCodexSubscription(file, quota);
  if (committed && quota.status === 'success' && providerForFile(file) === 'xai') {
    void enrichXaiQuotaPlan(file, quota).then((enriched) => {
      if (enriched === quota || getQuotaCacheSnapshot()[key] !== quota) return;
      commitQuotaCacheIfCurrent(generation, () => {
        updateQuotaCache((current) => ({ ...current, [key]: enriched }));
      });
    }).catch(() => { /* Optional plan failures preserve the original quota. */ });
  }
}
