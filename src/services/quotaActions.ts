import {
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  getQuotaCacheSnapshot,
  updateQuotaCache,
} from './quotaCache';
import { readBoolean } from './managementApi';
import {
  consumeCodexResetCredit, idleQuota, providerForFile, quotaKey,
  type AuthFile, type QuotaState,
} from './quotaService';

const pendingActions = new Set<string>();
type QuotaActionOutcome = 'cancelled' | 'success' | 'refresh-error' | 'error';

export const canResetCodexQuota = (file: AuthFile, quota: QuotaState): boolean =>
  providerForFile(file) === 'codex'
  && !readBoolean(file, 'disabled')
  && quota.status === 'success'
  && (quota.resetCredits ?? 0) > 0
  && quota.resetCreditsApplicable !== 0
  && !(quota.actionResult?.action === 'reset' && quota.actionResult.status !== 'success');

async function runConfirmedQuotaAction(
  file: AuthFile,
  action: 'reset',
  confirmAction: () => Promise<boolean>,
  execute: (file: AuthFile) => Promise<QuotaState>,
): Promise<QuotaActionOutcome> {
  const key = quotaKey(file);
  const original = getQuotaCacheSnapshot()[key];
  const previous = original ?? idleQuota();
  if (pendingActions.has(key) || previous.status === 'loading' || readBoolean(file, 'disabled')) return 'cancelled';
  const generation = captureQuotaCacheGeneration();
  pendingActions.add(key);
  let pending: QuotaState | undefined;
  const commit = (quota: QuotaState) => {
    commitQuotaCacheIfCurrent(generation, () => {
      updateQuotaCache((current) => current[key] === pending ? { ...current, [key]: quota } : current);
    });
  };
  try {
    if (await confirmAction() !== true || captureQuotaCacheGeneration() !== generation
      || getQuotaCacheSnapshot()[key] !== original) return 'cancelled';
    pending = { ...previous, status: 'loading', pendingAction: action, actionResult: undefined };
    updateQuotaCache((current) => ({ ...current, [key]: pending! }));
    const result = await execute(file);
    if (result.status === 'error') {
      const status = 'refresh-error';
      commit({ ...previous, actionResult: { action, status, error: result.error } });
      return status;
    }
    commit({ ...result, actionResult: { action, status: 'success' } });
    return 'success';
  } catch (error) {
    if (!pending) throw error;
    commit({ ...previous, actionResult: { action, status: 'error', error: error instanceof Error ? error.message : String(error) } });
    return 'error';
  } finally {
    pendingActions.delete(key);
  }
}

export function resetCodexQuotaWithConfirmation(file: AuthFile, confirmReset: () => Promise<boolean>): Promise<QuotaActionOutcome> {
  if (!canResetCodexQuota(file, getQuotaCacheSnapshot()[quotaKey(file)] ?? idleQuota())) return Promise.resolve('cancelled');
  return runConfirmedQuotaAction(file, 'reset', confirmReset, consumeCodexResetCredit);
}
