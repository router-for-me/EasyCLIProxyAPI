import { invoke } from '@tauri-apps/api/core';
import type { ClaudeDesktopModelMapping } from './claudeDesktopModels';
import type { ModelOption } from './modelService';
import type { DeepSeekHarnessLaunchOptions } from './deepSeekHarnessLaunch';

export type AgentExecutablePaths = Partial<Record<AgentClientId | `${AgentClientId}:app`, string>>;

export type AgentConfigBackupListing = { versions: AgentConfigBackupVersion[] };

export type AgentConfigBackupVersion = { id: string; createdAt: string | null; fileCount: number; location: string; files: AgentConfigBackupFile[]; restorable: boolean; error: string | null };

export type AgentConfigBackupFile = { path: string; exists: boolean | null; size: number | null };

export type AgentConfigBackupPreview = { revision: string; files: AgentConfigBackupFile[]; differences: { file: string; field: string; before: string; after: string }[] };

export type AgentConfigStatus = {
  id: AgentClientId;
  name: string;
  supportedPlatform: boolean;
  installed: boolean;
  pluginInstalled: boolean;
  launchTargets: AgentLaunchTarget[];
  version: string | null;
  cliVersion: string | null;
  appVersion: string | null;
  pluginVersion: string | null;
  configExists: boolean;
  configValid: boolean;
  configured: boolean;
  connectionState: 'configured' | 'not-configured' | 'needs-update' | 'invalid';
  configurationSynchronized: boolean;
  currentModel: string | null;
  currentApiKey?: string | null;
  oauthConfiguration: boolean;
  codexNativeOauth: boolean;
  codexOpenaiProvider?: boolean;
  codexRemoteCompaction?: boolean;
  modificationEnabled: boolean;
  modificationState: AgentModificationState;
  backupAvailable: boolean;
  appliedModel: string | null;
  claudeCodeModelMappings: ClaudeModelMappings | null;
  claudeDesktopModelMappings: ClaudeModelMappings | null;
  warnings: string[];
  error: string | null;
};

export type AgentClientId =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'opencode'
  | 'openclaw'
  | 'hermes'
  | 'deepseek-harness'
  | 'zcode'
  | 'workbuddy'
  | 'antigravity-cli'
  | 'copilot-cli'
  | 'vscode-copilot'
  | 'kimi-code'
  | 'grok-build'
  | 'omp'
  | 'pi';

export type AgentLaunchTarget = {
  id: 'app' | 'cli';
  label: string;
  detail: string;
};

export type AgentModificationState = 'unconfigured' | 'applied' | 'invalid';

export type ClaudeModelMappings = {
  desktopModels?: ClaudeDesktopModelMapping[];
  opus: string;
  sonnet: string;
  haiku: string;
  fable: string;
  fable1m: boolean;
  opus1m: boolean;
  sonnet1m: boolean;
  haiku1m: boolean;
  maxContextTokens: number;
  autoCompactPct: number;
  disableAutoCompact: boolean;
  manageDefaultModel: boolean;
  manageSubagentModel: boolean;
  startupModel: string;
  subagentModel: string;
};

export type DeepSeekHarnessProcessStatus = {
  running: boolean;
  pid: number | null;
  mode: string | null;
};

export type PiProviderUpdateStatus = {
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
};

export type AgentConfigActionResult = {
  outcome: 'applied' | 'default' | 'updated' | 'unchanged';
  enabled: boolean;
  model: string | null;
  changedFiles: string[];
  conflictFiles: string[];
};

export const listAgentConfigBackups = (args: { client: string; }): Promise<AgentConfigBackupListing> =>
  invoke<AgentConfigBackupListing>('list_agent_config_backups', args);

export const previewAgentConfigBackup = (args: { client: string; id: string; }): Promise<AgentConfigBackupPreview> =>
  invoke<AgentConfigBackupPreview>('preview_agent_config_backup', args);

export const restoreAgentConfigBackup = (args: { client: string; id: string; revision: string; }): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('restore_agent_config_backup', args);

export const deleteAgentConfigBackup = (args: { client: string; id: string; }): Promise<void> =>
  invoke<void>('delete_agent_config_backup', args);

export const refreshAgentConfigStatuses = (args: { executableOverrides: AgentExecutablePaths; }): Promise<AgentConfigStatus[]> =>
  invoke<AgentConfigStatus[]>('refresh_agent_config_statuses', args);

export const getAgentConfigStatuses = (args: { executableOverrides: AgentExecutablePaths; }): Promise<AgentConfigStatus[]> =>
  invoke<AgentConfigStatus[]>('get_agent_config_statuses', args);

export const getDeepSeekHarnessProcessStatus = (): Promise<DeepSeekHarnessProcessStatus> =>
  invoke<DeepSeekHarnessProcessStatus>('get_deepseek_harness_process_status');

