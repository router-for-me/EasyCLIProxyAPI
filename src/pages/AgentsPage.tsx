import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import {
  AlertTriangle,
  AppWindow,
  BadgeCheck,
  Bot,
  Check,
  ChevronDown,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import claudeIcon from '../assets/icons/claude.svg';
import codexIcon from '../assets/icons/codex.svg';
import deepseekIcon from '../assets/icons/deepseek.svg';
import hermesIcon from '../assets/icons/hermes.png';
import grokIcon from '../assets/icons/grok.svg';
import kimiIcon from '../assets/icons/kimi-light.svg';
import openclawIcon from '../assets/icons/openclaw.svg';
import opencodeIcon from '../assets/icons/opencode.svg';
import piIcon from '../assets/icons/pi-logo-on-light.svg';
import zcodeIcon from '../assets/icons/zcode.png';
import {
  agentModelAlias,
  filterAgentModels,
  filterAgentModelsByAlias,
  findAgentModel,
  resolveAgentModelForAliasMode,
  resolveAgentModelSelection,
} from '../services/agentModelPicker';
import {
  resolveAgentConfigurationAction,
  resolveAgentModelMappingsDraftSourceForClient,
  sameAgentModel,
  sameAgentModelMappings,
} from '../services/agentConfigurationDraft';
import {
  parseAgentLaunchDirectoryHistory,
  rememberAgentLaunchDirectory,
  type AgentLaunchDirectoryHistory,
} from '../services/agentLaunchDirectoryHistory';
import type { ModelOption } from '../services/modelService';
import { getCurrentLocale, translate, useI18n } from '../i18n';
import { CodexSessionsPanel } from './CodexSessionsPanel';
import { CodexModelCatalogDialog } from './CodexModelCatalogDialog';

type AgentClientId =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'opencode'
  | 'openclaw'
  | 'hermes'
  | 'deepseek-harness'
  | 'zcode'
  | 'kimi-code'
  | 'grok-build'
  | 'pi';

type ClaudeModelMappingClientId = 'claude-code' | 'claude-desktop';

type AgentModificationState = 'unconfigured' | 'applied' | 'invalid';

type AgentConfigStatus = {
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
  configValid: boolean;
  configured: boolean;
  configurationSynchronized: boolean;
  currentModel: string | null;
  oauthConfiguration: boolean;
  modificationEnabled: boolean;
  modificationState: AgentModificationState;
  backupAvailable: boolean;
  appliedModel: string | null;
  claudeCodeModelMappings: ClaudeModelMappings | null;
  claudeDesktopModelMappings: ClaudeModelMappings | null;
  warnings: string[];
  error: string | null;
};

type AgentLaunchTarget = {
  id: 'app' | 'cli';
  label: string;
  detail: string;
};

type AgentConfigActionResult = {
  outcome: 'applied' | 'default';
  enabled: boolean;
  model: string | null;
  changedFiles: string[];
  conflictFiles: string[];
};

type PiProviderUpdateStatus = {
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
};

type OAuthLoginRequiredAction = 'enable' | 'apply' | 'launch';

type ClaudeModelMappings = {
  opus: string;
  sonnet: string;
  haiku: string;
  opus1m: boolean;
  sonnet1m: boolean;
  haiku1m: boolean;
  maxContextTokens: number;
  autoCompactPct: number;
  disableAutoCompact: boolean;
};

const CODEX_OAUTH_LOGIN_REQUIRED_ERROR = 'CODEX_OAUTH_LOGIN_REQUIRED';
const DEFAULT_CLAUDE_CODE_MAX_CONTEXT_TOKENS = 200_000;
const DEFAULT_CLAUDE_AUTO_COMPACT_PCT = 90;

const createClaudeModelMappings = (model: string): ClaudeModelMappings => ({
  opus: model,
  sonnet: model,
  haiku: model,
  opus1m: false,
  sonnet1m: false,
  haiku1m: false,
  maxContextTokens: DEFAULT_CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  autoCompactPct: DEFAULT_CLAUDE_AUTO_COMPACT_PCT,
  disableAutoCompact: false,
});

const createClaudeModelMappingsByClient = (): Record<
  ClaudeModelMappingClientId,
  ClaudeModelMappings
> => ({
  'claude-code': createClaudeModelMappings(''),
  'claude-desktop': createClaudeModelMappings(''),
});

const createClaudeBooleanByClient = (): Record<ClaudeModelMappingClientId, boolean> => ({
  'claude-code': false,
  'claude-desktop': false,
});

let claudeModelMappingsDraftCache = createClaudeModelMappingsByClient();
let claudeCustomMappingCache = createClaudeBooleanByClient();
const claudeModelMappingsDirtyCache = createClaudeBooleanByClient();
let codexOauthConfigurationDraftCache: boolean | null = null;

const claudeMappingRoles = [
  {
    key: 'opus',
    contextKey: 'opus1m',
    labelKey: 'agents.claudeDesktopMapping.opus',
  },
  {
    key: 'sonnet',
    contextKey: 'sonnet1m',
    labelKey: 'agents.claudeDesktopMapping.sonnet',
  },
  {
    key: 'haiku',
    contextKey: 'haiku1m',
    labelKey: 'agents.claudeDesktopMapping.haiku',
  },
] as const;

type AgentDefinition = {
  id: AgentClientId;
  name: string;
  icon?: string;
  Icon?: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  descriptionKey: 'agents.description.claudeCode' | 'agents.description.claudeDesktop' | 'agents.description.codex' | 'agents.description.opencode' | 'agents.description.openclaw' | 'agents.description.hermes' | 'agents.description.deepseekHarness' | 'agents.description.zcode' | 'agents.description.kimiCode' | 'agents.description.grokBuild' | 'agents.description.pi';
};

type AgentSubpageId = 'core' | 'sessions';

type AgentSubpageDefinition = {
  id: AgentSubpageId;
  labelKey: 'agents.tabs.core' | 'agents.tabs.sessions';
  clients?: readonly AgentClientId[];
};

const agentDefinitions: AgentDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: claudeIcon,
    descriptionKey: 'agents.description.claudeCode',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    icon: claudeIcon,
    descriptionKey: 'agents.description.claudeDesktop',
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: codexIcon,
    descriptionKey: 'agents.description.codex',
  },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    icon: deepseekIcon,
    descriptionKey: 'agents.description.deepseekHarness',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    icon: opencodeIcon,
    descriptionKey: 'agents.description.opencode',
  },
  {
    id: 'pi',
    name: 'Pi',
    icon: piIcon,
    descriptionKey: 'agents.description.pi',
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    icon: grokIcon,
    descriptionKey: 'agents.description.grokBuild',
  },
  {
    id: 'zcode',
    name: 'ZCode',
    icon: zcodeIcon,
    descriptionKey: 'agents.description.zcode',
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    icon: kimiIcon,
    descriptionKey: 'agents.description.kimiCode',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    icon: openclawIcon,
    descriptionKey: 'agents.description.openclaw',
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    icon: hermesIcon,
    descriptionKey: 'agents.description.hermes',
  },
];

const agentSubpages: AgentSubpageDefinition[] = [
  {
    id: 'core',
    labelKey: 'agents.tabs.core',
  },
  {
    id: 'sessions',
    labelKey: 'agents.tabs.sessions',
    clients: ['codex'],
  },
];

const DEFAULT_AGENT_SUBPAGE: AgentSubpageId = 'core';

const AGENT_MODEL_SELECTIONS_KEY = 'cpa-gui.agent-model-selections.v1';
const AGENT_SELECTED_CLIENT_KEY = 'cpa-gui.agent-selected-client.v1';
const AGENT_LAUNCH_DIRECTORY_HISTORY_KEY = 'cpa-gui.agent-launch-directory-history.v1';

const readSelectedAgentClient = (): AgentClientId => {
  const fallback = agentDefinitions[0].id;
  if (typeof window === 'undefined') return fallback;
  try {
    const saved = window.localStorage.getItem(AGENT_SELECTED_CLIENT_KEY);
    return agentDefinitions.some((agent) => agent.id === saved)
      ? (saved as AgentClientId)
      : fallback;
  } catch {
    return fallback;
  }
};

const writeSelectedAgentClient = (client: AgentClientId) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AGENT_SELECTED_CLIENT_KEY, client);
  } catch {
    // Keep the current in-memory selection when persistent storage is unavailable.
  }
};

const readAgentModelSelections = (): Partial<Record<AgentClientId, string>> => {
  if (typeof window === 'undefined') return {};
  try {
    const payload = window.localStorage.getItem(AGENT_MODEL_SELECTIONS_KEY);
    if (!payload) return {};
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return agentDefinitions.reduce<Partial<Record<AgentClientId, string>>>((result, agent) => {
      const value = parsed[agent.id];
      if (typeof value === 'string' && value.trim()) result[agent.id] = value.trim();
      return result;
    }, {});
  } catch {
    return {};
  }
};

const writeAgentModelSelections = (
  selections: Partial<Record<AgentClientId, string>>,
) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AGENT_MODEL_SELECTIONS_KEY, JSON.stringify(selections));
  } catch {
    // Local storage can be unavailable in hardened webviews; the in-memory selection still works.
  }
};

const readAgentLaunchDirectoryHistory = (): AgentLaunchDirectoryHistory => {
  if (typeof window === 'undefined') return {};
  try {
    return parseAgentLaunchDirectoryHistory(
      window.localStorage.getItem(AGENT_LAUNCH_DIRECTORY_HISTORY_KEY),
      agentDefinitions.map((agent) => agent.id),
    );
  } catch {
    return {};
  }
};

