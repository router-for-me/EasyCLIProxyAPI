import { isTauri as nativeIsTauri } from '@tauri-apps/api/core';
import { getVersion as nativeGetVersion } from '@tauri-apps/api/app';
import { getCurrentWindow as nativeWindow } from '@tauri-apps/api/window';
import { getCurrentWebview as nativeWebview } from '@tauri-apps/api/webview';
import { open as nativeOpen, save as nativeSave } from '@tauri-apps/plugin-dialog';

export const isTauri = (): boolean => nativeIsTauri();
export const getVersion = (): Promise<string> => nativeGetVersion();

type FileFilter = { name: string; extensions: string[] };
type FileDialogOptions = { title?: string; defaultPath?: string; filters?: FileFilter[] };
export const open = (options: FileDialogOptions & { directory?: boolean; multiple?: false }): Promise<string | null> => nativeOpen(options);
export const save = (options: FileDialogOptions): Promise<string | null> => nativeSave(options);

export function getCurrentWindow() {
  const window = nativeWindow();
  return {
    isMaximized: (): Promise<boolean> => window.isMaximized(),
    isFocused: (): Promise<boolean> => window.isFocused(),
    minimize: (): Promise<void> => window.minimize(),
    toggleMaximize: (): Promise<void> => window.toggleMaximize(),
    close: (): Promise<void> => window.close(),
    onResized: (handler: () => void): Promise<() => void> => window.onResized(handler),
    onFocusChanged: (handler: (event: { payload: boolean }) => void): Promise<() => void> => window.onFocusChanged(handler),
    setTheme: (theme: 'light' | 'dark' | null): Promise<void> => window.setTheme(theme),
    theme: (): Promise<'light' | 'dark' | null> => window.theme(),
    onThemeChanged: (handler: (event: { payload: 'light' | 'dark' }) => void): Promise<() => void> => window.onThemeChanged(handler),
    setBackgroundColor: (color: string): Promise<void> => window.setBackgroundColor(color),
  };
}

export function getCurrentWebview() {
  const webview = nativeWebview();
  return { setBackgroundColor: (color: string): Promise<void> => webview.setBackgroundColor(color) };
}
