import {
  useCallback,
  useEffect,
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
  description: string;
};

const agentDefinitions: AgentDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: claudeIcon,
    description: '使用 CPA 的 Anthropic 兼容接口',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    icon: claudeIcon,
    description: '使用 CPA 3P 推理网关，支持 Windows、macOS 和 Linux Beta',
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: codexIcon,
    description: '使用 CPA Responses 接口',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    icon: opencodeIcon,
    description: '使用 CPA OpenAI Compatible provider',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    icon: openclawIcon,
    description: '使用 CPA 模型供应商和默认模型',
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    icon: hermesIcon,
    description: '使用 CPA custom provider',
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
  if (!status) return '正在检测';
  if (!status.supportedPlatform) return '当前平台不支持';
  if (!status.installed) return '未检测到安装';
  if (status.modificationState === 'conflict') return '配置冲突 · 等待恢复';
  if (status.modificationState === 'recovery') return '操作未完成 · 可恢复';
  if (status.modificationEnabled) return `已修改 · ${status.appliedModel ?? '未记录模型'}`;
  return status.version ? `已安装 · ${status.version}` : '已安装 · 保持原配置';
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

function AgentModelPicker({
  models,
  value,
  loading,
  error,
  disabled,
  onChange,
  onRefresh,
}: AgentModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const visibleModels = useMemo(() => filterAgentModels(models, search), [models, search]);
  const choices = useMemo(
    () => visibleModels.map((model) => ({ name: model.name, alias: model.alias ?? '' })),
    [visibleModels],
  );
  const selectedAlias = agentModelAlias(models, value);

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
            {value || (loading ? '正在读取模型' : error ? '获取模型失败' : models.length ? '选择模型' : '无可选模型')}
          </strong>
          {selectedAlias ? <small title={selectedAlias}>{selectedAlias}</small> : null}
        </span>
        <ChevronDown size={17} aria-hidden />
      </button>

      {open ? (
        <div className="agent-model-dropdown">
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
              placeholder="搜索模型名称或别名"
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
                title="清空搜索"
              >
                <X size={14} />
              </button>
            ) : null}
            <button type="button" className="icon-button quiet" onClick={onRefresh} disabled={loading} title="刷新模型">
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
            </button>
          </div>

          <div className="agent-model-list" id="agent-model-listbox" role="listbox">
            {loading && models.length === 0 ? (
              <div className="agent-model-empty"><LoaderCircle size={18} className="spin" />正在获取模型</div>
            ) : error && models.length === 0 ? (
              <div className="agent-model-empty error"><strong>获取模型失败</strong><span>{error}</span></div>
            ) : choices.length === 0 ? (
              <div className="agent-model-empty">
                <strong>{search.trim() ? '没有匹配的模型' : '暂时没有可用模型'}</strong>
                <span>{search.trim() ? '尝试其他关键词' : '请先接入可用模型后刷新'}</span>
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
                    <small>{choice.alias || '可用模型'}</small>
                  </span>
                  {selected ? <Check size={16} aria-hidden /> : null}
                </button>
              );
            })}
          </div>
          <div className="agent-model-dropdown-footer">
            <span>{models.length} 个可用模型</span>
            {error && models.length > 0 ? <span className="error">刷新失败，显示上次结果</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AgentsPage() {
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

  const loadStatuses = useCallback(async () => {
    const nextStatuses = await invoke<AgentConfigStatus[]>('get_agent_config_statuses');
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
      await Promise.all([loadStatuses(), loadModels()]);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, [loadModels, loadStatuses]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      setError('模型列表仍在加载，请稍后再试');
      return null;
    }
    if (models.length === 0) {
      setError(modelError || '当前没有可选模型，无法修改智能体配置');
      return null;
    }
    const model = findAgentModel(models, selectedModel);
    if (!model) {
      setError('当前选择已不在可用模型列表中，请刷新模型后重新选择');
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
        ? `${activeDefinition.name} 已启用配置修改；退出软件前建议关闭“修改智能体配置”，恢复原配置文件`
        : `${activeDefinition.name} 的原配置已恢复，请重启客户端`);
      await loadStatuses();
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
          throw new Error('当前配置存在冲突或恢复任务，暂时不能应用新模型');
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
          ? `${activeDefinition.name} 已应用模型并启动；退出软件前建议关闭“修改智能体配置”，恢复原配置文件`
          : `${activeDefinition.name} 已同步模型目录并启动；退出软件前建议关闭“修改智能体配置”，恢复原配置文件`
        : activeStatus?.modificationEnabled
          ? `${activeDefinition.name} 已启动；退出软件前建议关闭“修改智能体配置”，恢复原配置文件`
          : `${activeDefinition.name} 已启动`);
      if (appliedBeforeLaunch) await loadStatuses();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = loading
    ? '检测中'
    : !activeStatus?.supportedPlatform
      ? '平台不支持'
      : !activeStatus.installed
        ? '未安装'
        : activeStatus.modificationState === 'conflict'
          ? '配置冲突'
          : activeStatus.modificationState === 'recovery'
            ? '需要恢复'
            : activeStatus.modificationEnabled
              ? '已修改配置'
              : '保持原配置';
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
          <h1>智能体配置</h1>
        </div>
        <button type="button" className="secondary-button compact-button" onClick={() => void refresh()} disabled={loading || busy}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          重新检测
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
            <div><strong>本机客户端</strong><span>选择需要管理的智能体</span></div>
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
              <div><h2>{activeDefinition.name}</h2><span>{activeDefinition.description}</span></div>
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
              <span><BadgeCheck size={14} />安装状态</span>
              <strong>{activeStatus?.installed ? '已检测到客户端' : '未检测到客户端'}</strong>
            </div>
            <div>
              <span>客户端版本</span>
              <strong title={activeStatus?.version ?? undefined}>{activeStatus?.version ?? '未获取'}</strong>
            </div>
          </div>

          <section className="agent-model-section">
            <div className="agent-section-heading">
              <div><strong>使用模型</strong><span>同步内核当前开放的模型，并将所选项设为默认模型</span></div>
              {draftChanged ? <span className="agent-pending-badge">尚未应用</span> : null}
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
                ? '正在读取可用模型'
                : modelError && models.length === 0
                  ? modelError
                  : models.length === 0
                    ? '无可选模型，不能开启或更新配置'
                    : activeStatus?.modificationEnabled
                      ? `当前已应用：${appliedModel || '未记录模型'}`
                      : `${models.length} 个可用模型，首次默认选择第一项`}
            </span>
          </section>

          <section className={`agent-modification-switch ${activeStatus?.modificationEnabled ? 'enabled' : ''}`}>
            <div>
              <strong>修改智能体配置</strong>
              <span>{activeStatus?.modificationEnabled
                ? activeStatus.modificationState === 'conflict'
                  ? '配置已被外部修改，关闭时需要确认恢复'
                  : activeStatus.modificationState === 'recovery'
                    ? '上次操作未完成，关闭开关可尝试恢复原配置'
                    : '原配置已备份，当前由 CPA 管理'
                : '启动客户端前必须开启；程序会先备份原配置，再写入 CPA 配置'}</span>
            </div>
            <label className="switch-control" title="修改智能体配置">
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
                  ? '模型选择已变化，启动时会先应用新模型'
                  : '退出软件前建议关闭“修改智能体配置”，恢复开启前的原配置文件'
                : !activeStatus?.supportedPlatform
                  ? '当前系统无法配置该客户端'
                  : !activeStatus.installed
                    ? '请先安装客户端并重新检测'
                    : activeStatus.launchTargets.length === 0
                      ? '检测到配置文件，但没有找到客户端命令'
                      : !activeStatus.configValid
                        ? '原配置格式异常，无法安全修改'
                        : '请先开启“修改智能体配置”，确保 CPA 模型配置生效后再启动客户端'}</span>
            </div>
            <div className="agent-launch-actions">
              {activeLaunchTargets.length > 1 ? (
                <div className="agent-launch-targets" aria-label="Codex 启动方式">
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
                  : '请先开启“修改智能体配置”'}
              >
                {busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}
                {busy ? '启动中' : selectedLaunchTarget ? `启动 ${selectedLaunchTarget.label}` : '无法启动'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {restoreConflict ? (
        <div className="config-dialog-backdrop">
          <section className="config-dialog agent-restore-dialog" role="alertdialog" aria-modal="true" aria-labelledby="agent-restore-title">
            <div className="config-dialog-heading">
              <div><AlertTriangle size={19} /><h2 id="agent-restore-title">配置已发生外部变化</h2></div>
            </div>
            <p>
              开启修改配置后，有 {restoreConflict.length} 个配置文件又被其他程序修改。
              继续恢复会使用开启前的备份覆盖这些变化。
            </p>
            <div className="config-dialog-actions two-actions">
              <button type="button" className="secondary-button" onClick={() => setRestoreConflict(null)} disabled={busy}>取消</button>
              <button type="button" className="danger-button" onClick={() => void setModificationEnabled(false, true)} disabled={busy}>
                {busy ? <LoaderCircle size={16} className="spin" /> : null}
                确认强制恢复
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
