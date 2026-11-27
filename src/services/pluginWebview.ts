import { invoke, isWebUi } from './platform';

export type WebviewBounds = { x: number; y: number; width: number; height: number; viewportHeight: number };

export const EMPTY_BOUNDS: WebviewBounds = { x: 0, y: 0, width: 0, height: 0, viewportHeight: 0 };

export const roundBounds = ({ left, top, width, height }: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, viewportHeight: number): WebviewBounds => ({
  x: Math.max(0, Math.round(left)),
  y: Math.max(0, Math.round(top)),
  width: Math.max(0, Math.round(width)),
  height: Math.max(0, Math.round(height)),
  viewportHeight: Math.max(0, Math.round(viewportHeight)),
});

export const hasArea = (bounds: WebviewBounds): boolean => bounds.width > 0 && bounds.height > 0;

export const sameBounds = (a: WebviewBounds, b: WebviewBounds): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.viewportHeight === b.viewportHeight;

export const effectiveBounds = ({ active, overlay, bounds }: { active: boolean; overlay: boolean; bounds: WebviewBounds }): WebviewBounds =>
  active && !overlay && hasArea(bounds) ? bounds : EMPTY_BOUNDS;

let lastToken = 0;

export const newWebviewToken = (): number => {
  lastToken = Math.max(lastToken + 1, Date.now() * 1000);
  return lastToken;
};

export const hidePluginWebview = (args: { token: number; }): Promise<void> =>
  isWebUi() ? Promise.resolve() : invoke<void>('hide_plugin_webview', args);

export const showPluginWebview = (args: { pluginId: string; menuIndex: number; bounds: WebviewBounds; labels: { back: string; reload: string; openExternal: string; move: string; }; reload: boolean; token: number; }): Promise<string> =>
  invoke<string>('show_plugin_webview', args);

export const setPluginWebviewBounds = (args: { bounds: WebviewBounds; token: number; }): Promise<void> =>
  isWebUi() ? Promise.resolve() : invoke<void>('set_plugin_webview_bounds', args);

export const closePluginWebview = (): Promise<void> =>
  isWebUi() ? Promise.resolve() : invoke<void>('close_plugin_webview');

export const resolvePluginEntryPath = (args: { pluginId: string; menuIndex: number }): Promise<string> =>
  invoke<string>('resolve_plugin_entry_path', args);
