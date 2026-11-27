import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrentLocale, translate } from '../i18n';
import { authFileHealth } from './authFileHealth';
import { authFileName, dedupeAuthFiles, isOAuthCredentialFile, normalizeOAuthProvider } from './authFiles';
import { isRecord, normalizeAuthIndex, readBoolean, readString } from './managementApi';
import { isTauri } from './platform';
import { getQuotaCacheSnapshot } from './quotaCache';
import { decodeQuotaToken } from './quotaMetadata';
import type { QuotaState } from './quotaService';

const credentialQuotaKey = (file: AuthFile) =>
  `${authFileName(file)}::${normalizeAuthIndex(file.auth_index ?? file.authIndex)}`;

export type AuthFile = Record<string, unknown>;

export type CredentialAccountIdentity = {
  provider: string;
  accountId: string;
  member: string;
  invalid: boolean;
};

export type CredentialSignInEvaluation = 'required' | 'deactivated' | 'none';

type AuthEvidenceKind = 'reauth' | 'deactivated' | 'positive';

type AuthEvidence = {
  kind: AuthEvidenceKind;
  observedAtMs: number | null;
  statusCode: number | null;
};

/** Providers whose built-in OAuth flow finishes without a pasted callback or device code. */
export const REAUTH_PROVIDERS = new Set(['claude', 'codex', 'antigravity']);

export const credentialProvider = (file: AuthFile) =>
  normalizeOAuthProvider(readString(file, 'provider', 'type', 'account_type'));

export const canReauthenticate = (file: AuthFile) => REAUTH_PROVIDERS.has(credentialProvider(file));

// --- Strict account identity --------------------------------------------------

const CODEX_ACCOUNT_ID_FIELDS = [
  'chatgpt_account_id',
  'chatgptAccountId',
  'account_id',
  'accountId',
] as const;

const CODEX_NESTED_EVIDENCE_FIELDS = [
  'id_token',
  'idToken',
  'access_token',
  'accessToken',
  'metadata',
  'attributes',
] as const;

const GENERIC_ACCOUNT_ID_FIELDS = [
  'account_id',
  'accountId',
  'user_id',
  'userId',
] as const;

const GENERIC_NESTED_EVIDENCE_FIELDS = [
  'metadata',
  'attributes',
  'id_token',
  'idToken',
] as const;

const normalizeOpaqueId = (value: unknown): { value: string | null; present: boolean; valid: boolean } => {
  if (value === undefined || value === null) return { value: null, present: false, valid: true };
  if (typeof value === 'string') {
    const trimmed = value.replace(/^ +| +$/g, '');
    if (!trimmed) return { value: null, present: false, valid: true };
    return { value: trimmed, present: true, valid: true };
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { value: String(value), present: true, valid: true };
  }
  return { value: null, present: true, valid: false };
};

/**
 * Conservative ASCII email normalizer used to identify an account member.
 * Weak display labels (such as "Personal" or filenames) return an empty string.
 */
export function normalizeStrictEmail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/^ +| +$/g, '');
  const at = normalized.indexOf('@');
  if (
    !normalized
    || at <= 0
    || at === normalized.length - 1
    || normalized.indexOf('@', at + 1) !== -1
  ) {
    return '';
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f) return '';
  }
  return normalized.toLowerCase();
}

export function resolveCodexAccountIdEvidence(file: AuthFile): { accountId: string; invalid: boolean } {
  const candidates = new Set<string>();
  let invalid = false;
  const visited = new Set<object>();

  const visit = (input: unknown) => {
    if (!isRecord(input)) {
      const payload = decodeQuotaToken(input);
      if (payload) {
        visit(payload);
        const authClaim = payload['https://api.openai.com/auth'];
        if (isRecord(authClaim)) visit(authClaim);
      }
      return;
    }
    if (visited.has(input)) return;
    visited.add(input);

    for (const field of CODEX_ACCOUNT_ID_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
      const candidate = normalizeOpaqueId(input[field]);
      if (!candidate.present) continue;
      if (!candidate.valid || !candidate.value) {
        invalid = true;
        continue;
      }
      candidates.add(candidate.value);
    }

    for (const field of CODEX_NESTED_EVIDENCE_FIELDS) {
      const nested = input[field];
      if (nested !== undefined && nested !== null) visit(nested);
    }
  };

  visit(file);
  if (invalid || candidates.size > 1) return { accountId: '', invalid: true };
  return { accountId: candidates.values().next().value ?? '', invalid: false };
}

