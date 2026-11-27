import { authFileHealth } from './authFileHealth';
import { authFileCooldownResetIndex, authFileName, dedupeAuthFiles, isOAuthCredentialFile } from './authFiles';
import { managementApi, readBoolean, readString, responseList } from './managementApi';
import {
  getOAuthStatus,
  loadOAuthBrowserPreference,
  NO_AUTO_OPEN_BROWSER_ID,
  openOAuthUrl,
  startOAuthLogin,
} from './oauth';
import { getQuotaCacheSnapshot, updateQuotaCache } from './quotaCache';
import { idleQuota, quotaKey, type QuotaState } from './quotaService';
import {
  credentialProvider,
  currentCredentialConnectionFingerprint,
  hasStrongCredentialIdentity,
  isHealthyCredentialForReplacement,
  isHealthyCredentialStatusMessage,
  observeCredentialSignIn,
  readCredentialRefreshAtMs,
  readCredentialUpdatedAtMs,
  REAUTH_PROVIDERS,
  resolveCredentialAccountIdentity,
  sameCredentialIdentity,
  subscribeCredentialConnectionChange,
  subscribeObservedCredentialFiles,
  type AuthFile,
  type CredentialAccountIdentity,
} from './credentialSignIn';

const STORAGE_KEY = 'easy-cli-proxy-api.credential-reauth.v1';
const STORAGE_VERSION = 1;
const MAX_PENDING_REAUTHS = 16;
const MAX_PENDING_REAUTH_AGE_MS = 24 * 60 * 60 * 1000;
const OAUTH_POLL_INTERVAL_MS = 3000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type CredentialBaselineEvidence = {
  identityKey: string;
  fileName: string;
  authIndex: string;
  identity: CredentialAccountIdentity;
  refreshAtMs: number;
  updatedAtMs: number;
  statusMessage: string;
  hadError: boolean;
};

export type CredentialReauthBaseline = {
  provider: string;
  targetFileName: string;
  targetAuthIndex: string;
  targetIdentity: CredentialAccountIdentity;
  targetIdentityKey: string;
  startedAtMs: number;
  providerCredentials: CredentialBaselineEvidence[];
};

export type PendingCredentialReauth = CredentialReauthBaseline & {
  id: string;
  connectionFingerprint: string;
};

export type CredentialReauthReconciliation =
  | { status: 'confirmed'; file: AuthFile; replacedOldFile: boolean }
  | { status: 'identity-changed'; file: AuthFile; observedAccount: string }
  | { status: 'ambiguous' }
  | { status: 'unconfirmed' };

export type ReauthResult =
  | { status: 'success'; replacedFile?: string }
  | { status: 'identity-changed'; observedAccount: string }
  | { status: 'ambiguous' }
  | { status: 'unconfirmed' }
  | { status: 'error'; error: string }
  | { status: 'cancelled' };

export type ActiveCredentialReauthSnapshot = {
  pending: string | null;
  openFailure: { name: string; url: string } | null;
  completedRevision: number;
};

type StoredPendingReauths = {
  version: number;
  items: PendingCredentialReauth[];
};

let memoryPendingReauths: PendingCredentialReauth[] = [];

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const normalizeTimestamp = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
};

function getSessionStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function buildCredentialIdentityKey(file: AuthFile, identity = resolveCredentialAccountIdentity(file)): string {
  return JSON.stringify([
    identity.provider,
    identity.accountId,
    identity.member,
    readString(file, 'name'),
    authFileCooldownResetIndex(file) ?? '',
  ]);
}

function buildBaselineEvidence(file: AuthFile): CredentialBaselineEvidence {
  const identity = resolveCredentialAccountIdentity(file);
  const health = authFileHealth(file);
  return {
    identityKey: buildCredentialIdentityKey(file, identity),
    fileName: readString(file, 'name'),
    authIndex: authFileCooldownResetIndex(file) ?? '',
    identity,
    refreshAtMs: readCredentialRefreshAtMs(file) ?? 0,
    updatedAtMs: readCredentialUpdatedAtMs(file) ?? 0,
    statusMessage: health.message,
    hadError: health.tone === 'error' || readBoolean(file, 'unavailable') || health.status === 'error',
  };
}

