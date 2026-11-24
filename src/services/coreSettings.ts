import { invoke as nativeInvoke } from '@tauri-apps/api/core';
import { remoteTargetRevision } from './remoteCpa';

export function invokeCoreSetting<Result>(operation: string, args: Record<string, unknown> = {}): Promise<Result> {
  const revision = remoteTargetRevision();
  if (revision === undefined || operation.endsWith('software_settings') || operation === 'open_core_logs_directory') return nativeInvoke(operation, args);
  return nativeInvoke('remote_core_settings', { revision, operation, args });
}

export type SensitiveWordsSettings = {
  antigravitySensitiveWords: string[];
  devinSensitiveWords: string[];
  antigravitySensitiveWordsReplace: Record<string, string>;
  devinSensitiveWordsReplace: Record<string, string>;
};

export type CoreConfigSettings = {
  managementSecretConfigured: boolean;
  apiKeys: CoreApiKey[];
  debug: boolean;
  commercialMode: boolean;
  loggingToFile: boolean;
  logsMaxTotalSizeMb: number;
  errorLogsMaxFiles: number;
  usageStatisticsEnabled: boolean;
  redisUsageQueueRetentionSeconds: number;
  host: string;
  port: number;
  allowLan: boolean;
  routingStrategy: string;
  proxyUrl: string;
  proxyOverride: boolean;
  routingSessionAffinity: boolean;
  routingSessionAffinityTtl: string;
  disableCooling: boolean;
  requestRetry: number;
  maxRetryCredentials: number;
  maxRetryInterval: number;
  streamingBootstrapRetries: number;
};

export type CoreApiKey = {
  apiKey: string;
  remark: string;
};

export type SoftwareSettings = {
  closeBehavior: CloseBehavior;
  autostartEnabled: boolean;
  startCoreOnLaunch: boolean;
  silentStartEnabled: boolean;
  defaultTerminal: string;
  availableTerminals: AgentTerminalOption[];
};

export type CloseBehavior = 'ask' | 'exit' | 'minimize-to-tray';

export type AgentTerminalOption = {
  id: string;
  label: string;
};

export type CoreTlsSettings = {
  enabled: boolean;
  cert: string;
  key: string;
};

export const getCoreSensitiveWordsSettings = (): Promise<SensitiveWordsSettings> =>
  invokeCoreSetting<SensitiveWordsSettings>('get_core_sensitive_words_settings');

export const saveCoreSensitiveWordsSettings = (args: { expected?: unknown; settings: SensitiveWordsSettings; }): Promise<SensitiveWordsSettings> =>
  invokeCoreSetting<SensitiveWordsSettings>('save_core_sensitive_words_settings', args);

export const getCoreConfigSettings = (): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('get_core_config_settings');

export const getSoftwareSettings = (): Promise<SoftwareSettings> =>
  invokeCoreSetting<SoftwareSettings>('get_software_settings');

export const getCoreTlsSettings = (): Promise<CoreTlsSettings> =>
  invokeCoreSetting<CoreTlsSettings>('get_core_tls_settings');

export const followSystemCoreProxy = (): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('set_core_proxy_url', { proxyUrl: '', proxyOverride: false });

export const saveCoreProxySettings = (proxyUrl: string, proxyOverride: boolean): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('set_core_proxy_url', { proxyUrl, proxyOverride });

export const setCoreManagementSecretKey = (args: { secretKey: string; }): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('set_core_management_secret_key', args);

export const clearCoreManagementSecretKey = (): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('clear_core_management_secret_key');

export const updateCoreApiKey = (args: { originalApiKey: string; apiKey: string; remark: string; }): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('update_core_api_key', args);

export const addCoreApiKey = (args: { apiKey: string; remark: string; }): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('add_core_api_key', args);

export const saveCoreLoggingSettings = (args: { expected?: unknown; settings: { debug: boolean; commercialMode: boolean; loggingToFile: boolean; logsMaxTotalSizeMb: number; errorLogsMaxFiles: number; usageStatisticsEnabled: boolean; redisUsageQueueRetentionSeconds: number; }; }): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('save_core_logging_settings', args);

export const openCoreLogsDirectory = (): Promise<void> =>
  invokeCoreSetting<void>('open_core_logs_directory');

export const deleteCoreApiKey = (args: { apiKey: string; }): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('delete_core_api_key', args);

export const saveCoreTlsSettings = (args: { expected?: unknown; settings: { enabled: boolean; cert: string; key: string; }; }): Promise<CoreTlsSettings> =>
  invokeCoreSetting<CoreTlsSettings>('save_core_tls_settings', args);

export const setCoreRoutingStrategy = (args: { expected?: unknown; strategy: string; }): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('set_core_routing_strategy', args);

export const saveNetworkEndpointSettings = (args: { expected?: unknown; settings: { host: string; port: number; proxyUrl: string; proxyOverride: boolean; } | { host: string; port: number; }; }): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('save_network_endpoint_settings', args);

export const saveRetrySettings = (args: { expected?: unknown; settings: { disableCooling: boolean; requestRetry: number; maxRetryCredentials: number; maxRetryInterval: number; streamingBootstrapRetries: number; }; }): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('save_retry_settings', args);

export const saveSessionRoutingSettings = (args: { expected?: unknown; settings: { routingSessionAffinity: boolean; routingSessionAffinityTtl: string; }; }): Promise<CoreConfigSettings> =>
  invokeCoreSetting<CoreConfigSettings>('save_session_routing_settings', args);

export const saveSoftwareSettings = (args: { settings: { closeBehavior: CloseBehavior; autostartEnabled: boolean; startCoreOnLaunch: boolean; silentStartEnabled: boolean; defaultTerminal: string; }; }): Promise<SoftwareSettings> =>
  invokeCoreSetting<SoftwareSettings>('save_software_settings', args);
