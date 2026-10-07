import { useSyncExternalStore } from 'react';
import type { QuotaRow, QuotaState } from './quotaService';

type QuotaCache = Record<string, QuotaState>;
type QuotaCacheUpdater = QuotaCache | ((current: QuotaCache) => QuotaCache);

const rowIdentity = (row: QuotaRow) => row.windowId ?? row.label;

/** A row's remaining% climbing between two successful fetches only happens on a reset -- usage never organically goes back up. */
const annotateQuotaReset = (previous: QuotaState | undefined, next: QuotaState): QuotaState => {
  if (next.status !== 'success' || !previous || previous.status !== 'success' || !previous.rows.length) return next;
  let changed = false;
  const rows = next.rows.map((row): QuotaRow => {
    const match = previous.rows.find((old) => rowIdentity(old) === rowIdentity(row));
    if (!match || match.remainingPercent === null || row.remainingPercent === null) return row;
    if (row.remainingPercent - match.remainingPercent < 1) return row;
    changed = true;
    return { ...row, justReset: true };
  });
  return changed ? { ...next, rows } : next;
};

/** Writes a freshly-fetched quota result into the cache, flagging any row whose reset we can detect from the previous snapshot. */
export const quotaResultUpdater = (key: string, result: QuotaState) => (current: QuotaCache): QuotaCache =>
  ({ ...current, [key]: annotateQuotaReset(current[key], result) });

let cache: QuotaCache = {};
let generation = 0;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = () => cache;
export const getQuotaCacheSnapshot = getSnapshot;
export const captureQuotaCacheGeneration = () => generation;

export const commitQuotaCacheIfCurrent = (expectedGeneration: number, commit: () => void) => {
  if (generation !== expectedGeneration) return false;
  commit();
  return true;
};

export const updateQuotaCache = (updater: QuotaCacheUpdater) => {
  const next = typeof updater === 'function' ? updater(cache) : updater;
  if (Object.is(next, cache)) return;
  cache = next;
  listeners.forEach((listener) => listener());
};

export const pruneQuotaCache = (validKeys: Set<string>) => {
  updateQuotaCache((current) => {
    const next = Object.fromEntries(
      Object.entries(current)
        .filter(([key]) => validKeys.has(key))
        .map(([key, value]) => [
          key,
          value.status === 'loading' ? { status: 'idle', rows: [] } : value,
        ]),
    ) as QuotaCache;
    // When no keys are actually pruned, next has the same length as current even if a
    // loading entry above just got reset to idle — length alone can't see that value
    // change. Compare the entries themselves, or a stuck 'loading' row never clears.
    const unchanged = Object.keys(next).length === Object.keys(current).length
      && Object.entries(next).every(([key, value]) => current[key] === value);
    if (unchanged) return current;
    generation += 1;
    return next;
  });
};

export function useQuotaCache() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
