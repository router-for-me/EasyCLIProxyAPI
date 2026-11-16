import { invoke } from '@tauri-apps/api/core';

export type AcpModel = { id: string; name: string; reasoningLevels?: string[] };
export type AcpStatus = {
  executable: string | null;
  profile: string;
  authenticated: boolean;
  busy: boolean;
  operation: string;
  models: AcpModel[];
  selectedModel: string;
  error: string | null;
  latestProbe: AcpProbeResult | null;
  upstreamEnabled: boolean;
  upstreamUrl: string | null;
  accounts: Array<{ id: string; label: string; email?: string | null }>;
  activeAccount: string;
};
export type AcpProbeResult = {
  text: string; model: string; durationMs: number; firstTextMs: number | null; stopReason: string;
};
export const acpApi = {
  status: () => invoke<AcpStatus>('get_acp_status'),
  connect: (login: boolean) => invoke<AcpStatus>('acp_connect', { login }),
  switchAccount: (accountId: string) => invoke<AcpStatus>('switch_acp_account', { accountId }),
  addAccount: (label: string) => invoke<AcpStatus>('add_acp_account', { label }),
  reloginAccount: () => invoke<AcpStatus>('relogin_acp_account'),
  cancel: () => invoke<void>('cancel_acp_operation'),
  selectModel: (model: string) => invoke<AcpStatus>('select_acp_model', { model }),
  test: () => invoke<AcpProbeResult>('test_acp_connection'),
  setUpstreamEnabled: (enabled: boolean) => invoke<AcpStatus>('set_acp_upstream_enabled', { enabled }),
};
