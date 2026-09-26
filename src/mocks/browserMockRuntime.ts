export type BrowserMockScenario = 'running' | 'stopped' | 'empty' | 'error';
export type BrowserMockMode = BrowserMockScenario | 'off';

type JsonObject = Record<string, unknown>;
type EmitMockEvent = (event: string, payload: unknown) => void;

export type BrowserMockOptions = {
  mode: BrowserMockMode;
  delayMs: number;
};

export type BrowserMockRuntime = {
  scenario: BrowserMockScenario;
  invoke: (command: string, payload?: unknown) => Promise<unknown>;
};

const SCENARIOS = new Set<BrowserMockScenario>(['running', 'stopped', 'empty', 'error']);
const PROVIDER_SECTIONS = [
  'gemini-api-key',
  'codex-api-key',
  'claude-api-key',
  'openai-compatibility',
] as const;

const clone = <Value,>(value: Value): Value => structuredClone(value);
const sleep = (delayMs: number) => delayMs > 0
  ? new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
  : Promise.resolve();

const asObject = (value: unknown): JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {}
);

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const readString = (value: unknown) => typeof value === 'string' ? value : '';
const readNumber = (value: unknown, fallback = 0) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isoHoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
const localHourKey = (date: Date) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
  String(date.getHours()).padStart(2, '0'),
].join('-');

export function resolveBrowserMockOptions(
  search: string,
  storedScenario?: string | null,
): BrowserMockOptions {
  const params = new URLSearchParams(search);
  const requested = params.get('mock');
  const mode: BrowserMockMode = requested === 'off'
    ? 'off'
    : SCENARIOS.has(requested as BrowserMockScenario)
      ? requested as BrowserMockScenario
      : SCENARIOS.has(storedScenario as BrowserMockScenario)
        ? storedScenario as BrowserMockScenario
        : 'running';
  const delay = Number(params.get('mockDelay') ?? 0);
  return {
    mode,
    delayMs: Number.isFinite(delay) ? Math.max(0, Math.min(5_000, Math.round(delay))) : 0,
  };
}

type BrowserMockState = ReturnType<typeof createState>;

function createCoreStatus(scenario: BrowserMockScenario) {
  const installed = scenario !== 'empty';
  const running = scenario === 'running';
  return {
    installed,
    running,
    ready: running,
    starting: false,
    managed: running,
    processId: running ? 42817 : null,
    currentVersion: installed ? '7.3.15' : null,
    installDir: 'C:\\EasyCLIProxyAPI\\cpa-core',
    binaryPath: installed ? 'C:\\EasyCLIProxyAPI\\cpa-core\\cli-proxy-api.exe' : null,
    message: running ? 'Browser Mock 内核运行中' : installed ? 'Browser Mock 内核已停止' : 'Browser Mock 内核未安装',
  };
}

