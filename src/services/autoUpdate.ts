import { invoke } from './platform';

export type AutoUpdateSettings = {
  enabled: boolean;
  updateApp: boolean;
  updateCore: boolean;
};
export const defaultAutoUpdateSettings: Readonly<AutoUpdateSettings> = {
  enabled: false, updateApp: false, updateCore: false,
};

export type AutoUpdatePhase = 'disabled' | 'downloading' | 'installing'
  | 'waiting-startup' | 'waiting-update' | 'failed' | 'completed';
export type AutoUpdateStatus = {
  settings: AutoUpdateSettings;
  phase: AutoUpdatePhase;
  target: string | null;
  version: string | null;
  error: string | null;
};

export function validateAutoUpdateSettings(settings: AutoUpdateSettings): string | null {
  if (settings.enabled && !settings.updateApp && !settings.updateCore) return 'autoUpdate.selectTarget';
  return null;
}

export const getAutoUpdateStatus = () => invoke<AutoUpdateStatus>('get_auto_update_status');
export const saveAutoUpdateSettings = (settings: AutoUpdateSettings) => invoke<AutoUpdateStatus>('set_auto_update_settings', { settings });
export const retryAutoUpdate = () => invoke<AutoUpdateStatus>('retry_auto_update');
