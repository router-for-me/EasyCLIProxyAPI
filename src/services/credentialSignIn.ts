import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrentLocale, translate } from '../i18n';
import { authFileHealth } from './authFileHealth';
import { authFileName, isOAuthCredentialFile, normalizeOAuthProvider } from './authFiles';
import { readBoolean, readString } from './managementApi';
import { isTauri } from './platform';

type AuthFile = Record<string, unknown>;

// Health labels the core reports for a credential whose login can no longer be refreshed.
const signInLabels = new Set<string>([
  'authFiles.health.reason.invalidGrant',
  'authFiles.health.reason.unauthorized',
  'authFiles.health.reason.tokenExpired',
]);
// The core often passes the upstream error through verbatim, e.g.
// `{"error":"invalid_grant","error_description":"Refresh token expired"}` (#724).
const signInMessage = /invalid_grant|refresh[ _-]?token[^a-z]*(?:has |is |was )?(?:expired|revoked|invalid|not found|reused)|token (?:has |is )?(?:expired|revoked)|unauthori[sz]ed|\b401\b|sign in again|log ?in again|re-?authenticat/i;

/** Providers whose built-in OAuth flow finishes without a pasted callback or device code. */
export const REAUTH_PROVIDERS = new Set(['claude', 'codex', 'antigravity']);

/** An enabled OAuth credential that the core stopped using because its login can no longer be refreshed. */
export function credentialNeedsSignIn(file: AuthFile): boolean {
  if (!isOAuthCredentialFile(file)) return false;
  const health = authFileHealth(file);
  if (health.disabled || health.tone !== 'error') return false;
  return signInLabels.has(health.label) || signInMessage.test(health.message);
}

export const canReauthenticate = (file: AuthFile) => REAUTH_PROVIDERS.has(credentialProvider(file));

const credentialProvider = (file: AuthFile) => normalizeOAuthProvider(readString(file, 'provider', 'type', 'account_type'));

/** Same provider and same account, by account id when both carry one, otherwise by email. */
function sameAccount(left: AuthFile, right: AuthFile): boolean {
  if (credentialProvider(left) !== credentialProvider(right)) return false;
  const leftId = readString(left, 'account_id', 'accountId');
  const rightId = readString(right, 'account_id', 'accountId');
  if (leftId && rightId) return leftId === rightId;
  const leftEmail = readString(left, 'email').trim().toLowerCase();
  return Boolean(leftEmail) && leftEmail === readString(right, 'email').trim().toLowerCase();
}

/**
 * A working credential for the same account under another file name. The core
 * names some auth files after details that can change between logins (Codex
 * includes the plan, e.g. `-prolite` then `-pro`), so signing in again may add
 * a new file instead of overwriting the expired one.
 */
export function signInReplacement(file: AuthFile, files: AuthFile[]): AuthFile | undefined {
  if (!credentialNeedsSignIn(file)) return undefined;
  const name = authFileName(file);
  return files.find((other) => authFileName(other) !== name
    && isOAuthCredentialFile(other)
    && !readBoolean(other, 'disabled')
    && !credentialNeedsSignIn(other)
    && sameAccount(file, other));
}

export type CredentialSignInState = 'required' | 'replaced' | null;

export function credentialSignInState(file: AuthFile, files: AuthFile[]): CredentialSignInState {
  if (!credentialNeedsSignIn(file)) return null;
  return signInReplacement(file, files) ? 'replaced' : 'required';
}

/** Credentials that still need the user to sign in: no working replacement exists. */
export const credentialsNeedingSignIn = (files: AuthFile[]) =>
  files.filter((file) => credentialSignInState(file, files) === 'required');

/**
 * Reports credentials that entered the needs-sign-in state since the previous
 * snapshot, once per credential per transition. A credential that recovers and
 * fails again is reported again.
 */
export function createSignInTransitionTracker() {
  let known = new Set<string>();
  return (files: AuthFile[]): AuthFile[] => {
    const current = credentialsNeedingSignIn(files);
    const entered = current.filter((file) => !known.has(authFileName(file)));
    known = new Set(current.map(authFileName));
    return entered;
  };
}

// --- Preference ------------------------------------------------------------

const PREFERENCE_KEY = 'easy-cli-proxy-api.sign-in-notifications';
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
const alertListeners = new Set<() => void>();

/** Names of credentials that currently need to sign in again, from the latest credential list. */
export const readSignInAlerts = () => alertNames;

export function subscribeSignInAlerts(listener: () => void) {
  alertListeners.add(listener);
  return () => { alertListeners.delete(listener); };
}

const providerLabel = (file: AuthFile) => {
  const provider = credentialProvider(file);
  if (provider === 'xai') return 'xAI';
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : '';
};

let permission: Promise<boolean> | null = null;
const notificationPermission = () => {
  permission ??= (async () => {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === 'granted';
  })().catch(() => false);
  return permission;
};

async function notifySignInRequired(file: AuthFile) {
  if (!isTauri() || !signInNotificationsEnabled() || !await notificationPermission()) return;
  const locale = getCurrentLocale();
  const name = readString(file, 'email', 'account', 'label') || authFileName(file);
  sendNotification({
    title: translate(locale, 'notifications.signIn.title', { provider: providerLabel(file) }),
    body: translate(locale, 'notifications.signIn.body', { name }),
  });
}

const tracker = createSignInTransitionTracker();

/**
 * Feed every fresh `/credentials` list through here: it updates the badges and
 * sends one native notification per credential that newly needs to sign in.
 */
export function observeCredentialSignIn(files: AuthFile[]) {
  const entered = tracker(files);
  const names = credentialsNeedingSignIn(files).map(authFileName);
  if (names.join('\n') !== alertNames.join('\n')) {
    alertNames = names;
    alertListeners.forEach((listener) => listener());
  }
  for (const file of entered) {
    void notifySignInRequired(file).catch((error) => console.warn('Failed to send sign-in notification', error));
  }
}
