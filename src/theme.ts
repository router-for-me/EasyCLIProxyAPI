import {
  listCustomThemes,
  detectWindowMaterial as readWindowMaterial,
  getThemeSelection,
  saveThemeSelection,
  openCustomThemesDirectory as openThemesDirectory,
  detectCorePlatform,
  getLinuxSystemTheme,
  setWindowMaterial,
} from './services/desktopTheme';
import { useSyncExternalStore } from 'react';
import { isTauri, getCurrentWebview, getCurrentWindow } from './services/platform';
import { createThemeController, type ThemePreference } from './themeController';
import { ThemePreferences } from './services/themePreferences';
import { createThemeApplicator, themeWindowMaterial } from './themes/applyTheme';
import { cacheFirstPaint, firstPaint } from './themes/firstPaint';
import type { PlatformWindowMaterial } from './themes/types';
import { builtinThemes, createThemeRegistry, themeRegistry, type ThemeRegistry } from './themes/registry';
import { parseCustomThemes, type CustomThemeDiagnostic, type SkippedCustomTheme } from './themes/customThemes';

export type { AppTheme, ThemePreference } from './themeController';

const preferences = new ThemePreferences();
let platformMaterial: PlatformWindowMaterial | null = null;
const applyTheme = createThemeApplicator(document, () => platformMaterial);

export function detectThemePreference(): ThemePreference {
  return preferences.get();
}

export type CustomThemeStatus = {
  loading: boolean;
  failed: boolean;
  skipped: readonly SkippedCustomTheme[];
  diagnostics: readonly CustomThemeDiagnostic[];
  omitted: number;
};

let customRegistry = themeRegistry;
let customStatus: CustomThemeStatus = { loading: false, failed: false, skipped: [], diagnostics: [], omitted: 0 };
let customLoads = 0;
const customSubscribers = new Set<() => void>();

function reportCustomThemes(next: CustomThemeStatus) {
  customStatus = next;
  customSubscribers.forEach((listener) => listener());
}

async function loadCustomThemes() {
  const load = ++customLoads;
  reportCustomThemes({ ...customStatus, loading: true });
  try {
    const { files, omitted } = await listCustomThemes();
    const { themes, skipped, diagnostics } = parseCustomThemes(files);
    if (load !== customLoads) return;
    customRegistry = createThemeRegistry([...builtinThemes, ...themes]);
    controller?.setRegistry(customRegistry);
    reportCustomThemes({ loading: false, failed: false, skipped, diagnostics, omitted });
  } catch {
    if (load === customLoads) reportCustomThemes({ ...customStatus, loading: false, failed: true });
  }
}

async function detectWindowMaterial() {
  platformMaterial = await readWindowMaterial().catch(() => null);
}

export async function initializeThemePreferences(): Promise<void> {
  if (!isTauri()) return;
  await Promise.all([preferences.initialize({
    load: () => getThemeSelection(),
    save: (selection) => saveThemeSelection({ selection }),
  }), loadCustomThemes(), detectWindowMaterial()]);
}

export const reloadCustomThemes = loadCustomThemes;

export const openCustomThemesDirectory = () => openThemesDirectory();

const subscribeCustomThemes = (listener: () => void) => {
  customSubscribers.add(listener);
  return () => { customSubscribers.delete(listener); };
};

export function useCustomThemeStatus() {
  return useSyncExternalStore(subscribeCustomThemes, () => customStatus);
}

export function useThemePreferenceIssue() {
  return useSyncExternalStore(preferences.subscribe, preferences.getIssue);
}

export const retryThemeSave = preferences.retry;

let controller: ReturnType<typeof createThemeController> | undefined;

export function initializeTheme(registry: ThemeRegistry = customRegistry) {
  if (controller) return controller;
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  controller = createThemeController({
    readPreference: detectThemePreference,
    readSystemThemes: preferences.getSystemThemes,
    savePreference(preference, remembered) {
      preferences.set(preference, remembered);
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
    applyTheme(_appearance, definition) {
      applyTheme(definition);
      cacheFirstPaint(() => window.localStorage,
        firstPaint(controller?.getRegistry() ?? registry, preferences.get(), preferences.getSystemThemes(), definition));
    },
    async connectNative() {
      if (!isTauri()) return null;
      const currentWindow = getCurrentWindow();
      const currentWebview = getCurrentWebview();
      const { os } = await detectCorePlatform();
      return {
        explicitSystemAppearance: os === 'linux',
        setTheme: (theme) => currentWindow.setTheme(theme),
        readTheme: () => os === 'linux'
          ? getLinuxSystemTheme()
          : currentWindow.theme(),
        listen: (listener) => currentWindow.onThemeChanged(({ payload }) => listener(payload)),
        async setBackground(_appearance, definition) {
          const material = themeWindowMaterial(definition, platformMaterial);
          const paint = (background: string) => Promise.allSettled([
            currentWindow.setBackgroundColor(background),
            currentWebview.setBackgroundColor(background),
          ]);
          if (!platformMaterial) {
            await paint(definition.windowBackground);
            return;
          }
          const switchMaterial = () => setWindowMaterial({ material, appearance: definition.appearance });
          if (!material) {
            await paint(definition.windowBackground);
            await switchMaterial();
          } else if (await switchMaterial().then(() => true, () => false)) {
            await paint('#00000000');
          } else {
            platformMaterial = null;
            controller?.setRegistry(controller.getRegistry());
          }
        },
      };
    },
  }, registry);
  return controller;
}

export function useThemePreference() {
  const themeController = initializeTheme();
  const preference = useSyncExternalStore(themeController.subscribe, themeController.getPreference);
  return [preference, themeController.setPreference] as const;
}

export function useSystemThemes() {
  const themeController = initializeTheme();
  return useSyncExternalStore(themeController.subscribe, themeController.getSystemThemes);
}

export function useResolvedThemeId() {
  const themeController = initializeTheme();
  return useSyncExternalStore(themeController.subscribe, themeController.getResolvedThemeId);
}

export function useThemeRegistry() {
  const themeController = initializeTheme();
  return useSyncExternalStore(themeController.subscribe, themeController.getRegistry);
}

export function setSystemTheme(id: string) {
  initializeTheme().setSystemTheme(id);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => controller?.dispose());
}
