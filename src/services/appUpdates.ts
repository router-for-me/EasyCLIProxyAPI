import { invoke } from '@tauri-apps/api/core';
import type { AppLocale } from '../i18n/index';

export type AppVersionSeries = 'stable' | 'preview';
export type AppVersionBaselines = { stable: string | null; preview: string | null; installedSeries: AppVersionSeries | null };

export type AppUpdateInfo = {
  currentVersion: string | null;
  latestSeriesVersion: string | null;
  installedSeries: AppVersionSeries | null;
  comparisonNewer: boolean;
  latestVersion: string;
  updateAvailable: boolean;
  installAvailable: boolean;
  releaseUrl: string;
  releaseNotes: Partial<Record<AppLocale, string>> | null;
  skippedReleaseNotes?: { version: string; releaseNotes: Partial<Record<AppLocale, string>> }[];
  publishedAt: string;
  currentBuildAt: string | null;
  latestBuildAt: string | null;
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

export const checkAppVersionDisplay = (series: AppVersionSeries): Promise<AppUpdateInfo> =>
  invoke<AppUpdateInfo>('check_app_version_display', { series });

export const getAppVersionBaselines = (): Promise<AppVersionBaselines> =>
  invoke<AppVersionBaselines>('get_app_version_baselines');

export const getAppUpdateTask = (): Promise<AppUpdateTask> =>
  invoke<AppUpdateTask>('get_app_update_task');

export const startAppUpdate = (preserveCore: boolean, expectedChannel: string, expectedVersion: string): Promise<void> =>
  invoke<void>('start_app_update', { preserveCore, expectedChannel, expectedVersion });

export const cancelAppUpdate = (): Promise<void> =>
  invoke<void>('cancel_app_update');

export const getUpdateChannel = (): Promise<string> =>
  invoke<string>('get_update_channel');

export const listUpdateChannels = (): Promise<string[]> =>
  invoke<string[]>('list_update_channels');

export const setUpdateChannel = (channel: string): Promise<string> =>
  invoke<string>('set_update_channel', { channel });
