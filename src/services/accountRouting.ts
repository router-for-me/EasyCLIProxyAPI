import type { QuotaState } from './quotaService';

export type AccountRoutingCandidate = {
  id: string;
  priority: number;
  quota: QuotaState;
};

export type AccountQuotaScore = {
  bottleneckRemaining: number;
  averageRemaining: number;
  knownWindows: number;
};

const normalizeRemaining = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
};

export const accountQuotaScore = (quota: QuotaState): AccountQuotaScore | null => {
  if (quota.status !== 'success') return null;
  const remaining = quota.rows
    .map((row) => normalizeRemaining(row.remainingPercent))
    .filter((value): value is number => value !== null);
  if (remaining.length === 0) return null;
  return {
    bottleneckRemaining: Math.min(...remaining),
    averageRemaining: remaining.reduce((sum, value) => sum + value, 0) / remaining.length,
    knownWindows: remaining.length,
  };
};

export const preferredQuotaAccountId = (candidates: AccountRoutingCandidate[]) => {
  const scored = candidates
    .map((candidate) => ({ candidate, score: accountQuotaScore(candidate.quota) }))
    .filter((item): item is { candidate: AccountRoutingCandidate; score: AccountQuotaScore } =>
      item.score !== null,
    );
  scored.sort((left, right) =>
    right.score.bottleneckRemaining - left.score.bottleneckRemaining
    || right.score.averageRemaining - left.score.averageRemaining
    || right.score.knownWindows - left.score.knownWindows
    || right.candidate.priority - left.candidate.priority
    || left.candidate.id.localeCompare(right.candidate.id),
  );
  return scored[0]?.candidate.id ?? null;
};

export const currentPreferredAccountId = (candidates: AccountRoutingCandidate[]) => {
  if (candidates.length === 0) return null;
  const highestPriority = candidates.reduce(
    (current, candidate) => Math.max(current, candidate.priority),
    Number.MIN_SAFE_INTEGER,
  );
  const preferred = candidates.filter((candidate) => candidate.priority === highestPriority);
  return preferred.length === 1 ? preferred[0].id : null;
};

export const nextAccountSwitchPriority = (candidates: AccountRoutingCandidate[]) => {
  const highest = candidates.reduce(
    (current, candidate) => Math.max(current, candidate.priority),
    0,
  );
  return highest >= Number.MAX_SAFE_INTEGER ? null : highest + 1;
};
