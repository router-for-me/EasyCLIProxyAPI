import './styles/layers.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  hasBackend,
  initializeRuntimeTransport,
  isWebUi,
  useWebAuthStatus,
} from './services/platform';
import { getCpaConnection, type CpaConnection } from './services/remoteCpa';
import { AppErrorBoundary } from './AppErrorBoundary';
import App from './App';
import { I18nProvider } from './i18n';
import { initializeTheme, initializeThemePreferences, reloadCustomThemes } from './theme';
import { initializeUsagePreferences } from './services/usagePreferences';
import { initializePrivacyMode } from './privacy';
import './styles/index.css';
import { initializeWindowActivity } from './services/windowActivity';
import { WebLoginScreen } from './components/WebLoginScreen';

type ReadyPayload = {
  connection: CpaConnection | undefined;
  browserMockEnabled: boolean;
};

async function loadAuthenticatedAppState(browserMockEnabled: boolean): Promise<ReadyPayload> {
  const connection = await getCpaConnection().catch(() => undefined);
  await initializeWindowActivity();
  await Promise.all([
    initializeUsagePreferences(),
    initializeThemePreferences().then(() => initializeTheme()),
    initializePrivacyMode(),
  ]);
  initializeTheme();
  return { connection, browserMockEnabled };
}

function WebAuthGate({
  initialReady,
  browserMockEnabled,
}: {
  initialReady: ReadyPayload | null;
  browserMockEnabled: boolean;
}) {
  const auth = useWebAuthStatus();
  const [ready, setReady] = useState<ReadyPayload | null>(initialReady);
  const [loading, setLoading] = useState(false);

  const needsWebLogin = isWebUi() && !auth.authenticated;

  useEffect(() => {
    if (needsWebLogin) {
      setReady(null);
      return;
    }
    if (ready !== null) return;
    let cancelled = false;
    setLoading(true);
    void loadAuthenticatedAppState(browserMockEnabled)
      .then((payload) => {
        if (!cancelled) setReady(payload);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsWebLogin, ready, browserMockEnabled]);

  if (needsWebLogin) {
    return (
      <I18nProvider syncNativeLocale={false}>
        <AppErrorBoundary>
          <WebLoginScreen version={auth.version} />
        </AppErrorBoundary>
      </I18nProvider>
    );
  }

  if (!ready || loading) {
    return null;
  }

  return (
    <I18nProvider syncNativeLocale={ready.connection?.remoteActive === false}>
      <AppErrorBoundary>
        <App initialConnection={ready.connection} browserMockEnabled={ready.browserMockEnabled} />
      </AppErrorBoundary>
    </I18nProvider>
  );
}

async function bootstrap() {
  const auth = await initializeRuntimeTransport();
  let browserMockEnabled = false;
  if (import.meta.env.DEV && !hasBackend()) {
    const { installBrowserMock } = await import('./mocks/browserMock');
    browserMockEnabled = installBrowserMock() !== null;
    void reloadCustomThemes();
  }

  const initialReady = isWebUi() && !auth.authenticated
    ? null
    : await loadAuthenticatedAppState(browserMockEnabled);

  if (initialReady === null) {
    initializeTheme();
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <WebAuthGate initialReady={initialReady} browserMockEnabled={browserMockEnabled} />
    </StrictMode>,
  );
}

void bootstrap();