export const getAgentModels = (args: { client: AgentClientId; }): Promise<ModelOption[]> =>
  invoke<ModelOption[]>('get_agent_models', args);

export const checkPiProviderUpdate = (): Promise<PiProviderUpdateStatus> =>
  invoke<PiProviderUpdateStatus>('check_pi_provider_update');

export const restoreCodexOfficialConfig = (): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('restore_codex_official_config');

export const updateAgentConfig = (args: { client: AgentClientId; model: string; oauthConfiguration: boolean; claudeCodeModelMappings: ClaudeModelMappings | null; claudeDesktopModelMappings: ClaudeModelMappings | null; executableOverrides: AgentExecutablePaths; apiKey?: string | null; }): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('update_agent_config', args);

export const installPiProvider = (args: { model: string; executableOverrides: AgentExecutablePaths; apiKey?: string | null; }): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('install_pi_provider', args);

export const updatePiProvider = (args: { model: string; executableOverrides: AgentExecutablePaths; apiKey?: string | null; }): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('update_pi_provider', args);

export const repairPiProvider = (args: { model: string; apiKey?: string | null; }): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('repair_pi_provider', args);

export const uninstallPiProvider = (args: { executableOverrides: AgentExecutablePaths; }): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('uninstall_pi_provider', args);

export const applyAgentConfigTemplate = (args: { revision: string; client: AgentClientId; model: string; oauthConfiguration: boolean; claudeCodeModelMappings: ClaudeModelMappings | null; claudeDesktopModelMappings: ClaudeModelMappings | null; apiKey?: string | null; }): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('apply_agent_config_template', args);

export const setCodexOpenaiProvider = (args: { enabled: boolean; }): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('set_codex_openai_provider', args);

export const closeCodexConfigModification = (): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('close_codex_config_modification');

export const setAgentConfigEnabled = (args: { client: Exclude<AgentClientId, 'codex'>; model: string; enabled: boolean; forceRestore: boolean; claudeCodeModelMappings: null; claudeDesktopModelMappings: null; executableOverrides: AgentExecutablePaths; apiKey?: string | null; }): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('set_agent_config_enabled', args);

export const clearCodexConfig = (): Promise<string[]> =>
  invoke<string[]>('clear_codex_config');

export const launchAgent = (args: { client: AgentClientId; target: "app" | "cli"; executablePath: string | null; desktopExecutablePath: string | null; workingDirectory: string | null; deepseekHarnessOptions: DeepSeekHarnessLaunchOptions | null; }): Promise<void> =>
  invoke<void>('launch_agent', args);

export const stopDeepSeekHarnessProcess = (): Promise<DeepSeekHarnessProcessStatus> =>
  invoke<DeepSeekHarnessProcessStatus>('stop_deepseek_harness_process');

export const restartAgentApp = (args: { client: AgentClientId; executablePath: string | null; }): Promise<void> =>
  invoke<void>('restart_agent_app', args);

export const getCodexCliDaemonRunning = (args: { executablePath: string | null; }): Promise<boolean> =>
  invoke<boolean>('get_codex_cli_daemon_running', args);

export const restartCodexCliDaemon = (args: { executablePath: string | null; }): Promise<void> =>
  invoke<void>('restart_codex_cli_daemon', args);

export const restartDeepSeekHarnessProcess = (): Promise<DeepSeekHarnessProcessStatus> =>
  invoke<DeepSeekHarnessProcessStatus>('restart_deepseek_harness_process');

export const createAgentConfigBackup = (args: { client: AgentClientId; }): Promise<AgentConfigBackupVersion> =>
  invoke<AgentConfigBackupVersion>('create_agent_config_backup', args);

export const previewAgentConfigTemplate = (args: { client: AgentClientId; model: string; oauthConfiguration: boolean; claudeCodeModelMappings: ClaudeModelMappings | null; claudeDesktopModelMappings: ClaudeModelMappings | null; apiKey?: string | null; }): Promise<{ revision: string; files: string[] }> =>
  invoke<{ revision: string; files: string[] }>('preview_agent_config_template', args);

export const setCodexRemoteCompaction = (args: { enabled: boolean }) =>
  invoke<void>('set_codex_remote_compaction', args);

export type CodexSubagentConfig = {
  enabled: boolean;
  maxConcurrentThreadsPerSession: number | null;
  defaultSubagentModel: string | null;
  defaultSubagentReasoningEffort: string | null;
  interruptMessage: boolean;
};

export const getCodexSubagentConfig = (): Promise<CodexSubagentConfig> =>
  invoke<CodexSubagentConfig>('get_codex_subagent_config');

export const saveCodexSubagentConfig = (config: CodexSubagentConfig): Promise<AgentConfigActionResult> =>
  invoke<AgentConfigActionResult>('save_codex_subagent_config', { config });
