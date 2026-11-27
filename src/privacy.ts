import { getPrivacyMode, savePrivacyMode, PrivacyPreferences } from './services/privacyPreferences';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { hasBackend } from './services/platform';
import { maskIdentifier, maskSensitiveText } from './services/privacyMask';
import { authFileIdentities, authFileName, type AuthFileRecord } from './services/authFiles';

const preferences = new PrivacyPreferences(() => window.localStorage);

export async function initializePrivacyMode(): Promise<void> {
  if (!hasBackend()) return;
  try {
    await preferences.initialize({
      load: () => getPrivacyMode(),
      save: (enabled) => savePrivacyMode({ enabled }),
    });
  } catch {
    console.error('Failed to load privacy mode preference; using browser preference');
  }
}

export function usePrivacyMode() {
  const enabled = useSyncExternalStore(preferences.subscribe, preferences.get, preferences.get);
  return [enabled, preferences.set] as const;
}

/**
 * Render-time masking helpers. Use them only where a value is displayed
 * (text, title, aria-label); keep raw values for requests, keys and copying.
 */
export function usePrivacyMask() {
  const [enabled] = usePrivacyMode();
  const text = useCallback((value: string, identities?: readonly string[]) =>
    enabled ? maskSensitiveText(value, identities) : value, [enabled]);
  const identifier = useCallback((value: string) =>
    enabled ? maskIdentifier(value) : value, [enabled]);
  const credentialName = useCallback((file: AuthFileRecord) =>
    text(authFileName(file), authFileIdentities(file)), [text]);
  return useMemo(() => ({ enabled, text, identifier, credentialName }), [enabled, text, identifier, credentialName]);
}
