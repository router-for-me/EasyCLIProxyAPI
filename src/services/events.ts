import { listen } from '@tauri-apps/api/event';
import type { CoreStatus } from './coreLifecycle';
import type { AppUpdateTask } from './appUpdates';
import type { CoreInstallTask, VersionSourceSettings } from './coreVersions';
import type { CodexSessionRepairProgress } from './codexSessionState';

type Handler<T> = (event: { payload: T }) => void;
export const onCoreStatusChanged = (handler: Handler<CoreStatus>): Promise<() => void> => listen('core-status-changed', handler);
export const onAppUpdateProgress = (handler: Handler<AppUpdateTask>): Promise<() => void> => listen('app-update-progress', handler);
export const onCoreInstallProgress = (handler: Handler<CoreInstallTask>): Promise<() => void> => listen('core-install-progress', handler);
export const onVersionDownloadSourceChanged = (handler: Handler<VersionSourceSettings>): Promise<() => void> => listen('version-download-source-changed', handler);
export const onCodexSessionRepairProgress = (handler: Handler<CodexSessionRepairProgress>): Promise<() => void> => listen('codex-session-repair-progress', handler);
export const onConfigFilesChanged = (handler: () => void): Promise<() => void> => listen('config-files-changed', handler);
export const onUsageRecordsUpdated = (handler: () => void): Promise<() => void> => listen('usage-records-updated', handler);
export const onWindowsCloseRequested = (handler: () => void): Promise<() => void> => listen('windows-close-requested', handler);
