import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { dedupeAuthFiles } from '../services/authFiles';
import {
  cancelCredentialReauth,
  getCredentialReauthSnapshot,
  startCredentialReauth,
  subscribeCredentialReauth,
  type ReauthResult,
} from '../services/credentialReauth';
import {
  currentCredentialConnectionFingerprint,
  observeCredentialSignIn,
  readSignInAlerts,
  setSignInNotificationsEnabled,
  signInNotificationsEnabled,
  subscribeSignInAlerts,
  subscribeSignInNotificationsPreference,
  type AuthFile,
} from '../services/credentialSignIn';
import { managementApi, responseList } from '../services/managementApi';

export type { ReauthResult };

// Runs while the window is hidden too: an expired login matters most when nobody is looking.
const SIGN_IN_WATCH_INTERVAL_MS = 120_000;

/** App-level poll of `/credentials` that feeds sign-in badges and notifications. */
export function useCredentialSignInWatch(enabled: boolean, targetRevision?: number) {
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    const check = () => {
      const fingerprint = currentCredentialConnectionFingerprint();
      void managementApi.get('/credentials')
        .then((payload) => {
          if (disposed || currentCredentialConnectionFingerprint() !== fingerprint) return;
          observeCredentialSignIn(dedupeAuthFiles(responseList(payload, 'files')));
        })
        .catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, SIGN_IN_WATCH_INTERVAL_MS);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [enabled, targetRevision]);
}

export const useSignInAlerts = () => useSyncExternalStore(subscribeSignInAlerts, readSignInAlerts);

export function useSignInNotificationsPreference() {
  const enabled = useSyncExternalStore(subscribeSignInNotificationsPreference, signInNotificationsEnabled);
  return [enabled, setSignInNotificationsEnabled] as const;
}

/**
 * Runs the built-in OAuth flow in place for one credential via a shared session
 * controller so switching pages does not drop polling or post-login cleanup.
 */
export function useCredentialReauth() {
  const state = useSyncExternalStore(subscribeCredentialReauth, getCredentialReauthSnapshot);

  const signInAgain = useCallback(
    (file: AuthFile, currentFiles?: readonly AuthFile[]): Promise<ReauthResult> =>
      startCredentialReauth(file, currentFiles),
    [],
  );

  const cancel = useCallback(() => {
    cancelCredentialReauth();
  }, []);

  return {
    pending: state.pending,
    openFailure: state.openFailure,
    completedRevision: state.completedRevision,
    signInAgain,
    cancel,
  };
}
