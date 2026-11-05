import { isRecord } from './managementApi';

export type MetaQuotaWindow = {
  id: 'window' | 'weekly';
  usedPercent: number | null;
  resetAt?: number;
  durationMinutes?: number;
};

export type MetaQuotaData = { plan?: string; windows: MetaQuotaWindow[] };

const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const positiveNumber = (value: unknown): number | undefined => {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
};

export function parseMetaQuotaPayload(payload: unknown): MetaQuotaData | null {
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!isRecord(payload)) return null;
  const usage = isRecord(payload.subs_usage) ? payload.subs_usage : {};
  const explicitPlan = typeof payload.subs_tier_name === 'string' ? payload.subs_tier_name.trim() : '';
  const usagePlan = typeof usage.tier === 'string' ? usage.tier.trim() : '';
  return {
    plan: explicitPlan || usagePlan || undefined,
    windows: (['window', 'weekly'] as const).map((id) => {
      const raw = isRecord(usage[id]) ? usage[id] : {};
      const used = finiteNumber(raw.used_percent);
      return {
        id,
        usedPercent: used === undefined ? null : Math.max(0, Math.min(100, used)),
        resetAt: positiveNumber(raw.resets_at),
        durationMinutes: id === 'window' ? positiveNumber(raw.window_duration_mins) : undefined,
      };
    }),
  };
}
