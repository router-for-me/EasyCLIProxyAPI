import { Channel, invoke } from '@tauri-apps/api/core';

export type AcpRoutingStrategy = 'round_robin' | 'least_busy' | 'fill_first' | 'weighted';
export type AcpPromptProfile = 'append' | 'first_turn_context';
export type AcpAccountAuthState = 'unknown' | 'ready' | 'auth_required' | 'error';

export type AcpAccount = {
  id: string;
  label: string;
  email?: string | null;
  saved: boolean;
  isolated?: boolean;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  maxConcurrency?: number;
  proxyUrl?: string | null;
};

export type AcpAccountSettingsPatch = {
  label?: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  maxConcurrency?: number;
  proxyUrl?: string;
};

export type AcpPoolSettings = {
  accountPool: boolean;
  routingStrategy: AcpRoutingStrategy;
  maxGlobalConcurrency: number;
  maxLiveSessions: number;
  queueWaitMs: number;
  maxFailoverAttempts: number;
  cooldownBaseSecs: number;
  cooldownMaxSecs: number;
  promptProfile: AcpPromptProfile;
};

export type AcpModelCooldown = {
  model?: string | null;
  reason: string;
  untilEpochSecs: number;
  remainingSecs: number;
  consecutiveFailures: number;
};

export type AcpAccountRuntime = {
  authState: AcpAccountAuthState;
  modelCount: number;
  lastVerifiedAt?: number | null;
  lastError?: string | null;
  activeRequests: number;
  liveSessions: number;
  operating: boolean;
  cooldowns: AcpModelCooldown[];
};

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
  poolSettings?: AcpPoolSettings;
  activeRequests?: number;
  liveSessions?: number;
  accountRuntime?: Record<string, AcpAccountRuntime>;
};
export type AcpProbeResult = {
  text: string;
  model: string;
  durationMs: number;
  firstTextMs: number | null;
  stopReason: string;
  accountId?: string | null;
};
export type AcpAuthorizationLink = { attempt: string; url: string };

export const DEFAULT_ACP_POOL_SETTINGS: AcpPoolSettings = {
  accountPool: false,
  routingStrategy: 'round_robin',
  maxGlobalConcurrency: 16,
  maxLiveSessions: 64,
  queueWaitMs: 3000,
  maxFailoverAttempts: 2,
  cooldownBaseSecs: 60,
  cooldownMaxSecs: 600,
  promptProfile: 'append',
};

