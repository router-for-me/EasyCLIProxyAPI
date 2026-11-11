import type { MessageKey } from '../i18n/resources';
import { isRecord, readBoolean, readString } from './managementApi';

export type AuthFileCooldown = {
  scope: 'credential' | 'model';
  model?: string;
  reason: string;
  retryAt: string;
  remainingSeconds: number;
  httpStatus?: number;
  backoffLevel?: number;
};

export type AuthFileCooldownSnapshot = {
  receivedAtMs: number;
  observedAt?: string;
  records: AuthFileCooldown[] | null;
};

export type AuthFileHealth = {
  label: MessageKey;
  tone: 'success' | 'warning' | 'error' | 'neutral' | 'info';
  message: string;
  status: string;
  disabled: boolean;
  /** Upstream terms-of-service suspension reported by the core, not a plain disable. */
  suspension?: 'tos';
  /**
   * Set when the only evidence is the persisted appeal link, so the suspension is
   * historical rather than currently reported by the running core.
   */
  suspensionHistorical?: true;
};

export type AuthFileAppeal = { url: string; text?: string };

const reasonKeys: Record<string, MessageKey> = {
  quota: 'authFiles.health.reason.quota',
  credential_quota: 'authFiles.health.reason.credentialQuota',
  cloudflare_challenge: 'authFiles.health.reason.cloudflare',
  invalid_grant: 'authFiles.health.reason.invalidGrant',
  unauthorized: 'authFiles.health.reason.unauthorized',
  payment_required: 'authFiles.health.reason.accessDenied',
  not_found: 'authFiles.health.reason.notFound',
  model_not_supported: 'authFiles.health.reason.modelUnsupported',
  transient_error: 'authFiles.health.reason.upstream',
  token_expired: 'authFiles.health.reason.tokenExpired',
  tos_violation: 'authFiles.health.reason.tosViolation',
};

// The core marks a credential it deactivated after an upstream TOS violation with
// this status message; it is a terminal suspension, not a cooldown.
const suspensionReasons: Record<string, NonNullable<AuthFileHealth['suspension']>> = {
  tos_violation: 'tos',
};

/** HTTPS-only appeal link published by the core for a suspended credential. */
export function authFileAppeal(file: Record<string, unknown>): AuthFileAppeal | undefined {
  const url = readString(file, 'tos_appeal_url').trim();
  if (!/^https:\/\//i.test(url)) return undefined;
  const text = readString(file, 'tos_appeal_url_text').trim();
  return { url, ...(text ? { text } : {}) };
}

export function cooldownReasonKey(reason: string): MessageKey {
  return Object.prototype.hasOwnProperty.call(reasonKeys, reason)
    ? reasonKeys[reason] : 'authFiles.health.reason.unknown';
}

export function cooldownTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : undefined;
}