function resolveGenericAccountIdEvidence(file: AuthFile): { accountId: string; invalid: boolean } {
  const candidates = new Set<string>();
  let invalid = false;
  const visited = new Set<object>();

  const visit = (input: unknown) => {
    if (!isRecord(input)) {
      const payload = decodeQuotaToken(input);
      if (payload) visit(payload);
      return;
    }
    if (visited.has(input)) return;
    visited.add(input);

    for (const field of GENERIC_ACCOUNT_ID_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
      const candidate = normalizeOpaqueId(input[field]);
      if (!candidate.present) continue;
      if (!candidate.valid || !candidate.value) {
        invalid = true;
        continue;
      }
      candidates.add(candidate.value);
    }

    for (const field of GENERIC_NESTED_EVIDENCE_FIELDS) {
      const nested = input[field];
      if (nested !== undefined && nested !== null) visit(nested);
    }
  };

  visit(file);
  if (invalid || candidates.size > 1) return { accountId: '', invalid: true };
  return { accountId: candidates.values().next().value ?? '', invalid: false };
}

function resolveStrictMemberEvidence(file: AuthFile): { member: string; invalid: boolean } {
  const candidates = new Set<string>();
  const recordSources: Record<string, unknown>[] = [file];
  for (const nestedKey of ['metadata', 'attributes'] as const) {
    const nested = file[nestedKey];
    if (isRecord(nested)) recordSources.push(nested);
  }
  for (const tokenKey of ['id_token', 'idToken'] as const) {
    const payload = decodeQuotaToken(file[tokenKey]);
    if (payload) recordSources.push(payload);
    for (const nestedKey of ['metadata', 'attributes'] as const) {
      const nested = file[nestedKey];
      if (!isRecord(nested)) continue;
      const nestedPayload = decodeQuotaToken(nested[tokenKey]);
      if (nestedPayload) recordSources.push(nestedPayload);
    }
  }

  for (const source of recordSources) {
    for (const field of ['accountSnapshot', 'account_snapshot', 'account', 'email'] as const) {
      const normalized = normalizeStrictEmail(source[field]);
      if (normalized) candidates.add(normalized);
    }
  }

  if (candidates.size > 1) return { member: '', invalid: true };
  return { member: candidates.values().next().value ?? '', invalid: false };
}

export function resolveCredentialAccountIdentity(file: AuthFile): CredentialAccountIdentity {
  const provider = credentialProvider(file);
  const memberEvidence = resolveStrictMemberEvidence(file);
  if (provider === 'codex') {
    const idEvidence = resolveCodexAccountIdEvidence(file);
    const invalid = idEvidence.invalid || memberEvidence.invalid;
    return {
      provider,
      accountId: invalid ? '' : idEvidence.accountId,
      member: invalid ? '' : memberEvidence.member,
      invalid,
    };
  }
  const idEvidence = resolveGenericAccountIdEvidence(file);
  const invalid = idEvidence.invalid || memberEvidence.invalid;
  return {
    provider,
    accountId: invalid ? '' : idEvidence.accountId,
    member: invalid ? '' : memberEvidence.member,
    invalid,
  };
}

export function hasStrongCredentialIdentity(identity: CredentialAccountIdentity): boolean {
  if (!identity.provider || identity.invalid) return false;
  if (identity.provider === 'codex') {
    return Boolean(identity.accountId && identity.member);
  }
  return Boolean(identity.accountId || identity.member);
}

/**
 * Strict account equality.
 * For Codex, multiple Team members share the same ChatGPT Workspace account ID
 * and one email can belong to multiple Workspaces, so BOTH accountId and strict
 * member email must be present and match. Any conflicting identity fields fail closed.
 */
export function sameCredentialIdentity(
  left: CredentialAccountIdentity,
  right: CredentialAccountIdentity,
): boolean {
  if (!left.provider || left.provider !== right.provider || left.invalid || right.invalid) {
    return false;
  }
  if (left.provider === 'codex') {
    return Boolean(left.accountId && left.member)
      && left.accountId === right.accountId
      && left.member === right.member;
  }
  if (left.accountId && right.accountId && left.member && right.member) {
    return left.accountId === right.accountId && left.member === right.member;
  }
  if (left.accountId && right.accountId) {
    return left.accountId === right.accountId;
  }
  if (left.member && right.member) {
    return left.member === right.member;
  }
  return false;
}

