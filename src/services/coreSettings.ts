import { invoke } from '@tauri-apps/api/core';

export type SensitiveWordsSettings = {
  antigravitySensitiveWords: string[];
  devinSensitiveWords: string[];
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
  invoke<SensitiveWordsSettings>('get_core_sensitive_words_settings');

export const saveCoreSensitiveWordsSettings = (args: { settings: SensitiveWordsSettings; }): Promise<SensitiveWordsSettings> =>
  invoke<SensitiveWordsSettings>('save_core_sensitive_words_settings', args);

export const getCoreConfigSettings = (): Promise<CoreConfigSettings> =>
  invoke<CoreConfigSettings>('get_core_config_settings');

export const getSoftwareSettings = (): Promise<SoftwareSettings> =>
  invoke<SoftwareSettings>('get_software_settings');

export const getCoreTlsSettings = (): Promise<CoreTlsSettings> =>
  invoke<CoreTlsSettings>('get_core_tls_settings');

export const setCoreManagementSecretKey = (args: { secretKey: string; }): Promise<CoreConfigSettings> =>
  invoke<CoreConfigSettings>('set_core_management_secret_key', args);

export const clearCoreManagementSecretKey = (): Promise<CoreConfigSettings> =>
  invoke<CoreConfigSettings>('clear_core_management_secret_key');

export const updateCoreApiKey = (args: { originalApiKey: string; apiKey: string; remark: string; }): Promise<CoreConfigSettings> =>
  invoke<CoreConfigSettings>('update_core_api_key', args);

export const addCoreApiKey = (args: { apiKey: string; remark: string; }): Promise<CoreConfigSettings> =>
  invoke<CoreConfigSettings>('add_core_api_key', args);

export const saveCoreLoggingSettings = (args: { settings: { debug: boolean; commercialMode: boolean; loggingToFile: boolean; logsMaxTotalSizeMb: number; errorLogsMaxFiles: number; usageStatisticsEnabled: boolean; redisUsageQueueRetentionSeconds: number; }; }): Promise<CoreConfigSettings> =>
  invoke<CoreConfigSettings>('save_core_logging_settings', args);

export const openCoreLogsDirectory = (): Promise<void> =>
  invoke<void>('open_core_logs_directory');

export const deleteCoreApiKey = (args: { apiKey: string; }): Promise<CoreConfigSettings> =>
  invoke<CoreConfigSettings>('delete_core_api_key', args);

export const saveCoreTlsSettings = (args: { settings: { enabled: boolean; cert: string; key: string; }; }): Promise<CoreTlsSettings> =>
  invoke<CoreTlsSettings>('save_core_tls_settings', args);

export const setCoreRoutingStrategy = (args: { strategy: string; }): Promise<CoreConfigSettings> =>
  invoke<CoreConfigSettings>('set_core_routing_strategy', args);

export const saveNetworkEndpointSettings = (args: { settings: { host: string; port: number; proxyUrl: string; proxyOverride: boolean; } | { host: string; port: number; }; }): Promise<CoreConfigSettings> =>
  invoke<CoreConfigSettings>('save_network_endpoint_settings', args);

export const saveRetrySettings = (args: { settings: { disableCooling: boolean; requestRetry: number; maxRetryCredentials: number; maxRetryInterval: number; streamingBootstrapRetries: number; }; }): Promise<CoreConfigSettings> =>
  invoke<CoreConfigSettings>('save_retry_settings', args);

export const saveSessionRoutingSettings = (args: { settings: { routingSessionAffinity: boolean; routingSessionAffinityTtl: string; }; }): Promise<CoreConfigSettings> =>
  invoke<CoreConfigSettings>('save_session_routing_settings', args);

export const saveSoftwareSettings = (args: { settings: { closeBehavior: CloseBehavior; autostartEnabled: boolean; startCoreOnLaunch: boolean; silentStartEnabled: boolean; defaultTerminal: string; }; }): Promise<SoftwareSettings> =>
  invoke<SoftwareSettings>('save_software_settings', args);
