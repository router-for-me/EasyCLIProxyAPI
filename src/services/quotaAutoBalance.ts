import { useSyncExternalStore } from 'react';
import { isOAuthCredentialFile, normalizeAuthFilePriorityInput } from './authFiles';
import { isRecord, managementApi, readBoolean, readString, responseList } from './managementApi';
import type { AuthFile, QuotaRow, QuotaState } from './quotaService';

const STORAGE_KEY = 'easy-cli-proxy-api.quota-auto-balance';
const ORIGINALS_STORAGE_KEY = 'easy-cli-proxy-api.quota-auto-balance.originals';

/**
 * Priorities are anchored to the backend default (0) so credentials auto-balance never
 * touched rank alongside healthy ones, and depleted credentials rank below both.
 */
export const AUTO_BALANCE_PRIORITY = { healthy: 0, low: -5, critical: -10 } as const;

let cachedEnabled: boolean | undefined;
const listeners = new Set<() => void>();

/** Returns undefined when storage is unavailable so the in-memory value stays authoritative. */
function readStoredEnabled(): boolean | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return undefined;
  }
}

export function getQuotaAutoBalanceEnabled(): boolean {
  if (cachedEnabled === undefined) {
    cachedEnabled = readStoredEnabled() ?? false;
  }
  return cachedEnabled;
}

/** Re-reads the stored toggle, which another tab may have changed, and notifies on change. */
function refreshQuotaAutoBalanceEnabled(): boolean {
  const stored = readStoredEnabled();
  if (stored !== undefined && stored !== getQuotaAutoBalanceEnabled()) {
    cachedEnabled = stored;
    listeners.forEach((listener) => listener());
  }
  return getQuotaAutoBalanceEnabled();
}

/** Keeps the toggle in step with other tabs; `key` is null when storage was cleared. */
export function watchQuotaAutoBalanceStorage(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): () => void {
  const onStorage = (event: Event) => {
    const key = (event as Event & { key?: string | null }).key;
    if (key === STORAGE_KEY || key === null || key === undefined) refreshQuotaAutoBalanceEnabled();
  };
  target.addEventListener('storage', onStorage);
  return () => target.removeEventListener('storage', onStorage);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  watchQuotaAutoBalanceStorage(window);
}

export function setQuotaAutoBalanceEnabled(enabled: boolean): void {
  const next = Boolean(enabled);
  const changed = getQuotaAutoBalanceEnabled() !== next;
  cachedEnabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
  } catch {
    // Ignore storage errors in restricted environments.
  }
  if (changed) {
    listeners.forEach((listener) => listener());
  }
}

function subscribeQuotaAutoBalance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useQuotaAutoBalance(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(
    subscribeQuotaAutoBalance,
    getQuotaAutoBalanceEnabled,
    getQuotaAutoBalanceEnabled,
  );
  return [enabled, setQuotaAutoBalanceEnabled];
}

export type QuotaRoutingFields = { priority: number; weight: number | null };
type RoutingChangeListener = (name: string, fields: QuotaRoutingFields) => void;
const routingChangeListeners = new Set<RoutingChangeListener>();

/** Notifies pages holding credential lists so they can update rows immutably after a PATCH. */
export function subscribeQuotaRoutingChanges(listener: RoutingChangeListener): () => void {
  routingChangeListeners.add(listener);
  return () => {
    routingChangeListeners.delete(listener);
  };
}

export function applyQuotaRoutingChange<T extends AuthFile>(files: T[], name: string, fields: QuotaRoutingFields): T[] {
  let changed = false;
  const next = files.map((file) => {
    if (readString(file, 'name') !== name) return file;
    changed = true;
    return { ...file, priority: fields.priority, weight: fields.weight };
  });
  return changed ? next : files;
}

/**
 * Manual priority and weight captured before auto-balance first changed a credential, plus the
 * values auto-balance last applied so a later manual edit can be told apart from its own writes.
 */
type StoredOriginal = QuotaRoutingFields & { applied?: QuotaRoutingFields };
type StoredOriginals = Record<string, StoredOriginal>;

