import { invoke } from './rpc';
import { managementApi } from './managementApi';
import type { AccountSwitchCategoryFilter } from '../navigation';

export type SwitchPlatformId =
  | 'codex'
  | 'claude_code'
  | 'antigravity'
  | 'grok'
  | 'kimi'
  | 'github_copilot'
  | 'windsurf_devin'
  | 'workbuddy'
  | 'workbuddy_ai'
  | 'zcode'
  | 'claude_desktop';

export type PlatformCategory = 'official-cli' | 'ai-ide';
export type ProxyMode = 'direct' | 'cpa_proxy' | 'custom_proxy' | 'unknown';
export type AccountSource = 'local' | 'oauth' | 'cpa_import' | 'json_import';

export interface ProxyInspection {
  mode: ProxyMode;
  detail: string | null;
  canDecouple: boolean;
  configPaths: string[];
}

export interface SyncTargetInfo {
  id: string;
  label: string;
  installed: boolean;
  targetPath: string | null;
}

export interface QuotaMetric {
  id: string;
  label: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetAt: number | null;
  detail: string | null;
}

export interface QuotaSnapshot {
  fetchedAt: number;
  plan: string | null;
  planExpiresAt?: number | null;
  metrics: QuotaMetric[];
  error: string | null;
}

export interface AccountSummary {
  id: string;
  platform: SwitchPlatformId;
  label: string;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  fingerprint: string;
  tags: string[];
  groupId: string | null;
  notes: string | null;
  source: AccountSource;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  tokenExpiresAt: number | null;
  planExpiresAt?: number | null;
  hasRefreshToken: boolean;
  lastQuota: QuotaSnapshot | null;
  isActive: boolean;
}

export interface AccountGroup {
  id: string;
  name: string;
  color: string | null;
  order: number;
}

export interface LocalCredentialPreview {
  detected: boolean;
  label: string | null;
  email: string | null;
  accountId: string | null;
  fingerprint: string | null;
  matchedAccountId: string | null;
}

export interface PlatformRuntimeStatus {
  platform: SwitchPlatformId;
  category: PlatformCategory;
  displayName: string;
  installed: boolean;
  running: boolean;
  runningPids: number[];
  proxy: ProxyInspection;
  activeAccountId: string | null;
  localCredential: LocalCredentialPreview;
  accountCount: number;
  supportsOauth: boolean;
  supportsCpaImport: boolean;
  supportsClientRestart: boolean;
  syncTargets: SyncTargetInfo[];
}

export interface AccountSwitchCatalog {
  vaultDir: string;
  platforms: PlatformRuntimeStatus[];
  groups: AccountGroup[];
}

export interface PlatformAccountsPayload {
  platform: SwitchPlatformId;
  status: PlatformRuntimeStatus;
  accounts: AccountSummary[];
  groups: AccountGroup[];
}

export interface SwitchAccountOptions {
  refreshBeforeSwitch: boolean;
  decoupleCpaProxy: boolean;
  syncTargets: string[];
  restartClient: boolean;
}

export interface SyncTargetResult {
  target: string;
  status: 'synced' | 'skipped' | 'error' | string;
  message: string | null;
}

export interface SwitchAccountResult {
  platform: SwitchPlatformId;
  accountId: string;
  decoupledProxy: boolean;
  refreshedToken: boolean;
  clientRestarted: boolean;
  warnings: string[];
  syncResults: SyncTargetResult[];
  status: PlatformRuntimeStatus;
}

export interface CpaImportCandidate {
  fileName: string;
  filePath: string;
  platform: SwitchPlatformId;
  label: string;
  email: string | null;
  accountId: string | null;
  fingerprint: string;
  action: 'import' | 'update' | string;
  existingAccountId: string | null;
}

export interface CpaImportSelection {
  filePath?: string;
  fileName?: string;
  rawJson?: unknown;
  platform?: SwitchPlatformId;
}

