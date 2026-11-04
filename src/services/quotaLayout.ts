import type { QuotaDisplayProvider, QuotaState } from './quotaService';

/**
 * Rough card height in row units, from the data the card shows rather than its measured size, so cards keep their column when a refresh changes their height.
 * `glance` estimates the Compact summary, which shows only the name, group names and one line per quota.
 */
export function estimateQuotaCardHeight(quota: QuotaState, provider: QuotaDisplayProvider | null | undefined, glance = false): number {
  if (glance) {
    if (quota.status !== 'success') return 2.5;
    let group: string | undefined;
    let height = 1.5;
    for (const row of quota.rows) {
      if (row.groupLabel && row.groupLabel !== group) height += 1;
      group = row.groupLabel;
      height += 1;
    }
    return height;
  }
  let height = 3;
  if (quota.plan || quota.subscriptionActiveUntil) height += 1;
  if (quota.status !== 'success') return height + (quota.status === 'error' ? 2 : 1);
  if (provider === 'codex' || provider === 'claude') height += 2;
  let group: string | undefined;
  for (const row of quota.rows) {
    if (row.groupLabel && row.groupLabel !== group) height += row.groupDescription ? 2.5 : 1.5;
    group = row.groupLabel;
    height += 1.5;
  }
  return height;
}

/** The quota row with the least remaining share, for a one-line summary; null until quota has loaded or when no row has a percentage. */
export function lowestQuotaRow(quota: QuotaState): QuotaState['rows'][number] | null {
  if (quota.status !== 'success') return null;
  let lowest: QuotaState['rows'][number] | null = null;
  for (const row of quota.rows) {
    if (row.remainingPercent === null || !Number.isFinite(row.remainingPercent)) continue;
    if (!lowest || row.remainingPercent < (lowest.remainingPercent ?? Infinity)) lowest = row;
  }
  return lowest;
}

/**
 * Relative height of a credential card on the Authentication Files page, in rows, for Stacked and Compact packing.
 * Full cards share a fixed frame (header, recent requests, usage, actions) and grow with tags, cooldowns, open details and quota rows
 * (two per line in the dense quota panel); glance cards are the header plus one quota line.
 */
export function estimateCredentialCardHeight({ quota, tags, cooldown, expanded, glance }: {
  quota: QuotaState; tags: boolean; cooldown: boolean; expanded: boolean; glance: boolean;
}): number {
  if (glance) return 3 + (tags ? 1 : 0);
  let height = 9 + (tags ? 1 : 0) + (cooldown ? 1.5 : 0) + (expanded ? 6 : 0);
  height += quota.status === 'success' ? Math.ceil(quota.rows.length / 2) * 1.5 : 1;
  return height;
}

/** Places each item, in order, into the column with the least estimated height so far; ties go to the leftmost column. */
export function stackQuotaColumns(heights: readonly number[], columnCount: number): number[][] {
  const columns = Array.from({ length: Math.max(1, columnCount) }, () => ({ height: 0, items: [] as number[] }));
  heights.forEach((height, index) => {
    const target = columns.reduce((lowest, column) => column.height < lowest.height ? column : lowest);
    target.items.push(index);
    target.height += height;
  });
  return columns.map((column) => column.items);
}
