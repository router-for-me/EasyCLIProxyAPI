import { useSyncExternalStore } from 'react';
import type { QuotaState } from './quotaService';

type QuotaCache = Record<string, QuotaState>;
type QuotaCacheUpdater = QuotaCache | ((current: QuotaCache) => QuotaCache);

export const API_QUOTA_CACHE_PREFIX = 'api-quota::';

let cache: QuotaCache = {};
let generation = 0;
const namespaceGenerations = new Map<string, number>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = () => cache;
export const getQuotaCacheSnapshot = getSnapshot;
export const captureQuotaCacheGeneration = (namespacePrefix?: string) => namespacePrefix
  ? namespaceGenerations.get(namespacePrefix) ?? 0
  : generation;

export const commitQuotaCacheIfCurrent = (
  expectedGeneration: number,
  commit: () => void,
  namespacePrefix?: string,
) => {
  const currentGeneration = namespacePrefix
    ? namespaceGenerations.get(namespacePrefix) ?? 0
    : generation;
  if (currentGeneration !== expectedGeneration) return false;
  commit();
  return true;
};

export const updateQuotaCache = (updater: QuotaCacheUpdater) => {
  const next = typeof updater === 'function' ? updater(cache) : updater;
  if (Object.is(next, cache)) return;
  cache = next;
  listeners.forEach((listener) => listener());
};

const pruneQuotaCacheWhere = (
  validKeys: Set<string>,
  belongsToNamespace: (key: string) => boolean,
  namespacePrefix?: string,
) => {
  updateQuotaCache((current) => {
    const next = Object.fromEntries(
      Object.entries(current)
        .filter(([key]) => !belongsToNamespace(key) || validKeys.has(key))
        .map(([key, value]) => [
          key,
          belongsToNamespace(key) && value.status === 'loading'
            ? { status: 'idle', rows: [] }
            : value,
        ]),
    ) as QuotaCache;
    const unchanged = Object.keys(next).length === Object.keys(current).length
      && Object.entries(next).every(([key, value]) => value === current[key]);
    if (unchanged) return current;
    generation += 1;
    if (namespacePrefix) {
      namespaceGenerations.set(namespacePrefix, (namespaceGenerations.get(namespacePrefix) ?? 0) + 1);
    }
    return next;
  });
};

export const pruneQuotaCache = (validKeys: Set<string>) => {
  pruneQuotaCacheWhere(validKeys, (key) => !key.startsWith(API_QUOTA_CACHE_PREFIX));
};

export const pruneQuotaCacheNamespace = (
  namespacePrefix: string,
  validKeys: Set<string>,
) => {
  pruneQuotaCacheWhere(validKeys, (key) => key.startsWith(namespacePrefix), namespacePrefix);
};

export function useQuotaCache() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