const writeAgentLaunchDirectoryHistory = (history: AgentLaunchDirectoryHistory) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AGENT_LAUNCH_DIRECTORY_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Keep the current in-memory history when persistent storage is unavailable.
  }
};

function AgentMark({ definition, size = 26 }: { definition: AgentDefinition; size?: number }) {
  if (definition.icon) {
    return <img src={definition.icon} alt="" className="provider-logo" />;
  }
  const Icon = definition.Icon ?? Bot;
  return <Icon size={size} aria-hidden />;
}

const listStatusText = (status: AgentConfigStatus | undefined) => {
  const locale = getCurrentLocale();
  if (!status) return translate(locale, 'agents.list.detecting');
  if (!status.supportedPlatform) return translate(locale, 'agents.list.unsupported');
  if (!status.installed) return translate(locale, 'agents.list.notInstalled');
  if (status.id === 'pi') {
    return status.pluginInstalled
      ? translate(locale, 'agents.list.piInstalled')
      : translate(locale, 'agents.list.pluginNotInstalled');
  }
  if (status.modificationState === 'invalid') return translate(locale, 'agents.status.invalid');
  if (status.modificationState === 'applied') return translate(locale, 'agents.list.modified', { model: status.appliedModel ?? '—' });
  return status.version
    ? translate(locale, 'agents.list.installedVersion', { version: status.version })
    : translate(locale, 'agents.list.installed');
};

type AgentModelPickerProps = {
  models: ModelOption[];
  value: string;
  loading: boolean;
  error: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onRefresh: () => void;
};

type AgentModelDropdownLayout = {
  top: number;
  left: number;
  width: number;
  height: number;
};