function normalizeIdentity(value: unknown): CredentialAccountIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provider = normalizeString(record.provider);
  if (!provider) return null;
  return {
    provider,
    accountId: normalizeString(record.accountId),
    member: normalizeString(record.member),
    invalid: record.invalid === true,
  };
}

function normalizeBaselineEvidence(value: unknown): CredentialBaselineEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const identityKey = normalizeString(record.identityKey);
  const identity = normalizeIdentity(record.identity);
  if (!identityKey || !identity) return null;
  return {
    identityKey,
    fileName: normalizeString(record.fileName),
    authIndex: normalizeString(record.authIndex),
    identity,
    refreshAtMs: normalizeTimestamp(record.refreshAtMs),
    updatedAtMs: normalizeTimestamp(record.updatedAtMs),
    statusMessage: normalizeString(record.statusMessage),
    hadError: record.hadError === true,
  };
}

function parsePendingReauth(value: unknown): PendingCredentialReauth | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = normalizeString(record.id);
  const connectionFingerprint = normalizeString(record.connectionFingerprint);
  const provider = normalizeString(record.provider);
  const targetFileName = normalizeString(record.targetFileName);
  const targetIdentity = normalizeIdentity(record.targetIdentity);
  const targetIdentityKey = normalizeString(record.targetIdentityKey);
  const startedAtMs = normalizeTimestamp(record.startedAtMs);
  if (!id || !connectionFingerprint || !provider || !targetFileName || !targetIdentity || !targetIdentityKey || startedAtMs <= 0) {
    return null;
  }
  return {
    id,
    connectionFingerprint,
    provider,
    targetFileName,
    targetAuthIndex: normalizeString(record.targetAuthIndex),
    targetIdentity,
    targetIdentityKey,
    startedAtMs,
    providerCredentials: Array.isArray(record.providerCredentials)
      ? record.providerCredentials
          .map(normalizeBaselineEvidence)
          .filter((item): item is CredentialBaselineEvidence => item !== null)
      : [],
  };
}

function prunePendingReauths(
  items: readonly PendingCredentialReauth[],
  nowMs = Date.now(),
): PendingCredentialReauth[] {
  const oldestAllowedAtMs = nowMs - MAX_PENDING_REAUTH_AGE_MS;
  const unique = new Map<string, PendingCredentialReauth>();
  for (const item of items) {
    if (item.startedAtMs < oldestAllowedAtMs) continue;
    unique.set(item.id, item);
  }
  return Array.from(unique.values())
    .sort((left, right) => left.startedAtMs - right.startedAtMs || left.id.localeCompare(right.id))
    .slice(-MAX_PENDING_REAUTHS);
}

function readStoredPendingReauths(
  storage: StorageLike | null = getSessionStorage(),
  nowMs = Date.now(),
): PendingCredentialReauth[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<StoredPendingReauths>;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.items)) return [];
    return prunePendingReauths(
      parsed.items
        .map(parsePendingReauth)
        .filter((item): item is PendingCredentialReauth => item !== null),
      nowMs,
    );
  } catch {
    return [];
  }
}

function loadPendingReauths(
  storage: StorageLike | null = getSessionStorage(),
  nowMs = Date.now(),
): PendingCredentialReauth[] {
  return prunePendingReauths([...readStoredPendingReauths(storage, nowMs), ...memoryPendingReauths], nowMs);
}

function writePendingReauths(
  items: readonly PendingCredentialReauth[],
  storage: StorageLike | null = getSessionStorage(),
): boolean {
  const next = prunePendingReauths(items);
  memoryPendingReauths = next;
  if (!storage) return true;
  try {
    if (next.length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, items: next }));
    return true;
  } catch {
    return true;
  }
}

