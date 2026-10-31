import { invoke } from '@tauri-apps/api/core';
import type { AppLocale } from '../i18n/index';

export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  releaseNotes: Partial<Record<AppLocale, string>> | null;
  publishedAt: string;
  autoUpdateSupported: boolean;
  downloadSizeBytes: number | null;
  unsupportedReason: string | null;
};

export type AppUpdateTask = {
  running: boolean;
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

export const startAppUpdate = (): Promise<void> =>
  invoke<void>('start_app_update');

export const cancelAppUpdate = (): Promise<void> =>
  invoke<void>('cancel_app_update');
