import { invoke } from '@tauri-apps/api/core';

import { remoteTargetRevision } from './remoteCpa';
import { managementApi } from './managementApi';

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
  remoteTargetRevision() === undefined ? invoke<CoreStatus>('get_core_status') : managementApi.get('/config/config-version').then(() => ({
    installed: false, running: true, ready: true, starting: false, managed: false, processId: null, currentVersion: null, installDir: '', binaryPath: null, message: '',
  }));

export const restartCoreProcess = (): Promise<CoreStatus> =>
  invoke<CoreStatus>('restart_core_process');

export const startCoreProcess = (): Promise<CoreStatus> =>
  invoke<CoreStatus>('start_core_process');

export const stopCoreProcess = (): Promise<CoreStatus> =>
  invoke<CoreStatus>('stop_core_process');