const isRoutingFields = (value: unknown): value is QuotaRoutingFields => isRecord(value)
  && typeof value.priority === 'number'
  && (value.weight === null || typeof value.weight === 'number');

function readOriginals(): StoredOriginals {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ORIGINALS_STORAGE_KEY) ?? '{}');
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isRoutingFields(value)
      && ((value as StoredOriginal).applied === undefined || isRoutingFields((value as StoredOriginal).applied)))) as StoredOriginals;
  } catch {
    return {};
  }
}

function writeOriginals(originals: StoredOriginals): void {
  try {
    if (Object.keys(originals).length) localStorage.setItem(ORIGINALS_STORAGE_KEY, JSON.stringify(originals));
    else localStorage.removeItem(ORIGINALS_STORAGE_KEY);
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

function updateOriginal(name: string, next: StoredOriginal | undefined): void {
  const originals = readOriginals();
  if (next) originals[name] = next;
  else delete originals[name];
  writeOriginals(originals);
}

export type QuotaRoutingTarget = {
  priority: number;
  weight: number;
  bottleneckPercent: number;
  averagePercent: number;
};

const clampedPercent = (row: QuotaRow): number | null =>
  typeof row.remainingPercent === 'number' && Number.isFinite(row.remainingPercent)
    ? Math.max(0, Math.min(100, row.remainingPercent))
    : null;

/**
 * Percentages that gate the whole credential. Account-wide windows (5-hour, weekly, ...) all apply,
 * so the tightest one wins. Model- or feature-scoped limits only block part of the traffic, so they
 * are ignored when account-wide windows exist; otherwise (e.g. Antigravity model groups) each group
 * is reduced to its tightest window and the best group represents the credential.
 */
function routingPercents(rows: QuotaRow[]): { bottleneck: number; values: number[] } | null {
  const account: number[] = [];
  const groups = new Map<string, number>();
  for (const row of rows) {
    const percent = clampedPercent(row);
    if (percent === null) continue;
    if (!row.scoped && !row.groupLabel) {
      account.push(percent);
      continue;
    }
    const group = row.groupLabel || row.label;
    groups.set(group, Math.min(groups.get(group) ?? 100, percent));
  }
  if (account.length) return { bottleneck: Math.min(...account), values: account };
  const values = [...groups.values()];
  return values.length ? { bottleneck: Math.max(...values), values } : null;
}

/**
 * Compute recommended priority and weight from a fetched QuotaState.
 * Returns null if the quota is not successful or contains no numeric percentage rows.
 */
export function computeQuotaRoutingTarget(quota: QuotaState): QuotaRoutingTarget | null {
  if (quota.status !== 'success' || !Array.isArray(quota.rows) || quota.rows.length === 0) {
    return null;
  }
  const percents = routingPercents(quota.rows);
  if (!percents) return null;

  const bottleneckPercent = percents.bottleneck;
  const averagePercent = percents.values.reduce((acc, value) => acc + value, 0) / percents.values.length;

  let priority: number;
  let weight: number;

  if (bottleneckPercent < 5) {
    priority = AUTO_BALANCE_PRIORITY.critical;
    weight = 1;
  } else if (bottleneckPercent < 15) {
    priority = AUTO_BALANCE_PRIORITY.low;
    weight = Math.max(1, Math.round(bottleneckPercent));
  } else {
    priority = AUTO_BALANCE_PRIORITY.healthy;
    const effective = bottleneckPercent * 0.7 + averagePercent * 0.3;
    weight = Math.max(1, Math.round(effective));
  }

  return {
    priority,
    weight,
    bottleneckPercent,
    averagePercent,
  };
}

type BalanceApi = {
  get: (path: string, query?: Record<string, string>) => Promise<unknown>;
  patch: (path: string, body: Record<string, unknown>) => Promise<unknown>;
};

const parseWeight = (value: unknown): number | null => {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  if (!text) return null;
  const weight = Number(text);
  return Number.isFinite(weight) ? Math.max(0, weight) : null;
};

const sameRouting = (left: QuotaRoutingFields, right: QuotaRoutingFields) =>
  left.priority === right.priority && left.weight === right.weight;

/** Reads only the routing fields, so unrelated malformed metadata never blocks balancing. */
async function loadRoutingFields(api: BalanceApi, name: string): Promise<QuotaRoutingFields> {
  let metadata: unknown = await api.get('/credentials/download', { name });
  if (typeof metadata === 'string') metadata = JSON.parse(metadata);
  if (!isRecord(metadata)) throw new Error(`Unexpected credential payload for ${name}`);
  const priority = metadata.priority;
  return {
    priority: typeof priority === 'number' || typeof priority === 'string'
      ? normalizeAuthFilePriorityInput(String(priority)) ?? 0
      : 0,
    weight: parseWeight(metadata.weight),
  };
}

async function patchRouting(api: BalanceApi, name: string, fields: QuotaRoutingFields): Promise<void> {
  await api.patch('/credentials/fields', { name, ...fields });
  routingChangeListeners.forEach((listener) => listener(name, fields));
}

/** Sync and restore of one credential run one at a time so a late sync cannot undo a restore. */
const credentialLocks = new Map<string, Promise<unknown>>();

function withCredentialLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const previous = credentialLocks.get(name) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  credentialLocks.set(name, tail);
  void tail.then(() => {
    if (credentialLocks.get(name) === tail) credentialLocks.delete(name);
  });
  return run;
}

/**
 * Apply computed routing priority and weight to an OAuth credential file if changed.
 * The credential list does not carry weight, so current values are read from the stored file.
 */
export async function syncCredentialQuotaRouting(
  file: AuthFile,
  quota: QuotaState,
  api: BalanceApi = managementApi,
): Promise<QuotaRoutingTarget | null> {
  if (!isOAuthCredentialFile(file) || readBoolean(file, 'disabled')) {
    return null;
  }
  const name = readString(file, 'name');
  if (!name) return null;

  const target = computeQuotaRoutingTarget(quota);
  if (!target) return null;

  return withCredentialLock(name, async () => {
    // Read the stored toggle, not just this tab's copy, so another tab turning it off wins.
    if (!refreshQuotaAutoBalanceEnabled()) return null;
    const current = await loadRoutingFields(api, name);
    if (!refreshQuotaAutoBalanceEnabled()) return null;

    const desired = { priority: target.priority, weight: target.weight };
    const stored = readOriginals()[name];
    // A value differing from what auto-balance last applied is a newer manual setting.
    const manual = stored?.applied && sameRouting(current, stored.applied)
      ? { priority: stored.priority, weight: stored.weight }
      : current;
    if (sameRouting(current, desired)) {
      updateOriginal(name, stored?.applied ? { ...manual, applied: desired } : { ...manual });
      return target;
    }

    updateOriginal(name, { ...manual, applied: desired });
    try {
      await patchRouting(api, name, desired);
    } catch (error) {
      updateOriginal(name, stored);
      throw error;
    }
    return target;
  });
}

/**
 * Restore the manual priority and weight of every credential auto-balance changed. Credentials
 * that no longer exist are forgotten, and ones edited by hand since the last sync are left alone.
 */
export async function restoreQuotaRoutingOriginals(api: BalanceApi = managementApi): Promise<void> {
  const originals = readOriginals();
  if (!Object.keys(originals).length) return;
  const existing = new Set(responseList(await api.get('/credentials'), 'files').map((file) => readString(file, 'name')));

  const failures: unknown[] = [];
  for (const name of Object.keys(originals)) {
    if (!existing.has(name)) {
      updateOriginal(name, undefined);
      continue;
    }
    try {
      await withCredentialLock(name, async () => {
        if (refreshQuotaAutoBalanceEnabled()) return;
        const stored = readOriginals()[name];
        if (!stored) return;
        if (stored.applied) {
          const current = await loadRoutingFields(api, name);
          if (sameRouting(current, stored.applied)) {
            await patchRouting(api, name, { priority: stored.priority, weight: stored.weight });
          }
        }
        updateOriginal(name, undefined);
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
}
