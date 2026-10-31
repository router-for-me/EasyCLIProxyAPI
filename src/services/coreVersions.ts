import { invoke } from '@tauri-apps/api/core';

export type CoreLatest = {
  version: string;
  assetName: string;
};

export type CoreVersionOption = {
  version: string;
  assetName: string;
  prerelease: boolean;
};

export type CoreInstallTask = {
  running: boolean;
  cancellable: boolean;
  phase: string;
  downloaded: number;
  total: number | null;
  percent: number | null;
  message: string | null;
  result: CoreInstallResult | null;
};

export type CoreInstallResult = {
  version: string;
  assetName: string;
  installDir: string;
  binaryPath: string | null;
};

export type BundledCoreInfo = {
  version: string;
  assetName: string;
};

export type VersionSourceSettings = {
  source: VersionDownloadSource;
  gitcodeAvailable: boolean;
  customMirrors: string[];
};

export type VersionDownloadSource = string;

export const checkLatestCore = (): Promise<CoreLatest> =>
  invoke<CoreLatest>('check_latest_core');

export const listCoreVersions = (): Promise<CoreVersionOption[]> =>
  invoke<CoreVersionOption[]>('list_core_versions');

export const getCoreInstallTask = (): Promise<CoreInstallTask> =>
  invoke<CoreInstallTask>('get_core_install_task');

export const setDownloadSource = (args: { source: string; }): Promise<VersionSourceSettings> =>
  invoke<VersionSourceSettings>('set_download_source', args);

export const addCustomDownloadMirror = (args: { url: string; }): Promise<VersionSourceSettings> =>
  invoke<VersionSourceSettings>('add_custom_download_mirror', args);

export const removeCustomDownloadMirror = (args: { url: string; }): Promise<VersionSourceSettings> =>
  invoke<VersionSourceSettings>('remove_custom_download_mirror', args);

export const installBundledCore = (): Promise<CoreInstallResult> =>
  invoke<CoreInstallResult>('install_bundled_core');

export const installCoreVersion = (args: { version: string; }): Promise<CoreInstallResult> =>
  invoke<CoreInstallResult>('install_core_version', args);

export const cancelCoreInstall = (): Promise<void> =>
  invoke<void>('cancel_core_install');

export const detectBundledCore = (): Promise<BundledCoreInfo | null> =>
  invoke<BundledCoreInfo | null>('detect_bundled_core');

export const getVersionSourceSettings = (): Promise<VersionSourceSettings> =>
  invoke<VersionSourceSettings>('get_version_source_settings');