export function sameCredentialAccount(left: AuthFile, right: AuthFile): boolean {
  return sameCredentialIdentity(
    resolveCredentialAccountIdentity(left),
    resolveCredentialAccountIdentity(right),
  );
}

// --- Timestamps & multi-source evidence arbitration ---------------------------

const HEALTHY_STATUS_MESSAGES = new Set([
  'ok', 'healthy', 'ready', 'success', 'successful', 'available', 'active', 'enabled',
]);

export const isHealthyCredentialStatusMessage = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return !normalized || HEALTHY_STATUS_MESSAGES.has(normalized);
};

function parseTimestampMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.trunc(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.trunc(numeric < 1e12 ? numeric * 1000 : numeric);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  return null;
}

function maxTimestampMs(values: unknown[]): number | null {
  let latest = 0;
  for (const value of values) {
    const parsed = parseTimestampMs(value);
    if (parsed !== null && parsed > latest) latest = parsed;
  }
  return latest > 0 ? latest : null;
}

export function readCredentialUpdatedAtMs(file: AuthFile): number | null {
  return maxTimestampMs([file.updated_at, file.updatedAt, file.modtime]);
}

export function readCredentialRefreshAtMs(file: AuthFile): number | null {
  return maxTimestampMs([file.last_refresh, file.lastRefresh]);
}

export function readCredentialObservedAtMs(file: AuthFile): number | null {
  return maxTimestampMs([
    file.updated_at,
    file.updatedAt,
    file.modtime,
    file.last_refresh,
    file.lastRefresh,
  ]);
}

function normalizeHttpStatus(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
  }
  if (typeof value === 'string' && /^\s*\d{3}\s*$/.test(value)) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed >= 100 && parsed <= 599 ? parsed : null;
  }
  return null;
}

