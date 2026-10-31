import { invoke } from '@tauri-apps/api/core';
import type { CustomThemeList } from '../themes/customThemes';
import type { PlatformWindowMaterial, ThemeSelection, ThemeAppearance } from '../themes/types';
import type { AppTheme } from '../themeController';

export const listCustomThemes = (): Promise<CustomThemeList> =>
  invoke<CustomThemeList>('list_custom_themes');

export const detectWindowMaterial = (): Promise<PlatformWindowMaterial | null> =>
  invoke<PlatformWindowMaterial | null>('detect_window_material');

export const getThemeSelection = (): Promise<ThemeSelection | null> =>
  invoke<ThemeSelection | null>('get_theme_selection');

export const saveThemeSelection = (args: { selection: ThemeSelection; }): Promise<void> =>
  invoke<void>('save_theme_selection', args);

export const openCustomThemesDirectory = (): Promise<void> =>
  invoke<void>('open_custom_themes_directory');

export const detectCorePlatform = (): Promise<{ os: string }> =>
  invoke<{ os: string }>('detect_core_platform');

export const getLinuxSystemTheme = (): Promise<AppTheme | null> =>
  invoke<AppTheme | null>('get_linux_system_theme');

export const setWindowMaterial = (args: { material: PlatformWindowMaterial | null; appearance: ThemeAppearance; }): Promise<void> =>
  invoke<void>('set_window_material', args);