function createPendingReauthId(startedAtMs: number): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall back to a session-local opaque id when Web Crypto is unavailable.
  }
  return `${startedAtMs.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createCredentialReauthBaseline({
  file,
  files = [file],
  startedAtMs = Date.now(),
}: {
  file: AuthFile;
  files?: readonly AuthFile[];
  startedAtMs?: number;
}): CredentialReauthBaseline | null {
  const provider = credentialProvider(file);
  const targetFileName = readString(file, 'name');
  const normalizedStartedAtMs = normalizeTimestamp(startedAtMs);
  if (!provider || !targetFileName || normalizedStartedAtMs <= 0) return null;

  const targetIdentity = resolveCredentialAccountIdentity(file);
  const providerCredentials = files
    .filter((candidate) => isOAuthCredentialFile(candidate) && credentialProvider(candidate) === provider)
    .map(buildBaselineEvidence);

  return {
    provider,
    targetFileName,
    targetAuthIndex: authFileCooldownResetIndex(file) ?? '',
    targetIdentity,
    targetIdentityKey: buildCredentialIdentityKey(file, targetIdentity),
    startedAtMs: normalizedStartedAtMs,
    providerCredentials,
  };
}

export function recordPendingCredentialReauth({
  connectionFingerprint,
  baseline,
  storage = getSessionStorage(),
}: {
  connectionFingerprint: string;
  baseline: CredentialReauthBaseline;
  storage?: StorageLike | null;
}): PendingCredentialReauth | null {
  const normalizedFingerprint = connectionFingerprint.trim();
  if (!normalizedFingerprint) return null;
  const item: PendingCredentialReauth = {
    ...baseline,
    id: createPendingReauthId(baseline.startedAtMs),
    connectionFingerprint: normalizedFingerprint,
  };
  const existing = loadPendingReauths(storage).filter(
    (candidate) =>
      candidate.connectionFingerprint !== normalizedFingerprint
      || candidate.targetIdentityKey !== baseline.targetIdentityKey,
  );
  return writePendingReauths([...existing, item], storage) ? item : null;
}

export function listPendingCredentialReauths(
  connectionFingerprint: string,
  storage: StorageLike | null = getSessionStorage(),
  nowMs = Date.now(),
): PendingCredentialReauth[] {
  const normalizedFingerprint = connectionFingerprint.trim();
  if (!normalizedFingerprint) return [];
  return loadPendingReauths(storage, nowMs).filter(
    (item) => item.connectionFingerprint === normalizedFingerprint,
  );
}

export function acknowledgePendingCredentialReauths(
  ids: readonly string[],
  storage: StorageLike | null = getSessionStorage(),
): void {
  const acknowledged = new Set(ids.map(normalizeString).filter(Boolean));
  if (acknowledged.size === 0) return;
  writePendingReauths(
    loadPendingReauths(storage).filter((item) => !acknowledged.has(item.id)),
    storage,
  );
}

function hasChangedCredentialEvidence(
  current: CredentialBaselineEvidence,
  baseline: CredentialBaselineEvidence | undefined,
): boolean {
  if (!baseline) return true;
  const statusImproved = baseline.statusMessage.length > 0
    && current.statusMessage !== baseline.statusMessage
    && isHealthyCredentialStatusMessage(current.statusMessage);
  const errorCleared = baseline.hadError && !current.hadError;
  return (
    current.refreshAtMs > baseline.refreshAtMs
    || current.updatedAtMs > baseline.updatedAtMs
    || statusImproved
    || errorCleared
  );
}

function formatObservedAccount(file: AuthFile, identity: CredentialAccountIdentity): string {
  return identity.member || identity.accountId || readString(file, 'email', 'account', 'label') || authFileName(file);
}

/**
 * Reconciles the credential list after OAuth completes against the pre-reauth
 * baseline snapshot. Never guesses across ambiguous updates or weak identities.
 */
export function reconcileCredentialReauth(
  baseline: CredentialReauthBaseline,
  files: readonly AuthFile[],
  quotas?: Readonly<Record<string, QuotaState>>,
): CredentialReauthReconciliation {
  const providerFiles = files.filter((file) =>
    isOAuthCredentialFile(file) && credentialProvider(file) === baseline.provider);
  const healthyProviderFiles = providerFiles.filter((file) =>
    isHealthyCredentialForReplacement(file, quotas?.[quotaKey(file)]));

  if (baseline.targetIdentity.invalid) return { status: 'unconfirmed' };

  const baselineByKey = new Map(
    baseline.providerCredentials.map((entry) => [entry.identityKey, entry]),
  );

  // Codex requires both Workspace accountId and strict member email (fail-closed).
  if (baseline.provider === 'codex' && !hasStrongCredentialIdentity(baseline.targetIdentity)) {
    return { status: 'unconfirmed' };
  }

  // Non-Codex without accountId or email can only confirm an exact in-place file recovery,
  // never cross-file replacement or deletion.
  if (!hasStrongCredentialIdentity(baseline.targetIdentity)) {
    const exactTarget = healthyProviderFiles.find((file) =>
      readString(file, 'name') === baseline.targetFileName
      && (!baseline.targetAuthIndex || (authFileCooldownResetIndex(file) ?? '') === baseline.targetAuthIndex));
    if (!exactTarget) return { status: 'unconfirmed' };
    const evidence = buildBaselineEvidence(exactTarget);
    if (evidence.identity.invalid) return { status: 'unconfirmed' };
    const prior = baselineByKey.get(evidence.identityKey)
      ?? baseline.providerCredentials.find((entry) => entry.fileName === baseline.targetFileName);
    return hasChangedCredentialEvidence(evidence, prior)
      ? { status: 'confirmed', file: exactTarget, replacedOldFile: false }
      : { status: 'unconfirmed' };
  }

  const matchingFiles = healthyProviderFiles.filter((file) =>
    sameCredentialIdentity(baseline.targetIdentity, resolveCredentialAccountIdentity(file)));
  const changedMatchingFiles = matchingFiles.filter((file) => {
    const evidence = buildBaselineEvidence(file);
    return hasChangedCredentialEvidence(evidence, baselineByKey.get(evidence.identityKey));
  });

  if (changedMatchingFiles.length > 1) return { status: 'ambiguous' };
  if (changedMatchingFiles.length === 1) {
    const matched = changedMatchingFiles[0];
    const matchedName = readString(matched, 'name');
    const oldStillExists = providerFiles.some((file) => readString(file, 'name') === baseline.targetFileName);
    return {
      status: 'confirmed',
      file: matched,
      replacedOldFile: Boolean(matchedName && matchedName !== baseline.targetFileName && oldStillExists),
    };
  }

  // Only a brand-new credential with a different strong identity is causal evidence
  // of signing into the wrong account; background refreshes of existing unrelated
  // credentials must not trigger false identity-changed alerts.
  const newDifferentIdentityFiles = healthyProviderFiles.filter((file) => {
    const evidence = buildBaselineEvidence(file);
    return (
      hasStrongCredentialIdentity(evidence.identity)
      && !sameCredentialIdentity(baseline.targetIdentity, evidence.identity)
      && !baselineByKey.has(evidence.identityKey)
    );
  });

  if (newDifferentIdentityFiles.length > 1) return { status: 'ambiguous' };
  if (newDifferentIdentityFiles.length === 1) {
    const file = newDifferentIdentityFiles[0];
    return {
      status: 'identity-changed',
      file,
      observedAccount: formatObservedAccount(file, resolveCredentialAccountIdentity(file)),
    };
  }

  return { status: 'unconfirmed' };
}

export function clearPendingCredentialReauthsForTests(): void {
  memoryPendingReauths = [];
  const storage = getSessionStorage();
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore unavailable or blocked session storage.
  }
}

// --- Module-level active re-auth controller (survives page switches) ----------

let activeSessionId = 0;
let activeOAuthState: string | null = null;
let activePendingId: string | null = null;
let activeConnectionFingerprint: string | null = null;
let snapshot: ActiveCredentialReauthSnapshot = {
  pending: null,
  openFailure: null,
  completedRevision: 0,
};
const stateListeners = new Set<() => void>();

function emitSnapshot(next: ActiveCredentialReauthSnapshot) {
  snapshot = next;
  stateListeners.forEach((listener) => listener());
}

export const getCredentialReauthSnapshot = () => snapshot;

export function subscribeCredentialReauth(listener: () => void) {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}

function clearStaleQuotaErrorsFor(files: readonly AuthFile[]) {
  const keys = files.map(quotaKey).filter(Boolean);
  if (keys.length === 0) return;
  updateQuotaCache((current) => {
    let changed = false;
    const next = { ...current };
    for (const key of keys) {
      if (next[key]?.status === 'error') {
        next[key] = idleQuota();
        changed = true;
      }
    }
    return changed ? next : current;
  });
}

export function cancelCredentialReauth(options: { remoteSession?: boolean } = {}) {
  const state = activeOAuthState;
  const pendingId = activePendingId;
  const sameConnection = activeConnectionFingerprint === currentCredentialConnectionFingerprint();
  activeSessionId += 1;
  activeOAuthState = null;
  activePendingId = null;
  activeConnectionFingerprint = null;
  if (pendingId) acknowledgePendingCredentialReauths([pendingId]);
  if (snapshot.pending !== null || snapshot.openFailure !== null) {
    emitSnapshot({ ...snapshot, pending: null, openFailure: null });
  }
  if (options.remoteSession !== false && state && sameConnection) {
    void managementApi.delete('/oauth/session', { query: { state } }).catch(() => undefined);
  }
}

// Cancel in-flight polling cleanly on remote/local CPA target switch without deleting
// an unrelated session on the newly selected server.
subscribeCredentialConnectionChange(() => {
  if (activeOAuthState || snapshot.pending !== null || snapshot.openFailure !== null) {
    cancelCredentialReauth({ remoteSession: false });
  }
});

// Passively clear persisted baselines once fresh credential lists show recovery
// (for example if the window reloaded while a sign-in was still open in the browser).
subscribeObservedCredentialFiles((files, fingerprint) => {
  const pendingItems = listPendingCredentialReauths(fingerprint);
  if (pendingItems.length === 0) return;
  const resolvedIds = pendingItems
    .filter((item) => item.id !== activePendingId && reconcileCredentialReauth(item, files, getQuotaCacheSnapshot()).status === 'confirmed')
    .map((item) => item.id);
  if (resolvedIds.length > 0) acknowledgePendingCredentialReauths(resolvedIds);
});

export async function startCredentialReauth(
  file: AuthFile,
  currentFiles?: readonly AuthFile[],
): Promise<ReauthResult> {
  const name = readString(file, 'name');
  const provider = credentialProvider(file);
  if (!name || !REAUTH_PROVIDERS.has(provider)) {
    return { status: 'error', error: 'unsupported OAuth provider' };
  }
  if (snapshot.pending !== null) {
    return { status: 'cancelled' };
  }

  const connectionFingerprint = currentCredentialConnectionFingerprint();
  let baselineFiles = currentFiles && currentFiles.length > 0 ? dedupeAuthFiles([...currentFiles]) : [];
  if (baselineFiles.length === 0) {
    try {
      baselineFiles = dedupeAuthFiles(responseList(await managementApi.get('/credentials'), 'files'));
    } catch {
      baselineFiles = [file];
    }
  }

  const baseline = createCredentialReauthBaseline({ file, files: baselineFiles });
  if (!baseline) {
    return { status: 'error', error: 'invalid credential baseline' };
  }

  const id = ++activeSessionId;
  activeConnectionFingerprint = connectionFingerprint;
  const pendingRecord = recordPendingCredentialReauth({ connectionFingerprint, baseline });
  activePendingId = pendingRecord?.id ?? null;
  emitSnapshot({ ...snapshot, pending: name, openFailure: null });

  try {
    const preferred = loadOAuthBrowserPreference();
    const manualOnly = preferred === NO_AUTO_OPEN_BROWSER_ID;
    const browser = manualOnly ? NO_AUTO_OPEN_BROWSER_ID : (preferred || 'default');
    const started = await startOAuthLogin({ provider, browser });
    if (activeSessionId !== id || currentCredentialConnectionFingerprint() !== connectionFingerprint) {
      return { status: 'cancelled' };
    }
    if (!started.state) {
      return { status: 'error', error: 'missing OAuth state' };
    }

    if (manualOnly) {
      emitSnapshot({ ...snapshot, pending: name, openFailure: { name, url: started.url } });
    } else if (!started.opened) {
      try {
        await openOAuthUrl({ url: started.url, browser });
      } catch {
        if (activeSessionId === id) {
          emitSnapshot({ ...snapshot, pending: name, openFailure: { name, url: started.url } });
        }
      }
    }

    const state = started.state;
    activeOAuthState = state;

    while (activeSessionId === id && currentCredentialConnectionFingerprint() === connectionFingerprint) {
      await new Promise((resolve) => window.setTimeout(resolve, OAUTH_POLL_INTERVAL_MS));
      if (activeSessionId !== id || currentCredentialConnectionFingerprint() !== connectionFingerprint) break;
      const result = await getOAuthStatus({ state });
      if (activeSessionId !== id || currentCredentialConnectionFingerprint() !== connectionFingerprint) break;
      const status = (result.status || '').toLowerCase();
      if (status === 'error') {
        return { status: 'error', error: result.error || '' };
      }
      if (status === 'ok') {
        const freshFiles = dedupeAuthFiles(responseList(await managementApi.get('/credentials'), 'files'));
        if (currentCredentialConnectionFingerprint() !== connectionFingerprint) {
          return { status: 'cancelled' };
        }
        const reconciliation = reconcileCredentialReauth(baseline, freshFiles, getQuotaCacheSnapshot());
        if (reconciliation.status === 'confirmed') {
          clearStaleQuotaErrorsFor([file, reconciliation.file]);
          let replacedFile: string | undefined;
          let observedFiles = freshFiles;
          if (reconciliation.replacedOldFile) {
            try {
              await managementApi.delete('/credentials', { query: { name } });
              replacedFile = authFileName(reconciliation.file);
              observedFiles = freshFiles.filter((candidate) => readString(candidate, 'name') !== name);
            } catch {
              // Keep the newly signed-in credential usable even if cleanup fails.
            }
          }
          observeCredentialSignIn(observedFiles);
          emitSnapshot({
            pending: null,
            openFailure: null,
            completedRevision: snapshot.completedRevision + 1,
          });
          return { status: 'success', ...(replacedFile ? { replacedFile } : {}) };
        }
        observeCredentialSignIn(freshFiles);
        emitSnapshot({
          pending: null,
          openFailure: null,
          completedRevision: snapshot.completedRevision + 1,
        });
        if (reconciliation.status === 'identity-changed') {
          return { status: 'identity-changed', observedAccount: reconciliation.observedAccount };
        }
        return { status: reconciliation.status };
      }
    }
    return { status: 'cancelled' };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (activeSessionId === id) {
      if (activePendingId) acknowledgePendingCredentialReauths([activePendingId]);
      activeOAuthState = null;
      activePendingId = null;
      activeConnectionFingerprint = null;
      if (snapshot.pending !== null || snapshot.openFailure !== null) {
        emitSnapshot({ ...snapshot, pending: null, openFailure: null });
      }
    }
  }
}

export function resetCredentialReauthStateForTests() {
  activeSessionId += 1;
  activeOAuthState = null;
  activePendingId = null;
  activeConnectionFingerprint = null;
  snapshot = { pending: null, openFailure: null, completedRevision: 0 };
  clearPendingCredentialReauthsForTests();
}