function readHttpStatusFromText(text: string): number | null {
  if (!text) return null;
  const explicit = text.match(/(?:\bhttp\s*|\bstatus(?:[_ -]?code)?\s*[:=]?\s*|\bcode["']?\s*[:=]\s*|\()([1-5]\d{2})\b/i);
  if (explicit) return normalizeHttpStatus(explicit[1]);
  const authOrRate = text.match(/\b(401|402|403|408|409|413|422|429|499|5\d{2})\b/);
  return authOrRate ? normalizeHttpStatus(authOrRate[1]) : null;
}

function readCredentialStatusCode(file: AuthFile, text: string): number | null {
  for (const field of ['error_status', 'errorStatus', 'status_code', 'statusCode', 'http_status', 'httpStatus']) {
    const parsed = normalizeHttpStatus(file[field]);
    if (parsed !== null) return parsed;
  }
  return readHttpStatusFromText(text);
}

const DEACTIVATED_PATTERN = /\b(?:account[_ -]?deactivated|deactivated[_ -]?workspace|tos[_ -]?violation)\b/i;

const NEUTRAL_TRANSPORT_PATTERN = /\b(?:context[_ -]?cancel(?:ed|led)|request[_ -]?cancel(?:ed|led)|client[_ -]?cancel(?:ed|led)?|cancel(?:ed|led)[_ -]?by[_ -]?client|client[_ -]?(?:disconnect(?:ed)?|closed[_ -]?(?:request|connection))|unexpected[_ -]?eof[_ -]?(?:from|by)[_ -]?client)\b|websocket:\s*close\s*100[01]\b/i;

const HIGH_CONFIDENCE_REAUTH_PATTERNS = [
  /\binvalid[_ -]?grant\b/i,
  /\brefresh[_ -]?token[_ -]?reused\b/i,
  /\brefresh[_ -]?token[^a-z0-9]*(?:has |is |was |has been )?(?:expired|revoked|invalid(?:ated)?|not found|reused|already used)\b/i,
  /\b(?:oauth[_ -]?)?token[_ -]?(?:revoked|invalidated|expired)\b/i,
  /\binvalidated[_ -]?oauth[_ -]?token\b/i,
  /\b(?:authentication|access|oauth)?[_ -]?token (?:has |is |was |has been )?(?:expired|revoked|invalidated)\b/i,
  /\binvalid[_ -]?token\b/i,
  /\binvalid or expired credentials?\b/i,
  /\bno[_ -]?auth[_ -]?context\b/i,
  /\bauth[_ -]?unavailable\b/i,
  /\b(?:sign ?in|log ?in) again\b/i,
  /\brequires? re-?(?:authori[sz]ation|authentication)\b/i,
  /\bre-?authenticat(?:e|ion required)\b/i,
] as const;

const QUOTA_LIMIT_PATTERN = /\b(?:insufficient[_ -]?quota|quota[_ -]?(?:exceeded|depleted|exhausted|limited|reached)|credits?[_ -]?(?:depleted|exhausted|limited)|rate[_ -]?limit(?:ed|[_ -]?(?:exceeded|reached))?|too many requests|usage[_ -]?limit(?:ed|[_ -]?(?:exceeded|reached))?)\b/i;

const REVIEW_PERMISSION_PATTERN = /\b(?:forbidden|permission[_ -]?denied)\b/i;

const REQUEST_ERROR_PATTERN = /\b(?:invalid[_ -]?request(?:[_ -]?error)?|bad[_ -]?request(?:[_ -]?error)?|malformed[_ -]?request|unsupported[_ -]?(?:parameter|model)|unprocessable[_ -]?entity|payload[_ -]?too[_ -]?large)\b/i;

const NON_AUTH_HTTP_STATUSES = new Set([400, 408, 409, 413, 422, 499]);

const HIGH_CONFIDENCE_HEALTH_LABELS = new Set<string>([
  'authFiles.health.reason.invalidGrant',
  'authFiles.health.reason.tokenExpired',
]);

function classifyAuthSignal(input: {
  statusCode: number | null;
  text: string;
  healthLabel?: string;
}): AuthEvidenceKind | 'neutral' | null {
  const { statusCode, text, healthLabel } = input;

  // 1. Deactivated accounts/workspaces cannot be recovered by signing in again.
  if (DEACTIVATED_PATTERN.test(text)) {
    return 'deactivated';
  }

  // 2. Client cancellations and neutral transport closures are never auth failures.
  if (statusCode === 499 || NEUTRAL_TRANSPORT_PATTERN.test(text)) {
    return 'neutral';
  }

  // 3. Explicit OAuth token revocation/expiry signals (including RFC 6749 HTTP 400 invalid_grant).
  if (
    (healthLabel && HIGH_CONFIDENCE_HEALTH_LABELS.has(healthLabel))
    || HIGH_CONFIDENCE_REAUTH_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return 'reauth';
  }

  // 4. Request-shape and transient upstream errors are excluded from sign-in alerts.
  if (statusCode !== null && (NON_AUTH_HTTP_STATUSES.has(statusCode) || statusCode >= 500)) {
    return 'neutral';
  }

  // 5. Quota and rate-limit responses (excluding deactivated_workspace above) confirm the token authenticated.
  if (statusCode === 429 || statusCode === 402 || QUOTA_LIMIT_PATTERN.test(text)) {
    return 'positive';
  }

  // 6. Generic 403/permission denials require manual review rather than automatic re-login alerts.
  if (statusCode === 403 || REVIEW_PERMISSION_PATTERN.test(text)) {
    return 'neutral';
  }

  // 7. HTTP 401 or explicit unauthorized/unauthenticated markers.
  if (
    statusCode === 401
    || healthLabel === 'authFiles.health.reason.unauthorized'
    || /\b(?:unauthori[sz]ed|unauthenticated)\b/i.test(text)
  ) {
    return 'reauth';
  }

  // 8. Request-body errors without an auth status code.
  if (REQUEST_ERROR_PATTERN.test(text)) {
    return 'neutral';
  }

  // 9. Successful HTTP responses confirm authentication works.
  if (statusCode !== null && statusCode >= 200 && statusCode < 400) {
    return 'positive';
  }

  return null;
}

function getCredentialStatusEvidence(file: AuthFile): AuthEvidence | null {
  const health = authFileHealth(file);
  const rawDetails = [
    health.message,
    readString(file, 'error', 'error_code', 'errorCode', 'error_type', 'errorType'),
  ].filter(Boolean).join(' ');
  const statusCode = readCredentialStatusCode(file, rawDetails);
  const observedAtMs = readCredentialObservedAtMs(file);

  if (rawDetails || statusCode !== null || health.tone === 'error') {
    const classified = classifyAuthSignal({
      statusCode,
      text: rawDetails,
      healthLabel: health.label,
    });
    if (classified === 'deactivated' || classified === 'reauth' || classified === 'positive') {
      return { kind: classified, observedAtMs, statusCode };
    }
    if (health.tone === 'error') return null;
  }

  const rawStatusMessage = readString(file, 'status_message', 'statusMessage').trim().toLowerCase();
  const explicitlyHealthy = health.status === 'active'
    || health.status === 'ready'
    || health.label === 'authFiles.health.active'
    || (rawStatusMessage.length > 0 && HEALTHY_STATUS_MESSAGES.has(rawStatusMessage));
  if (explicitlyHealthy) {
    return { kind: 'positive', observedAtMs, statusCode };
  }
  const refreshAtMs = readCredentialRefreshAtMs(file);
  if (refreshAtMs !== null && !readBoolean(file, 'unavailable')) {
    return { kind: 'positive', observedAtMs: refreshAtMs, statusCode };
  }
  return null;
}

function getQuotaStatusEvidence(quota: QuotaState | undefined): AuthEvidence | null {
  if (!quota || quota.status === 'idle' || quota.status === 'loading') return null;
  if (quota.status === 'success') {
    return {
      kind: 'positive',
      observedAtMs: parseTimestampMs(quota.fetchedAt),
      statusCode: 200,
    };
  }
  const errorText = typeof quota.error === 'string' ? quota.error.trim() : '';
  const statusCode = normalizeHttpStatus(quota.errorStatus) ?? readHttpStatusFromText(errorText);
  const observedAtMs = maxTimestampMs([quota.failedAtMs, quota.fetchedAt]);
  const classified = classifyAuthSignal({ statusCode, text: errorText });
  if (classified === 'deactivated' || classified === 'reauth' || classified === 'positive') {
    return { kind: classified, observedAtMs, statusCode };
  }
  return null;
}

/**
 * Evaluates whether a single OAuth credential currently requires re-authentication,
 * combining `/credentials` status and `quotaCache` evidence using timestamp arbitration.
 */
export function evaluateCredentialSignIn(
  file: AuthFile,
  quota?: QuotaState,
): CredentialSignInEvaluation {
  if (!isOAuthCredentialFile(file)) return 'none';
  const health = authFileHealth(file);
  if (health.disabled || health.suspension !== undefined) return 'none';

  const evidences = [
    getCredentialStatusEvidence(file),
    getQuotaStatusEvidence(quota),
  ].filter((item): item is AuthEvidence => item !== null);

  let latestPositiveAtMs = 0;
  for (const evidence of evidences) {
    if (evidence.kind === 'positive' && evidence.observedAtMs !== null && evidence.observedAtMs > latestPositiveAtMs) {
      latestPositiveAtMs = evidence.observedAtMs;
    }
  }

  const isCurrent = (evidence: AuthEvidence) =>
    evidence.observedAtMs === null || latestPositiveAtMs <= evidence.observedAtMs;

  if (evidences.some((evidence) => evidence.kind === 'deactivated' && isCurrent(evidence))) {
    return 'deactivated';
  }
  if (evidences.some((evidence) => evidence.kind === 'reauth' && isCurrent(evidence))) {
    return 'required';
  }
  return 'none';
}

/** An enabled OAuth credential whose login can no longer be used and needs sign-in again. */
export function credentialNeedsSignIn(file: AuthFile, quota?: QuotaState): boolean {
  return evaluateCredentialSignIn(file, quota) === 'required';
}

/** True when a credential is enabled, non-error, and not suffering an active auth/deactivation failure. */
export function isHealthyCredentialForReplacement(file: AuthFile, quota?: QuotaState): boolean {
  if (!isOAuthCredentialFile(file)) return false;
  const health = authFileHealth(file);
  if (health.disabled || health.tone === 'error' || health.suspension !== undefined) return false;
  if (readBoolean(file, 'unavailable') || health.status === 'error') return false;
  return evaluateCredentialSignIn(file, quota) === 'none';
}

/**
 * A healthy credential for the same account under another file name. The core
 * names some auth files after details that can change between logins (for
 * example Codex plan names), so signing in again may create a sibling file
 * instead of overwriting the expired one.
 */
export function signInReplacement(
  file: AuthFile,
  files: readonly AuthFile[],
  quotas?: Readonly<Record<string, QuotaState>>,
): AuthFile | undefined {
  if (!credentialNeedsSignIn(file, quotas?.[credentialQuotaKey(file)])) return undefined;
  const name = authFileName(file);
  return files.find((other) =>
    authFileName(other) !== name
    && isHealthyCredentialForReplacement(other, quotas?.[credentialQuotaKey(other)])
    && sameCredentialAccount(file, other));
}

/**
 * True when a credential still requires user attention to sign in again:
 * it needs sign-in and no healthy sibling for the same account suppresses it.
 */
export function credentialRequiresSignIn(
  file: AuthFile,
  files: readonly AuthFile[],
  quotas?: Readonly<Record<string, QuotaState>>,
): boolean {
  if (!credentialNeedsSignIn(file, quotas?.[credentialQuotaKey(file)])) return false;
  return !signInReplacement(file, files, quotas);
}

/** Credentials that currently require the user to sign in again (suppressed when a healthy replacement exists). */
export const credentialsNeedingSignIn = (
  files: readonly AuthFile[],
  quotas?: Readonly<Record<string, QuotaState>>,
): AuthFile[] => files.filter((file) => credentialRequiresSignIn(file, files, quotas));

// --- Transition tracker -------------------------------------------------------

export type SignInTransitionTrackerOptions = {
  initialKnown?: Iterable<string>;
  onChange?: (known: string[]) => void;
};

/**
 * Reports credentials that entered the needs-sign-in state since the previous
 * snapshot, once per credential per transition. A credential that recovers and
 * fails again is reported again.
 */
export function createSignInTransitionTracker(options: SignInTransitionTrackerOptions = {}) {
  let known = new Set<string>(options.initialKnown ?? []);
  return (files: readonly AuthFile[], quotas?: Readonly<Record<string, QuotaState>>): AuthFile[] => {
    const current = credentialsNeedingSignIn(files, quotas);
    const entered = current.filter((file) => !known.has(authFileName(file)));
    const nextKnown = new Set(current.map(authFileName));
    const changed = nextKnown.size !== known.size
      || Array.from(nextKnown).some((name) => !known.has(name));
    known = nextKnown;
    if (changed) options.onChange?.(Array.from(nextKnown));
    return entered;
  };
}

// --- Connection-scoped storage & notification dedup ---------------------------

const PREFERENCE_KEY = 'easy-cli-proxy-api.sign-in-notifications';
const NOTIFIED_STORAGE_PREFIX = 'easy-cli-proxy-api.sign-in-notified.v1';

let currentEndpoint: string | null = null;
const connectionChangeListeners = new Set<(fingerprint: string) => void>();
const observedFilesListeners = new Set<(files: readonly AuthFile[], fingerprint: string) => void>();

export function currentCredentialConnectionFingerprint(): string {
  return currentEndpoint ? `remote:${currentEndpoint}` : 'local';
}

function notifiedStorageKeyFor(endpoint: string | null): string {
  return endpoint ? `${NOTIFIED_STORAGE_PREFIX}:${endpoint}` : NOTIFIED_STORAGE_PREFIX;
}

function readStoredNotifiedNames(endpoint: string | null): string[] {
  try {
    const raw = window.localStorage.getItem(notifiedStorageKeyFor(endpoint));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function writeStoredNotifiedNames(endpoint: string | null, names: readonly string[]) {
  try {
    const key = notifiedStorageKeyFor(endpoint);
    if (names.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(names));
  } catch {
    // Ignore storage unavailability in restricted environments.
  }
}

export function subscribeCredentialConnectionChange(listener: (fingerprint: string) => void) {
  connectionChangeListeners.add(listener);
  return () => { connectionChangeListeners.delete(listener); };
}

export function subscribeObservedCredentialFiles(
  listener: (files: readonly AuthFile[], fingerprint: string) => void,
) {
  observedFilesListeners.add(listener);
  return () => { observedFilesListeners.delete(listener); };
}

const preferenceListeners = new Set<() => void>();

export function signInNotificationsEnabled(): boolean {
  try { return window.localStorage.getItem(PREFERENCE_KEY) !== 'off'; } catch { return true; }
}

export function setSignInNotificationsEnabled(enabled: boolean) {
  try { window.localStorage.setItem(PREFERENCE_KEY, enabled ? 'on' : 'off'); } catch {}
  preferenceListeners.forEach((listener) => listener());
}

export function subscribeSignInNotificationsPreference(listener: () => void) {
  preferenceListeners.add(listener);
  return () => { preferenceListeners.delete(listener); };
}

// --- Shared state for badges --------------------------------------------------

let alertNames: readonly string[] = [];
let latestObservedFiles: AuthFile[] = [];
const alertListeners = new Set<() => void>();

/** Names of credentials that currently need to sign in again, from the latest observation. */
export const readSignInAlerts = () => alertNames;

export function subscribeSignInAlerts(listener: () => void) {
  alertListeners.add(listener);
  return () => { alertListeners.delete(listener); };
}

function setAlertNames(names: readonly string[]) {
  if (names.join('\n') === alertNames.join('\n')) return;
  alertNames = names;
  alertListeners.forEach((listener) => listener());
}

const providerLabel = (file: AuthFile) => {
  const provider = credentialProvider(file);
  if (provider === 'xai') return 'xAI';
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : '';
};

let permissionGranted = false;
let permissionRequested = false;
let permissionInFlight: Promise<boolean> | null = null;

async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionGranted) return true;
  if (permissionInFlight) return permissionInFlight;
  permissionInFlight = (async () => {
    if (await isPermissionGranted()) {
      permissionGranted = true;
      return true;
    }
    if (permissionRequested) return false;
    permissionRequested = true;
    const granted = (await requestPermission()) === 'granted';
    if (granted) permissionGranted = true;
    return granted;
  })().catch(() => false).finally(() => {
    permissionInFlight = null;
  });
  return permissionInFlight;
}

async function notifySignInRequired(file: AuthFile) {
  if (!isTauri() || !signInNotificationsEnabled() || !await ensureNotificationPermission()) return;
  const locale = getCurrentLocale();
  const name = readString(file, 'email', 'account', 'label') || authFileName(file);
  sendNotification({
    title: translate(locale, 'notifications.signIn.title', { provider: providerLabel(file) }),
    body: translate(locale, 'notifications.signIn.body', { name }),
  });
}

function createPersistentTracker(endpoint: string | null) {
  return createSignInTransitionTracker({
    initialKnown: readStoredNotifiedNames(endpoint),
    onChange: (known) => writeStoredNotifiedNames(endpoint, known),
  });
}

let tracker = createPersistentTracker(currentEndpoint);

export function selectCredentialSignInStore(endpoint: string | null) {
  const normalized = endpoint?.trim() || null;
  if (normalized === currentEndpoint) return;
  currentEndpoint = normalized;
  latestObservedFiles = [];
  tracker = createPersistentTracker(currentEndpoint);
  setAlertNames([]);
  const fingerprint = currentCredentialConnectionFingerprint();
  connectionChangeListeners.forEach((listener) => listener(fingerprint));
}

function applyCredentialObservation(
  files: AuthFile[],
  quotas: Readonly<Record<string, QuotaState>>,
  notifyObservedListeners: boolean,
) {
  const entered = tracker(files, quotas);
  const names = credentialsNeedingSignIn(files, quotas).map(authFileName);
  setAlertNames(names);
  for (const file of entered) {
    void notifySignInRequired(file).catch((error) => console.warn('Failed to send sign-in notification', error));
  }
  if (notifyObservedListeners) {
    const fingerprint = currentCredentialConnectionFingerprint();
    observedFilesListeners.forEach((listener) => listener(files, fingerprint));
  }
}

/**
 * Feed every fresh `/credentials` list through here: it updates the badges and
 * sends one native notification per credential that newly needs to sign in.
 */
export function observeCredentialSignIn(
  files: readonly AuthFile[],
  quotas: Readonly<Record<string, QuotaState>> = getQuotaCacheSnapshot(),
) {
  const normalized = dedupeAuthFiles([...files]);
  latestObservedFiles = normalized;
  applyCredentialObservation(normalized, quotas, true);
}

/**
 * Re-evaluates the latest observed credential list against updated quota evidence
 * (for example after a quota lookup returns 401 or succeeds and clears an old error).
 */
export function refreshObservedCredentialSignIn(
  quotas: Readonly<Record<string, QuotaState>> = getQuotaCacheSnapshot(),
) {
  if (latestObservedFiles.length === 0) return;
  applyCredentialObservation(latestObservedFiles, quotas, false);
}

export function resetCredentialSignInStateForTests() {
  currentEndpoint = null;
  latestObservedFiles = [];
  permissionGranted = false;
  permissionRequested = false;
  permissionInFlight = null;
  tracker = createPersistentTracker(null);
  setAlertNames([]);
}
