import type {
  AccountGroup,
  AccountMetaPatch,
  AccountSummary,
  AccountSwitchCatalog,
  CpaImportCandidate,
  CpaImportSelection,
  GroupAction,
  PlatformRuntimeStatus,
  SwitchAccountOptions,
  SwitchPlatformId,
} from '../services/accountSwitch';

const clone = <T,>(value: T): T => structuredClone(value);

export function createAccountSwitchMock() {
  const now = Date.now();
  let groups: AccountGroup[] = [
    { id: 'grp-main', name: '主力账号', color: '#3b82f6', order: 0 },
    { id: 'grp-backup', name: '备用池', color: '#10b981', order: 1 },
  ];

  const platforms: PlatformRuntimeStatus[] = [
    {
      platform: 'codex',
      category: 'official-cli',
      displayName: 'Codex',
      installed: true,
      running: true,
      runningPids: [14820],
      proxy: {
        mode: 'cpa_proxy',
        detail: 'Codex config.toml routes through CPA reverse proxy (http://127.0.0.1:8317/v1)',
        canDecouple: true,
        configPaths: ['~/.codex/config.toml'],
      },
      activeAccountId: 'codex-1',
      localCredential: {
        detected: true,
        label: 'local-unimported@openai.test',
        email: 'local-unimported@openai.test',
        accountId: 'acct_local_99',
        fingerprint: 'fp_local_unimported',
        matchedAccountId: null,
      },
      accountCount: 3,
      supportsOauth: true,
      supportsCpaImport: true,
      supportsClientRestart: true,
      syncTargets: [
        { id: 'opencode', label: 'OpenCode', installed: true, targetPath: '~/.local/share/opencode/auth.json' },
        { id: 'openclaw', label: 'OpenClaw', installed: true, targetPath: '~/.openclaw/agents/main/agent/auth-profiles.json' },
        { id: 'hermes', label: 'Hermes Agent', installed: false, targetPath: '~/.hermes/auth.json' },
        { id: 'wsl', label: 'WSL Codex', installed: true, targetPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex' },
      ],
    },
    {
      platform: 'claude_code',
      category: 'official-cli',
      displayName: 'Claude Code',
      installed: true,
      running: false,
      runningPids: [],
      proxy: { mode: 'direct', detail: null, canDecouple: false, configPaths: ['~/.claude/settings.json'] },
      activeAccountId: 'claude-1',
      localCredential: {
        detected: true,
        label: 'alice.claude@anthropic.test',
        email: 'alice.claude@anthropic.test',
        accountId: 'uuid-claude-1',
        fingerprint: 'fp_claude_1',
        matchedAccountId: 'claude-1',
      },
      accountCount: 2,
      supportsOauth: true,
      supportsCpaImport: true,
      supportsClientRestart: false,
      syncTargets: [],
    },
    {
      platform: 'antigravity',
      category: 'official-cli',
      displayName: 'Antigravity',
      installed: true,
      running: true,
      runningPids: [22410],
      proxy: { mode: 'direct', detail: null, canDecouple: false, configPaths: [] },
      activeAccountId: 'agy-1',
      localCredential: { detected: false, label: null, email: null, accountId: null, fingerprint: null, matchedAccountId: null },
      accountCount: 1,
      supportsOauth: false,
      supportsCpaImport: true,
      supportsClientRestart: true,
      syncTargets: [],
    },
    {
      platform: 'grok',
      category: 'official-cli',
      displayName: 'Grok / xAI',
      installed: true,
      running: false,
      runningPids: [],
      proxy: { mode: 'direct', detail: null, canDecouple: false, configPaths: ['~/.grok/config.toml'] },
      activeAccountId: null,
      localCredential: { detected: false, label: null, email: null, accountId: null, fingerprint: null, matchedAccountId: null },
      accountCount: 0,
      supportsOauth: true,
      supportsCpaImport: true,
      supportsClientRestart: false,
      syncTargets: [
        { id: 'opencode', label: 'OpenCode', installed: true, targetPath: '~/.local/share/opencode/auth.json' },
      ],
    },
    {
      platform: 'kimi',
      category: 'official-cli',
      displayName: 'Kimi Code',
      installed: true,
      running: false,
      runningPids: [],
      proxy: { mode: 'direct', detail: null, canDecouple: false, configPaths: ['~/.kimi-code/config.toml'] },
      activeAccountId: null,
      localCredential: { detected: false, label: null, email: null, accountId: null, fingerprint: null, matchedAccountId: null },
      accountCount: 0,
      supportsOauth: true,
      supportsCpaImport: true,
      supportsClientRestart: false,
      syncTargets: [],
    },
    {
      platform: 'github_copilot',
      category: 'ai-ide',
      displayName: 'GitHub Copilot',
      installed: true,
      running: true,
      runningPids: [19300],
      proxy: { mode: 'direct', detail: null, canDecouple: false, configPaths: [] },
      activeAccountId: 'gh-1',
      localCredential: { detected: false, label: null, email: null, accountId: null, fingerprint: null, matchedAccountId: null },
      accountCount: 1,
      supportsOauth: true,
      supportsCpaImport: false,
      supportsClientRestart: true,
      syncTargets: [
        { id: 'opencode', label: 'OpenCode', installed: true, targetPath: '~/.local/share/opencode/auth.json' },
      ],
    },
    {
      platform: 'windsurf_devin',
      category: 'ai-ide',
      displayName: 'Devin / Windsurf',
      installed: true,
      running: false,
      runningPids: [],
      proxy: { mode: 'direct', detail: null, canDecouple: false, configPaths: [] },
      activeAccountId: 'devin-1',
      localCredential: { detected: false, label: null, email: null, accountId: null, fingerprint: null, matchedAccountId: null },
      accountCount: 1,
      supportsOauth: false,
      supportsCpaImport: true,
      supportsClientRestart: true,
      syncTargets: [],
    },
    {
      platform: 'workbuddy',
      category: 'ai-ide',
      displayName: 'WorkBuddy',
      installed: false,
      running: false,
      runningPids: [],
      proxy: { mode: 'direct', detail: null, canDecouple: false, configPaths: [] },
      activeAccountId: null,
      localCredential: { detected: false, label: null, email: null, accountId: null, fingerprint: null, matchedAccountId: null },
      accountCount: 0,
      supportsOauth: false,
      supportsCpaImport: false,
      supportsClientRestart: true,
      syncTargets: [],
    },
    {
      platform: 'workbuddy_ai',
      category: 'ai-ide',
      displayName: 'WorkBuddy AI',
      installed: false,
      running: false,
      runningPids: [],
      proxy: { mode: 'direct', detail: null, canDecouple: false, configPaths: [] },
      activeAccountId: null,
      localCredential: { detected: false, label: null, email: null, accountId: null, fingerprint: null, matchedAccountId: null },
      accountCount: 0,
      supportsOauth: false,
      supportsCpaImport: false,
      supportsClientRestart: true,
      syncTargets: [],
    },
    {
      platform: 'zcode',
      category: 'ai-ide',
      displayName: 'ZCode',
      installed: true,
      running: false,
      runningPids: [],
      proxy: { mode: 'direct', detail: null, canDecouple: false, configPaths: [] },
      activeAccountId: null,
      localCredential: { detected: false, label: null, email: null, accountId: null, fingerprint: null, matchedAccountId: null },
      accountCount: 0,
      supportsOauth: false,
      supportsCpaImport: false,
      supportsClientRestart: true,
      syncTargets: [],
    },
    {
      platform: 'claude_desktop',
      category: 'ai-ide',
      displayName: 'Claude Desktop',
      installed: true,
      running: false,
      runningPids: [],
      proxy: { mode: 'direct', detail: null, canDecouple: false, configPaths: [] },
      activeAccountId: null,
      localCredential: { detected: false, label: null, email: null, accountId: null, fingerprint: null, matchedAccountId: null },
      accountCount: 0,
      supportsOauth: false,
      supportsCpaImport: false,
      supportsClientRestart: true,
      syncTargets: [],
    },
  ];

  const accountsByPlatform: Record<SwitchPlatformId, AccountSummary[]> = {
    codex: [
      {
        id: 'codex-1',
        platform: 'codex',
        label: 'alice.dev@openai.test',
        email: 'alice.dev@openai.test',
        accountId: 'acct_codex_001',
        planType: 'Plus',
        fingerprint: 'fp_codex_1',
        tags: ['work', 'daily'],
        groupId: 'grp-main',
        notes: '主力开发号',
        source: 'local',
        createdAt: now - 86_400_000 * 5,
        updatedAt: now - 3_600_000,
        lastUsedAt: now - 1_800_000,
        tokenExpiresAt: Math.floor(now / 1000) + 7200,
        planExpiresAt: Math.floor(now / 1000) + 86_400 * 18,
        hasRefreshToken: true,
        lastQuota: {
          fetchedAt: now - 600_000,
          plan: 'Plus',
          metrics: [
            { id: '5h', label: '5h Window', remainingPercent: 82, usedPercent: 18, resetAt: Math.floor(now / 1000) + 12_000, detail: null },
            { id: 'weekly', label: 'Weekly Window', remainingPercent: 64, usedPercent: 36, resetAt: Math.floor(now / 1000) + 320_000, detail: null },
          ],
          error: null,
        },
        isActive: true,
      },
      {
        id: 'codex-2',
        platform: 'codex',
        label: 'team-builder@openai.test',
        email: 'team-builder@openai.test',
        accountId: 'acct_codex_002',
        planType: 'Team',
        fingerprint: 'fp_codex_2',
        tags: ['team'],
        groupId: 'grp-backup',
        notes: null,
        source: 'cpa_import',
        createdAt: now - 86_400_000 * 2,
        updatedAt: now - 7_200_000,
        lastUsedAt: null,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        planExpiresAt: Math.floor(now / 1000) + 86_400 * 2 + 10_800,
        hasRefreshToken: true,
        lastQuota: {
          fetchedAt: now - 1_200_000,
          plan: 'Team',
          metrics: [
            { id: '5h', label: '5h Window', remainingPercent: 100, usedPercent: 0, resetAt: Math.floor(now / 1000) + 18_000, detail: null },
            { id: 'weekly', label: 'Weekly Window', remainingPercent: 95, usedPercent: 5, resetAt: Math.floor(now / 1000) + 420_000, detail: null },
          ],
          error: null,
        },
        isActive: false,
      },
      {
        id: 'codex-3',
        platform: 'codex',
        label: 'spare.dev@openai.test',
        email: 'spare.dev@openai.test',
        accountId: 'acct_codex_003',
        planType: 'Free',
        fingerprint: 'fp_codex_3',
        tags: ['backup'],
        groupId: 'grp-backup',
        notes: '低额度测试号',
        source: 'json_import',
        createdAt: now - 86_400_000 * 8,
        updatedAt: now - 86_400_000,
        lastUsedAt: now - 86_400_000 * 2,
        tokenExpiresAt: Math.floor(now / 1000) + 1800,
        planExpiresAt: null,
        hasRefreshToken: true,
        lastQuota: {
          fetchedAt: now - 900_000,
          plan: 'Free',
          metrics: [
            { id: '5h', label: '5h Window', remainingPercent: 28, usedPercent: 72, resetAt: Math.floor(now / 1000) + 5_400, detail: null },
            { id: 'weekly', label: 'Weekly Window', remainingPercent: 14, usedPercent: 86, resetAt: Math.floor(now / 1000) + 190_000, detail: null },
          ],
          error: null,
        },
        isActive: false,
      },
    ],
    claude_code: [
      {
        id: 'claude-1',
        platform: 'claude_code',
        label: 'alice.claude@anthropic.test',
        email: 'alice.claude@anthropic.test',
        accountId: 'uuid-claude-1',
        planType: 'Max 5x',
        fingerprint: 'fp_claude_1',
        tags: ['prod'],
        groupId: 'grp-main',
        notes: null,
        source: 'oauth',
        createdAt: now - 86_400_000 * 3,
        updatedAt: now - 3_600_000,
        lastUsedAt: now - 3_600_000,
        tokenExpiresAt: Math.floor(now / 1000) + 5400,
        planExpiresAt: Math.floor(now / 1000) + 86_400 * 25,
        hasRefreshToken: true,
        lastQuota: {
          fetchedAt: now - 300_000,
          plan: 'Max 5x',
          metrics: [
            { id: '5h', label: '5h Session', remainingPercent: 74, usedPercent: 26, resetAt: Math.floor(now / 1000) + 9_000, detail: null },
            { id: '7d', label: '7d All Models', remainingPercent: 88, usedPercent: 12, resetAt: Math.floor(now / 1000) + 410_000, detail: null },
          ],
          error: null,
        },
        isActive: true,
      },
      {
        id: 'claude-2',
        platform: 'claude_code',
        label: 'backup.claude@anthropic.test',
        email: 'backup.claude@anthropic.test',
        accountId: 'uuid-claude-2',
        planType: 'Pro',
        fingerprint: 'fp_claude_2',
        tags: ['backup'],
        groupId: 'grp-backup',
        notes: '高余量备用',
        source: 'cpa_import',
        createdAt: now - 86_400_000 * 6,
        updatedAt: now - 1_800_000,
        lastUsedAt: now - 86_400_000,
        tokenExpiresAt: Math.floor(now / 1000) + 7200,
        planExpiresAt: Math.floor(now / 1000) + 86_400 * 5,
        hasRefreshToken: true,
        lastQuota: {
          fetchedAt: now - 600_000,
          plan: 'Pro',
          metrics: [
            { id: '5h', label: '5h Session', remainingPercent: 96, usedPercent: 4, resetAt: Math.floor(now / 1000) + 16_000, detail: null },
            { id: '7d', label: '7d All Models', remainingPercent: 92, usedPercent: 8, resetAt: Math.floor(now / 1000) + 510_000, detail: null },
          ],
          error: null,
        },
        isActive: false,
      },
    ],
    antigravity: [
      {
        id: 'agy-1',
        platform: 'antigravity',
        label: 'builder@google.test',
        email: 'builder@google.test',
        accountId: 'proj-agy-01',
        planType: 'Pro',
        fingerprint: 'fp_agy_1',
        tags: ['work'],
        groupId: 'grp-main',
        notes: null,
        source: 'cpa_import',
        createdAt: now - 86_400_000,
        updatedAt: now - 600_000,
        lastUsedAt: now - 600_000,
        tokenExpiresAt: Math.floor(now / 1000) + 3200,
        planExpiresAt: Math.floor(now / 1000) + 86_400 * 20,
        hasRefreshToken: true,
        lastQuota: {
          fetchedAt: now - 600_000,
          plan: 'Pro',
          metrics: [
            { id: 'gemini-pro', label: 'Gemini Pro', remainingPercent: 91, usedPercent: 9, resetAt: Math.floor(now / 1000) + 14_400, detail: null },
          ],
          error: null,
        },
        isActive: true,
      },
    ],
    grok: [],
    kimi: [],
    github_copilot: [
      {
        id: 'gh-1',
        platform: 'github_copilot',
        label: 'octocat-dev',
        email: 'octocat@github.test',
        accountId: 'octocat-dev',
        planType: 'Pro',
        fingerprint: 'fp_gh_1',
        tags: ['ide'],
        groupId: 'grp-main',
        notes: null,
        source: 'oauth',
        createdAt: now - 86_400_000 * 4,
        updatedAt: now - 3_600_000,
        lastUsedAt: now - 3_600_000,
        tokenExpiresAt: null,
        planExpiresAt: Math.floor(now / 1000) + 86_400 * 14,
        hasRefreshToken: false,
        lastQuota: {
          fetchedAt: now - 1_800_000,
          plan: 'Pro',
          metrics: [
            { id: 'premium_interactions', label: 'Premium Requests', remainingPercent: 78, usedPercent: 22, resetAt: Math.floor(now / 1000) + 864_000, detail: '234 / 300' },
          ],
          error: null,
        },
        isActive: true,
      },
    ],
    windsurf_devin: [
      {
        id: 'devin-1',
        platform: 'windsurf_devin',
        label: 'devin.pro@cognition.test',
        email: 'devin.pro@cognition.test',
        accountId: 'devin-user-1',
        planType: 'Pro',
        fingerprint: 'fp_devin_1',
        tags: ['ide'],
        groupId: null,
        notes: null,
        source: 'local',
        createdAt: now - 86_400_000,
        updatedAt: now - 3_600_000,
        lastUsedAt: now - 3_600_000,
        tokenExpiresAt: null,
        planExpiresAt: Math.floor(now / 1000) + 86_400 * 14,
        hasRefreshToken: false,
        lastQuota: {
          fetchedAt: now - 900_000,
          plan: 'Pro',
          metrics: [
            { id: 'daily', label: 'Daily Quota', remainingPercent: 85, usedPercent: 15, resetAt: Math.floor(now / 1000) + 40_000, detail: null },
            { id: 'weekly', label: 'Weekly Quota', remainingPercent: 60, usedPercent: 40, resetAt: Math.floor(now / 1000) + 250_000, detail: null },
          ],
          error: null,
        },
        isActive: true,
      },
    ],
    workbuddy: [],
    workbuddy_ai: [],
    zcode: [],
    claude_desktop: [],
  };

  const syncCounts = () => {
    for (const status of platforms) {
      status.accountCount = accountsByPlatform[status.platform].length;
    }
  };

  const findPlatform = (id: string): PlatformRuntimeStatus => {
    const match = platforms.find((p) => p.platform === id);
    if (!match) throw new Error(`Unsupported platform: ${id}`);
    return match;
  };

  const mockCpaCandidates: CpaImportCandidate[] = [
    {
      fileName: 'codex-cpa-pool.json',
      filePath: 'C:\\EasyCLIProxyAPI\\oauth\\codex-cpa-pool.json',
      platform: 'codex',
      label: 'cpa-imported@openai.test',
      email: 'cpa-imported@openai.test',
      accountId: 'acct_cpa_009',
      fingerprint: 'fp_cpa_codex_9',
      action: 'import',
      existingAccountId: null,
    },
    {
      fileName: 'claude-cpa-pool.json',
      filePath: 'C:\\EasyCLIProxyAPI\\oauth\\claude-cpa-pool.json',
      platform: 'claude_code',
      label: 'cpa-claude@anthropic.test',
      email: 'cpa-claude@anthropic.test',
      accountId: 'uuid_cpa_claude_2',
      fingerprint: 'fp_cpa_claude_2',
      action: 'import',
      existingAccountId: null,
    },
  ];

  return {
    handle(command: string, payload?: Record<string, unknown>): unknown | undefined {
      if (!command.startsWith('account_switch_')) return undefined;
      syncCounts();

      switch (command) {
        case 'account_switch_get_catalog': {
          const result: AccountSwitchCatalog = {
            vaultDir: 'C:\\EasyCLIProxyAPI\\account-switch',
            platforms: clone(platforms),
            groups: clone(groups),
          };
          return result;
        }
        case 'account_switch_list_accounts': {
          const status = findPlatform(String(payload?.platform ?? 'codex'));
          return {
            platform: status.platform,
            status: clone(status),
            accounts: clone(accountsByPlatform[status.platform]),
            groups: clone(groups),
          };
        }
        case 'account_switch_inspect_platform': {
          return clone(findPlatform(String(payload?.platform ?? 'codex')));
        }
        case 'account_switch_decouple_proxy': {
          const status = findPlatform(String(payload?.platform ?? 'codex'));
          const wasProxy = status.proxy.mode !== 'direct';
          status.proxy = { mode: 'direct', detail: null, canDecouple: false, configPaths: status.proxy.configPaths };
          return {
            platform: status.platform,
            changed: wasProxy,
            message: `${status.displayName} has been switched back to official direct mode`,
            status: clone(status),
          };
        }
        case 'account_switch_import_local': {
          const status = findPlatform(String(payload?.platform ?? 'codex'));
          const id = `${status.platform}-local-${Date.now()}`;
          const label = status.localCredential.label ?? `${status.displayName} Local`;
          const created: AccountSummary = {
            id,
            platform: status.platform,
            label,
            email: status.localCredential.email,
            accountId: status.localCredential.accountId,
            planType: 'Pro',
            fingerprint: status.localCredential.fingerprint ?? `fp_${id}`,
            tags: [],
            groupId: null,
            notes: null,
            source: 'local',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastUsedAt: null,
            tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
            hasRefreshToken: true,
            lastQuota: null,
            isActive: false,
          };
          accountsByPlatform[status.platform].unshift(created);
          status.localCredential.matchedAccountId = id;
          syncCounts();
          return clone(created);
        }
        case 'account_switch_preview_cpa_oauth': {
          const filter = payload?.platform ? String(payload.platform) : null;
          return clone(
            filter
              ? mockCpaCandidates.filter((item) => item.platform === filter)
              : mockCpaCandidates,
          );
        }
        case 'account_switch_import_cpa_oauth': {
          const entries = (payload?.entries as CpaImportSelection[]) ?? [];
          const added: AccountSummary[] = [];
          for (const entry of entries) {
            const candidate = mockCpaCandidates.find((c) => c.filePath === entry.filePath);
            const platform = (entry.platform ?? candidate?.platform ?? 'codex') as SwitchPlatformId;
            const id = `${platform}-cpa-${Date.now()}-${added.length}`;
            const acc: AccountSummary = {
              id,
              platform,
              label: candidate?.label ?? entry.fileName ?? 'CPA Account',
              email: candidate?.email ?? null,
              accountId: candidate?.accountId ?? null,
              planType: 'Plus',
              fingerprint: candidate?.fingerprint ?? `fp_${id}`,
              tags: ['cpa'],
              groupId: null,
              notes: null,
              source: 'cpa_import',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastUsedAt: null,
              tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
              hasRefreshToken: true,
              lastQuota: null,
              isActive: false,
            };
            accountsByPlatform[platform].push(acc);
            added.push(acc);
          }
          syncCounts();
          return {
            imported: added.length,
            updated: 0,
            skipped: 0,
            errors: [],
            accounts: clone(added),
          };
        }
        case 'account_switch_import_json': {
          const status = findPlatform(String(payload?.platform ?? 'codex'));
          const raw = JSON.parse(String(payload?.payload ?? '{}')) as Record<string, unknown>;
          const label = String(raw.email ?? raw.label ?? `${status.displayName} JSON`);
          const id = `${status.platform}-json-${Date.now()}`;
          const acc: AccountSummary = {
            id,
            platform: status.platform,
            label,
            email: typeof raw.email === 'string' ? raw.email : null,
            accountId: typeof raw.account_id === 'string' ? raw.account_id : null,
            planType: null,
            fingerprint: `fp_${id}`,
            tags: [],
            groupId: null,
            notes: null,
            source: 'json_import',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastUsedAt: null,
            tokenExpiresAt: null,
            hasRefreshToken: Boolean(raw.refresh_token),
            lastQuota: null,
            isActive: false,
          };
          accountsByPlatform[status.platform].push(acc);
          syncCounts();
          return { imported: 1, updated: 0, skipped: 0, errors: [], accounts: [clone(acc)] };
        }
        case 'account_switch_export_json': {
          const status = findPlatform(String(payload?.platform ?? 'codex'));
          const requestedIds = Array.isArray(payload?.accountIds)
            ? new Set((payload.accountIds as string[]).filter(Boolean))
            : null;
          const allAccounts = accountsByPlatform[status.platform];
          const exported =
            requestedIds && requestedIds.size > 0
              ? allAccounts.filter((acc) => requestedIds.has(acc.id))
              : allAccounts;
          return JSON.stringify(
            {
              format: 'easycliproxyapi-account-switch-v1',
              platform: status.platform,
              exportedAt: new Date().toISOString(),
              accounts: exported.map((acc) => ({
                ...acc,
                credential: {
                  access_token: `mock_tok_${acc.id}_9f8e7d6c5b4a`,
                  refresh_token: acc.hasRefreshToken
                    ? `mock_ref_${acc.id}_1a2b3c4d5e6f`
                    : null,
                },
              })),
            },
            null,
            2,
          );
        }
        case 'account_switch_switch_account': {
          const status = findPlatform(String(payload?.platform ?? 'codex'));
          const accountId = String(payload?.accountId ?? '');
          const options = (payload?.options as SwitchAccountOptions | undefined) ?? {
            refreshBeforeSwitch: true,
            decoupleCpaProxy: true,
            syncTargets: [],
            restartClient: false,
          };
          let decoupled = false;
          if (options.decoupleCpaProxy && status.proxy.mode === 'cpa_proxy') {
            status.proxy = { mode: 'direct', detail: null, canDecouple: false, configPaths: status.proxy.configPaths };
            decoupled = true;
          }
          status.activeAccountId = accountId;
          for (const acc of accountsByPlatform[status.platform]) {
            acc.isActive = acc.id === accountId;
            if (acc.isActive) acc.lastUsedAt = Date.now();
          }
          return {
            platform: status.platform,
            accountId,
            decoupledProxy: decoupled,
            refreshedToken: options.refreshBeforeSwitch,
            clientRestarted: options.restartClient,
            warnings: [],
            syncResults: (options.syncTargets ?? []).map((target) => ({
              target,
              status: 'synced',
              message: `Synced to ${target}`,
            })),
            status: clone(status),
          };
        }
        case 'account_switch_refresh_quota': {
          const status = findPlatform(String(payload?.platform ?? 'codex'));
          const list = accountsByPlatform[status.platform];
          for (const acc of list) {
            acc.lastQuota = {
              fetchedAt: Date.now(),
              plan: acc.planType ?? 'Pro',
              metrics: acc.lastQuota?.metrics.length
                ? acc.lastQuota.metrics
                : [{ id: 'main', label: 'Primary Window', remainingPercent: 92, usedPercent: 8, resetAt: Math.floor(Date.now() / 1000) + 14_400, detail: null }],
              error: null,
            };
          }
          return { platform: status.platform, updated: clone(list), errors: [] };
        }
        case 'account_switch_update_account_meta': {
          const status = findPlatform(String(payload?.platform ?? 'codex'));
          const accountId = String(payload?.accountId ?? '');
          const patch = (payload?.patch as AccountMetaPatch) ?? {};
          const acc = accountsByPlatform[status.platform].find((item) => item.id === accountId);
          if (!acc) throw new Error('Account not found');
          if (patch.label) acc.label = patch.label;
          if (patch.notes !== undefined) acc.notes = patch.notes;
          if (patch.groupId !== undefined) acc.groupId = patch.groupId;
          if (patch.tags !== undefined) acc.tags = patch.tags;
          acc.updatedAt = Date.now();
          return clone(acc);
        }
        case 'account_switch_delete_accounts': {
          const status = findPlatform(String(payload?.platform ?? 'codex'));
          const ids = new Set((payload?.accountIds as string[]) ?? []);
          const before = accountsByPlatform[status.platform].length;
          accountsByPlatform[status.platform] = accountsByPlatform[status.platform].filter(
            (acc) => !ids.has(acc.id),
          );
          if (status.activeAccountId && ids.has(status.activeAccountId)) {
            status.activeAccountId = null;
          }
          syncCounts();
          return before - accountsByPlatform[status.platform].length;
        }
        case 'account_switch_manage_groups': {
          const action = (payload?.action as GroupAction) ?? { action: 'create' };
          if (action.action === 'create' && action.name?.trim()) {
            const nextOrder =
              groups.reduce((max, item) => Math.max(max, item.order), -1) + 1;
            groups.push({
              id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              name: action.name.trim(),
              color: action.color ?? null,
              order: nextOrder,
            });
          } else if (
            (action.action === 'rename' || action.action === 'update') &&
            action.id
          ) {
            const target = groups.find((g) => g.id === action.id);
            if (target) {
              if (action.name?.trim()) target.name = action.name.trim();
              if (action.color !== undefined) target.color = action.color;
            }
          } else if (action.action === 'delete' && action.id) {
            groups = groups.filter((g) => g.id !== action.id);
            for (const list of Object.values(accountsByPlatform)) {
              for (const acc of list) {
                if (acc.groupId === action.id) {
                  acc.groupId = null;
                }
              }
            }
          } else if (action.action === 'reorder' && Array.isArray(action.order)) {
            const orderMap = new Map(
              action.order.map((id, idx) => [id, idx]),
            );
            for (const group of groups) {
              const idx = orderMap.get(group.id);
              if (idx !== undefined) group.order = idx;
            }
            groups.sort((a, b) => a.order - b.order);
          }
          return clone(groups);
        }
        case 'account_switch_restart_client':
          return true;
        case 'account_switch_oauth_start':
          return {
            sessionId: 'mock-oauth-1',
            platform: String(payload?.platform ?? 'codex'),
            flow: 'pkce_browser',
            status: 'pending',
            authUrl: 'https://example.test/oauth',
            userCode: 'MOCK-2026',
            verificationUri: 'https://example.test/device',
            expiresInSeconds: 300,
            error: null,
            account: null,
          };
        case 'account_switch_oauth_poll':
        case 'account_switch_oauth_cancel':
          return {
            sessionId: String(payload?.sessionId ?? 'mock-oauth-1'),
            platform: 'codex',
            flow: 'pkce_browser',
            status: 'cancelled',
            authUrl: null,
            userCode: null,
            verificationUri: null,
            expiresInSeconds: null,
            error: null,
            account: null,
          };
        default:
          return undefined;
      }
    },
  };
}
