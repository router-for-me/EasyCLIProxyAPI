import {
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  getQuotaCacheSnapshot,
  updateQuotaCache,
} from './quotaCache';
import { consumeCodexResetCredit, idleQuota, quotaKey, type AuthFile, type QuotaState } from './quotaService';

/** Reserve the credential before opening the asynchronous native confirmation dialog. */
export async function resetCodexQuotaWithConfirmation(
  file: AuthFile,
  confirmReset: () => Promise<boolean>,
): Promise<void> {
  const key = quotaKey(file);
  const previous = getQuotaCacheSnapshot()[key] ?? idleQuota();
  if (previous.status === 'loading') return;
  const generation = captureQuotaCacheGeneration();
  const pending: QuotaState = { ...previous, status: 'loading' };
  updateQuotaCache((current) => ({ ...current, [key]: pending }));

  const isCurrent = () => captureQuotaCacheGeneration() === generation
    && getQuotaCacheSnapshot()[key] === pending;
  const commit = (quota: QuotaState) => {
    commitQuotaCacheIfCurrent(generation, () => {
      updateQuotaCache((current) => current[key] === pending ? { ...current, [key]: quota } : current);
    });
  };

  let started = false;
  try {
    // Never treat a pending promise, dismissal, or unexpected result as consent.
    if (await confirmReset() !== true || !isCurrent()) return;
    started = true;
    commit(await consumeCodexResetCredit(file));
  } catch (error) {
    if (started) commit({
      status: 'error', rows: [], error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    // Cancellation and dialog failures preserve the displayed quota and release the lock.
    if (!started) commit(previous);
  }
}
