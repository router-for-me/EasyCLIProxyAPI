import { quotaAvailability } from './quotaAvailability';
import { quotaKey, type AuthFile, type QuotaState } from './quotaService';
import type { DashboardRequest } from './dashboardActivity';

export function recoveryEvents(files: AuthFile[], quotas: Record<string, QuotaState>, now: number, stale = false) {
  return files.flatMap(file => {
    const state = quotaAvailability(file, quotas[quotaKey(file)], now, stale);
    if (state.groups) return state.groups.flatMap(group => group.recoveryAt && group.recoveryAt > now
      ? [{ file, at: group.recoveryAt, group: group.label, includedOnly: false }] : []);
    return state.recoveryAt && state.recoveryAt > now
      ? [{ file, at: state.recoveryAt, group: '', includedOnly: Boolean(state.includedOnly) }] : [];
  }).sort((a, b) => a.at - b.at);
}

export function recoveredAccounts(before: Record<string, string>, after: Record<string, string>) {
  return Object.keys(after).filter(key => ['exhausted', 'limited', 'creditBacked', 'resetDue'].includes(before[key]) && after[key] === 'available');
}
export function failureIdentity(item: DashboardRequest) {
  return [item.timestamp, item.auth_index, item.model, item.user_agent, item.failure_status].join('|');
}
