import { isRecord } from './managementApi';

export type CodexCredits = { available: boolean; balance?: number; unlimited: boolean; blocked: boolean };

/** Credits are separate from included quota; neither a balance nor a reset proves a request will succeed. */
export function codexCreditsFor(payload: unknown): CodexCredits | undefined {
  if (!isRecord(payload) || !isRecord(payload.credits)) return undefined;
  const credit = payload.credits;
  const raw = credit.balance;
  const parsed = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
  const balance = Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  const unlimited = credit.unlimited === true;
  const blocked = credit.overage_limit_reached === true || payload.spend_control_reached === true
    || (isRecord(payload.spend_control) && payload.spend_control.limit_reached === true);
  return { available: !blocked && credit.has_credits === true && (unlimited || (balance ?? 0) > 0), balance, unlimited, blocked };
}
