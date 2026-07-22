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
import {
  AlertTriangle,
  BadgeCheck,
  Bot,
  Check,
  ChevronDown,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import claudeIcon from '../assets/icons/claude.svg';
import codexIcon from '../assets/icons/codex.svg';
import hermesIcon from '../assets/icons/hermes.png';
import openclawIcon from '../assets/icons/openclaw.svg';
import opencodeIcon from '../assets/icons/opencode.svg';
import {
  agentModelAlias,
  filterAgentModels,
  findAgentModel,
  resolveAgentModelSelection,
} from '../services/agentModelPicker';
import type { ModelOption } from '../services/modelService';
import { getCurrentLocale, translate, useI18n } from '../i18n';

type AgentClientId =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'opencode'
  | 'openclaw'
  | 'hermes';

type AgentModificationState = 'inactive' | 'active' | 'conflict' | 'recovery';

type AgentConfigStatus = {
  id: AgentClientId;
  name: string;
  supportedPlatform: boolean;
  installed: boolean;
  executablePath: string | null;
  launchTargets: AgentLaunchTarget[];
  version: string | null;
  configValid: boolean;
  configured: boolean;
  currentModel: string | null;
  modificationEnabled: boolean;
  modificationState: AgentModificationState;
  backupAvailable: boolean;
  appliedModel: string | null;
  warnings: string[];
  error: string | null;
};

type AgentLaunchTarget = {
  id: string;
  label: string;
  detail: string;
};

type AgentConfigActionResult = {
  outcome: 'enabled' | 'disabled' | 'updated' | 'restore-conflict';
  enabled: boolean;
  model: string | null;
  changedFiles: string[];
  conflictFiles: string[];
};

type AgentDefinition = {
  id: AgentClientId;
  name: string;
  icon?: string;
  Icon?: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  descriptionKey: 'agents.description.claudeCode' | 'agents.description.claudeDesktop' | 'agents.description.codex' | 'agents.description.opencode' | 'agents.description.openclaw' | 'agents.description.hermes';
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
    id: 'opencode',
    name: 'OpenCode',
    icon: opencodeIcon,
    descriptionKey: 'agents.description.opencode',
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

const AGENT_MODEL_SELECTIONS_KEY = 'cpa-gui.agent-model-selections.v1';
const AGENT_SELECTED_CLIENT_KEY = 'cpa-gui.agent-selected-client.v1';

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

const reconcileAgentModelSelections = (
  current: Partial<Record<AgentClientId, string>>,
  models: ModelOption[],
) => {
  return agentDefinitions.reduce<Partial<Record<AgentClientId, string>>>((result, agent) => {
    const existing = current[agent.id] ?? '';
    result[agent.id] = resolveAgentModelSelection(models, existing);
    return result;
  }, {});
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
  if (status.modificationState === 'conflict') return translate(locale, 'agents.list.conflict');
  if (status.modificationState === 'recovery') return translate(locale, 'agents.list.recovery');
  if (status.modificationEnabled) return translate(locale, 'agents.list.modified', { model: status.appliedModel ?? '—' });
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
  const selectedAlias = agentModelAlias(models, value);

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
          <strong title={value || undefined}>
            {value || (loading ? t('agents.model.loading') : error ? t('agents.model.loadFailed') : models.length ? t('agents.model.select') : t('agents.model.none'))}
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

export function AgentsPage() {
  const { t } = useI18n();
  const [selected, setSelected] = useState<AgentClientId>(readSelectedAgentClient);
  const [statuses, setStatuses] = useState<AgentConfigStatus[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelByClient, setModelByClient] = useState<Partial<Record<AgentClientId, string>>>(
    readAgentModelSelections,
  );
  const [launchTargetByClient, setLaunchTargetByClient] = useState<Partial<Record<AgentClientId, string>>>({});
  const [loading, setLoading] = useState(true);
  const [modelLoading, setModelLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modelError, setModelError] = useState('');
  const [notice, setNotice] = useState('');
  const [restoreConflict, setRestoreConflict] = useState<string[] | null>(null);

  const loadStatuses = useCallback(async (forceRefresh = false) => {
    const command = forceRefresh
      ? 'refresh_agent_config_statuses'
      : 'get_agent_config_statuses';
    const nextStatuses = await invoke<AgentConfigStatus[]>(command);
    setStatuses(nextStatuses);
  }, []);

  const loadModels = useCallback(async () => {
    setModelLoading(true);
    setModelError('');
    try {
      const nextModels = await invoke<ModelOption[]>('get_agent_models');
      setModels(nextModels);
      setModelByClient((current) => {
        const next = reconcileAgentModelSelections(current, nextModels);
        writeAgentModelSelections(next);
        return next;
      });
    } catch (requestError) {
      setModelError(String(requestError));
    } finally {
      setModelLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([loadStatuses(true), loadModels()]);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, [loadModels, loadStatuses]);

  useEffect(() => {
    setLoading(true);
    setError('');
    void Promise.all([loadStatuses(), loadModels()])
      .catch((requestError) => setError(String(requestError)))
      .finally(() => setLoading(false));
  }, [loadModels, loadStatuses]);

  useEffect(() => {
    writeSelectedAgentClient(selected);
  }, [selected]);

  useEffect(() => {
    setLaunchTargetByClient((current) => agentDefinitions.reduce<Partial<Record<AgentClientId, string>>>(
      (next, definition) => {
        const targets = statuses.find((status) => status.id === definition.id)?.launchTargets ?? [];
        const previous = current[definition.id] ?? '';
        next[definition.id] = targets.some((target) => target.id === previous)
          ? previous
          : targets[0]?.id ?? '';
        return next;
      },
      {},
    ));
  }, [statuses]);

  const activeDefinition = agentDefinitions.find((agent) => agent.id === selected)
    ?? agentDefinitions[0];
  const activeStatus = statuses.find((status) => status.id === selected) ?? null;
  const savedSelectedModel = modelByClient[selected] ?? '';
  const selectedModelOption = findAgentModel(models, savedSelectedModel);
  const selectedModel = selectedModelOption?.name ?? '';
  const activeLaunchTargets = activeStatus?.launchTargets ?? [];
  const selectedLaunchTargetId = launchTargetByClient[selected] ?? activeLaunchTargets[0]?.id ?? '';
  const selectedLaunchTarget = activeLaunchTargets.find(
    (target) => target.id === selectedLaunchTargetId,
  ) ?? activeLaunchTargets[0] ?? null;
  const appliedModel = activeStatus?.appliedModel ?? activeStatus?.currentModel ?? '';
  const draftChanged = Boolean(
    activeStatus?.modificationEnabled
      && selectedModel.trim()
      && selectedModel.trim() !== appliedModel.trim(),
  );
  const canEnable = Boolean(
    activeStatus?.supportedPlatform
      && activeStatus.installed
      && activeStatus.configValid
      && !modelLoading
      && selectedModelOption,
  );
  const canLaunch = Boolean(
    activeStatus?.supportedPlatform
      && activeStatus.installed
      && activeStatus.modificationEnabled
      && activeStatus.modificationState === 'active'
      && selectedLaunchTarget,
  );

  const refreshModels = () => {
    void loadModels();
  };

  const selectModel = (value: string) => {
    const model = findAgentModel(models, value);
    if (!model) return;
    setModelByClient((current) => {
      const next = { ...current, [selected]: model.name };
      writeAgentModelSelections(next);
      return next;
    });
  };

  const requireSelectedModel = () => {
    if (modelLoading) {
      setError(t('agents.error.modelsLoading'));
      return null;
    }
    if (models.length === 0) {
      setError(modelError || t('agents.error.noModels'));
      return null;
    }
    const model = findAgentModel(models, selectedModel);
    if (!model) {
      setError(t('agents.error.selectionGone'));
      return null;
    }
    return model.name;
  };

  const setModificationEnabled = async (enabled: boolean, forceRestore = false) => {
    const model = enabled ? requireSelectedModel() : selectedModel.trim();
    if (enabled && !model) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await invoke<AgentConfigActionResult>('set_agent_config_enabled', {
        client: selected,
        model: model ?? '',
        enabled,
        forceRestore,
      });
      if (result.outcome === 'restore-conflict') {
        setRestoreConflict(result.conflictFiles);
        return;
      }
      setRestoreConflict(null);
      setNotice(result.enabled
        ? t('agents.notice.enabled', { name: activeDefinition.name })
        : t('agents.notice.restored', { name: activeDefinition.name }));
      await loadStatuses(true);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const launchAgent = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let appliedBeforeLaunch = false;
      const shouldSyncModelCatalog = Boolean(
        activeStatus?.modificationEnabled && selectedModelOption,
      );
      if (draftChanged || shouldSyncModelCatalog) {
        if (activeStatus?.modificationState !== 'active') {
          throw new Error(t('agents.error.conflict'));
        }
        const model = requireSelectedModel();
        if (!model) return;
        await invoke<AgentConfigActionResult>('update_agent_config', {
          client: selected,
          model,
        });
        appliedBeforeLaunch = true;
      }
      await invoke('launch_agent', { client: selected, target: selectedLaunchTarget?.id });
      setNotice(appliedBeforeLaunch
        ? draftChanged
          ? t('agents.notice.appliedLaunch', { name: activeDefinition.name })
          : t('agents.notice.syncedLaunch', { name: activeDefinition.name })
        : activeStatus?.modificationEnabled
          ? t('agents.notice.managedLaunch', { name: activeDefinition.name })
          : t('agents.notice.launched', { name: activeDefinition.name }));
      if (appliedBeforeLaunch) await loadStatuses(true);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = loading
    ? t('agents.status.detecting')
    : !activeStatus?.supportedPlatform
      ? t('agents.status.unsupported')
      : !activeStatus.installed
        ? t('agents.status.notInstalled')
        : activeStatus.modificationState === 'conflict'
          ? t('agents.status.conflict')
          : activeStatus.modificationState === 'recovery'
            ? t('agents.status.recovery')
            : activeStatus.modificationEnabled
              ? t('agents.status.modified')
              : t('agents.status.original');
  const statusTone = activeStatus?.modificationState === 'conflict'
    || activeStatus?.modificationState === 'recovery'
    || !activeStatus?.supportedPlatform
    ? 'error'
    : activeStatus?.modificationEnabled
      ? 'success'
      : '';

  return (
    <section className="page management-page agents-page">
      <header className="management-header">
        <div>
          <span>Agent Clients</span>
          <h1>{t('agents.title')}</h1>
        </div>
        <button type="button" className="secondary-button compact-button" onClick={() => void refresh()} disabled={loading || busy}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          {t('agents.redetect')}
        </button>
      </header>

      <div className="agent-feedback-slot" aria-live="polite">
        {error ? <div className="management-alert error">{error}</div> : null}
        {!error && notice ? <div className="management-alert success">{notice}</div> : null}
      </div>

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
                  onClick={() => setSelected(agent.id)}
                  disabled={busy}
                >
                  <span className="agent-client-icon"><AgentMark definition={agent} /></span>
                  <span><strong>{agent.name}</strong><small>{listStatusText(status)}</small></span>
                  <i
                    className={status?.modificationEnabled ? 'configured' : status?.installed ? 'installed' : ''}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </aside>

        <section className="panel agent-config-panel">
          <div className="agent-config-heading">
            <div className="agent-config-title">
              <span className="agent-logo"><AgentMark definition={activeDefinition} size={24} /></span>
              <div><h2>{activeDefinition.name}</h2><span>{t(activeDefinition.descriptionKey)}</span></div>
            </div>
            <span className={`state-pill ${statusTone}`}>{statusLabel}</span>
          </div>

          <div className="agent-config-message-slot">
            {activeStatus?.error ? <div className="management-alert error">{activeStatus.error}</div> : null}
            {activeStatus?.warnings.length && !activeStatus.error ? (
              <div className="agent-warning-line">{activeStatus.warnings.join('；')}</div>
            ) : null}
          </div>

          <div className="agent-status-grid">
            <div>
              <span><BadgeCheck size={14} />{t('agents.installStatus')}</span>
              <strong>{activeStatus?.installed ? t('agents.clientDetected') : t('agents.clientNotDetected')}</strong>
            </div>
            <div>
              <span>{t('agents.clientVersion')}</span>
              <strong title={activeStatus?.version ?? undefined}>{activeStatus?.version ?? t('agents.notFetched')}</strong>
            </div>
          </div>

          <section className="agent-model-section">
            <div className="agent-section-heading">
              <div><strong>{t('agents.useModel')}</strong><span>{t('agents.useModelDescription')}</span></div>
              {draftChanged ? <span className="agent-pending-badge">{t('agents.pending')}</span> : null}
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
            <span className="agent-model-hint">
              {modelLoading
                ? t('agents.model.readingAvailable')
                : modelError && models.length === 0
                  ? modelError
                  : models.length === 0
                    ? t('agents.model.cannotConfigure')
                    : activeStatus?.modificationEnabled
                      ? t('agents.model.current', { model: appliedModel || '—' })
                      : t('agents.model.firstSelection', { count: models.length })}
            </span>
          </section>

          <section className={`agent-modification-switch ${activeStatus?.modificationEnabled ? 'enabled' : ''}`}>
            <div>
              <strong>{t('agents.modify.title')}</strong>
              <span>{activeStatus?.modificationEnabled
                ? activeStatus.modificationState === 'conflict'
                  ? t('agents.modify.conflict')
                  : activeStatus.modificationState === 'recovery'
                    ? t('agents.modify.recovery')
                    : t('agents.modify.managed')
                : t('agents.modify.disabled')}</span>
            </div>
            <label className="switch-control" title={t('agents.modify.title')}>
              <input
                type="checkbox"
                checked={Boolean(activeStatus?.modificationEnabled)}
                disabled={busy || (!activeStatus?.modificationEnabled && !canEnable)}
                onChange={(event) => void setModificationEnabled(event.currentTarget.checked)}
              />
              <span className="switch-track" />
            </label>
          </section>

          <div className="agent-config-footer">
            <div>
              {activeStatus?.modificationEnabled ? <Check size={16} /> : <Sparkles size={16} />}
              <span>{activeStatus?.modificationEnabled
                ? draftChanged
                  ? t('agents.footer.changed')
                  : t('agents.footer.restore')
                : !activeStatus?.supportedPlatform
                  ? t('agents.footer.unsupported')
                  : !activeStatus.installed
                    ? t('agents.footer.installFirst')
                    : activeStatus.launchTargets.length === 0
                      ? t('agents.footer.noCommand')
                      : !activeStatus.configValid
                        ? t('agents.footer.invalidConfig')
                        : t('agents.footer.enableFirst')}</span>
            </div>
            <div className="agent-launch-actions">
              {activeLaunchTargets.length > 1 ? (
                <div className="agent-launch-targets" aria-label={t('agents.launchMethods')}>
                  {activeLaunchTargets.map((target) => (
                    <button
                      type="button"
                      className={target.id === selectedLaunchTarget?.id ? 'active' : ''}
                      key={target.id}
                      onClick={() => setLaunchTargetByClient((current) => ({
                        ...current,
                        [selected]: target.id,
                      }))}
                      disabled={busy}
                      title={target.detail}
                    >
                      {target.label.replace('Codex ', '')}
                    </button>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                className="primary-button"
                onClick={() => void launchAgent()}
                disabled={
                  busy
                  || !canLaunch
                  || (draftChanged && activeStatus?.modificationState !== 'active')
                }
                title={activeStatus?.modificationEnabled
                  ? selectedLaunchTarget?.detail
                  : t('agents.launch.enableFirst')}
              >
                {busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}
                {busy ? t('agents.launch.starting') : selectedLaunchTarget ? t('agents.launch.start', { target: selectedLaunchTarget.label }) : t('agents.launch.unavailable')}
              </button>
            </div>
          </div>
        </section>
      </div>

      {restoreConflict ? (
        <div className="config-dialog-backdrop">
          <section className="config-dialog agent-restore-dialog" role="alertdialog" aria-modal="true" aria-labelledby="agent-restore-title">
            <div className="config-dialog-heading">
              <div><AlertTriangle size={19} /><h2 id="agent-restore-title">{t('agents.restore.title')}</h2></div>
            </div>
            <p>
              {t('agents.restore.description', { count: restoreConflict.length })}
            </p>
            <div className="config-dialog-actions two-actions">
              <button type="button" className="secondary-button" onClick={() => setRestoreConflict(null)} disabled={busy}>{t('common.cancel')}</button>
              <button type="button" className="danger-button" onClick={() => void setModificationEnabled(false, true)} disabled={busy}>
                {busy ? <LoaderCircle size={16} className="spin" /> : null}
                {t('agents.restore.confirm')}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
