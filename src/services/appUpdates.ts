import { invoke } from '@tauri-apps/api/core';
import type { AppLocale } from '../i18n/index';

export type AppUpdateAction = 'update' | 'switchChannel';

export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  action: AppUpdateAction | null;
  downloadSource: string;
  releaseUrl: string;
  releaseNotes: Partial<Record<AppLocale, string>> | null;
  skippedReleaseNotes?: { version: string; releaseNotes: Partial<Record<AppLocale, string>> }[];
  publishedAt: string;
  currentBuildAt: string | null;
  autoUpdateSupported: boolean;
  preserveCoreSupported?: boolean;
  downloadUrl: string | null;
  downloadFileName: string | null;
  downloadSizeBytes: number | null;
  unsupportedReason: string | null;
  updateChannel: string;
};

export type AppUpdateTask = {
  running: boolean;
  preserveCore?: boolean;
  cancellable: boolean;
  phase: AppUpdatePhase;
  targetVersion: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  message: string | null;
};

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'staging'
  | 'waitingForExit'
  | 'restarting'
  | 'completed'
  | 'cancelled'
  | 'failed';

export const checkAppUpdate = (): Promise<AppUpdateInfo> =>
  invoke<AppUpdateInfo>('check_app_update');

export const getAppUpdateTask = (): Promise<AppUpdateTask> =>
  invoke<AppUpdateTask>('get_app_update_task');

export type AppUpdateOffer = Pick<AppUpdateInfo, 'updateChannel' | 'latestVersion' | 'downloadSource' | 'releaseUrl'> & {
  action: AppUpdateAction;
};

export const startAppUpdate = (offer: AppUpdateOffer, preserveCore = false): Promise<void> => {
  const { updateChannel, latestVersion, downloadSource, releaseUrl, action } = offer;
  return invoke<void>('start_app_update', {
    offer: { updateChannel, latestVersion, downloadSource, releaseUrl, action },
    preserveCore,
  });
};

export const cancelAppUpdate = (): Promise<void> =>
  invoke<void>('cancel_app_update');

export const getUpdateChannel = (): Promise<string> =>
  invoke<string>('get_update_channel');

export const listUpdateChannels = (): Promise<string[]> =>
  invoke<string[]>('list_update_channels');

export const setUpdateChannel = (channel: string): Promise<string> =>
  invoke<string>('set_update_channel', { channel });