function normalizeCooldown(value: unknown): AuthFileCooldown | null {
  if (!isRecord(value)) return null;
  const scope = value.scope;
  const model = typeof value.model_key === 'string' ? value.model_key.trim() : '';
  const retryAt = cooldownTimestamp(value.retry_at);
  const remainingSeconds = value.remaining_seconds;
  if ((scope !== 'credential' && scope !== 'model') || (scope === 'model' && !model)
    || !retryAt || typeof remainingSeconds !== 'number'
    || !Number.isSafeInteger(remainingSeconds) || remainingSeconds <= 0
    || remainingSeconds > Number.MAX_SAFE_INTEGER / 1000) return null;
  const httpStatus = value.http_status;
  const backoffLevel = value.backoff_level;
  return {
    scope,
    ...(scope === 'model' ? { model } : {}),
    retryAt,
    remainingSeconds,
    reason: typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : 'unknown',
    ...(typeof httpStatus === 'number' && Number.isInteger(httpStatus)
      && httpStatus >= 400 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(typeof backoffLevel === 'number' && Number.isSafeInteger(backoffLevel)
      && backoffLevel >= 0 ? { backoffLevel } : {}),
  };
}

export function normalizeAuthFileCooldowns(
  value: unknown,
  receivedAtMs: number,
  observedAt?: string,
): AuthFileCooldownSnapshot | undefined {
  if (value === undefined) return undefined;
  const snapshot = { receivedAtMs, observedAt: cooldownTimestamp(observedAt) };
  if (!Array.isArray(value)) return { ...snapshot, records: null };
  const records = value.map(normalizeCooldown);
  if (records.some((record) => record === null)) return { ...snapshot, records: null };
  return { ...snapshot, records: records as AuthFileCooldown[] };
}

export function cooldownRemainingSeconds(record: AuthFileCooldown, receivedAtMs: number, nowMs: number): number {
  // Server-provided remaining time avoids client/server wall-clock skew. Keep
  // expired records visible until a fresh snapshot confirms the restriction lifted.
  const elapsedSeconds = Math.max(0, nowMs - receivedAtMs) / 1000;
  return Math.max(0, Math.ceil(record.remainingSeconds - elapsedSeconds));
}

export function summarizeAuthFileCooldowns(snapshot: AuthFileCooldownSnapshot | undefined, nowMs: number) {
  const receivedAtMs = snapshot?.receivedAtMs ?? nowMs;
  const rows = (snapshot?.records ?? []).map((record) => ({
    record,
    remainingSeconds: cooldownRemainingSeconds(record, receivedAtMs, nowMs),
  }));
  const active = rows.filter((row) => row.remainingSeconds > 0);
  return {
    rows,
    active,
    modelCount: new Set(active.filter(({ record }) => record.scope === 'model').map(({ record }) => record.model)).size,
    credentialWide: active.some(({ record }) => record.scope === 'credential'),
    earliestSeconds: active.length ? Math.min(...active.map((row) => row.remainingSeconds)) : 0,
    elapsed: rows.length > 0 && active.length === 0,
  };
}

const healthyMessages = new Set(['ok', 'healthy', 'ready', 'success', 'available', 'active']);
const messageReasons: Record<string, string> = {
  'quota exhausted': 'quota',
  'cloudflare challenge': 'cloudflare_challenge',
  'token expired': 'token_expired',
  'transient upstream error': 'transient_error',
};

export function authFileHealth(file: Record<string, unknown>): AuthFileHealth {
  const status = readString(file, 'status').toLowerCase();
  const rawMessage = readString(file, 'status_message', 'statusMessage');
  const message = healthyMessages.has(rawMessage.toLowerCase()) ? '' : rawMessage;
  const disabled = readBoolean(file, 'disabled') || status === 'disabled';
  const base = { status, message, disabled };
  if (disabled) {
    // A live suspension arrives as a status marker. That marker is memory-only, so
    // a reloaded credential keeps just the persisted appeal link. The two states
    // are indistinguishable in the payload once a re-enabled credential is disabled
    // again, so the link-only case is reported as a past suspension instead of
    // claiming a current one.
    const suspension = suspensionReasons[message.toLowerCase()];
    if (suspension) {
      return { ...base, message: '', label: 'authFiles.health.reason.tosViolation', tone: 'warning', suspension };
    }
    if (!message && authFileAppeal(file)) {
      return { ...base, message: '', label: 'authFiles.health.reason.tosViolationHistorical', tone: 'neutral', suspension: 'tos', suspensionHistorical: true };
    }
    return { ...base, label: 'authFiles.status.disabled', tone: 'neutral' };
  }
  if (readBoolean(file, 'unavailable') || status === 'error') {
    const marker = message.toLowerCase();
    const reason = Object.prototype.hasOwnProperty.call(messageReasons, marker) ? messageReasons[marker] : marker;
    const reasonKey = cooldownReasonKey(reason);
    return {
      ...base,
      label: reasonKey !== 'authFiles.health.reason.unknown' ? reasonKey
        : readBoolean(file, 'unavailable') ? 'authFiles.status.unavailable' : 'authFiles.health.error',
      tone: 'error',
    };
  }
  if (status === 'refreshing') return { ...base, label: 'authFiles.health.refreshing', tone: 'info' };
  if (status === 'pending') return { ...base, label: 'authFiles.health.pending', tone: 'warning' };
  if (message) return { ...base, label: 'authFiles.health.warning', tone: 'warning' };
  if (status === 'active' || status === 'ready') return { ...base, label: 'authFiles.health.active', tone: 'success' };
  return { ...base, label: 'authFiles.health.unknown', tone: 'neutral' };
}