export const acpApi = {
  status: () => invoke<AcpStatus>('get_acp_status'),
  connect: (login: boolean) => invoke<AcpStatus>('acp_connect', { login }),
  switchAccount: (accountId: string) => invoke<AcpStatus>('switch_acp_account', { accountId }),
  addAccount: (label: string, receive: (link: AcpAuthorizationLink) => void, replace?: string) => {
    const onLink = new Channel<AcpAuthorizationLink>();
    onLink.onmessage = receive;
    return invoke<AcpStatus>('add_acp_account', { label, onLink, replace });
  },
  submitAccountAuthorization: (attempt: string, response: string) =>
    invoke<void>('submit_acp_account_authorization', { attempt, response }),
  reloginAccount: (accountId?: string) =>
    invoke<AcpStatus>('relogin_acp_account', accountId ? { accountId } : {}),
  renameAccount: (accountId: string, label: string) => invoke<AcpStatus>('rename_acp_account', { accountId, label }),
  updateAccountSettings: (accountId: string, patch: AcpAccountSettingsPatch) =>
    invoke<AcpStatus>('update_acp_account_settings', { accountId, patch }),
  updatePoolSettings: (settings: AcpPoolSettings) =>
    invoke<AcpStatus>('update_acp_pool_settings', { settings }),
  verifyAccount: (accountId: string) => invoke<AcpStatus>('verify_acp_account', { accountId }),
  verifyAllAccounts: () => invoke<AcpStatus>('verify_all_acp_accounts'),
  resetAccountCooldown: (accountId?: string) =>
    invoke<AcpStatus>('reset_acp_account_cooldown', { accountId: accountId ?? null }),
  removeAccount: (accountId: string) => invoke<AcpStatus>('remove_acp_account', { accountId }),
  logoutAccount: (accountId?: string) =>
    invoke<AcpStatus>('logout_acp_account', accountId ? { accountId } : {}),
  cancel: () => invoke<void>('cancel_acp_operation'),
  selectModel: (model: string) => invoke<AcpStatus>('select_acp_model', { model }),
  test: (accountId?: string, model?: string) =>
    invoke<AcpProbeResult>('test_acp_connection', accountId || model ? { accountId: accountId ?? null, model: model ?? null } : {}),
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
  'Up to 64 ACP accounts can be saved': 'acp.errorAccountLimit',
  'Unknown ACP account': 'acp.errorAccountMissing',
  'ACP account directory already exists': 'acp.errorAccountDirectoryExists',
  'ACP account paths must not contain symbolic links': 'acp.errorUnsafeAccountPath',
  'Invalid ACP profile path': 'acp.errorUnsafeAccountPath',
  'Invalid ACP account ID': 'acp.errorUnsafeAccountPath',
  'Invalid ACP account registry': 'acp.errorAccountRegistry',
  'An ACP operation is already running': 'acp.errorAccountBusy',
  'Wait for the current ACP operation to finish': 'acp.errorAccountBusy',
  'This ACP account has active API requests; wait for them to finish': 'acp.errorAccountActiveRequests',
  "Enter a valid proxy URL (http://, https://, socks5://, socks5h://) or 'direct'": 'acp.errorInvalidProxy',
  'The installed Antigravity CLI does not offer supported terminal sign-in': 'acp.errorManualUnsupported',
  'Antigravity authorization expired while waiting for a response': 'acp.errorManualWaitExpired',
  'Could not deliver the authorization response to Antigravity CLI': 'acp.errorManualDelivery',
  'Antigravity CLI exited without providing an authorization link': 'acp.errorManualNoLink',
  'Antigravity CLI did not provide an authorization link in time': 'acp.errorManualNoLink',
  'Antigravity CLI exited before receiving the authorization response': 'acp.errorManualEarlyExit',
  'Antigravity CLI timed out completing authorization': 'acp.errorManualExchangeTimeout',
  'Google rejected the authorization response': 'acp.errorManualRejected',
  'Antigravity CLI could not reach Google during authorization': 'acp.errorManualNetwork',
  'Antigravity terminal sign-in did not complete': 'acp.errorManualFailed',
  'Enter the authorization code or the official Antigravity callback URL': 'acp.errorManualInput',
  'This Antigravity authorization request is no longer waiting for a code': 'acp.errorManualInactive',
  'ACP request cancelled': 'acp.errorCancelled',
  'Account saved; connection not verified: ACP request cancelled': 'acp.errorSavedCancelled',
};
export function acpErrorMessageKey(error: string): string | null {
  const exact = accountErrorKeys[error];
  if (exact) return exact;
  if (/^Up to \d+ ACP accounts can be saved$/.test(error)) return 'acp.errorAccountLimit';
  if (error.startsWith('ACP account weight must be between ') || error.startsWith('ACP account max concurrency must be between ')) return 'acp.errorInvalidAccountSettings';
  if (error.startsWith('ACP global max concurrency must be between ') || error.startsWith('ACP max live sessions must be between ') || error.startsWith('ACP queue wait timeout must be between ') || error.startsWith('ACP failover attempts must be between ') || error.startsWith('ACP cooldown ')) return 'acp.errorInvalidPoolSettings';
  if (error.startsWith('Could not verify Antigravity CLI terminal sign-in:') || error === 'Could not start Antigravity CLI to check terminal sign-in') return 'acp.errorManualProbeFailed';
  if (error.startsWith('This Google account is already saved.')) return 'acp.errorDuplicateIdentity';
  if (error.startsWith('Google identity could not be verified against saved accounts.')) return 'acp.errorIdentityUnknown';
  if (error.includes('ACP API provider configuration sync failed: ')) return 'acp.errorProviderSyncFailed';
  if (error.startsWith('Google authorization completed, but the account registry could not be saved. Login data is preserved at ')) return 'acp.errorSaveAuthorizedAccount';
  if (error.startsWith('Account saved; connection not verified: ')) return 'acp.errorSavedUnverified';
  return null;
}
