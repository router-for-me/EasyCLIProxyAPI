import { getRuntimeCapabilities, invoke, isWebUi } from './platform';
import type { AppLocale } from '../i18n/index';

export type GuiSettings = {
  host: string;
  port: number;
  runOnStartup: boolean;
  allowLan: boolean;
  closeBehavior: 'ask' | WindowsCloseAction;
};

export type WindowsCloseAction = 'exit' | 'minimize-to-tray';

export const setAppLocale = (args: { locale: AppLocale; }): Promise<string> =>
  invoke<string>('set_app_locale', args);

export const openExternalUrl = async (args: { url: string; }): Promise<void> => {
  if (isWebUi() || !getRuntimeCapabilities().canOpenLocalBrowser) {
    if (typeof window !== 'undefined' && /^https?:\/\//i.test(args.url.trim())) {
      window.open(args.url.trim(), '_blank', 'noopener,noreferrer');
      return;
    }
  }
  await invoke<void>('open_external_url', args);
};

export const getGuiSettings = (): Promise<GuiSettings> =>
  invoke<GuiSettings>('get_gui_settings');

export const resolveWindowsCloseRequest = (args: { action: WindowsCloseAction; remember: boolean; }): Promise<void> =>
  invoke<void>('resolve_windows_close_request', args);