export interface ImportBatchResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
  accounts: AccountSummary[];
}

export interface AccountMetaPatch {
  label?: string;
  notes?: string | null;
  groupId?: string | null;
  tags?: string[];
}

export interface GroupAction {
  action: 'create' | 'rename' | 'update' | 'delete' | 'reorder';
  id?: string;
  name?: string;
  color?: string | null;
  order?: string[];
}

export interface OAuthSessionView {
  sessionId: string;
  platform: SwitchPlatformId;
  flow: 'pkce_browser' | 'device_code' | string;
  status: 'pending' | 'completed' | 'error' | 'cancelled' | string;
  authUrl: string | null;
  userCode: string | null;
  verificationUri: string | null;
  expiresInSeconds: number | null;
  error: string | null;
  account: AccountSummary | null;
}

export interface DecoupleProxyResult {
  platform: SwitchPlatformId;
  changed: boolean;
  message: string;
  status: PlatformRuntimeStatus;
}

export interface RefreshQuotaResult {
  platform: SwitchPlatformId;
  updated: AccountSummary[];
  errors: string[];
}

export type PlatformVisualMeta = {
  id: SwitchPlatformId;
  category: PlatformCategory;
  shortTag: string;
  accent: string;
  clientHint: string;
};

export const PLATFORM_VISUAL_META: Record<SwitchPlatformId, PlatformVisualMeta> = {
  codex: {
    id: 'codex',
    category: 'official-cli',
    shortTag: 'CX',
    accent: '#10a37f',
    clientHint: 'Codex CLI / Desktop App',
  },
  claude_code: {
    id: 'claude_code',
    category: 'official-cli',
    shortTag: 'CC',
    accent: '#d97757',
    clientHint: 'Claude Code CLI',
  },
  antigravity: {
    id: 'antigravity',
    category: 'official-cli',
    shortTag: 'AG',
    accent: '#4285f4',
    clientHint: 'Antigravity App / IDE / agy CLI',
  },
  grok: {
    id: 'grok',
    category: 'official-cli',
    shortTag: 'GK',
    accent: '#64748b',
    clientHint: 'Grok Build / Grok CLI',
  },
  kimi: {
    id: 'kimi',
    category: 'official-cli',
    shortTag: 'KM',
    accent: '#0ea5e9',
    clientHint: 'Kimi Code CLI',
  },
  github_copilot: {
    id: 'github_copilot',
    category: 'ai-ide',
    shortTag: 'GH',
    accent: '#6366f1',
    clientHint: 'VS Code Copilot / Copilot CLI',
  },
  windsurf_devin: {
    id: 'windsurf_devin',
    category: 'ai-ide',
    shortTag: 'DV',
    accent: '#14b8a6',
    clientHint: 'Devin / Windsurf IDE',
  },
  workbuddy: {
    id: 'workbuddy',
    category: 'ai-ide',
    shortTag: 'WB',
    accent: '#3b82f6',
    clientHint: 'WorkBuddy（国内版）',
  },
  workbuddy_ai: {
    id: 'workbuddy_ai',
    category: 'ai-ide',
    shortTag: 'WA',
    accent: '#2563eb',
    clientHint: 'WorkBuddy AI（国际版）',
  },
  zcode: {
    id: 'zcode',
    category: 'ai-ide',
    shortTag: 'ZC',
    accent: '#8b5cf6',
    clientHint: 'ZCode Desktop (Z.ai / BigModel)',
  },
  claude_desktop: {
    id: 'claude_desktop',
    category: 'ai-ide',
    shortTag: 'CD',
    accent: '#c26d4a',
    clientHint: 'Claude Desktop Snapshot',
  },
};

export function platformsInCategory(
  platforms: readonly PlatformRuntimeStatus[],
  filter: AccountSwitchCategoryFilter,
): PlatformRuntimeStatus[] {
  if (filter === 'all') return [...platforms];
  return platforms.filter((item) => item.category === filter);
}

