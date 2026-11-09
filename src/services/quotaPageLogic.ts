import type { AuthFile, QuotaState } from './quotaService';

export type QuotaRowEntry = { provider: string; file: AuthFile; quota: QuotaState };

export type QuotaSortMode = 'default' | 'soonest';

const readText = (file: AuthFile, key: string): string => {
  const value = file[key];
  return typeof value === 'string' ? value : '';
};

/** Keeps rows whose credential name or email contains the trimmed, case-insensitive query; an empty query matches every row. */
export function filterQuotaRows<T extends Pick<QuotaRowEntry, 'file'>>(rows: T[], search: string): T[] {
  const query = search.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter(({ file }) => [readText(file, 'name'), readText(file, 'email')]
    .some((value) => value.toLowerCase().includes(query)));
}

/** Earliest upcoming reset across the quota rows, or undefined while no row has a finite reset in the future. */
export function nextRecoveryMs(quota: QuotaState, now = Date.now()): number | undefined {
  let next: number | undefined;
  for (const row of quota.rows) {
    const resetAtMs = row.resetAtMs;
    if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || resetAtMs <= now) continue;
    if (next === undefined || resetAtMs < next) next = resetAtMs;
  }
  return next;
}

/** Copies the rows, ordering by next recovery when requested; rows without a recovery keep their order after the sorted ones. */
export function sortQuotaRows<T extends Pick<QuotaRowEntry, 'quota'>>(
  rows: readonly T[],
  mode: QuotaSortMode,
  resolveNextRecoveryMs: (quota: QuotaState) => number | undefined,
): T[] {
  if (mode === 'default') return [...rows];
  return rows
    .map((row, index) => ({ row, index, recovery: resolveNextRecoveryMs(row.quota) }))
    .sort((a, b) => {
      if (a.recovery === undefined && b.recovery === undefined) return a.index - b.index;
      if (a.recovery === undefined) return 1;
      if (b.recovery === undefined) return -1;
      return a.recovery - b.recovery || a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** Slices a page of items and clamps the requested page to the pages that exist. */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): {
  pageItems: T[];
  currentPage: number;
  totalPages: number;
} {
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const currentPage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (currentPage - 1) * size;
  return { pageItems: items.slice(start, start + size), currentPage, totalPages };
}