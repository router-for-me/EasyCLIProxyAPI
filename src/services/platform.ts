import { getVersion as nativeGetVersion } from '@tauri-apps/api/app';
import { getCurrentWindow as nativeWindow } from '@tauri-apps/api/window';
import { getCurrentWebview as nativeWebview } from '@tauri-apps/api/webview';
import { open as nativeOpen, save as nativeSave } from '@tauri-apps/plugin-dialog';
import {
  browseServerPath,
  getRuntimeCapabilities,
  getWebAuthSnapshot,
  hasBackend,
  initializeRuntimeTransport,
  invoke,
  isDesktopApp,
  isWebUi,
  listen,
  loadRuntimeCapabilities,
  pickBrowserFile,
  registerServerPathPicker,
  requestServerPathPicker,
  subscribeRuntimeCapabilities,
  subscribeWebAuth,
  uploadTempFile,
  useRuntimeCapabilities,
  useWebAuthStatus,
  webAuth,
  type RuntimeCapabilities,
  type RuntimeMode,
  type ServerFileFilter,
  type ServerPathEntry,
  type ServerPathListing,
  type ServerPathPickerOptions,
  type StagedUploadResult,
  type WebAuthStatus,
} from './rpc';

export const isTauri = (): boolean => isDesktopApp();
export const getVersion = (): Promise<string> => {
  if (isWebUi()) {
    const version = getRuntimeCapabilities().appVersion || getWebAuthSnapshot().version;
    return Promise.resolve(version);
  }
  return nativeGetVersion();
};

export {
  browseServerPath,
  getRuntimeCapabilities,
  getWebAuthSnapshot,
  hasBackend,
  initializeRuntimeTransport,
  invoke,
  isDesktopApp,
  isWebUi,
  listen,
  loadRuntimeCapabilities,
  pickBrowserFile,
  registerServerPathPicker,
  subscribeRuntimeCapabilities,
  subscribeWebAuth,
  uploadTempFile,
  useRuntimeCapabilities,
  useWebAuthStatus,
  webAuth,
};
export type {
  RuntimeCapabilities,
  RuntimeMode,
  ServerFileFilter,
  ServerPathEntry,
  ServerPathListing,
  ServerPathPickerOptions,
  StagedUploadResult,
  WebAuthStatus,
};

type FileFilter = { name: string; extensions: string[] };
type FileDialogOptions = { title?: string; defaultPath?: string; filters?: FileFilter[] };
export const open = (
  options: FileDialogOptions & { directory?: boolean; multiple?: false },
): Promise<string | null> => {
  if (isWebUi()) {
    return requestServerPathPicker({
      title: options.title,
      defaultPath: options.defaultPath,
      directory: options.directory,
      filters: options.filters,
    });
  }
  return nativeOpen(options);
};
export const save = (options: FileDialogOptions): Promise<string | null> => {
  if (isWebUi()) {
    return Promise.resolve(null);
  }
  return nativeSave(options);
};

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
