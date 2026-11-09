import { listen } from '@tauri-apps/api/event';
import type { CoreStatus } from './coreLifecycle';
import type { AppUpdateTask } from './appUpdates';
import type { CoreInstallTask } from './coreVersions';
import type { CodexSessionRepairProgress } from './codexSessionState';
import type { AgentUsageSyncProgress, AgentUsageSyncResult } from './agentUsage';

type Handler<T> = (event: { payload: T }) => void;
export const onCoreStatusChanged = (handler: Handler<CoreStatus>): Promise<() => void> => listen('core-status-changed', handler);
export const onAppUpdateProgress = (handler: Handler<AppUpdateTask>): Promise<() => void> => listen('app-update-progress', handler);
export const onCoreInstallProgress = (handler: Handler<CoreInstallTask>): Promise<() => void> => listen('core-install-progress', handler);
export const onCodexSessionRepairProgress = (handler: Handler<CodexSessionRepairProgress>): Promise<() => void> => listen('codex-session-repair-progress', handler);
export const onConfigFilesChanged = (handler: () => void): Promise<() => void> => listen('config-files-changed', handler);
export const onUsageRecordsUpdated = (handler: () => void): Promise<() => void> => listen('usage-records-updated', handler);
export const onAgentUsageSyncProgress = (handler: Handler<AgentUsageSyncProgress>): Promise<() => void> => listen('agent-usage-sync-progress', handler);
export const onAgentUsageSynced = (handler: Handler<AgentUsageSyncResult | null>): Promise<() => void> => listen('agent-usage-synced', handler);
export const onWindowsCloseRequested = (handler: () => void): Promise<() => void> => listen('windows-close-requested', handler);