function createTimeline() {
  return Array.from({ length: 24 }, (_, index) => {
    const date = new Date(Date.now() - (23 - index) * 60 * 60 * 1000);
    const requests = 6 + (index % 5) * 3;
    const failure = index % 7 === 0 ? 1 : 0;
    const canceled = index % 11 === 0 ? 1 : 0;
    const success = Math.max(0, requests - failure - canceled);
    const codexTokens = 18_000 + index * 1_350;
    const claudeTokens = 9_000 + (index % 6) * 2_100;
    return {
      hour: localHourKey(date),
      requests,
      success,
      failure,
      canceled,
      tokens: codexTokens + claudeTokens,
      models: [
        { key: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', tokens: codexTokens, requests: Math.ceil(requests * 0.65) },
        { key: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tokens: claudeTokens, requests: Math.floor(requests * 0.35) },
      ],
    };
  });
}

function createUsageEvents() {
  const models = ['gpt-5.2-codex', 'claude-sonnet-4-6', 'gemini-3-pro'];
  return Array.from({ length: 18 }, (_, index) => {
    const failed = index === 5 || index === 13;
    const input = 1_200 + index * 137;
    const output = failed ? 0 : 380 + index * 31;
    const reasoning = failed ? 0 : 160 + index * 19;
    const cacheRead = index % 3 === 0 ? 640 : 0;
    return {
      id: `mock-event-${index + 1}`,
      row_id: String(index + 1),
      timestamp: isoHoursAgo(index / 2),
      latency_ms: 620 + index * 47,
      ttft_ms: failed ? null : 180 + index * 9,
      source: index % 2 === 0 ? 'codex' : 'claude-code',
      source_display: index % 2 === 0 ? 'Codex' : 'Claude Code',
      failed,
      canceled: false,
      failure_status: failed ? 429 : 0,
      failure_body: failed ? 'Mock rate limit exceeded' : '',
      provider: index % 2 === 0 ? 'OpenAI OAuth' : 'Claude OAuth',
      model: models[index % models.length],
      alias: '',
      reasoning_effort: index % 2 === 0 ? 'high' : 'medium',
      endpoint: '/v1/responses',
      api_key_hash: 'mock-key-hash',
      api_key_display: 'sk-mock••••••••2026',
      api_key_remark: '浏览器 Mock 密钥',
      tokens: {
        input_tokens: input,
        output_tokens: output,
        reasoning_tokens: reasoning,
        cache_read_tokens: cacheRead,
        cache_creation_tokens: 0,
        total_tokens: input + output + reasoning + cacheRead,
      },
    };
  });
}

function createAgentStatuses() {
  const ids = [
    ['claude-code', 'Claude Code'],
    ['claude-desktop', 'Claude Desktop'],
    ['codex', 'Codex'],
    ['opencode', 'OpenCode'],
    ['openclaw', 'OpenClaw'],
    ['hermes', 'Hermes Agent'],
    ['deepseek-harness', 'DeepSeek Harness'],
    ['zcode', 'ZCode'],
    ['workbuddy', 'WorkBuddy'],
    ['antigravity-cli', 'Antigravity CLI'],
    ['kimi-code', 'Kimi Code'],
    ['grok-build', 'Grok Build'],
    ['pi', 'Pi'],
  ] as const;
  const claudeMappings = {
    opus: 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5',
    opus1m: false,
    sonnet1m: false,
    haiku1m: false,
    maxContextTokens: 200_000,
    autoCompactPct: 90,
    disableAutoCompact: false,
  };
  return ids.map(([id, name], index) => ({
    id,
    name,
    supportedPlatform: true,
    installed: id !== 'openclaw',
    pluginInstalled: id === 'pi',
    launchTargets: id === 'codex' || id === 'opencode'
      ? [
          { id: 'app', label: 'Desktop App', detail: 'Browser Mock 桌面入口' },
          { id: 'cli', label: 'CLI', detail: 'Browser Mock 命令行入口' },
        ]
      : [{ id: id === 'claude-desktop' ? 'app' : 'cli', label: '启动', detail: 'Browser Mock 启动目标' }],
    version: `1.${index + 4}.0`,
    cliVersion: id === 'claude-desktop' ? null : `1.${index + 4}.0`,
    appVersion: id === 'claude-desktop' ? '0.12.8' : null,
    pluginVersion: id === 'pi' ? '0.4.2' : null,
    configExists: true,
    configValid: true,
    configured: id !== 'openclaw',
    connectionState: id === 'openclaw' ? 'not-configured' : 'configured',
    configurationSynchronized: true,
    currentModel: id.startsWith('claude') ? 'claude-sonnet-4-6' : 'gpt-5.2-codex',
    oauthConfiguration: id === 'codex',
    codexNativeOauth: false,
    modificationEnabled: id !== 'openclaw',
    modificationState: id === 'openclaw' ? 'unconfigured' : 'applied',
    backupAvailable: true,
    appliedModel: id.startsWith('claude') ? 'claude-sonnet-4-6' : 'gpt-5.2-codex',
    claudeCodeModelMappings: id === 'claude-code' ? clone(claudeMappings) : null,
    claudeDesktopModelMappings: id === 'claude-desktop'
      ? {
          ...clone(claudeMappings),
          desktopModels: [
            { id: 'claude-opus-5-cpa', alias: 'Claude Opus', model: 'claude-opus-4-6', enabled: true },
            { id: 'claude-sonnet-5-cpa', alias: 'Claude Sonnet', model: 'claude-sonnet-4-6', enabled: true },
            { id: 'claude-haiku-4-5-cpa', alias: 'Claude Haiku', model: 'claude-haiku-4-5', enabled: true },
          ],
        }
      : null,
    warnings: id === 'openclaw' ? ['Mock：尚未应用配置'] : [],
    error: null,
  }));
}

function createState(scenario: BrowserMockScenario) {
  const timeline = createTimeline();
  const events = createUsageEvents();
  const authFiles: JsonObject[] = [
    {
      name: 'codex-personal.json',
      provider: 'codex',
      type: 'codex',
      source: 'file',
      path: 'C:\\EasyCLIProxyAPI\\oauth\\codex-personal.json',
      auth_index: 'mock-codex-1',
      account_id: 'acct_mock_codex',
      email: 'codex.mock@example.com',
      disabled: false,
      priority: 0,
      success: 138,
      failed: 4,
      modtime: Date.now() - 20 * 60_000,
      recent_requests: Array.from({ length: 20 }, (_, index) => ({
        time: isoHoursAgo((19 - index) / 3),
        success: 3 + index % 4,
        failed: index % 8 === 0 ? 1 : 0,
      })),
      excluded_models: [],
    },
    {
      name: 'claude-team.json',
      provider: 'claude',
      type: 'anthropic',
      source: 'file',
      path: 'C:\\EasyCLIProxyAPI\\oauth\\claude-team.json',
      auth_index: 'mock-claude-1',
      email: 'claude.mock@example.com',
      disabled: false,
      priority: 0,
      success: 92,
      failed: 1,
      modtime: Date.now() - 45 * 60_000,
      excluded_models: ['claude-legacy-*'],
    },
    {
      name: 'gemini-runtime',
      provider: 'gemini',
      type: 'gemini',
      source: 'runtime',
      runtime_only: true,
      auth_index: 'mock-gemini-runtime',
      disabled: false,
      success: 27,
      failed: 0,
    },
  ];
  const providerConfig: Record<(typeof PROVIDER_SECTIONS)[number], JsonObject[]> = {
    'codex-api-key': [
      {
        name: 'Codex Direct',
        'api-key': 'sk-mock-codex-direct',
        'base-url': 'https://api.openai.com/v1',
        priority: 10,
        models: [
          { name: 'gpt-5.2-codex', alias: 'codex-latest', thinking: { levels: ['low', 'medium', 'high', 'xhigh'] } },
          { name: 'gpt-5.1-codex', thinking: { levels: ['low', 'medium', 'high'] } },
        ],
      },
      {
        name: 'DeepSeek',
        'api-key': 'sk-mock-deepseek',
        'base-url': 'https://api.deepseek.com',
        priority: 20,
        models: [
          { name: 'deepseek-chat' },
          { name: 'deepseek-reasoner', thinking: { levels: ['high'] } },
        ],
      },
    ],
    'claude-api-key': [{
      name: 'Claude Direct',
      'api-key': 'sk-ant-mock-claude',
      'base-url': 'https://api.anthropic.com',
      models: [
        { name: 'claude-opus-4-6' },
        { name: 'claude-sonnet-4-6' },
        { name: 'claude-haiku-4-5' },
      ],
    }],
    'gemini-api-key': [{
      name: 'Gemini AI Studio',
      'api-key': 'AIza-mock-gemini',
      'base-url': 'https://generativelanguage.googleapis.com',
      models: [{ name: 'gemini-3-pro' }, { name: 'gemini-3-flash' }],
    }],
    'openai-compatibility': [{
      name: 'Mock OpenAI Compatible',
      'base-url': 'https://mock-provider.example.com/v1',
      'api-key-entries': [
        { 'api-key': 'sk-mock-compatible-a', 'auth-index': 'mock-compatible-a' },
        { 'api-key': 'sk-mock-compatible-b', 'auth-index': 'mock-compatible-b' },
      ],
      models: [
        { name: 'mock-large', alias: 'mock-default' },
        { name: 'mock-fast' },
      ],
      priority: 30,
      disabled: false,
    }],
  };
  const analysis = {
    models: [
      { key: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', requests: 182, failures: 4, tokens: 1_284_600 },
      { key: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', requests: 96, failures: 2, tokens: 684_200 },
      { key: 'gemini-3-pro', label: 'Gemini 3 Pro', requests: 34, failures: 1, tokens: 218_500 },
    ],
    providers: [
      { key: 'openai-oauth', label: 'OpenAI OAuth', requests: 182, failures: 4, tokens: 1_284_600 },
      { key: 'claude-oauth', label: 'Claude OAuth', requests: 96, failures: 2, tokens: 684_200 },
      { key: 'gemini-api', label: 'Gemini API', requests: 34, failures: 1, tokens: 218_500 },
    ],
    sources: [
      { key: 'codex', label: 'Codex', requests: 164, failures: 4, tokens: 1_102_000 },
      { key: 'claude-code', label: 'Claude Code', requests: 114, failures: 2, tokens: 752_000 },
      { key: 'other', label: 'Other', requests: 34, failures: 1, tokens: 333_300 },
    ],
    apiKeys: [
      { key: 'mock-key-hash', label: '浏览器 Mock 密钥', requests: 312, failures: 7, tokens: 2_187_300 },
    ],
  };
  return {
    scenario,
    coreStatus: createCoreStatus(scenario),
    guiSettings: {
      host: '127.0.0.1',
      port: 8317,
      runOnStartup: true,
      closeBehavior: 'ask',
    },
    coreConfig: {
      apiKeys: [
        { apiKey: 'sk-browser-mock-2026', remark: '浏览器 Mock 密钥' },
        { apiKey: 'sk-browser-demo-secondary', remark: '备用演示密钥' },
      ],
      debug: false,
      commercialMode: false,
      loggingToFile: true,
      logsMaxTotalSizeMb: 256,
      errorLogsMaxFiles: 10,
      usageStatisticsEnabled: true,
      redisUsageQueueRetentionSeconds: 60,
      host: '127.0.0.1',
      port: 8317,
      allowLan: false,
      routingStrategy: 'round-robin',
      proxyUrl: '',
      proxyOverride: false,
      routingSessionAffinity: true,
      routingSessionAffinityTtl: '30m',
      disableCooling: false,
      requestRetry: 3,
      maxRetryCredentials: 0,
      maxRetryInterval: 30,
      streamingBootstrapRetries: 0,
    },
    softwareSettings: {
      closeBehavior: 'ask',
      autostartEnabled: false,
      startCoreOnLaunch: true,
      silentStartEnabled: false,
      defaultTerminal: 'auto',
      availableTerminals: [
        { id: 'auto', label: '自动选择' },
        { id: 'windows-terminal', label: 'Windows Terminal' },
        { id: 'powershell', label: 'PowerShell' },
      ],
    },
    tlsSettings: { enabled: false, cert: '', key: '' },
    sensitiveWords: {
      antigravitySensitiveWords: ['internal-only', 'mock-secret'],
      devinSensitiveWords: ['private-repository'],
    },
    appUpdateInfo: {
      currentVersion: '0.2.97',
      latestVersion: '0.3.0',
      updateAvailable: true,
      releaseUrl: 'https://github.com/router-for-me/EasyCLIProxyAPI/releases/latest',
      releaseNotes: {
        'zh-CN': '## Browser Mock 更新示例\n\n- 新增界面调试模式\n- 改进启动体验',
        en: '## Browser Mock release\n\n- Added UI mock mode',
      },
      publishedAt: isoHoursAgo(18),
      autoUpdateSupported: true,
      downloadSizeBytes: 48 * 1024 * 1024,
      unsupportedReason: null,
    },
    appUpdateTask: {
      running: false,
      cancellable: false,
      phase: 'idle',
      targetVersion: null,
      downloadedBytes: 0,
      totalBytes: null,
      percent: null,
      message: null,
    },
    coreLatest: { version: '7.3.16', assetName: 'CLIProxyAPI_7.3.16_windows_amd64.zip' },
    coreInstallTask: {
      running: false,
      cancellable: false,
      phase: 'idle',
      downloaded: 0,
      total: null,
      percent: null,
      message: null,
      result: null,
    },
    versionSource: { source: 'github', gitcodeAvailable: true, customMirrors: ['https://gh-proxy.example.com/'] },
    providerConfig,
    authFiles,
    oauthExcludedModels: { codex: [], claude: ['claude-legacy-*'], gemini: [] } as Record<string, string[]>,
    oauthSessions: new Map<string, string>(),
    analysis,
    usageOverview: {
      totalRequests: 312,
      successCount: 301,
      failureCount: 7,
      canceledCount: 4,
      successRate: 96.47,
      inputTokens: 1_264_000,
      outputTokens: 486_500,
      reasoningTokens: 286_800,
      cacheReadTokens: 132_000,
      cacheCreationTokens: 18_000,
      totalTokens: 2_187_300,
      rpm: 4.8,
      tpm: 31_450,
      tps: 58.4,
      tpsSampleCount: 284,
      averageLatencyMs: 1_284,
      cacheHitRate: 38.6,
      estimatedCost: 3.8421,
      pricedRequests: 296,
      timeline,
    },
    usageEvents: events,
    usagePrices: [
      {
        model: 'gpt-5.2-codex', prompt: 1.25, completion: 10, cacheRead: 0.125, cacheCreation: 0,
        promptConfigured: true, completionConfigured: true, cacheReadConfigured: true, cacheCreationConfigured: false,
        source: 'mock', sourceModelId: 'gpt-5.2-codex', updatedAtMs: Date.now(),
      },
      {
        model: 'claude-sonnet-4-6', prompt: 3, completion: 15, cacheRead: 0.3, cacheCreation: 3.75,
        promptConfigured: true, completionConfigured: true, cacheReadConfigured: true, cacheCreationConfigured: true,
        source: 'mock', sourceModelId: 'claude-sonnet-4-6', updatedAtMs: Date.now(),
      },
    ],
    usageStorage: { maxDatabaseSizeMb: 512, databaseSizeBytes: 84 * 1024 * 1024, totalRecords: 312, deletedRecords: 0 },
    agentStatuses: createAgentStatuses(),
    deepSeekStatus: {
      running: false,
      pid: null as number | null,
      mode: null as string | null,
    },
    thinkingAliases: [
      {
        sourceModel: 'gpt-5.2-codex',
        alias: 'codex-high',
        effort: 'high' as string | null,
        provider: 'Codex OAuth',
        kind: 'codex-oauth',
        oauthChannel: 'codex' as string | null,
      },
    ],
    speedAliases: [
      {
        sourceModel: 'gpt-5.2-codex',
        alias: 'codex-fast',
        serviceTier: 'priority',
        provider: 'Codex OAuth',
        kind: 'codex-oauth',
        oauthChannel: 'codex' as string | null,
      },
    ],
    aliasSources: [
      { id: 'codex:gpt-5.2-codex', model: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', provider: 'Codex OAuth', kind: 'codex-oauth', protocol: 'openai', reasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'claude:claude-sonnet-4-6', model: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', provider: 'Claude OAuth', kind: 'claude-oauth', protocol: 'anthropic', reasoningLevels: ['low', 'medium', 'high'] },
    ],
    codexCatalog: {
      revision: 'mock-catalog-r1',
      models: ['gpt-5.2-codex', 'gpt-5.1-codex'].map((slug) => {
        const configuration = {
          display_name: slug === 'gpt-5.2-codex' ? 'GPT-5.2 Codex' : 'GPT-5.1 Codex',
          description: 'Browser Mock 模型目录',
          context_window: 272_000,
          max_context_window: 400_000,
          effective_context_window_percent: 90,
          auto_compact_token_limit: 244_800,
          default_reasoning_level: 'medium',
          supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map((effort) => ({ effort, description: `${effort} reasoning effort` })),
          input_modalities: ['text', 'image'],
          visibility: 'list',
          supports_parallel_tool_calls: true,
        };
        return {
          slug,
          hasOfficialTemplate: true,
          contextSource: 'template',
          customized: false,
          configuration,
          defaults: clone(configuration),
        };
      }),
    },
    harnessCatalog: {
      revision: 'mock-harness-r1',
      models: [
        { id: 'deepseek-chat', defaults: { name: 'DeepSeek Chat', input: ['text'], contextWindow: 64_000, maxTokens: 8_192 }, configuration: {} },
        { id: 'deepseek-reasoner', defaults: { name: 'DeepSeek Reasoner', input: ['text'], contextWindow: 64_000, maxTokens: 16_384 }, configuration: { reasoningEfforts: { high: 'high' } } },
      ],
      provider: { api: 'openai-completions', defaultContextWindow: 64_000 },
      baseUrl: 'http://127.0.0.1:8317/v1',
      defaultModel: 'deepseek-chat',
      configured: true,
    },
    codexSessions: [
      { id: 'mock-session-1', title: '实现 Browser Mock', cwd: 'E:\\projects\\mock-demo', modelProvider: 'cpa-gui', archived: false, updatedAtMs: Date.now() - 20 * 60_000, databasePath: 'C:\\Users\\Mock\\.codex\\state.sqlite' },
      { id: 'mock-session-2', title: 'TypeScript 类型学习', cwd: 'E:\\projects\\typescript-study', modelProvider: 'openai', archived: false, updatedAtMs: Date.now() - 3 * 60 * 60_000, databasePath: 'C:\\Users\\Mock\\.codex\\state.sqlite' },
      { id: 'mock-session-3', title: '旧版界面检查', cwd: 'E:\\projects\\legacy-ui', modelProvider: 'cpa-gui', archived: true, updatedAtMs: Date.now() - 3 * 24 * 60 * 60_000, databasePath: 'C:\\Users\\Mock\\.codex\\state.sqlite' },
    ],
  };
}

function findAuthFile(state: BrowserMockState, name: string) {
  return state.authFiles.find((file) => file.name === name);
}

function mockModelDefinitions() {
  return {
    models: [
      { id: 'gpt-5.2-codex', display_name: 'GPT-5.2 Codex' },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
      { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
      { id: 'deepseek-chat', display_name: 'DeepSeek Chat' },
    ],
  };
}

function mockApiCall(body: JsonObject) {
  const url = readString(body.url).toLowerCase();
  if (url.includes('/models')) {
    return {
      status_code: 200,
      body: {
        data: [
          { id: 'mock-large', display_name: 'Mock Large' },
          { id: 'mock-fast', display_name: 'Mock Fast' },
          { id: 'mock-reasoner', display_name: 'Mock Reasoner' },
        ],
      },
    };
  }
  if (url.includes('/api/oauth/profile')) {
    return { status_code: 200, body: { account: { has_claude_pro: true, has_claude_max: false } } };
  }
  if (url.includes('wham/usage')) {
    return {
      status_code: 200,
      body: {
        rate_limit: {
          primary_window: { used_percent: 28, reset_after_seconds: 7_200, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 42, reset_after_seconds: 345_600, limit_window_seconds: 604_800 },
        },
      },
    };
  }
  if (url.includes('anthropic.com/api/oauth/usage')) {
    return {
      status_code: 200,
      body: {
        five_hour: { utilization: 24, resets_at: isoHoursAgo(-3) },
        seven_day: { utilization: 41, resets_at: isoHoursAgo(-72) },
      },
    };
  }
  if (url.includes('retrieveuserquotasummary')) {
    return {
      status_code: 200,
      body: {
        groups: [{ display_name: 'Gemini Pro', buckets: [{ window: '5h', remaining_fraction: 0.74, reset_time: isoHoursAgo(-3) }] }],
      },
    };
  }
  if (url.includes('billing')) {
    return {
      status_code: 200,
      body: {
        periodType: 'weekly',
        usagePercent: 36,
        periodEnd: isoHoursAgo(-48),
        productUsage: [{ product: 'Grok Code', usagePercent: 31 }],
      },
    };
  }
  return {
    status_code: 200,
    body: {
      id: 'mock-response',
      choices: [{ message: { content: 'Browser Mock response' } }],
      content: [{ type: 'text', text: 'Browser Mock response' }],
    },
  };
}

function managementResponse(state: BrowserMockState, payload: JsonObject) {
  const request = asObject(payload.request);
  const method = readString(request.method).toUpperCase();
  const path = readString(request.path);
  const query = asObject(request.query);
  const body = request.body;

  if (method === 'GET' && path === '/config') {
    return clone(state.providerConfig);
  }
  if (PROVIDER_SECTIONS.some((section) => path === `/${section}`)) {
    const section = path.slice(1) as (typeof PROVIDER_SECTIONS)[number];
    if (method === 'GET') return { [section]: clone(state.providerConfig[section]) };
    if (method === 'PUT') {
      state.providerConfig[section] = asArray(body).map((item) => clone(asObject(item)));
      return { [section]: clone(state.providerConfig[section]) };
    }
    if (method === 'PATCH' && section === 'openai-compatibility') {
      const patch = asObject(body);
      const index = readNumber(patch.index, -1);
      const current = state.providerConfig[section][index];
      if (current) state.providerConfig[section][index] = { ...current, ...asObject(patch.value) };
      return { [section]: clone(state.providerConfig[section]) };
    }
  }
  if (method === 'GET' && path === '/auth-files') {
    return { files: clone(state.authFiles), observed_at: new Date().toISOString() };
  }
  if (method === 'GET' && path === '/auth-files/download') {
    const file = findAuthFile(state, readString(query.name));
    return clone(file ?? { name: query.name, excluded_models: [] });
  }
  if (method === 'GET' && path === '/auth-files/models') return mockModelDefinitions();
  if (method === 'GET' && path.startsWith('/model-definitions/')) return mockModelDefinitions();
  if (method === 'GET' && path === '/oauth-excluded-models') {
    return { 'oauth-excluded-models': clone(state.oauthExcludedModels) };
  }
  if (method === 'PATCH' && path === '/oauth-excluded-models') {
    const patch = asObject(body);
    state.oauthExcludedModels[readString(patch.provider)] = asArray(patch.models).map(String);
    return { 'oauth-excluded-models': clone(state.oauthExcludedModels) };
  }
  if (method === 'DELETE' && path === '/oauth-excluded-models') {
    delete state.oauthExcludedModels[readString(query.provider)];
    return null;
  }
  if (method === 'PATCH' && (path === '/auth-files/fields' || path === '/auth-files/status')) {
    const patch = asObject(body);
    const file = findAuthFile(state, readString(patch.name));
    if (file) Object.assign(file, patch);
    return clone(file ?? null);
  }
  if (method === 'DELETE' && path === '/auth-files') {
    const index = state.authFiles.findIndex((file) => file.name === query.name);
    if (index >= 0) state.authFiles.splice(index, 1);
    return null;
  }
  if (method === 'POST' && path === '/api-call') return mockApiCall(asObject(body));
  if (method === 'DELETE' && path === '/oauth-session') return null;
  return {};
}

function updateCoreConfig(state: BrowserMockState, payload: JsonObject) {
  Object.assign(state.coreConfig, asObject(payload.settings));
  state.guiSettings.host = state.coreConfig.host;
  state.guiSettings.port = state.coreConfig.port;
  return clone(state.coreConfig);
}

function createActionResult(payload: JsonObject) {
  return {
    outcome: 'updated',
    enabled: true,
    model: readString(payload.model) || 'gpt-5.2-codex',
    changedFiles: ['C:\\Users\\Mock\\.config\\agent\\settings.json'],
    conflictFiles: [],
  };
}

const ERROR_SCENARIO_COMMANDS = new Set([
  'get_core_status',
  'get_gui_settings',
  'get_core_config_settings',
  'check_app_update',
  'check_latest_core',
  'management_request',
  'get_usage_overview',
  'get_agent_config_statuses',
]);

export function createBrowserMockRuntime(
  scenario: BrowserMockScenario,
  emitEvent: EmitMockEvent = () => {},
  delayMs = 0,
): BrowserMockRuntime {
  const state = createState(scenario);
  const emit = (event: string, payload: unknown) => emitEvent(event, clone(payload));

  const invoke = async (command: string, rawPayload?: unknown): Promise<unknown> => {
    await sleep(delayMs);
    const payload = asObject(rawPayload);
    if (scenario === 'error' && ERROR_SCENARIO_COMMANDS.has(command)) {
      throw new Error(`Browser Mock error scenario: ${command}`);
    }

    switch (command) {
      case 'plugin:app|version': return '0.2.97-mock';
      case 'plugin:app|name': return 'EasyCLIProxyAPI Browser Mock';
      case 'plugin:app|tauri_version': return '2.x-mock';
      case 'plugin:app|identifier': return 'com.cpa.gui.browser-mock';
      case 'plugin:dialog|open': {
        const options = asObject(payload.options);
        return options.directory
          ? 'C:\\Users\\Mock\\Projects\\demo'
          : 'C:\\Users\\Mock\\Certificates\\mock.pem';
      }
      case 'plugin:dialog|save': return 'C:\\Users\\Mock\\Downloads\\mock-output.json';
      case 'detect_core_platform': return { os: 'windows', arch: 'x86_64', assetOs: 'windows', assetArch: 'amd64', archiveKind: 'zip' };
      case 'get_linux_system_theme': return 'light';
      case 'set_app_locale':
      case 'open_external_url':
      case 'open_oauth_url':
      case 'resolve_windows_close_request':
      case 'open_auth_files_directory':
      case 'open_core_logs_directory':
      case 'restart_agent_app':
      case 'restart_codex_app':
      case 'restart_opencode_app':
      case 'check_codex_oauth_login':
      case 'restore_codex_official_config':
      case 'create_agent_config_backup':
      case 'restore_agent_config_backup':
      case 'launch_agent': return null;

      case 'get_core_status': return clone(state.coreStatus);
      case 'start_core_process': {
        if (!state.coreStatus.installed) throw new Error('Browser Mock：请先安装内核');
        Object.assign(state.coreStatus, { running: true, ready: true, managed: true, starting: false, processId: 42817, message: 'Browser Mock 内核运行中' });
        state.guiSettings.runOnStartup = true;
        emit('core-status-changed', state.coreStatus);
        return clone(state.coreStatus);
      }
      case 'stop_core_process': {
        Object.assign(state.coreStatus, { running: false, ready: false, managed: false, starting: false, processId: null, message: 'Browser Mock 内核已停止' });
        state.guiSettings.runOnStartup = false;
        emit('core-status-changed', state.coreStatus);
        return clone(state.coreStatus);
      }
      case 'restart_core_process': {
        if (!state.coreStatus.installed) throw new Error('Browser Mock：请先安装内核');
        Object.assign(state.coreStatus, { running: true, ready: true, managed: true, starting: false, processId: 42818, message: 'Browser Mock 内核已重启' });
        emit('core-status-changed', state.coreStatus);
        return clone(state.coreStatus);
      }
      case 'get_gui_settings': return clone(state.guiSettings);
      case 'get_core_config_settings': return clone(state.coreConfig);
      case 'get_software_settings': return clone(state.softwareSettings);
      case 'get_core_tls_settings': return clone(state.tlsSettings);
      case 'get_core_sensitive_words_settings': return clone(state.sensitiveWords);
      case 'save_core_sensitive_words_settings': {
        state.sensitiveWords = clone(asObject(payload.settings)) as typeof state.sensitiveWords;
        emit('config-files-changed', { paths: ['cpa-core/config.yaml'], errors: [] });
        return clone(state.sensitiveWords);
      }
      case 'save_software_settings': {
        Object.assign(state.softwareSettings, asObject(payload.settings));
        return clone(state.softwareSettings);
      }
      case 'save_core_tls_settings': {
        Object.assign(state.tlsSettings, asObject(payload.settings));
        emit('config-files-changed', { paths: ['cpa-core/config.yaml'], errors: [] });
        return clone(state.tlsSettings);
      }
      case 'save_core_logging_settings':
      case 'save_network_endpoint_settings':
      case 'save_retry_settings':
      case 'save_session_routing_settings': return updateCoreConfig(state, payload);
      case 'set_core_routing_strategy': {
        state.coreConfig.routingStrategy = readString(payload.strategy);
        return clone(state.coreConfig);
      }
      case 'set_core_proxy_url': {
        state.coreConfig.proxyUrl = readString(payload.proxyUrl);
        return clone(state.coreConfig);
      }
      case 'set_core_session_affinity': {
        state.coreConfig.routingSessionAffinity = Boolean(payload.enabled);
        return clone(state.coreConfig);
      }
      case 'set_core_session_affinity_ttl': {
        state.coreConfig.routingSessionAffinityTtl = readString(payload.ttl);
        return clone(state.coreConfig);
      }
      case 'add_core_api_key': {
        state.coreConfig.apiKeys.push({ apiKey: readString(payload.apiKey), remark: readString(payload.remark) });
        return clone(state.coreConfig);
      }
      case 'update_core_api_key': {
        const entry = state.coreConfig.apiKeys.find((item) => item.apiKey === payload.originalApiKey);
        if (entry) Object.assign(entry, { apiKey: readString(payload.apiKey), remark: readString(payload.remark) });
        return clone(state.coreConfig);
      }
      case 'delete_core_api_key': {
        state.coreConfig.apiKeys = state.coreConfig.apiKeys.filter((item) => item.apiKey !== payload.apiKey);
        return clone(state.coreConfig);
      }
      case 'set_core_management_secret_key':
      case 'clear_core_management_secret_key': return clone(state.coreConfig);

      case 'check_app_update': return clone(state.appUpdateInfo);
      case 'get_app_update_task': return clone(state.appUpdateTask);
      case 'start_app_update': {
        Object.assign(state.appUpdateTask, {
          running: true,
          cancellable: true,
          phase: 'downloading',
          targetVersion: state.appUpdateInfo.latestVersion,
          downloadedBytes: 18 * 1024 * 1024,
          totalBytes: state.appUpdateInfo.downloadSizeBytes,
          percent: 38,
          message: 'Browser Mock 正在下载更新',
        });
        emit('app-update-progress', state.appUpdateTask);
        return null;
      }
      case 'cancel_app_update': {
        Object.assign(state.appUpdateTask, { running: false, cancellable: false, phase: 'cancelled', message: 'Browser Mock 已取消更新' });
        emit('app-update-progress', state.appUpdateTask);
        return null;
      }
      case 'check_latest_core': return clone(state.coreLatest);
      case 'get_core_install_task': return clone(state.coreInstallTask);
      case 'install_core_version':
      case 'install_bundled_core': {
        const result = {
          version: readString(payload.version) || state.coreLatest.version,
          assetName: state.coreLatest.assetName,
          installDir: state.coreStatus.installDir,
          binaryPath: 'C:\\EasyCLIProxyAPI\\cpa-core\\cli-proxy-api.exe',
        };
        Object.assign(state.coreStatus, { installed: true, currentVersion: result.version, binaryPath: result.binaryPath, message: 'Browser Mock 内核已安装' });
        Object.assign(state.coreInstallTask, { running: false, cancellable: false, phase: 'completed', downloaded: 64 * 1024 * 1024, total: 64 * 1024 * 1024, percent: 100, message: 'Browser Mock 安装完成', result });
        emit('core-install-progress', state.coreInstallTask);
        emit('core-status-changed', state.coreStatus);
        return clone(result);
      }
      case 'cancel_core_install': return null;
      case 'detect_bundled_core': return { version: '7.3.15', assetName: 'CLIProxyAPI_7.3.15_windows_amd64.zip' };
      case 'get_version_source_settings': return clone(state.versionSource);
      case 'set_download_source': {
        state.versionSource.source = readString(payload.source) || 'github';
        emit('version-download-source-changed', state.versionSource);
        return clone(state.versionSource);
      }
      case 'add_custom_download_mirror': {
        const url = readString(payload.url);
        if (url && !state.versionSource.customMirrors.includes(url)) state.versionSource.customMirrors.push(url);
        return clone(state.versionSource);
      }
      case 'remove_custom_download_mirror': {
        state.versionSource.customMirrors = state.versionSource.customMirrors.filter((url) => url !== payload.url);
        if (state.versionSource.source === `custom:${payload.url}`) state.versionSource.source = 'github';
        return clone(state.versionSource);
      }
      case 'set_prefer_gitcode_downloads': return clone(state.versionSource);

      case 'management_request': return clone(managementResponse(state, payload));
      case 'upload_auth_file': {
        const name = readString(payload.name) || 'uploaded-mock.json';
        state.authFiles.push({ name, provider: 'codex', type: 'codex', source: 'file', auth_index: `mock-upload-${state.authFiles.length + 1}`, disabled: false, priority: 0 });
        return { ok: true, name };
      }
      case 'resolve_api_access_remarks': {
        return asArray(payload.queries).map((query) => {
          const item = asObject(query);
          return readString(item.providerName) || 'Browser Mock Provider';
        });
      }
      case 'save_api_access_remark': return null;
      case 'provider_health_probe': return { firstTokenLatencyMs: 184, responseLatencyMs: 642 };

      case 'list_oauth_browsers': return [
        { id: 'default', label: '系统默认浏览器' },
        { id: 'chrome', label: 'Google Chrome (Mock)' },
        { id: 'edge', label: 'Microsoft Edge (Mock)' },
      ];
      case 'start_oauth_login': {
        const provider = readString(payload.provider) || 'codex';
        const session = `mock-oauth-${provider}-${Date.now()}`;
        state.oauthSessions.set(session, provider);
        return { url: `https://example.com/mock-oauth/${provider}?state=${session}`, state: session, opened: true, openError: null };
      }
      case 'get_oauth_status': {
        const session = readString(payload.state);
        const provider = state.oauthSessions.get(session);
        if (provider && !state.authFiles.some((file) => file.name === `${provider}-mock-login.json`)) {
          state.authFiles.push({
            name: `${provider}-mock-login.json`, provider, type: provider, source: 'file',
            auth_index: `mock-${provider}-${state.authFiles.length + 1}`, priority: 0, disabled: false, modtime: Date.now(),
          });
        }
        return { status: 'ok', error: null };
      }
      case 'submit_oauth_callback': return null;

      case 'get_usage_collector_status': return {
        state: state.coreStatus.ready ? 'collecting' : 'waiting-core',
        message: state.coreStatus.ready ? 'Browser Mock 正在采集使用记录' : '等待内核启动',
        lastCollectedAt: new Date().toISOString(),
        totalRecords: state.usageOverview.totalRequests,
      };
      case 'get_usage_overview': return clone(state.usageOverview);
      case 'get_usage_analysis': return clone(state.analysis);
      case 'get_usage_events': {
        const query = asObject(payload.query);
        const page = Math.max(1, readNumber(query.page, 1));
        const pageSize = Math.max(1, readNumber(query.page_size, 50));
        const start = (page - 1) * pageSize;
        return {
          items: clone(state.usageEvents.slice(start, start + pageSize)),
          total: state.usageEvents.length,
          page,
          pageSize,
          totalPages: Math.max(1, Math.ceil(state.usageEvents.length / pageSize)),
        };
      }
      case 'get_usage_pricing': {
        const rows = state.usagePrices.map((price, index) => ({
          model: price.model,
          requests: index === 0 ? 182 : 96,
          inputTokens: index === 0 ? 820_000 : 386_000,
          outputTokens: index === 0 ? 312_000 : 142_000,
          cacheReadTokens: index === 0 ? 82_000 : 44_000,
          cacheCreationTokens: index === 0 ? 0 : 18_000,
          totalTokens: index === 0 ? 1_214_000 : 590_000,
          estimatedCost: index === 0 ? 1.92 : 1.71,
          price: clone(price),
        }));
        return { rows, totalCost: 3.63, totalRequests: 278, pricedRequests: 278, savedPrices: state.usagePrices.length };
      }
      case 'get_usage_storage_settings': return clone(state.usageStorage);
      case 'save_usage_storage_settings': {
        state.usageStorage.maxDatabaseSizeMb = readNumber(payload.maxDatabaseSizeMb);
        state.usageStorage.deletedRecords = 0;
        return clone(state.usageStorage);
      }
      case 'shrink_usage_database': {
        const targetMb = readNumber(payload.targetDatabaseSizeMb, 64);
        state.usageStorage.databaseSizeBytes = targetMb * 1024 * 1024;
        state.usageStorage.deletedRecords = 42;
        state.usageStorage.totalRecords = Math.max(0, state.usageStorage.totalRecords - 42);
        return clone(state.usageStorage);
      }
      case 'repair_usage_cache_records': return { scanned: 312, repaired: 3, deleted: 1, backupPath: 'C:\\EasyCLIProxyAPI\\usage-records\\backups\\mock.sqlite' };
      case 'save_usage_model_price': {
        const next = asObject(payload.price ?? payload);
        const model = readString(next.model);
        const current = state.usagePrices.find((price) => price.model === model);
        const normalized = {
          model,
          prompt: readNumber(next.prompt),
          completion: readNumber(next.completion),
          cacheRead: readNumber(next.cacheRead),
          cacheCreation: readNumber(next.cacheCreation),
          promptConfigured: true,
          completionConfigured: true,
          cacheReadConfigured: true,
          cacheCreationConfigured: true,
          source: 'manual',
          sourceModelId: model,
          updatedAtMs: Date.now(),
        };
        if (current) Object.assign(current, normalized); else state.usagePrices.push(normalized);
        return null;
      }
      case 'delete_usage_model_price': {
        state.usagePrices = state.usagePrices.filter((price) => price.model !== payload.model);
        return null;
      }
      case 'preview_usage_model_prices': return {
        source: readString(payload.source) || 'models-dev',
        sourceUrl: 'https://example.com/browser-mock-prices.json',
        matches: clone(state.usagePrices),
        unmatched: ['mock-unknown-model'],
      };
      case 'apply_usage_model_prices': return { imported: asArray(payload.prices).length };

      case 'get_agent_config_statuses':
      case 'refresh_agent_config_statuses': return clone(state.agentStatuses);
      case 'get_agent_models': return [
        { name: 'gpt-5.2-codex', alias: 'codex-latest', displayName: 'GPT-5.2 Codex', isAlias: true, contextWindow: 272_000, inputModalities: ['text', 'image'] },
        { name: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', contextWindow: 200_000, inputModalities: ['text', 'image'] },
        { name: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', contextWindow: 200_000, inputModalities: ['text', 'image'] },
        { name: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', contextWindow: 200_000, inputModalities: ['text', 'image'] },
        { name: 'gemini-3-pro', displayName: 'Gemini 3 Pro', contextWindow: 1_000_000, inputModalities: ['text', 'image'] },
        { name: 'deepseek-chat', displayName: 'DeepSeek Chat', contextWindow: 64_000, inputModalities: ['text'] },
      ];
      case 'update_agent_config':
      case 'apply_agent_config_template':
      case 'install_pi_provider':
      case 'update_pi_provider':
      case 'repair_pi_provider':
      case 'set_agent_config_enabled':
      case 'close_codex_config_modification': return createActionResult(payload);
      case 'uninstall_pi_provider': return { ...createActionResult(payload), enabled: false, model: null };
      case 'check_pi_provider_update': return { installedVersion: '0.4.2', latestVersion: '0.4.3', updateAvailable: true };
      case 'clear_codex_config': return ['C:\\Users\\Mock\\.codex\\config.toml'];
      case 'preview_agent_config_template': return { revision: 'mock-template-r1', files: ['settings.json', 'models.json'] };
      case 'get_deepseek_harness_process_status': return clone(state.deepSeekStatus);
      case 'stop_deepseek_harness_process': {
        state.deepSeekStatus = { running: false, pid: null, mode: null };
        return clone(state.deepSeekStatus);
      }
      case 'restart_deepseek_harness_process': {
        state.deepSeekStatus = { running: true, pid: 43110, mode: 'web' };
        return clone(state.deepSeekStatus);
      }
      case 'list_agent_config_backups': return {
        versions: [{
          id: 'mock-backup-2026-09-25', createdAt: isoHoursAgo(5), fileCount: 2,
          location: 'C:\\EasyCLIProxyAPI\\agent-backups\\mock-backup-2026-09-25',
          files: [
            { path: 'settings.json', exists: true, size: 1_428 },
            { path: 'models.json', exists: true, size: 3_260 },
          ],
          restorable: true, error: null,
        }],
      };
      case 'preview_agent_config_backup': return {
        revision: 'mock-backup-r1',
        files: [{ path: 'settings.json', exists: true, size: 1_428 }],
        differences: [{ file: 'settings.json', field: 'model', before: 'gpt-5.1-codex', after: 'gpt-5.2-codex' }],
      };
      case 'delete_agent_config_backup': return null;

      case 'get_thinking_aliases': return clone(state.thinkingAliases);
      case 'get_speed_aliases': return clone(state.speedAliases);
      case 'get_model_alias_sources': return clone(state.aliasSources);
      case 'get_thinking_alias_sources': return clone(state.aliasSources);
      case 'get_speed_alias_sources': return clone(state.aliasSources);
      case 'get_model_alias_edit_source': {
        const alias = readString(payload.alias);
        const entry = state.thinkingAliases.find((item) => item.alias === alias);
        const source = state.aliasSources.find((item) => item.model === entry?.sourceModel) ?? state.aliasSources[0];
        return { source: clone(source), revision: 'mock-alias-r1', effort: entry?.effort ?? null, fast: state.speedAliases.some((item) => item.alias === alias) };
      }
      case 'create_thinking_alias': {
        const request = asObject(payload.request ?? payload);
        const entry = {
          sourceModel: readString(request.sourceModel ?? request.model),
          alias: readString(request.alias),
          effort: readString(request.effort) || null,
          provider: readString(request.provider) || 'Browser Mock',
          kind: readString(request.kind) || 'codex-oauth',
          oauthChannel: readString(request.oauthChannel) || null,
        };
        state.thinkingAliases = [...state.thinkingAliases.filter((item) => item.alias !== entry.alias), entry];
        return clone(state.thinkingAliases);
      }
      case 'delete_thinking_alias': {
        state.thinkingAliases = state.thinkingAliases.filter((item) => item.alias !== payload.alias);
        return clone(state.thinkingAliases);
      }
      case 'create_speed_alias': {
        const request = asObject(payload.request ?? payload);
        const entry = {
          sourceModel: readString(request.sourceModel ?? request.model),
          alias: readString(request.alias),
          serviceTier: readString(request.serviceTier) || 'priority',
          provider: readString(request.provider) || 'Browser Mock',
          kind: readString(request.kind) || 'codex-oauth',
          oauthChannel: readString(request.oauthChannel) || null,
        };
        state.speedAliases = [...state.speedAliases.filter((item) => item.alias !== entry.alias), entry];
        return clone(state.speedAliases);
      }
      case 'delete_speed_alias': {
        state.speedAliases = state.speedAliases.filter((item) => item.alias !== payload.alias);
        return clone(state.speedAliases);
      }

      case 'get_codex_model_catalog_editor': return clone(state.codexCatalog);
      case 'save_codex_model_catalog_editor': {
        const request = asObject(payload.request);
        const models = asArray(request.models).map(asObject);
        state.codexCatalog.models = state.codexCatalog.models.map((model) => {
          const update = models.find((item) => item.slug === model.slug);
          return update ? { ...model, configuration: clone(asObject(update.configuration)) as typeof model.configuration, customized: true } : model;
        });
        state.codexCatalog.revision = `mock-catalog-${Date.now()}`;
        return { snapshot: clone(state.codexCatalog), synchronizationError: null };
      }
      case 'get_deepseek_harness_model_catalog_editor': return clone(state.harnessCatalog);
      case 'save_deepseek_harness_model_catalog_editor': {
        const request = asObject(payload.request);
        state.harnessCatalog = { ...state.harnessCatalog, ...clone(request), revision: `mock-harness-${Date.now()}`, configured: true } as typeof state.harnessCatalog;
        return clone(state.harnessCatalog);
      }

      case 'list_codex_sessions': {
        const request = asObject(payload.request);
        const offset = Math.max(0, readNumber(request.offset));
        const limit = Math.max(1, readNumber(request.limit, 50));
        return {
          codexHome: 'C:\\Users\\Mock\\.codex',
          databasePaths: ['C:\\Users\\Mock\\.codex\\state.sqlite'],
          sessions: clone(state.codexSessions.slice(offset, offset + limit)),
          totalCount: state.codexSessions.length,
          offset,
          limit,
          hasMore: offset + limit < state.codexSessions.length,
          warnings: [],
        };
      }
      case 'delete_codex_sessions': {
        const request = asObject(payload.request);
        const ids = asArray(request.sessionIds).map(String);
        state.codexSessions = state.codexSessions.filter((session) => !ids.includes(session.id));
        return {
          results: ids.map((id) => ({ sessionId: id, status: 'deleted', message: 'Browser Mock 已删除', backupPath: 'C:\\Users\\Mock\\.codex\\backups\\mock.zip' })),
          deletedCount: ids.length,
          failedCount: 0,
        };
      }
      case 'repair_codex_session_metadata': {
        emit('codex-session-repair-progress', { phase: 'complete', percent: 100, processed: state.codexSessions.length, total: state.codexSessions.length });
        return {
          targetProvider: 'cpa-gui', changedRolloutFiles: 2, sqliteRowsUpdated: 2,
          skippedLockedFiles: [], backupPath: 'C:\\Users\\Mock\\.codex\\backups\\repair.zip',
          encryptedContentWarning: null, warnings: [],
        };
      }
      case 'preview_codex_session_index_cleanup': return {
        snapshotSha256: 'mock-snapshot-sha256',
        candidates: [{ id: 'stale-thread-1', threadName: '已不存在的会话', updatedAt: isoHoursAgo(72) }],
      };
      case 'apply_codex_session_index_cleanup': return { prunedEntries: asArray(asObject(payload.request).threadIds).length, backupPath: 'C:\\Users\\Mock\\.codex\\backups\\index.json' };

      case 'get_lan_ipv4': return ['192.168.100.100'];
      default:
        if (command.startsWith('plugin:window|') || command.startsWith('plugin:webview|')) return null;
        console.warn(`[Browser Mock] 尚未实现命令：${command}`, rawPayload);
        throw new Error(`Browser Mock 尚未实现命令：${command}`);
    }
  };

  return { scenario, invoke };
}
