import { invoke } from '@tauri-apps/api/core';

export type ProviderSection =
  | 'gemini-api-key'
  | 'interactions-api-key'
  | 'vertex-api-key'
  | 'xai-api-key'
  | 'meta-api-key'
  | 'codex-api-key'
  | 'claude-api-key'
  | 'openai-compatibility';

export type ApiAccessRemarkLocator = {
  providerName: string;
  baseUrl: string;
  apiKeys: string[];
  configIdentity?: string;
};

export const resolveApiAccessRemarks = (args: { queries: { providerName: string; baseUrl: string; apiKeys: string[]; configIdentity?: string; providerSection: ProviderSection; }[]; }): Promise<string[]> =>
  invoke<string[]>('resolve_api_access_remarks', args);

export const saveApiAccessRemark = (args: { update: { providerSection: ProviderSection; previousRecords: ApiAccessRemarkLocator[]; records: ApiAccessRemarkLocator[]; allRecords: ApiAccessRemarkLocator[]; remark: string; }; }): Promise<void> =>
  invoke<void>('save_api_access_remark', args);
