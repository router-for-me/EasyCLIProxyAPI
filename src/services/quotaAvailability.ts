import { authFileHealth } from './authFileHealth';
import { providerForFile, type AuthFile, type QuotaState, type QuotaRow } from './quotaService';

export type AvailabilityKind = 'available' | 'exhausted' | 'creditBacked' | 'limited' | 'unknown' | 'disabled' | 'unavailable' | 'resetDue';
export type GroupAvailability = { id: string; label: string; kind: AvailabilityKind; blockers: QuotaRow[]; recoveryAt?: number };
export type Availability = { kind: AvailabilityKind; blockers: QuotaRow[]; recoveryAt?: number; updating: boolean; groups?: GroupAvailability[]; reason?: 'paidQuota' | 'notReported' | 'unmapped'; uncertainty?: 'stale' | 'checkFailed' | 'notChecked' | 'offline' | 'health' | 'incomplete'; includedOnly?: boolean; creditBalance?: number; resetsAvailable?: number };
export const QUOTA_FRESH_MS = 6 * 60_000;

/** Included allowance and reported credit fallback. Neither is a routing decision or a success guarantee. */
export function quotaAvailability(file: AuthFile, quota: QuotaState | undefined, now: number, stale = false): Availability {
  const health = authFileHealth(file);
  const base = { blockers: [] as QuotaRow[], updating: quota?.status === 'loading' };
  if (health.disabled) return { ...base, kind: 'disabled' };
  if (stale) return { ...base, kind: 'unknown', uncertainty: 'offline' };
  if (health.tone === 'error') return { ...base, kind: 'unavailable' };
  if (quota?.status === 'error') return { ...base, kind: 'unknown', uncertainty: 'checkFailed' };
  if (!quota?.fetchedAt || quota.status === 'idle') return { ...base, kind: 'unknown', uncertainty: 'notChecked' };
  if (now - quota.fetchedAt > QUOTA_FRESH_MS || quota.fetchedAt > now + 60_000) return { ...base, kind: 'unknown', uncertainty: 'stale' };
  if (providerForFile(file) === 'antigravity') {
    if (health.tone !== 'success' || !quota.rows.length || quota.rows.some(row => !row.groupId)) return { ...base, kind: 'unknown', uncertainty: health.tone !== 'success' ? 'health' : 'incomplete' };
    const groups: GroupAvailability[] = [...new Set(quota.rows.map(row => row.groupId!))].map(id => {
      const rows = quota.rows.filter(row => row.groupId === id);
      const label = rows[0].groupLabel || rows[0].label;
      const blockers = rows.filter(row => row.remainingPercent === 0);
      const future = (row: QuotaRow) => typeof row.resetAtMs === 'number' && Number.isFinite(row.resetAtMs) && row.resetAtMs > now;
      if (blockers.length) {
        const active = blockers.filter(row => !Number.isFinite(row.resetAtMs) || future(row));
        return { id, label, blockers, kind: active.length ? 'exhausted' : 'resetDue',
          recoveryAt: active.length && active.every(future) ? Math.max(...active.map(row => row.resetAtMs!)) : undefined };
      }
      const clear = rows.every(row => typeof row.remainingPercent === 'number' && Number.isFinite(row.remainingPercent) && row.remainingPercent > 0
        && (row.resetAtMs === undefined || future(row)));
      return { id, label, blockers, kind: clear ? 'available' : 'unknown' };
    });
    const kind = groups.every(group => group.kind === 'available') ? 'available'
      : groups.every(group => group.kind === 'exhausted') ? 'exhausted'
      : groups.every(group => group.kind === 'resetDue') ? 'resetDue'
      : groups.some(group => group.kind === 'unknown') ? 'unknown' : 'limited';
    // Independent model groups recover separately: the first known group recovery restores some allowance.
    const recoveryAt = kind === 'exhausted' && groups.every(group => group.recoveryAt !== undefined)
      ? Math.min(...groups.map(group => group.recoveryAt!)) : undefined;
    return { ...base, kind, groups, uncertainty: kind === 'unknown' ? 'incomplete' : undefined, blockers: groups.flatMap(group => group.blockers), recoveryAt };
  }
  if (providerForFile(file) === 'xai') {
    const reason = quota.rows.length && quota.rows.every(row => row.scope === 'paid') ? 'paidQuota'
      : quota.rows.every(row => row.remainingPercent === null) ? 'notReported' : 'unmapped';
    return { ...base, kind: 'unknown', reason };
  }
  const account = quota.rows.filter(row => row.scope === 'account');
  const model = quota.rows.filter(row => row.scope === 'model');
  const zero = (row: QuotaRow) => row.remainingPercent === 0;
  const blockers = account.filter(zero);
  const future = (row: QuotaRow) => typeof row.resetAtMs === 'number' && Number.isFinite(row.resetAtMs) && row.resetAtMs > now;
  if (blockers.length) {
    const active = blockers.filter(row => !Number.isFinite(row.resetAtMs) || future(row));
    if (!active.length) return { ...base, blockers, kind: 'resetDue' };
    const codex = providerForFile(file) === 'codex';
    return { ...base, blockers, kind: codex && quota.credits?.available ? 'creditBacked' : 'exhausted',
      includedOnly: codex,
      creditBalance: codex && quota.credits?.available ? quota.credits.balance : undefined,
      resetsAvailable: codex ? quota.resetCredits : undefined,
      recoveryAt: active.every(future) ? Math.max(...active.map(row => row.resetAtMs!)) : undefined };
  }
  const known = (row: QuotaRow) => typeof row.remainingPercent === 'number' && Number.isFinite(row.remainingPercent) && row.remainingPercent > 0;
  if (health.tone !== 'success' || !account.length || account.some(row => !known(row) || (row.resetAtMs !== undefined && !future(row)))) return { ...base, kind: 'unknown', uncertainty: health.tone !== 'success' ? 'health' : 'incomplete' };
  if (model.some(zero)) return { ...base, kind: 'limited', blockers: model.filter(zero) };
  if (model.some(row => !known(row) || (row.resetAtMs !== undefined && !future(row)))) return { ...base, kind: 'unknown', uncertainty: health.tone !== 'success' ? 'health' : 'incomplete' };
  return { ...base, kind: 'available' };
}

export const quotaPercent = (value: number) => value > 0 && value < 1 ? '<1' : String(Math.round(value));
