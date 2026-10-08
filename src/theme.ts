import { useSyncExternalStore } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createThemeController, type AppTheme, type ThemePreference } from './themeController';
import { ThemePreferences } from './services/themePreferences';

export type { AppTheme, ThemePreference } from './themeController';

const preferences = new ThemePreferences(() => window.localStorage);
const WINDOW_BACKGROUND: Record<AppTheme, string> = {
  light: '#ffffff',
  dark: '#0b0d11',
};

export function detectThemePreference(): ThemePreference {
  return preferences.get();
}

export async function initializeThemePreferences(): Promise<void> {
  if (!isTauri()) return;
  try {
    await preferences.initialize({
      load: () => invoke<ThemePreference | null>('get_theme_preference'),
      save: (preference) => invoke('save_theme_preference', { preference }),
    });
  } catch {
    console.error('Failed to load theme preference; using browser preference');
  }
}

function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.documentElement.style.backgroundColor = WINDOW_BACKGROUND[theme];
  if (document.body) {
    document.body.style.backgroundColor = WINDOW_BACKGROUND[theme];
  }
}

let controller: ReturnType<typeof createThemeController> | undefined;

export function initializeTheme() {
  if (controller) return controller;
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  controller = createThemeController({
    readPreference: detectThemePreference,
    savePreference(preference) {
      preferences.set(preference);
    },
    readMediaTheme: () => media?.matches ? 'dark' : 'light',
    listenMedia(listener) {
      if (!media) return () => {};
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', listener);
        return () => media.removeEventListener('change', listener);
      }
      media.addListener(listener);
      return () => media.removeListener(listener);
    },
    listenResume(listener) {
      const visible = () => { if (document.visibilityState === 'visible') listener(); };
      window.addEventListener('focus', listener);
      document.addEventListener('visibilitychange', visible);
      return () => {
        window.removeEventListener('focus', listener);
        document.removeEventListener('visibilitychange', visible);
      };
    },
    applyTheme,
    async connectNative() {
      if (!isTauri()) return null;
      const currentWindow = getCurrentWindow();
      const currentWebview = getCurrentWebview();
      const { os } = await invoke<{ os: string }>('detect_core_platform');
      return {
        explicitSystemAppearance: os === 'linux',
        setTheme: (theme) => currentWindow.setTheme(theme),
        readTheme: () => os === 'linux'
          ? invoke<AppTheme | null>('get_linux_system_theme')
          : currentWindow.theme(),
        listen: (listener) => currentWindow.onThemeChanged(({ payload }) => listener(payload)),
        async setBackground(theme) {
          const background = WINDOW_BACKGROUND[theme];
          await Promise.allSettled([
            currentWindow.setBackgroundColor(background),
            currentWebview.setBackgroundColor(background),
          ]);
        },
      };
    },
  });
  return controller;
}

export function useThemePreference() {
  const themeController = initializeTheme();
  const preference = useSyncExternalStore(themeController.subscribe, themeController.getPreference);
  return [preference, themeController.setPreference] as const;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => controller?.dispose());
}