export const accountSwitchApi = {
  getCatalog: () => invoke<AccountSwitchCatalog>('account_switch_get_catalog'),
  listAccounts: (platform: SwitchPlatformId) =>
    invoke<PlatformAccountsPayload>('account_switch_list_accounts', { platform }),
  inspectPlatform: (platform: SwitchPlatformId) =>
    invoke<PlatformRuntimeStatus>('account_switch_inspect_platform', { platform }),
  importLocal: (platform: SwitchPlatformId) =>
    invoke<AccountSummary>('account_switch_import_local', { platform }),
  previewCpaOauth: (platform?: SwitchPlatformId) =>
    invoke<CpaImportCandidate[]>('account_switch_preview_cpa_oauth', {
      platform: platform ?? null,
    }),
  importCpaOauth: (entries: CpaImportSelection[]) =>
    invoke<ImportBatchResult>('account_switch_import_cpa_oauth', { entries }),
  importJson: (platform: SwitchPlatformId, payload: string) =>
    invoke<ImportBatchResult>('account_switch_import_json', { platform, payload }),
  exportJson: (platform: SwitchPlatformId, accountIds?: string[]) =>
    invoke<string>('account_switch_export_json', {
      platform,
      accountIds: accountIds?.length ? accountIds : null,
    }),
  startOauth: (platform: SwitchPlatformId) =>
    invoke<OAuthSessionView>('account_switch_oauth_start', { platform }),
  pollOauth: (sessionId: string) =>
    invoke<OAuthSessionView>('account_switch_oauth_poll', { sessionId }),
  cancelOauth: (sessionId: string) =>
    invoke<OAuthSessionView>('account_switch_oauth_cancel', { sessionId }),
  decoupleProxy: (platform: SwitchPlatformId) =>
    invoke<DecoupleProxyResult>('account_switch_decouple_proxy', { platform }),
  switchAccount: (
    platform: SwitchPlatformId,
    accountId: string,
    options: SwitchAccountOptions,
  ) =>
    invoke<SwitchAccountResult>('account_switch_switch_account', {
      platform,
      accountId,
      options,
    }),
  refreshQuota: (platform: SwitchPlatformId, accountIds?: string[]) =>
    invoke<RefreshQuotaResult>('account_switch_refresh_quota', {
      platform,
      accountIds: accountIds?.length ? accountIds : null,
    }),
  updateMeta: (platform: SwitchPlatformId, accountId: string, patch: AccountMetaPatch) =>
    invoke<AccountSummary>('account_switch_update_account_meta', {
      platform,
      accountId,
      patch,
    }),
  deleteAccounts: (platform: SwitchPlatformId, accountIds: string[]) =>
    invoke<number>('account_switch_delete_accounts', { platform, accountIds }),
  manageGroups: (action: GroupAction) =>
    invoke<AccountGroup[]>('account_switch_manage_groups', { action }),
  restartClient: (platform: SwitchPlatformId) =>
    invoke<boolean>('account_switch_restart_client', { platform }),

  /** Optional online fallback when connected to remote CPA and local oauth/ dir has no files. */
  async fetchRemoteCpaSelections(platform?: SwitchPlatformId): Promise<CpaImportSelection[]> {
    try {
      const list = await managementApi.get<{ files?: Array<Record<string, unknown>> }>('/credentials');
      const files = Array.isArray(list?.files) ? list.files : [];
      const selections: CpaImportSelection[] = [];
      for (const file of files) {
        const name = typeof file.name === 'string' ? file.name : '';
        if (!name) continue;
        try {
          const downloaded = await managementApi.get<unknown>('/credentials/download', { name });
          const rawJson = typeof downloaded === 'string' ? JSON.parse(downloaded) : downloaded;
          selections.push({ fileName: name, rawJson, platform });
        } catch {
          /* skip unreadable remote files */
        }
      }
      return selections;
    } catch {
      return [];
    }
  },
};
