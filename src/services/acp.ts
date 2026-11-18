import { invoke } from '@tauri-apps/api/core';

export type AcpAccount = { id: string; label: string; email?: string | null; saved: boolean };
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
  accounts: AcpAccount[];
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
  renameAccount: (accountId: string, label: string) => invoke<AcpStatus>('rename_acp_account', { accountId, label }),
  removeAccount: (accountId: string) => invoke<AcpStatus>('remove_acp_account', { accountId }),
  logoutAccount: () => invoke<AcpStatus>('logout_acp_account'),
  cancel: () => invoke<void>('cancel_acp_operation'),
  selectModel: (model: string) => invoke<AcpStatus>('select_acp_model', { model }),
  test: () => invoke<AcpProbeResult>('test_acp_connection'),
  setUpstreamEnabled: (enabled: boolean) => invoke<AcpStatus>('set_acp_upstream_enabled', { enabled }),
};

// Only app-owned lifecycle messages have friendly translations. Arbitrary
// official-server errors remain verbatim; never guess their meaning or tone.
const accountErrorKeys: Record<string, string> = {
  "This official CLI does not support ACP logout. Update Antigravity CLI to sign out or authorize again; alternatively remove this app's local account record.": 'acp.errorLogoutUnsupported',
  'Install official Antigravity CLI before adding an account': 'acp.errorCliRequired',
  'Install official Antigravity CLI before connecting': 'acp.errorCliRequired',
  'Install official Antigravity CLI to sign out. You can still remove the local account record.': 'acp.errorCliRequired',
  'Official Antigravity CLI not found': 'acp.errorCliRequired',
  'Enter an ACP account label of 1–80 characters without control characters': 'acp.labelInvalid',
  'Up to 32 ACP accounts can be saved': 'acp.errorAccountLimit',
  'Unknown ACP account': 'acp.errorAccountMissing',
  'ACP account directory already exists': 'acp.errorAccountDirectoryExists',
  'ACP account paths must not contain symbolic links': 'acp.errorUnsafeAccountPath',
  'Invalid ACP profile path': 'acp.errorUnsafeAccountPath',
  'Invalid ACP account ID': 'acp.errorUnsafeAccountPath',
  'Invalid ACP account registry': 'acp.errorAccountRegistry',
  'An ACP operation is already running': 'acp.errorAccountBusy',
  'Wait for the current ACP operation to finish': 'acp.errorAccountBusy',
  'ACP request cancelled': 'acp.errorCancelled',
  'Account saved; connection not verified: ACP request cancelled': 'acp.errorSavedCancelled',
};
export function acpErrorMessageKey(error: string): string | null {
  const exact = accountErrorKeys[error];
  if (exact) return exact;
  if (error.includes('ACP API provider configuration sync failed: ')) return 'acp.errorProviderSyncFailed';
  if (error.startsWith('Google authorization completed, but the account registry could not be saved. Login data is preserved at ')) return 'acp.errorSaveAuthorizedAccount';
  if (error.startsWith('Account saved; connection not verified: ')) return 'acp.errorSavedUnverified';
  return null;
}
