import { getCurrentLocale, translate } from '../i18n';
import { authFileHealth } from './authFileHealth';
import { authFileRequestStats } from './authFileRequests';
import { parseAuthFilePriority } from './authFiles';
import { readString } from './managementApi';
import { type AuthFile, type QuotaState } from './quotaService';

export function nextAccountReset(quota: QuotaState | undefined, now: number): number | undefined {
  if (quota?.status !== 'success') return undefined;
  const resets = quota.rows.map((row) => row.resetAtMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > now);
  return resets.length ? Math.min(...resets) : undefined;
}

export function resetCountdown(resetAt: number | undefined, now: number): string {
  if (resetAt === undefined || !Number.isFinite(resetAt)) return translate(getCurrentLocale(), 'accountDashboard.unknown');
  if (resetAt <= now) return translate(getCurrentLocale(), 'accountDashboard.resetDue');
  const minutes = Math.max(1, Math.ceil((resetAt - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? translate(getCurrentLocale(), 'accountDashboard.days', { days, hours })
    : hours ? translate(getCurrentLocale(), 'accountDashboard.hours', { hours, minutes: minutes % 60 })
      : translate(getCurrentLocale(), 'accountDashboard.minutes', { minutes });
}

export function accountSummary(file: AuthFile) {
  const stats = authFileRequestStats(file);
  const health = authFileHealth(file);
  return {
    label: readString(file, 'email', 'label', 'name') || translate(getCurrentLocale(), 'accountDashboard.unnamed'),
    priority: parseAuthFilePriority(file.priority) ?? 0,
    health,
    stats,
    ready: health.tone === 'success',
  };
}
