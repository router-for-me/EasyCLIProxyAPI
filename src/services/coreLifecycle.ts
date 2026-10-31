import { invoke } from '@tauri-apps/api/core';

export type CoreStatus = {
  installed: boolean;
  running: boolean;
  ready: boolean;
  starting: boolean;
  managed: boolean;
  processId: number | null;
  currentVersion: string | null;
  installDir: string;
  binaryPath: string | null;
  message: string;
  recovery?: {
    phase: 'waiting' | 'restarting' | 'failed';
    attempt: number;
    delaySeconds: number;
    detail: string;
  } | null;
};

export const getCoreStatus = (): Promise<CoreStatus> =>
  invoke<CoreStatus>('get_core_status');

export const restartCoreProcess = (): Promise<CoreStatus> =>
  invoke<CoreStatus>('restart_core_process');

export const startCoreProcess = (): Promise<CoreStatus> =>
  invoke<CoreStatus>('start_core_process');

export const stopCoreProcess = (): Promise<CoreStatus> =>
  invoke<CoreStatus>('stop_core_process');
