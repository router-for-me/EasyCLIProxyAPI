import './styles/layers.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from './services/platform';
import { AppErrorBoundary } from './AppErrorBoundary';
import App from './App';
import { I18nProvider } from './i18n';
import { initializeTheme, initializeThemePreferences, reloadCustomThemes } from './theme';
import { initializeUsagePreferences } from './services/usagePreferences';
import { initializePrivacyMode } from './privacy';
import './styles/index.css';
import { initializeWindowActivity } from './services/windowActivity';

async function bootstrap() {
  await initializeWindowActivity();
  await Promise.all([initializeUsagePreferences(), initializeThemePreferences().then(() => initializeTheme()), initializePrivacyMode()]);
  if (import.meta.env.DEV && !isTauri()) {
    const { installBrowserMock } = await import('./mocks/browserMock');
    installBrowserMock();
    void reloadCustomThemes();
  }

  initializeTheme();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </I18nProvider>
    </StrictMode>,
  );
}

void bootstrap();
