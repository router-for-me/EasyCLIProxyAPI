import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppErrorBoundary } from './AppErrorBoundary';
import App from './App';
import { I18nProvider } from './i18n';
import { ThemeProvider } from './theme';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>
);
