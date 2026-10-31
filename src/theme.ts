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
import type { PlatformWindowMaterial, ThemeDefinition } from './themes/types';
import { builtinThemes, createThemeRegistry, type ThemeRegistry } from './themes/registry';
import {
  ANIME_SAKURA_SKY_WALLPAPER,
  ANIME_STARLIGHT_WALLPAPER,
  withAnimeBackdrop,
  type AnimeWallpaperPreset,
} from './themes/anime';
import { isThemeImageDataUrl } from './themes/resources';
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

const ANIME_PRESET_KEY = 'easy-cli-proxy-api.anime-backdrop-preset.v1';
const ANIME_IMAGE_KEY = 'easy-cli-proxy-api.anime-backdrop-image.v1';

function readStorage(key: string): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

let animePreset: AnimeWallpaperPreset = (() => {
  const saved = readStorage(ANIME_PRESET_KEY);
  return saved === 'sakura-sky' || saved === 'none' || saved === 'custom' ? saved : 'starlight';
})();
let customAnimeImage: string | null = (() => {
  const saved = readStorage(ANIME_IMAGE_KEY);
  return isThemeImageDataUrl(saved) ? saved : null;
})();
let loadedCustomThemes: ThemeDefinition[] = [];

function resolveAnimeBackdropImage(): string | undefined {
  if (animePreset === 'none') return undefined;
  if (animePreset === 'sakura-sky') return ANIME_SAKURA_SKY_WALLPAPER;
  if (animePreset === 'custom' && customAnimeImage) return customAnimeImage;
  return ANIME_STARLIGHT_WALLPAPER;
}

function buildActiveRegistry(): ThemeRegistry {
  const resolvedBuiltins = builtinThemes.map((theme) =>
    theme.id === 'anime-light' ? withAnimeBackdrop(resolveAnimeBackdropImage()) : theme,
  );
  return createThemeRegistry([...resolvedBuiltins, ...loadedCustomThemes]);
}

let customRegistry = buildActiveRegistry();
let customStatus: CustomThemeStatus = { loading: false, failed: false, skipped: [], diagnostics: [], omitted: 0 };
let customLoads = 0;
const customSubscribers = new Set<() => void>();

function notifyThemeSubscribers() {
  customSubscribers.forEach((listener) => listener());
}

function refreshActiveRegistry() {
  customRegistry = buildActiveRegistry();
  controller?.setRegistry(customRegistry);
  notifyThemeSubscribers();
}

export function useAnimeBackdropState() {
  return useSyncExternalStore(
    subscribeCustomThemes,
    () => `${animePreset}:${customAnimeImage ? '1' : '0'}`,
  );
}

export function getAnimeBackdropInfo(): { preset: AnimeWallpaperPreset; hasCustomImage: boolean } {
  return { preset: animePreset, hasCustomImage: Boolean(customAnimeImage) };
}

export function setAnimeBackdropPreset(preset: AnimeWallpaperPreset): boolean {
  const next = preset === 'custom' && !customAnimeImage ? 'starlight' : preset;
  if (!writeStorage(ANIME_PRESET_KEY, next)) return false;
  animePreset = next;
  refreshActiveRegistry();
  return true;
}

export function setCustomAnimeBackdropImage(dataUrl: string | null): boolean {
  if (dataUrl !== null && !isThemeImageDataUrl(dataUrl)) return false;
  const nextPreset = dataUrl !== null ? 'custom' : animePreset === 'custom' ? 'starlight' : animePreset;
  const previousImage = readStorage(ANIME_IMAGE_KEY);
  if (!writeStorage(ANIME_IMAGE_KEY, dataUrl)) return false;
  if (!writeStorage(ANIME_PRESET_KEY, nextPreset)) {
    writeStorage(ANIME_IMAGE_KEY, previousImage);
    return false;
  }
  customAnimeImage = dataUrl;
  animePreset = nextPreset;
  refreshActiveRegistry();
  return true;
}

function reportCustomThemes(next: CustomThemeStatus) {
  customStatus = next;
  notifyThemeSubscribers();
}

async function loadCustomThemes() {
  const load = ++customLoads;
  reportCustomThemes({ ...customStatus, loading: true });
  try {
    const { files, omitted } = await listCustomThemes();
    const { themes, skipped, diagnostics } = parseCustomThemes(files);
    if (load !== customLoads) return;
    loadedCustomThemes = themes;
    customRegistry = buildActiveRegistry();
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