function AgentModelPicker({
  models,
  value,
  loading,
  error,
  disabled,
  onChange,
  onRefresh,
}: AgentModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [dropdownLayout, setDropdownLayout] = useState<AgentModelDropdownLayout | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const visibleModels = useMemo(() => filterAgentModels(models, search), [models, search]);
  const choices = useMemo(
    () => visibleModels.map((model) => ({ name: model.name, alias: model.alias ?? '' })),
    [visibleModels],
  );
  const selectedModel = findAgentModel(models, value);
  const selectedName = selectedModel?.name ?? '';
  const selectedAlias = selectedName ? agentModelAlias(models, selectedName) : '';

  const updateDropdownLayout = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;

    const rect = root.getBoundingClientRect();
    const edgeGap = 12;
    const triggerGap = 6;
    const preferredHeight = 282;
    const minimumHeight = 150;
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - triggerGap - edgeGap);
    const spaceAbove = Math.max(0, rect.top - triggerGap - edgeGap);
    const placeAbove = spaceBelow < preferredHeight && spaceAbove > spaceBelow;
    const availableHeight = placeAbove ? spaceAbove : spaceBelow;
    const height = Math.min(preferredHeight, Math.max(minimumHeight, availableHeight));
    const width = Math.min(rect.width, window.innerWidth - edgeGap * 2);
    const left = Math.min(
      Math.max(edgeGap, rect.left),
      Math.max(edgeGap, window.innerWidth - edgeGap - width),
    );
    const desiredTop = placeAbove
      ? rect.top - triggerGap - height
      : rect.bottom + triggerGap;
    const top = Math.min(
      Math.max(edgeGap, desiredTop),
      Math.max(edgeGap, window.innerHeight - edgeGap - height),
    );

    setDropdownLayout({ top, left, width, height });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setDropdownLayout(null);
      return undefined;
    }

    updateDropdownLayout();
    window.addEventListener('resize', updateDropdownLayout);
    window.addEventListener('scroll', updateDropdownLayout);
    return () => {
      window.removeEventListener('resize', updateDropdownLayout);
      window.removeEventListener('scroll', updateDropdownLayout);
    };
  }, [open, updateDropdownLayout]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    const selectedIndex = filterAgentModels(models, '').findIndex(
      (model) => model.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase(),
    );
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(choices.length - 1, 0)));
  }, [choices.length]);

  const choose = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  const moveActive = (offset: number) => {
    if (choices.length === 0) return;
    setActiveIndex((current) => (current + offset + choices.length) % choices.length);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter' && choices[activeIndex]) {
      event.preventDefault();
      choose(choices[activeIndex].name);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className={`agent-model-picker ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="agent-model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>
          <strong title={selectedName || undefined}>
            {selectedName || (loading ? t('agents.model.loading') : error ? t('agents.model.loadFailed') : models.length ? t('agents.model.select') : t('agents.model.none'))}
          </strong>
          {selectedAlias ? <small title={selectedAlias}>{selectedAlias}</small> : null}
        </span>
        <ChevronDown size={17} aria-hidden />
      </button>

      {open ? (
        <div
          className="agent-model-dropdown"
          style={dropdownLayout
            ? dropdownLayout
            : { top: 0, left: 0, width: 0, height: 0, visibility: 'hidden' }}
        >
          <div className="agent-model-search">
            <Search size={15} aria-hidden />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => {
                setSearch(event.currentTarget.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('agents.model.search')}
              role="combobox"
              aria-controls="agent-model-listbox"
              aria-expanded="true"
            />
            {search ? (
              <button
                type="button"
                className="icon-button quiet"
                onClick={() => {
                  setSearch('');
                  setActiveIndex(0);
                  searchRef.current?.focus();
                }}
                title={t('agents.model.clearSearch')}
              >
                <X size={14} />
              </button>
            ) : null}
            <button type="button" className="icon-button quiet" onClick={onRefresh} disabled={loading} title={t('agents.model.refresh')}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
            </button>
          </div>

          <div className="agent-model-list" id="agent-model-listbox" role="listbox">
            {loading && models.length === 0 ? (
              <div className="agent-model-empty"><LoaderCircle size={18} className="spin" />{t('agents.model.fetching')}</div>
            ) : error && models.length === 0 ? (
              <div className="agent-model-empty error"><strong>{t('agents.model.loadFailed')}</strong><span>{error}</span></div>
            ) : choices.length === 0 ? (
              <div className="agent-model-empty">
                <strong>{search.trim() ? t('agents.model.noMatch') : t('agents.model.unavailable')}</strong>
                <span>{search.trim() ? t('agents.model.tryKeywords') : t('agents.model.connectFirst')}</span>
              </div>
            ) : choices.map((choice, index) => {
              const selected = choice.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase();
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`agent-model-option ${selected ? 'selected' : ''} ${index === activeIndex ? 'active' : ''}`}
                  key={choice.name}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(choice.name)}
                >
                  <span>
                    <strong title={choice.name}>{choice.name}</strong>
                    <small>{choice.alias || t('agents.model.available')}</small>
                  </span>
                  {selected ? <Check size={16} aria-hidden /> : null}
                </button>
              );
            })}
          </div>
          <div className="agent-model-dropdown-footer">
            <span>{t('agents.model.count', { count: models.length })}</span>
            {error && models.length > 0 ? <span className="error">{t('agents.model.stale')}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type AgentsPageProps = {
  embedded?: boolean;
  onConfigurationApplied?: () => void;
};

export function AgentsPage({ embedded = false, onConfigurationApplied }: AgentsPageProps = {}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<AgentClientId>(readSelectedAgentClient);
  const [activeSubpage, setActiveSubpage] = useState<AgentSubpageId>(DEFAULT_AGENT_SUBPAGE);
  const [statuses, setStatuses] = useState<AgentConfigStatus[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelByClient, setModelByClient] = useState<Partial<Record<AgentClientId, string>>>(
    readAgentModelSelections,
  );
  const [claudeModelMappingsDraftByClient, setClaudeModelMappingsDraftByClientState] = useState(
    () => ({
      'claude-code': { ...claudeModelMappingsDraftCache['claude-code'] },
      'claude-desktop': { ...claudeModelMappingsDraftCache['claude-desktop'] },
    }),
  );
  const [claudeCustomMappingByClient, setClaudeCustomMappingByClientState] = useState(
    () => ({ ...claudeCustomMappingCache }),
  );
  const [loading, setLoading] = useState(true);
  const [modelLoading, setModelLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<
    'apply' | 'close-config' | 'default' | 'clear' | 'install-pi' | 'update-pi' | 'repair-pi' | 'uninstall-pi' | 'oauth-check' | 'directory' | 'launch' | 'launch-cli' | 'launch-app' | 'restart-app' | null
  >(null);
  const busy = busyAction !== null;
  const [detectionError, setDetectionError] = useState('');
  const [modelError, setModelError] = useState('');
  const [modelSelectionError, setModelSelectionError] = useState('');
  const [configurationError, setConfigurationError] = useState('');
  const [defaultError, setDefaultError] = useState('');
  const [defaultConfirmOpen, setDefaultConfirmOpen] = useState(false);
  const [clearError, setClearError] = useState('');
  const [clearNotice, setClearNotice] = useState('');
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const [launchDirectoryDialogOpen, setLaunchDirectoryDialogOpen] = useState(false);
  const [codexCatalogDialogOpen, setCodexCatalogDialogOpen] = useState(false);
  const [launchDirectory, setLaunchDirectory] = useState('');
  const [launchDirectoryTarget, setLaunchDirectoryTarget] = useState<AgentLaunchTarget | null>(null);
  const [launchDirectoryError, setLaunchDirectoryError] = useState('');
  const [launchDirectoryHistory, setLaunchDirectoryHistory] = useState(
    readAgentLaunchDirectoryHistory,
  );
  const [oauthLoginRequiredAction, setOauthLoginRequiredAction] = useState<OAuthLoginRequiredAction | null>(null);
  const [oauthConfigurationDraft, setOauthConfigurationDraftState] = useState<boolean | null>(
    () => codexOauthConfigurationDraftCache,
  );
  const [piProviderUpdateStatus, setPiProviderUpdateStatus] = useState<PiProviderUpdateStatus | null>(null);
  const modelRequestRef = useRef(0);
  const piUpdateRequestRef = useRef(0);
  const claudeModelMappingsDirtyRef = useRef(claudeModelMappingsDirtyCache);

  const setClaudeModelMappingsDraftByClient = useCallback((
    update: (
      current: Record<ClaudeModelMappingClientId, ClaudeModelMappings>,
    ) => Record<ClaudeModelMappingClientId, ClaudeModelMappings>,
  ) => {
    setClaudeModelMappingsDraftByClientState((current) => {
      const next = update(current);
      claudeModelMappingsDraftCache = next;
      return next;
    });
  }, []);

  const setClaudeCustomMappingByClient = useCallback((
    update: (
      current: Record<ClaudeModelMappingClientId, boolean>,
    ) => Record<ClaudeModelMappingClientId, boolean>,
  ) => {
    setClaudeCustomMappingByClientState((current) => {
      const next = update(current);
      claudeCustomMappingCache = next;
      return next;
    });
  }, []);

  const setOauthConfigurationDraft = useCallback((value: boolean | null) => {
    codexOauthConfigurationDraftCache = value;
    setOauthConfigurationDraftState(value);
  }, []);

  const loadStatuses = useCallback(async (forceRefresh = false) => {
    const command = forceRefresh
      ? 'refresh_agent_config_statuses'
      : 'get_agent_config_statuses';
    const nextStatuses = await invoke<AgentConfigStatus[]>(command);
    setStatuses(nextStatuses);
  }, []);

  const loadModels = useCallback(async (client: AgentClientId, preferredModel = '') => {
    const requestId = modelRequestRef.current + 1;
    modelRequestRef.current = requestId;
    setModelLoading(true);
    setModelError('');
    setModels([]);
    try {
      const nextModels = await invoke<ModelOption[]>('get_agent_models', { client });
      if (modelRequestRef.current !== requestId) return;
      setModels(nextModels);
      setModelSelectionError('');
      setModelByClient((current) => {
        const next = {
          ...current,
          [client]: resolveAgentModelSelection(nextModels, current[client] ?? preferredModel),
        };
        writeAgentModelSelections(next);
        return next;
      });
    } catch (requestError) {
      if (modelRequestRef.current === requestId) setModelError(String(requestError));
    } finally {
      if (modelRequestRef.current === requestId) setModelLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setDetectionError('');
    try {
      await loadStatuses(true);
    } catch (requestError) {
      setDetectionError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, [loadStatuses]);

  useEffect(() => {
    setLoading(true);
    setDetectionError('');
    void loadStatuses()
      .catch((requestError) => setDetectionError(String(requestError)))
      .finally(() => setLoading(false));
  }, [loadStatuses]);

  useEffect(() => {
    if (loading) return;
    const preferredModel = statuses.find((status) => status.id === selected)?.currentModel ?? '';
    void loadModels(selected, preferredModel);
  }, [loadModels, loading, selected]);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void listen('config-files-changed', () => {
      if (disposed) return;
      setDetectionError('');
      void loadStatuses().catch((requestError) => {
        if (!disposed) setDetectionError(String(requestError));
      });
      void loadModels(selected);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [loadModels, loadStatuses, selected]);

  useEffect(() => {
    writeSelectedAgentClient(selected);
  }, [selected]);

  useEffect(() => {
    setActiveSubpage(DEFAULT_AGENT_SUBPAGE);
    setModelSelectionError('');
    setConfigurationError('');
    setDefaultError('');
    setDefaultConfirmOpen(false);
    setClearError('');
    setClearNotice('');
    setClearConfirmOpen(false);
    setLaunchError('');
    setLaunchDirectoryDialogOpen(false);
    setLaunchDirectoryTarget(null);
    setLaunchDirectoryError('');
    setOauthLoginRequiredAction(null);
    // Preserve unsaved client-specific configuration while navigating between clients.
    // Each configuration action decides whether its draft should be retained or cleared.
  }, [selected]);

  const activeDefinition = agentDefinitions.find((agent) => agent.id === selected)
    ?? agentDefinitions[0];
  const activeStatus = statuses.find((status) => status.id === selected) ?? null;
  const oauthConfiguration = oauthConfigurationDraft
    ?? activeStatus?.oauthConfiguration
    ?? false;
  const savedSelectedModel = modelByClient[selected] ?? '';
  const selectedModelOption = findAgentModel(models, savedSelectedModel);
  const selectedModel = selectedModelOption?.name ?? '';
  const isPiClient = selected === 'pi';
  const hasIndependentCliAndApp = selected === 'codex' || selected === 'opencode';
  const isClaudeModelMappingClient = selected === 'claude-code' || selected === 'claude-desktop';
  const claudeModelMappingsDraft = isClaudeModelMappingClient
    ? claudeModelMappingsDraftByClient[selected]
    : createClaudeModelMappings('');
  const claudeCustomMapping = isClaudeModelMappingClient
    ? claudeCustomMappingByClient[selected]
    : false;
  const claudeMappingModels = useMemo(
    () => filterAgentModelsByAlias(models, claudeCustomMapping),
    [claudeCustomMapping, models],
  );

  const loadPiProviderUpdateStatus = useCallback(async () => {
    const requestId = piUpdateRequestRef.current + 1;
    piUpdateRequestRef.current = requestId;
    try {
      const nextStatus = await invoke<PiProviderUpdateStatus>('check_pi_provider_update');
      if (piUpdateRequestRef.current === requestId) setPiProviderUpdateStatus(nextStatus);
    } catch {
      if (piUpdateRequestRef.current === requestId) setPiProviderUpdateStatus(null);
    }
  }, []);

  useEffect(() => {
    if (!isPiClient || !activeStatus?.pluginInstalled || !activeStatus.pluginVersion) {
      piUpdateRequestRef.current += 1;
      setPiProviderUpdateStatus(null);
      return;
    }
    void loadPiProviderUpdateStatus();
  }, [activeStatus?.pluginInstalled, activeStatus?.pluginVersion, isPiClient, loadPiProviderUpdateStatus]);

  const piPluginUpdateAvailable = Boolean(
    piProviderUpdateStatus?.updateAvailable
      && piProviderUpdateStatus.installedVersion === activeStatus?.pluginVersion
      && piProviderUpdateStatus.latestVersion,
  );
  const piPluginUpdateTitle = piPluginUpdateAvailable
    ? t('agents.pi.updateAvailable', { version: piProviderUpdateStatus?.latestVersion ?? '' })
    : activeStatus?.pluginVersion ?? undefined;

  useEffect(() => {
    if (!isClaudeModelMappingClient || !selectedModel) return;
    const appliedMappings = selected === 'claude-code'
      ? activeStatus?.claudeCodeModelMappings
      : activeStatus?.claudeDesktopModelMappings;
    const dirty = claudeModelMappingsDirtyRef.current[selected];
    if (!dirty) {
      const appliedModels = appliedMappings
        ? claudeMappingRoles
            .map((role) => findAgentModel(models, appliedMappings[role.key]))
            .filter((model): model is ModelOption => model !== null)
        : [];
      setClaudeCustomMappingByClient((current) => ({
        ...current,
        [selected]: appliedModels.length === claudeMappingRoles.length
          && appliedModels.every((model) => Boolean(model.isAlias)),
      }));
    }
    setClaudeModelMappingsDraftByClient((current) => {
      const currentClientDraft = current[selected];
      const source = resolveAgentModelMappingsDraftSourceForClient(
        current,
        selected,
        appliedMappings,
        createClaudeModelMappings(selectedModel),
        dirty,
      );
      const next: ClaudeModelMappings = {
        opus: findAgentModel(models, source.opus)?.name ?? selectedModel,
        sonnet: findAgentModel(models, source.sonnet)?.name ?? selectedModel,
        haiku: findAgentModel(models, source.haiku)?.name ?? selectedModel,
        opus1m: Boolean(source.opus1m),
        sonnet1m: Boolean(source.sonnet1m),
        haiku1m: Boolean(source.haiku1m),
        maxContextTokens: source.maxContextTokens ?? DEFAULT_CLAUDE_CODE_MAX_CONTEXT_TOKENS,
        autoCompactPct: source.autoCompactPct ?? DEFAULT_CLAUDE_AUTO_COMPACT_PCT,
        disableAutoCompact: Boolean(source.disableAutoCompact),
      };
      return sameAgentModelMappings(currentClientDraft, next)
        ? current
        : { ...current, [selected]: next };
    });
  }, [
    activeStatus?.claudeCodeModelMappings,
    activeStatus?.claudeDesktopModelMappings,
    isClaudeModelMappingClient,
    models,
    selected,
    selectedModel,
  ]);

  const appliedModel = activeStatus?.appliedModel ?? activeStatus?.currentModel ?? '';
  const modelDraftChanged = !isClaudeModelMappingClient && Boolean(
    selectedModel.trim()
      && appliedModel.trim()
      && !sameAgentModel(selectedModel, appliedModel),
  );
  const appliedClaudeModelMappings = (selected === 'claude-code'
    ? activeStatus?.claudeCodeModelMappings
    : activeStatus?.claudeDesktopModelMappings)
    ?? createClaudeModelMappings(appliedModel);
  const claudeMappingsReady = !isClaudeModelMappingClient
    || claudeMappingRoles.every((role) =>
      Boolean(findAgentModel(models, claudeModelMappingsDraft[role.key])),
    );
  const claudeCodeRuntimeSettingsReady = selected !== 'claude-code' || (
    claudeModelMappingsDraft.maxContextTokens >= 100_000
    && claudeModelMappingsDraft.maxContextTokens <= 1_000_000
    && claudeModelMappingsDraft.autoCompactPct >= 1
    && claudeModelMappingsDraft.autoCompactPct <= 100
  );
  const claudeMappingDraftChanged = isClaudeModelMappingClient
    && activeStatus?.modificationState === 'applied'
    && !sameAgentModelMappings(
      claudeModelMappingsDraft,
      appliedClaudeModelMappings,
    );
  const oauthConfigurationChanged = selected === 'codex'
    && oauthConfiguration !== Boolean(activeStatus?.oauthConfiguration);
  const draftChanged = modelDraftChanged || claudeMappingDraftChanged || oauthConfigurationChanged;
  const configurationAction = resolveAgentConfigurationAction({
    client: selected,
    modificationState: activeStatus?.modificationState ?? 'unconfigured',
    configurationSynchronized: Boolean(activeStatus?.configurationSynchronized),
    selectedModel,
    appliedModel,
    oauthConfiguration,
    appliedOauthConfiguration: Boolean(activeStatus?.oauthConfiguration),
    modelMappings: claudeModelMappingsDraft,
    appliedModelMappings: appliedClaudeModelMappings,
  });
  const canEnable = Boolean(
    activeStatus?.supportedPlatform
      && activeStatus.installed
      && !modelLoading
      && (isClaudeModelMappingClient
        ? claudeMappingsReady && claudeCodeRuntimeSettingsReady
        : selectedModelOption),
  );
  const activeLaunchTargets = activeStatus?.launchTargets ?? [];
  const defaultLaunchTarget = activeLaunchTargets[0] ?? null;
  const cliLaunchTarget = activeLaunchTargets.find((target) => target.id === 'cli') ?? null;
  const appLaunchTarget = activeLaunchTargets.find((target) => target.id === 'app') ?? null;
  const launchEnabled = Boolean(
    activeStatus?.supportedPlatform
      && activeStatus.installed,
  );
  const canLaunchTarget = (target: AgentLaunchTarget | null) => launchEnabled && Boolean(target);
  const activeLaunchDirectoryHistory = launchDirectoryHistory[selected] ?? [];
  const modelHint = modelSelectionError
    || modelError
    || (modelLoading
      ? t('agents.model.readingAvailable')
      : models.length === 0
        ? ''
        : activeStatus?.modificationState === 'applied'
          ? t('agents.model.current', { model: appliedModel || '—' })
          : t('agents.model.firstSelection', { count: models.length }));
  const modificationDescription = activeStatus?.modificationState === 'invalid'
    ? t('agents.modify.invalid')
    : selected === 'zcode'
      ? t('agents.modify.zcodeRestart')
      : '';
  const refreshModels = () => {
    void loadModels(selected);
  };

  const runEmbeddedPrimaryAction = () => {
    if (isPiClient) {
      void (activeStatus?.pluginInstalled ? repairPiProvider() : installPiProvider());
      return;
    }
    void (configurationAction === 'close'
      ? closeConfigurationChanges()
      : applyConfigurationChanges());
  };

  const reloadStatusesAfterAction = async () => {
    setDetectionError('');
    try {
      await loadStatuses(true);
    } catch (requestError) {
      setDetectionError(String(requestError));
    }
  };

  const selectModel = (value: string) => {
    const model = findAgentModel(models, value);
    if (!model) return;
    setModelSelectionError('');
    setModelByClient((current) => {
      const next = { ...current, [selected]: model.name };
      writeAgentModelSelections(next);
      return next;
    });
  };

  const selectEmbeddedModel = (value: string) => {
    const model = findAgentModel(models, value);
    if (!model) return;
    if (isClaudeModelMappingClient) {
      claudeModelMappingsDirtyRef.current[selected] = true;
      setClaudeModelMappingsDraftByClient((current) => ({
        ...current,
        [selected]: {
          ...current[selected],
          opus: model.name,
          sonnet: model.name,
          haiku: model.name,
        },
      }));
    }
    selectModel(model.name);
  };

  const selectClaudeModelMapping = (
    role: 'opus' | 'sonnet' | 'haiku',
    value: string,
  ) => {
    const model = findAgentModel(models, value);
    if (!model || !isClaudeModelMappingClient) return;
    claudeModelMappingsDirtyRef.current[selected] = true;
    setModelSelectionError('');
    setClaudeModelMappingsDraftByClient((current) => ({
      ...current,
      [selected]: { ...current[selected], [role]: model.name },
    }));
  };

  const changeClaude1mPreference = (
    preference: 'opus1m' | 'sonnet1m' | 'haiku1m',
    enabled: boolean,
  ) => {
    if (!isClaudeModelMappingClient) return;
    claudeModelMappingsDirtyRef.current[selected] = true;
    setClaudeModelMappingsDraftByClient((current) => {
      const next = { ...current[selected], [preference]: enabled };
      if (selected === 'claude-code') {
        const any1mEnabled = next.opus1m || next.sonnet1m || next.haiku1m;
        next.maxContextTokens = any1mEnabled
          ? 1_000_000
          : DEFAULT_CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      }
      return { ...current, [selected]: next };
    });
  };

  const changeClaudeCodeRuntimeSetting = (
    key: 'maxContextTokens' | 'autoCompactPct',
    value: number,
  ) => {
    if (selected !== 'claude-code') return;
    claudeModelMappingsDirtyRef.current[selected] = true;
    setClaudeModelMappingsDraftByClient((current) => ({
      ...current,
      [selected]: { ...current[selected], [key]: value },
    }));
  };

  const changeClaudeCodeAutoCompactDisabled = (disabled: boolean) => {
    if (selected !== 'claude-code') return;
    claudeModelMappingsDirtyRef.current[selected] = true;
    setClaudeModelMappingsDraftByClient((current) => ({
      ...current,
      [selected]: {
        ...current[selected],
        disableAutoCompact: disabled,
      },
    }));
  };

  const changeClaudeCustomMapping = (enabled: boolean) => {
    if (!isClaudeModelMappingClient) return;
    setClaudeCustomMappingByClient((current) => ({ ...current, [selected]: enabled }));
    setModelSelectionError('');
    setClaudeModelMappingsDraftByClient((current) => {
      const currentClientDraft = current[selected];
      const next: ClaudeModelMappings = {
        opus: resolveAgentModelForAliasMode(models, currentClientDraft.opus, enabled),
        sonnet: resolveAgentModelForAliasMode(models, currentClientDraft.sonnet, enabled),
        haiku: resolveAgentModelForAliasMode(models, currentClientDraft.haiku, enabled),
        opus1m: currentClientDraft.opus1m,
        sonnet1m: currentClientDraft.sonnet1m,
        haiku1m: currentClientDraft.haiku1m,
        maxContextTokens: currentClientDraft.maxContextTokens,
        autoCompactPct: currentClientDraft.autoCompactPct,
        disableAutoCompact: currentClientDraft.disableAutoCompact,
      };
      if (!sameAgentModelMappings(currentClientDraft, next)) {
        claudeModelMappingsDirtyRef.current[selected] = true;
      }
      return { ...current, [selected]: next };
    });
  };

  const requireSelectedModel = () => {
    if (modelLoading) {
      setModelSelectionError(t('agents.error.modelsLoading'));
      return null;
    }
    if (models.length === 0) {
      setModelSelectionError(modelError || t('agents.error.noModels'));
      return null;
    }
    const model = findAgentModel(models, selectedModel);
    if (!model) {
      setModelSelectionError(t('agents.error.selectionGone'));
      return null;
    }
    setModelSelectionError('');
    return model.name;
  };

  const requireClaudeModelMappings = (): ClaudeModelMappings | null => {
    if (!isClaudeModelMappingClient) return null;
    const resolved = {} as ClaudeModelMappings;
    for (const role of claudeMappingRoles) {
      const model = findAgentModel(models, claudeModelMappingsDraft[role.key]);
      if (!model) {
        setModelSelectionError(t('agents.error.mappingSelectionGone'));
        return null;
      }
      resolved[role.key] = model.name;
      resolved[role.contextKey] = claudeModelMappingsDraft[role.contextKey];
    }
    if (selected === 'claude-code') {
      if (!claudeCodeRuntimeSettingsReady) {
        setModelSelectionError(t('agents.error.claudeCodeRuntimeSettingsInvalid'));
        return null;
      }
    }
    resolved.maxContextTokens = claudeModelMappingsDraft.maxContextTokens;
    resolved.autoCompactPct = claudeModelMappingsDraft.autoCompactPct;
    resolved.disableAutoCompact = claudeModelMappingsDraft.disableAutoCompact;
    return resolved;
  };

  const handleOAuthLoginError = (requestError: unknown, action: OAuthLoginRequiredAction) => {
    const message = String(requestError);
    if (message.includes(CODEX_OAUTH_LOGIN_REQUIRED_ERROR)) {
      setOauthLoginRequiredAction(action);
      return true;
    }
    return false;
  };

  const changeOauthConfiguration = async (enabled: boolean) => {
    if (!enabled) {
      setOauthConfigurationDraft(false);
      return;
    }

    setBusyAction('oauth-check');
    try {
      await invoke('check_codex_oauth_login');
      setOauthConfigurationDraft(true);
    } catch (requestError) {
      if (!handleOAuthLoginError(requestError, 'enable')) {
        setConfigurationError(String(requestError));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const applyConfigurationChanges = async () => {
    setConfigurationError('');
    const claudeModelMappings = requireClaudeModelMappings();
    if (isClaudeModelMappingClient && !claudeModelMappings) return;
    const model = isClaudeModelMappingClient
      ? claudeModelMappings?.sonnet ?? null
      : requireSelectedModel();
    if (!model) return;
    setBusyAction('apply');
    try {
      await invoke<AgentConfigActionResult>('apply_agent_config', {
        client: selected,
        model,
        oauthConfiguration,
        claudeCodeModelMappings: selected === 'claude-code' ? claudeModelMappings : null,
        claudeDesktopModelMappings: selected === 'claude-desktop' ? claudeModelMappings : null,
      });
      if (isClaudeModelMappingClient) {
        claudeModelMappingsDirtyRef.current[selected] = false;
      }
      await reloadStatusesAfterAction();
      setOauthConfigurationDraft(null);
      onConfigurationApplied?.();
    } catch (requestError) {
      if (!handleOAuthLoginError(requestError, 'apply')) {
        setConfigurationError(String(requestError));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const installPiProvider = async () => {
    const model = requireSelectedModel();
    if (!model) return;
    setBusyAction('install-pi');
    setConfigurationError('');
    try {
      await invoke<AgentConfigActionResult>('install_pi_provider', { model });
      await reloadStatusesAfterAction();
      onConfigurationApplied?.();
    } catch (requestError) {
      setConfigurationError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const updatePiProvider = async () => {
    const model = requireSelectedModel();
    if (!model) return;
    setBusyAction('update-pi');
    setConfigurationError('');
    setPiProviderUpdateStatus(null);
    try {
      await invoke<AgentConfigActionResult>('update_pi_provider', { model });
      await reloadStatusesAfterAction();
      await loadPiProviderUpdateStatus();
    } catch (requestError) {
      setConfigurationError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const repairPiProvider = async () => {
    const model = requireSelectedModel();
    if (!model) return;
    setBusyAction('repair-pi');
    setConfigurationError('');
    try {
      await invoke<AgentConfigActionResult>('repair_pi_provider', { model });
      await reloadStatusesAfterAction();
      onConfigurationApplied?.();
    } catch (requestError) {
      setConfigurationError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const uninstallPiProvider = async () => {
    setBusyAction('uninstall-pi');
    setConfigurationError('');
    setPiProviderUpdateStatus(null);
    try {
      await invoke<AgentConfigActionResult>('uninstall_pi_provider');
      await reloadStatusesAfterAction();
    } catch (requestError) {
      setConfigurationError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const closeConfigurationChanges = async () => {
    const retainedOauthConfiguration = selected === 'codex' ? oauthConfiguration : null;
    setConfigurationError('');
    setBusyAction('close-config');
    try {
      await invoke<AgentConfigActionResult>('close_agent_config_modification', { client: selected });
      if (isClaudeModelMappingClient) {
        claudeModelMappingsDirtyRef.current[selected] = false;
      }
      await reloadStatusesAfterAction();
      setOauthConfigurationDraft(retainedOauthConfiguration);
    } catch (requestError) {
      setConfigurationError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const resetConfigurationToDefault = async () => {
    const claudeModelMappings = requireClaudeModelMappings();
    if (isClaudeModelMappingClient && !claudeModelMappings) return;
    const model = isClaudeModelMappingClient
      ? claudeModelMappings?.sonnet ?? null
      : requireSelectedModel();
    if (!model) return;
    setBusyAction('default');
    setDefaultError('');
    try {
      await invoke<AgentConfigActionResult>('reset_agent_config_to_default', {
        client: selected,
        model,
        oauthConfiguration,
        claudeCodeModelMappings: selected === 'claude-code' ? claudeModelMappings : null,
        claudeDesktopModelMappings: selected === 'claude-desktop' ? claudeModelMappings : null,
      });
      setDefaultConfirmOpen(false);
      if (isClaudeModelMappingClient) {
        claudeModelMappingsDirtyRef.current[selected] = false;
      }
      await reloadStatusesAfterAction();
      setOauthConfigurationDraft(null);
    } catch (requestError) {
      if (!handleOAuthLoginError(requestError, 'apply')) {
        setDefaultError(String(requestError));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const clearCodexConfiguration = async () => {
    setBusyAction('clear');
    setClearError('');
    setClearNotice('');
    try {
      await invoke<string[]>('clear_codex_config');
      setClearConfirmOpen(false);
      setClearNotice(t('agents.clear.success'));
      await reloadStatusesAfterAction();
      setOauthConfigurationDraft(null);
    } catch (requestError) {
      setClearError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const openLaunchDirectoryDialog = (target: AgentLaunchTarget) => {
    setLaunchDirectory(activeLaunchDirectoryHistory[0] ?? '');
    setLaunchDirectoryTarget(target);
    setLaunchDirectoryError('');
    setLaunchDirectoryDialogOpen(true);
  };

  const chooseLaunchDirectory = async () => {
    setBusyAction('directory');
    setLaunchDirectoryError('');
    try {
      const selectedDirectory = await open({
        directory: true,
        multiple: false,
        defaultPath: launchDirectory || undefined,
        title: t('agents.launchDirectory.dialogTitle', { client: activeDefinition.name }),
      });
      if (typeof selectedDirectory === 'string') setLaunchDirectory(selectedDirectory);
    } catch (requestError) {
      setLaunchDirectoryError(String(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const rememberLaunchDirectory = (client: AgentClientId, directory: string) => {
    setLaunchDirectoryHistory((current) => {
      const next = rememberAgentLaunchDirectory(current, client, directory);
      writeAgentLaunchDirectoryHistory(next);
      return next;
    });
  };

  const invokeAgentLaunch = async (
    target: AgentLaunchTarget,
    workingDirectory: string | null = null,
  ) => {
    const action = hasIndependentCliAndApp
      ? target.id === 'cli' ? 'launch-cli' : 'launch-app'
      : 'launch';
    setBusyAction(action);
    setLaunchError('');
    try {
      await invoke('launch_agent', {
        client: selected,
        target: target.id,
        workingDirectory,
      });
      if (workingDirectory) {
        rememberLaunchDirectory(selected, workingDirectory);
        setLaunchDirectoryDialogOpen(false);
        setLaunchDirectoryTarget(null);
      }
    } catch (requestError) {
      if (workingDirectory) {
        setLaunchDirectoryError(String(requestError));
      } else if (!handleOAuthLoginError(requestError, 'launch')) {
        setLaunchError(String(requestError));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const launchAgent = async (target: AgentLaunchTarget | null) => {
    if (!target) return;
    if (target.id === 'cli') {
      openLaunchDirectoryDialog(target);
      return;
    }
    await invokeAgentLaunch(target);
  };

  const restartDesktopApp = async () => {
    if (!hasIndependentCliAndApp) return;
    setBusyAction('restart-app');
    setLaunchError('');
    try {
      await invoke(selected === 'codex' ? 'restart_codex_app' : 'restart_opencode_app');
    } catch (requestError) {
      if (!handleOAuthLoginError(requestError, 'launch')) {
        setLaunchError(String(requestError));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const launchFromDirectoryDialog = async () => {
    if (!launchDirectoryTarget) return;
    const workingDirectory = launchDirectory.trim();
    if (!workingDirectory) {
      setLaunchDirectoryError(t('agents.launchDirectory.directoryRequired'));
      return;
    }
    setLaunchDirectoryError('');
    await invokeAgentLaunch(launchDirectoryTarget, workingDirectory);
  };

  const openDefaultConfirmation = () => {
    setDefaultError('');
    setDefaultConfirmOpen(true);
  };

  const closeDefaultConfirmation = () => {
    setDefaultError('');
    setDefaultConfirmOpen(false);
  };

  const openClearConfirmation = () => {
    setClearError('');
    setClearConfirmOpen(true);
  };

  const closeClearConfirmation = () => {
    setClearError('');
    setClearConfirmOpen(false);
  };

  const availableSubpages = agentSubpages.filter(
    (subpage) => !subpage.clients || subpage.clients.includes(selected),
  );
  const oauthLoginRequiredDescription = oauthLoginRequiredAction === 'enable' ? (
    <>
      {t('agents.oauthLoginRequired.enableDescription')}
      <strong>{t('agents.oauthLoginRequired.enableClearConfiguration')}</strong>
      {t('agents.oauthLoginRequired.enableDescriptionSuffix')}
    </>
  ) : oauthLoginRequiredAction ? t(`agents.oauthLoginRequired.${oauthLoginRequiredAction}Description`) : '';

  return (
    <section className={`page management-page agents-page${embedded ? ' agents-page-embedded' : ''}`}>
      <header className="management-header">
        <div className={embedded ? 'agent-embedded-header-copy' : undefined}>
          {embedded ? (
            <>
              <h1>{t('agents.embedded.title')}</h1>
              <p>{t('agents.embedded.subtitle')}</p>
            </>
          ) : (
            <>
              <span>Agent Clients</span>
              <h1>{t('agents.title')}</h1>
            </>
          )}
        </div>
        <div className="agent-header-actions">
          {detectionError ? (
            <span className="agent-inline-message error" role="alert" aria-live="polite">
              {detectionError}
            </span>
          ) : null}
          <button type="button" className="secondary-button compact-button" onClick={() => void refresh()} disabled={loading || busy}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            {t('agents.redetect')}
          </button>
        </div>
      </header>

      <div className="agent-workbench">
        <aside className="panel agent-client-list">
          <div className="agent-list-heading">
            <Bot size={18} />
            <div><strong>{t('agents.localClients')}</strong><span>{t('agents.selectClient')}</span></div>
          </div>
          <div className="agent-list-items">
            {agentDefinitions.map((agent) => {
              const status = statuses.find((item) => item.id === agent.id);
              return (
                <button
                  type="button"
                  className={selected === agent.id ? 'active' : ''}
                  key={agent.id}
                  onClick={() => {
                    setActiveSubpage(DEFAULT_AGENT_SUBPAGE);
                    setSelected(agent.id);
                  }}
                  disabled={busy}
                >
                  <span className="agent-client-icon"><AgentMark definition={agent} /></span>
                  <span><strong>{agent.name}</strong><small>{listStatusText(status)}</small></span>
                  <i
                    className={status?.id === 'pi'
                      ? status?.installed ? 'installed' : ''
                      : status?.modificationEnabled ? 'configured' : status?.installed ? 'installed' : ''}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </aside>

        <section className="panel agent-config-panel">
          {embedded ? (
            <div className="agent-minimal-config">
              <div className="agent-minimal-client-summary">
                <span className="agent-minimal-client-icon"><AgentMark definition={activeDefinition} size={24} /></span>
                <div>
                  <strong>{activeDefinition.name}</strong>
                  <span>{activeStatus?.installed ? t('agents.clientDetected') : t('agents.clientNotDetected')}</span>
                </div>
                <span className="agent-minimal-version" title={activeStatus?.version ?? undefined}>
                  {activeStatus?.version ?? activeStatus?.appVersion ?? activeStatus?.cliVersion ?? t('agents.notFetched')}
                </span>
              </div>

              {activeStatus?.error || activeStatus?.warnings.length ? (
                <div className="agent-minimal-message" aria-live="polite">
                  {activeStatus.error ? (
                    <span className="agent-inline-message error" role="alert">{activeStatus.error}</span>
                  ) : (
                    <span className="agent-inline-message warning">{activeStatus.warnings.join('；')}</span>
                  )}
                </div>
              ) : null}

              <div className="agent-minimal-field">
                <label htmlFor="embedded-agent-model">{t('agents.useModel')}</label>
                <AgentModelPicker
                  models={isClaudeModelMappingClient ? claudeMappingModels : models}
                  value={isClaudeModelMappingClient ? claudeModelMappingsDraft.sonnet : selectedModel}
                  loading={modelLoading}
                  error={modelError}
                  disabled={busy || !activeStatus?.installed || !activeStatus.supportedPlatform}
                  onChange={selectEmbeddedModel}
                  onRefresh={refreshModels}
                />
              </div>

              <div className="agent-minimal-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={runEmbeddedPrimaryAction}
                  disabled={busy || (isPiClient ? !canEnable : configurationAction !== 'close' && !canEnable)}
                >
                  {busyAction ? <LoaderCircle size={16} className="spin" /> : null}
                  {isPiClient
                    ? activeStatus?.pluginInstalled ? t('agents.pi.repair') : t('agents.pi.install')
                    : configurationAction === 'update'
                      ? t('agents.modify.update')
                      : configurationAction === 'close'
                        ? t('agents.modify.close')
                        : t('agents.modify.apply')}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void launchAgent(defaultLaunchTarget)}
                  disabled={busy || !canLaunchTarget(defaultLaunchTarget)}
                  title={defaultLaunchTarget?.detail ?? t('agents.launch.unavailable')}
                >
                  {busyAction === 'launch' || busyAction === 'launch-cli'
                    ? <LoaderCircle size={16} className="spin" />
                    : <Play size={16} />}
                  {busyAction === 'launch' || busyAction === 'launch-cli'
                    ? t('agents.launch.starting')
                    : t('agents.launch.start', { target: defaultLaunchTarget?.label ?? activeDefinition.name })}
                </button>
              </div>

              {configurationError || modelSelectionError || launchError ? (
                <div className="agent-minimal-message" aria-live="polite">
                  {configurationError || modelSelectionError || launchError}
                </div>
              ) : null}
            </div>
          ) : (
          <>
          <div className="agent-subpage-tabs" role="tablist" aria-label={t('agents.tabs.label')}>
            {availableSubpages.map((subpage) => (
              <button
                type="button"
                id={`agent-subpage-tab-${subpage.id}`}
                role="tab"
                className={activeSubpage === subpage.id ? 'active' : ''}
                aria-selected={activeSubpage === subpage.id}
                aria-controls={`agent-subpage-panel-${subpage.id}`}
                tabIndex={activeSubpage === subpage.id ? 0 : -1}
                key={subpage.id}
                onClick={() => setActiveSubpage(subpage.id)}
              >
                {t(subpage.labelKey)}
              </button>
            ))}
          </div>

          {activeSubpage === 'core' ? (
            <div
              className="agent-core-config"
              id="agent-subpage-panel-core"
              role="tabpanel"
              aria-labelledby="agent-subpage-tab-core"
            >
              <div className={`agent-status-grid ${hasIndependentCliAndApp ? 'dual-install-status-grid' : isPiClient ? 'pi-status-grid' : ''}`}>
                <div>
                  <span><BadgeCheck size={14} />{t('agents.installStatus')}</span>
                  <strong>{activeStatus?.installed ? t('agents.clientDetected') : t('agents.clientNotDetected')}</strong>
                </div>
                {hasIndependentCliAndApp ? (
                  <>
                    <div>
                      <span>{t('agents.cliVersion')}</span>
                      <strong title={activeStatus?.cliVersion ?? undefined}>{activeStatus?.cliVersion ?? t('agents.notFetched')}</strong>
                    </div>
                    <div>
                      <span>{t('agents.appVersion')}</span>
                      <strong title={activeStatus?.appVersion ?? undefined}>{activeStatus?.appVersion ?? t('agents.notFetched')}</strong>
                    </div>
                  </>
                ) : isPiClient ? (
                  <>
                    <div>
                      <span>{t('agents.clientVersion')}</span>
                      <strong title={activeStatus?.version ?? undefined}>{activeStatus?.version ?? t('agents.notFetched')}</strong>
                    </div>
                    <div>
                      <span>
                        {t('agents.pluginVersion')}
                        {piPluginUpdateAvailable ? (
                          <span
                            className="agent-version-update-dot"
                            role="status"
                            aria-label={piPluginUpdateTitle}
                            title={piPluginUpdateTitle}
                          />
                        ) : null}
                      </span>
                      <strong title={piPluginUpdateTitle}>{activeStatus?.pluginVersion ?? t('agents.notFetched')}</strong>
                    </div>
                  </>
                ) : (
                  <div>
                    <span>{t('agents.clientVersion')}</span>
                    <strong title={activeStatus?.version ?? undefined}>{activeStatus?.version ?? t('agents.notFetched')}</strong>
                  </div>
                )}
              </div>

              {activeStatus?.error || activeStatus?.warnings.length ? (
                <div className="agent-status-messages" aria-live="polite">
                  {activeStatus.error ? (
                    <span className="agent-inline-message error" role="alert">{activeStatus.error}</span>
                  ) : (
                    <span className="agent-inline-message warning">{activeStatus.warnings.join('；')}</span>
                  )}
                </div>
              ) : null}

              {!isClaudeModelMappingClient ? (
                <section className="agent-core-setting-section agent-model-section">
                  <div className="agent-section-heading">
                    <div><strong>{t('agents.useModel')}</strong></div>
                  </div>
                  <AgentModelPicker
                    models={models}
                    value={selectedModel}
                    loading={modelLoading}
                    error={modelError}
                    disabled={busy || !activeStatus?.installed || !activeStatus.supportedPlatform}
                    onChange={selectModel}
                    onRefresh={refreshModels}
                  />
                  {modelHint ? (
                    <span
                      className={`agent-model-hint ${modelSelectionError || modelError ? 'error' : ''}`}
                      role={modelSelectionError || modelError ? 'alert' : undefined}
                      aria-live="polite"
                    >
                      {modelHint}
                    </span>
                  ) : null}
                </section>
              ) : null}

              {isClaudeModelMappingClient ? (
                <section className="agent-core-setting-section agent-claude-desktop-mapping">
                  <div className="agent-section-heading">
                    <div>
                      <strong>{t(selected === 'claude-code'
                        ? 'agents.claudeCodeMapping.title'
                        : 'agents.claudeDesktopMapping.title')}</strong>
                      <span>{t(selected === 'claude-code'
                        ? 'agents.claudeCodeMapping.description'
                        : 'agents.claudeDesktopMapping.description')}</span>
                    </div>
                    <div className="agent-section-heading-actions">
                      <label
                        className="agent-claude-desktop-mapping-filter"
                        title={t('agents.claudeDesktopMapping.customMappingHint')}
                      >
                        <span>{t('agents.claudeDesktopMapping.customMapping')}</span>
                        <span className="switch-control">
                          <input
                            type="checkbox"
                            checked={claudeCustomMapping}
                            onChange={(event) => changeClaudeCustomMapping(event.currentTarget.checked)}
                            disabled={busy || modelLoading}
                          />
                          <span className="switch-track" />
                        </span>
                      </label>
                    </div>
                  </div>
                  {selected === 'claude-code' ? (
                    <div className="agent-claude-code-runtime-settings">
                      <div className="agent-claude-code-number-field">
                        <span>{t('agents.claudeCodeRuntime.maxContextTokens')}</span>
                        <input
                          type="number"
                          min={100_000}
                          max={1_000_000}
                          step={1_000}
                          value={claudeModelMappingsDraft.maxContextTokens}
                          onChange={(event) => changeClaudeCodeRuntimeSetting(
                            'maxContextTokens',
                            Math.trunc(event.currentTarget.valueAsNumber || 0),
                          )}
                          disabled={busy || modelLoading}
                          aria-label={t('agents.claudeCodeRuntime.maxContextTokens')}
                          aria-describedby="claude-code-max-context-hint"
                        />
                        <small id="claude-code-max-context-hint">
                          {t('agents.claudeCodeRuntime.maxContextTokensHint')}
                        </small>
                      </div>
                      <label className="agent-claude-code-number-field">
                        <span>{t('agents.claudeCodeRuntime.autoCompactPct')}</span>
                        <div className="agent-claude-code-percent-input">
                          <input
                            type="number"
                            min={1}
                            max={100}
                            step={1}
                            value={claudeModelMappingsDraft.autoCompactPct}
                            onChange={(event) => changeClaudeCodeRuntimeSetting(
                              'autoCompactPct',
                              Math.trunc(event.currentTarget.valueAsNumber || 0),
                            )}
                            disabled={busy || modelLoading || claudeModelMappingsDraft.disableAutoCompact}
                            aria-describedby="claude-code-auto-compact-hint"
                          />
                          <span>%</span>
                        </div>
                        <small id="claude-code-auto-compact-hint">
                          {t('agents.claudeCodeRuntime.autoCompactPctHint')}
                        </small>
                      </label>
                      <label
                        className="agent-claude-code-disable-compact"
                        title={t('agents.claudeCodeRuntime.disableAutoCompactHint')}
                      >
                        <span>
                          <strong>{t('agents.claudeCodeRuntime.disableAutoCompact')}</strong>
                          <small>{t('agents.claudeCodeRuntime.disableAutoCompactHint')}</small>
                        </span>
                        <span className="switch-control">
                          <input
                            type="checkbox"
                            checked={claudeModelMappingsDraft.disableAutoCompact}
                            onChange={(event) => changeClaudeCodeAutoCompactDisabled(
                              event.currentTarget.checked,
                            )}
                            disabled={busy || modelLoading}
                          />
                          <span className="switch-track" />
                        </span>
                      </label>
                    </div>
                  ) : null}
                  <div className="agent-claude-desktop-mapping-grid">
                    {claudeMappingRoles.map((role) => (
                      <div className="agent-claude-desktop-mapping-row" key={role.key}>
                        <div className="agent-claude-mapping-card-heading">
                          <strong>{t(role.labelKey)}</strong>
                          <label
                            className="agent-claude-context-toggle"
                            title={t(selected === 'claude-code'
                              ? 'agents.claudeCodeRuntime.context1mHint'
                              : 'agents.claudeMapping.context1mHint')}
                          >
                            <span>{t('agents.claudeMapping.context1m')}</span>
                            <span className="switch-control">
                              <input
                                type="checkbox"
                                checked={claudeModelMappingsDraft[role.contextKey]}
                                onChange={(event) => changeClaude1mPreference(
                                  role.contextKey,
                                  event.currentTarget.checked,
                                )}
                                disabled={busy || modelLoading}
                              />
                              <span className="switch-track" />
                            </span>
                          </label>
                        </div>
                        <AgentModelPicker
                          models={claudeMappingModels}
                          value={claudeModelMappingsDraft[role.key]}
                          loading={modelLoading}
                          error={modelError}
                          disabled={busy || !activeStatus?.installed || !activeStatus.supportedPlatform}
                          onChange={(value) => selectClaudeModelMapping(role.key, value)}
                          onRefresh={refreshModels}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {isPiClient ? (
                <section className="agent-core-setting-section agent-modification-actions">
                  <div className="agent-section-heading">
                    <div>
                      <strong>{t('agents.pi.installTitle')}</strong>
                      <span>{t('agents.pi.installDescription')}</span>
                    </div>
                  </div>
                  <div className="agent-modification-control">
                    <div className="agent-modification-buttons">
                      <button
                        type="button"
                        className={activeStatus?.pluginInstalled ? 'danger-button' : 'primary-button'}
                        onClick={() => void (activeStatus?.pluginInstalled ? uninstallPiProvider() : installPiProvider())}
                        disabled={busy || !activeStatus?.installed || !activeStatus.supportedPlatform || (!activeStatus.pluginInstalled && !selectedModelOption)}
                      >
                        {busyAction === 'install-pi' || busyAction === 'uninstall-pi'
                          ? <LoaderCircle size={16} className="spin" />
                          : null}
                        {activeStatus?.pluginInstalled
                          ? busyAction === 'uninstall-pi' ? t('agents.pi.uninstalling') : t('agents.pi.uninstall')
                          : busyAction === 'install-pi' ? t('agents.pi.installing') : t('agents.pi.install')}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void repairPiProvider()}
                        disabled={busy || !activeStatus?.installed || !activeStatus.supportedPlatform || !activeStatus.pluginInstalled || !selectedModelOption}
                      >
                        {busyAction === 'repair-pi' ? <LoaderCircle size={16} className="spin" /> : <Wrench size={16} />}
                        {busyAction === 'repair-pi' ? t('agents.pi.repairing') : t('agents.pi.repair')}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void updatePiProvider()}
                        disabled={busy || !activeStatus?.installed || !activeStatus.supportedPlatform || !activeStatus.pluginInstalled || !selectedModelOption}
                      >
                        {busyAction === 'update-pi' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
                        {busyAction === 'update-pi' ? t('agents.pi.updating') : t('agents.pi.update')}
                      </button>
                    </div>
                    {configurationError ? (
                      <span className="agent-inline-message error" role="alert" aria-live="polite">
                        {configurationError}
                      </span>
                    ) : null}
                  </div>
                </section>
              ) : (
              <section className={`agent-core-setting-section agent-modification-actions ${activeStatus?.modificationState === 'applied' ? 'enabled' : ''}`}>
                <div className="agent-section-heading">
                  <div>
                    <strong>{t('agents.modify.title')}</strong>
                    {modificationDescription ? <span>{modificationDescription}</span> : null}
                  </div>
                </div>
                <div className="agent-modification-control">
                  {selected === 'codex' ? (
                    <div className="agent-codex-options">
                      <label
                        className="agent-oauth-configuration"
                        title={t('agents.modify.oauthConfiguration')}
                      >
                        <span>{t('agents.modify.oauthConfiguration')}</span>
                        <span className="switch-control">
                          <input
                            type="checkbox"
                            role="switch"
                            checked={oauthConfiguration}
                            onChange={(event) => void changeOauthConfiguration(event.currentTarget.checked)}
                            disabled={busy}
                            aria-label={t('agents.modify.oauthConfiguration')}
                          />
                          <span className="switch-track" />
                        </span>
                      </label>
                      <button
                        type="button"
                        className="secondary-button agent-codex-catalog-button"
                        onClick={() => setCodexCatalogDialogOpen(true)}
                        disabled={busy}
                      >
                        <SlidersHorizontal size={16} />
                        {t('agents.catalog.button')}
                      </button>
                    </div>
                  ) : null}
                  <div className={`agent-modification-buttons ${selected === 'codex' ? 'codex' : ''}`}>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => void (configurationAction === 'close'
                        ? closeConfigurationChanges()
                        : applyConfigurationChanges())}
                      disabled={
                        busy
                        || (configurationAction === 'close' ? false : !canEnable)
                      }
                    >
                      {busyAction === 'apply' || busyAction === 'close-config'
                        ? <LoaderCircle size={16} className="spin" />
                        : null}
                      {configurationAction === 'update'
                        ? t('agents.modify.update')
                        : configurationAction === 'close'
                          ? t('agents.modify.close')
                          : t('agents.modify.apply')}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={openDefaultConfirmation}
                      disabled={busy || !canEnable}
                    >
                      {busyAction === 'default'
                        ? <LoaderCircle size={16} className="spin" />
                        : <RefreshCw size={16} />}
                      {t('agents.modify.default')}
                    </button>
                    {selected === 'codex' ? (
                      <button
                        type="button"
                        className="danger-button"
                        onClick={openClearConfirmation}
                        disabled={busy}
                      >
                        {busyAction === 'clear' ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}
                        {t('agents.modify.clear')}
                      </button>
                    ) : null}
                  </div>
                  {configurationError ? (
                    <span className="agent-inline-message error" role="alert" aria-live="polite">
                      {configurationError}
                    </span>
                  ) : null}
                  {clearNotice ? (
                    <span className="agent-inline-message" role="status" aria-live="polite">
                      {clearNotice}
                    </span>
                  ) : null}
                </div>
              </section>
              )}

              <div className="agent-config-footer">
                <div className="agent-launch-control">
                  <div className="agent-launch-actions">
                    {hasIndependentCliAndApp ? (
                      <>
                        <button
                          type="button"
                          className="secondary-button agent-launch-button"
                          onClick={() => void launchAgent(cliLaunchTarget)}
                          disabled={busy || !canLaunchTarget(cliLaunchTarget)}
                          title={cliLaunchTarget?.detail ?? t('agents.launch.unavailable')}
                        >
                          {busyAction === 'launch-cli'
                            ? <LoaderCircle size={16} className="spin" />
                            : <Terminal size={16} />}
                          {busyAction === 'launch-cli'
                            ? t('agents.launch.starting')
                            : t('agents.launch.startCli')}
                        </button>
                        <button
                          type="button"
                          className="primary-button agent-launch-button"
                          onClick={() => void launchAgent(appLaunchTarget)}
                          disabled={busy || !canLaunchTarget(appLaunchTarget)}
                          title={appLaunchTarget?.detail ?? t('agents.launch.unavailable')}
                        >
                          {busyAction === 'launch-app'
                            ? <LoaderCircle size={16} className="spin" />
                            : <AppWindow size={16} />}
                          {busyAction === 'launch-app'
                            ? t('agents.launch.starting')
                            : t('agents.launch.startApp')}
                        </button>
                        <button
                          type="button"
                          className="secondary-button agent-launch-button"
                          onClick={() => void restartDesktopApp()}
                          disabled={busy || !canLaunchTarget(appLaunchTarget)}
                          title={appLaunchTarget?.detail ?? t('agents.launch.unavailable')}
                        >
                          {busyAction === 'restart-app'
                            ? <LoaderCircle size={16} className="spin" />
                            : <RefreshCw size={16} />}
                          {busyAction === 'restart-app'
                            ? t('agents.launch.restartingApp')
                            : t('agents.launch.restartApp')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="primary-button agent-launch-button"
                        onClick={() => void launchAgent(defaultLaunchTarget)}
                        disabled={busy || !canLaunchTarget(defaultLaunchTarget)}
                        title={defaultLaunchTarget?.detail ?? t('agents.launch.unavailable')}
                      >
                        {busyAction === 'launch'
                          ? <LoaderCircle size={16} className="spin" />
                          : defaultLaunchTarget?.id === 'cli'
                            ? <Terminal size={16} />
                            : <Play size={16} />}
                        {busyAction === 'launch'
                          ? t('agents.launch.starting')
                          : defaultLaunchTarget
                            ? t('agents.launch.start', { target: defaultLaunchTarget.label })
                            : t('agents.launch.unavailable')}
                      </button>
                    )}
                  </div>
                  {launchError ? (
                    <span className="agent-inline-message error" role="alert" aria-live="polite">
                      {launchError}
                    </span>
                  ) : null}
                </div>
              </div>

            </div>
          ) : null}

          {selected === 'codex' && activeSubpage === 'sessions' ? (
            <div
              className="agent-sessions-page"
              id="agent-subpage-panel-sessions"
              role="tabpanel"
              aria-labelledby="agent-subpage-tab-sessions"
            >
              <CodexSessionsPanel />
            </div>
          ) : null}
          </>
          )}
        </section>
      </div>

      {codexCatalogDialogOpen ? (
        <CodexModelCatalogDialog
          onClose={() => setCodexCatalogDialogOpen(false)}
          onSaved={() => loadModels('codex', selectedModel)}
        />
      ) : null}

      {launchDirectoryDialogOpen ? (
        <div className="config-dialog-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target && !busy) {
            setLaunchDirectoryDialogOpen(false);
            setLaunchDirectoryTarget(null);
          }
        }}>
          <section
            className="config-dialog agent-launch-directory-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-launch-directory-title"
          >
            <div className="config-dialog-heading">
              <div>
                <h2 id="agent-launch-directory-title">
                  {t('agents.launchDirectory.dialogTitle', { client: activeDefinition.name })}
                </h2>
              </div>
            </div>
            <p>{t('agents.launchDirectory.dialogDescription', { client: activeDefinition.name })}</p>
            <div className="config-dialog-field">
              <span>{t('agents.launchDirectory.workingDirectory')}</span>
              <button
                type="button"
                className="agent-launch-directory-picker"
                onClick={() => void chooseLaunchDirectory()}
                disabled={busy}
                autoFocus
              >
                <span>
                  <small>{launchDirectory
                    ? t('agents.launchDirectory.selectedDirectory')
                    : t('agents.launchDirectory.noDirectory')}</small>
                  <strong title={launchDirectory || undefined}>
                    {launchDirectory || t('agents.launchDirectory.chooseDirectory')}
                  </strong>
                </span>
                <b>{busyAction === 'directory'
                  ? t('agents.launchDirectory.choosing')
                  : t('agents.launchDirectory.browse')}</b>
              </button>
            </div>
            {activeLaunchDirectoryHistory.length ? (
              <div className="agent-launch-directory-history">
                <strong>{t('agents.launchDirectory.historyTitle')}</strong>
                <div className="agent-launch-directory-history-list">
                  {activeLaunchDirectoryHistory.map((directory, index) => {
                    const active = directory === launchDirectory;
                    return (
                      <button
                        type="button"
                        className={active ? 'active' : ''}
                        key={directory}
                        onClick={() => {
                          setLaunchDirectory(directory);
                          setLaunchDirectoryError('');
                        }}
                        disabled={busy}
                        title={directory}
                      >
                        <span>
                          <strong>{directory}</strong>
                          <small>{index === 0
                            ? t('agents.launchDirectory.lastUsed')
                            : t('agents.launchDirectory.recentItem')}</small>
                        </span>
                        <b>
                          {active ? <Check size={15} aria-hidden /> : null}
                          {active
                            ? t('agents.launchDirectory.historySelected')
                            : t('agents.launchDirectory.historyUse')}
                        </b>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {launchDirectoryError ? (
              <span className="agent-inline-message error" role="alert" aria-live="polite">
                {launchDirectoryError}
              </span>
            ) : null}
            <div className="config-dialog-actions two-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setLaunchDirectoryDialogOpen(false);
                  setLaunchDirectoryTarget(null);
                }}
                disabled={busy}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void launchFromDirectoryDialog()}
                disabled={busy || !launchDirectory.trim() || !launchDirectoryTarget}
              >
                {busyAction === 'launch' || busyAction === 'launch-cli'
                  ? <LoaderCircle size={16} className="spin" />
                  : null}
                {t('agents.launchDirectory.launch', { client: activeDefinition.name })}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {defaultConfirmOpen ? (
        <div className="config-dialog-backdrop">
          <section className="config-dialog agent-restore-dialog" role="alertdialog" aria-modal="true" aria-labelledby="agent-default-title">
            <div className="config-dialog-heading">
              <div><AlertTriangle size={19} /><h2 id="agent-default-title">{t('agents.default.title')}</h2></div>
            </div>
            <p>
              {t('agents.default.description', { name: activeDefinition.name })}
            </p>
            {defaultError ? (
              <span className="agent-inline-message error" role="alert" aria-live="polite">
                {defaultError}
              </span>
            ) : null}
            <div className="config-dialog-actions two-actions">
              <button type="button" className="secondary-button" onClick={closeDefaultConfirmation} disabled={busy}>{t('common.cancel')}</button>
              <button type="button" className="danger-button" onClick={() => void resetConfigurationToDefault()} disabled={busy}>
                {busyAction === 'default' ? <LoaderCircle size={16} className="spin" /> : null}
                {t('agents.default.confirm')}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {clearConfirmOpen ? (
        <div className="config-dialog-backdrop">
          <section className="config-dialog agent-restore-dialog" role="alertdialog" aria-modal="true" aria-labelledby="agent-clear-title">
            <div className="config-dialog-heading">
              <div><AlertTriangle size={19} /><h2 id="agent-clear-title">{t('agents.clear.title')}</h2></div>
            </div>
            <p>{t('agents.clear.description')}</p>
            {clearError ? (
              <span className="agent-inline-message error" role="alert" aria-live="polite">
                {clearError}
              </span>
            ) : null}
            <div className="config-dialog-actions two-actions">
              <button type="button" className="secondary-button" onClick={closeClearConfirmation} disabled={busy}>{t('common.cancel')}</button>
              <button type="button" className="danger-button" onClick={() => void clearCodexConfiguration()} disabled={busy}>
                {busyAction === 'clear' ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}
                {t('agents.clear.confirm')}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {oauthLoginRequiredAction ? (
        <div className="config-dialog-backdrop">
          <section className="config-dialog agent-restore-dialog" role="alertdialog" aria-modal="true" aria-labelledby="agent-oauth-login-required-title">
            <div className="config-dialog-heading">
              <div><AlertTriangle size={19} /><h2 id="agent-oauth-login-required-title">{t('agents.oauthLoginRequired.title')}</h2></div>
            </div>
            <p>{oauthLoginRequiredDescription}</p>
            <div className="config-dialog-actions single-action">
              <button type="button" className="primary-button" onClick={() => setOauthLoginRequiredAction(null)}>{t('agents.oauthLoginRequired.confirm')}</button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
