import { useSyncExternalStore } from 'react';
import type { QuotaState } from './quotaService';

type QuotaCache = Record<string, QuotaState>;
type QuotaCacheUpdater = QuotaCache | ((current: QuotaCache) => QuotaCache);

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
    const unchanged = Object.keys(next).length === Object.keys(current).length;
    if (unchanged) return current;
    generation += 1;
    return next;
  });
};

export function useQuotaCache() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
