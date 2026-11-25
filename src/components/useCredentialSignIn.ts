import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { managementApi, readString, responseList } from '../services/managementApi';
import { dedupeAuthFiles } from '../services/authFiles';
import {
  observeCredentialSignIn,
  signInReplacement,
  readSignInAlerts,
  setSignInNotificationsEnabled,
  signInNotificationsEnabled,
  subscribeSignInAlerts,
  subscribeSignInNotificationsPreference,
} from '../services/credentialSignIn';
import {
  getOAuthStatus,
  loadOAuthBrowserPreference,
  NO_AUTO_OPEN_BROWSER_ID,
  openOAuthUrl,
  startOAuthLogin,
} from '../services/oauth';

// Runs while the window is hidden too: an expired login matters most when nobody is looking.
const SIGN_IN_WATCH_INTERVAL_MS = 120_000;
const OAUTH_POLL_INTERVAL_MS = 3000;

/** App-level poll of `/credentials` that feeds sign-in badges and notifications. */
export function useCredentialSignInWatch(enabled: boolean, targetRevision?: number) {
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    const check = () => {
      void managementApi.get('/credentials')
        .then((payload) => { if (!disposed) observeCredentialSignIn(responseList(payload, 'files')); })
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
 * After a successful sign-in, delete the expired file when the core wrote the
 * new tokens to a different file for the same account. Leaves it alone when the
 * user signed in to another account, so nothing is lost.
 */
async function removeReplacedCredential(name: string): Promise<string | undefined> {
  try {
    const files = dedupeAuthFiles(responseList(await managementApi.get('/credentials'), 'files'));
    const previous = files.find((file) => readString(file, 'name') === name);
    const replacement = previous && signInReplacement(previous, files);
    if (!replacement) return undefined;
    await managementApi.delete('/credentials', { query: { name } });
    return readString(replacement, 'name');
  } catch {
    return undefined;
  }
}

export type ReauthResult =
  // `replacedFile` is set when the core saved the new login under another name
  // and the expired file was removed.
  | { status: 'success'; replacedFile?: string }
  | { status: 'error'; error: string }
  | { status: 'cancelled' };

/**
 * Runs the same built-in OAuth flow as "+ Add Account" for one credential. The
 * core writes the new tokens to the same auth file, so the card recovers in place.
 */
export function useCredentialReauth() {
  const [pending, setPending] = useState<string | null>(null);
  // Set when no browser could be opened, so the page can show the sign-in link instead.
  const [openFailure, setOpenFailure] = useState<{ name: string; url: string } | null>(null);
  const session = useRef(0);
  const oauthState = useRef<string | null>(null);

  useEffect(() => () => { session.current += 1; }, []);

  const signInAgain = useCallback(async (name: string, provider: string): Promise<ReauthResult> => {
    const id = ++session.current;
    setPending(name);
    setOpenFailure(null);
    try {
      const preferred = loadOAuthBrowserPreference();
      const browser = preferred && preferred !== NO_AUTO_OPEN_BROWSER_ID ? preferred : 'default';
      const started = await startOAuthLogin({ provider, browser });
      if (!started.state) return { status: 'error', error: 'missing OAuth state' };
      if (!started.opened) {
        try { await openOAuthUrl({ url: started.url, browser: 'default' }); } catch { setOpenFailure({ name, url: started.url }); }
      }
      const state = started.state;
      oauthState.current = state;
      while (session.current === id) {
        await new Promise((resolve) => window.setTimeout(resolve, OAUTH_POLL_INTERVAL_MS));
        if (session.current !== id) break;
        const result = await getOAuthStatus({ state });
        const status = (result.status || '').toLowerCase();
        if (status === 'ok') return { status: 'success', replacedFile: await removeReplacedCredential(name) };
        if (status === 'error') return { status: 'error', error: result.error || '' };
      }
      return { status: 'cancelled' };
    } catch (error) {
      return { status: 'error', error: String(error) };
    } finally {
      if (session.current === id) { setPending(null); setOpenFailure(null); oauthState.current = null; }
    }
  }, []);

  const cancel = useCallback(() => {
    const state = oauthState.current;
    oauthState.current = null;
    session.current += 1;
    setPending(null);
    setOpenFailure(null);
    if (state) void managementApi.delete('/oauth/session', { query: { state } }).catch(() => undefined);
  }, []);

  return { pending, signInAgain, cancel, openFailure };
}
