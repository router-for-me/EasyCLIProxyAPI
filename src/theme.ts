import { useSyncExternalStore } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createThemeController, type AppTheme, type ThemePreference } from './themeController';

export type { AppTheme, ThemePreference } from './themeController';

const STORAGE_KEY = 'easy-cli-proxy-api.theme';
const WINDOW_BACKGROUND: Record<AppTheme, string> = {
  light: '#f6f7f5',
  dark: '#111412',
};

export function detectThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
  }
  return 'system';
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
      try {
        window.localStorage.setItem(STORAGE_KEY, preference);
      } catch {
      }
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
