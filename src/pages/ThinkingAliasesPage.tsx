import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowRight,
  BrainCircuit,
  Check,
  GitFork,
  LoaderCircle,
  Search,
  Trash2,
  X,
} from 'lucide-react';

type PresetThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

type ThinkingAliasEntry = {
  sourceModel: string;
  alias: string;
  effort: string | null;
  provider: string;
  kind: string;
};

type ThinkingAliasSource = {
  id: string;
  model: string;
  displayName: string | null;
  provider: string;
  kind: string;
  protocol: string;
};

const effortOptions: { value: PresetThinkingEffort; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: '轻量' },
  { value: 'medium', label: 'Medium', hint: '均衡' },
  { value: 'high', label: 'High', hint: '深入' },
  { value: 'xhigh', label: 'XHigh', hint: '超高' },
  { value: 'max', label: 'Max', hint: '最大' },
];

export const thinkingAliasSourceKindLabel = (kind: string) => {
  if (kind === 'codex-oauth') return 'Codex OAuth';
  if (kind === 'codex-api') return 'Codex API';
  if (kind === 'openai-compatible') return 'OpenAI 兼容';
  return '其他来源';
};

const thinkingAliasProviderDetail = (kind: string, provider: string) => (
  provider === thinkingAliasSourceKindLabel(kind) ? '内核当前可用模型' : provider
);

const thinkingAliasSourceDetail = (source: ThinkingAliasSource) => (
  thinkingAliasProviderDetail(source.kind, source.provider)
);

export function ThinkingAliasesPage() {
  const [entries, setEntries] = useState<ThinkingAliasEntry[]>([]);
  const [sources, setSources] = useState<ThinkingAliasSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [effort, setEffort] = useState('xhigh');
  const [customEffortOpen, setCustomEffortOpen] = useState(false);
  const [alias, setAlias] = useState('');
  const [search, setSearch] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [busyAlias, setBusyAlias] = useState('');
  const [busyAction, setBusyAction] = useState<'create' | 'delete' | ''>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextEntries, nextSources] = await Promise.all([
        invoke<ThinkingAliasEntry[]>('get_thinking_aliases'),
        invoke<ThinkingAliasSource[]>('get_thinking_alias_sources'),
      ]);
      setEntries(nextEntries);
      setSources(nextSources);
      setSelectedSourceId((current) => (
        nextSources.some((source) => source.id === current) ? current : ''
      ));
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!modelPickerOpen) return undefined;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) {
        setModelPickerOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [modelPickerOpen]);

  const selectedSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId) ?? null,
    [selectedSourceId, sources],
  );

  const filteredSources = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sources;
    return sources
      .map((source, index) => {
        const model = source.model.toLowerCase();
        const displayName = (source.displayName ?? '').toLowerCase();
        const haystack = `${model} ${displayName} ${source.provider} ${thinkingAliasSourceKindLabel(source.kind)}`
          .toLowerCase();
        let score = 5;
        if (model === query) score = 0;
        else if (displayName === query) score = 1;
        else if (model.startsWith(query)) score = 2;
        else if (displayName.startsWith(query)) score = 3;
        else if (haystack.includes(query)) score = 4;
        return { source, index, score };
      })
      .filter((item) => item.score < 5)
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .map((item) => item.source);
  }, [sources, search]);

  useEffect(() => {
    setActiveSourceIndex(0);
  }, [search, sources]);

  const chooseSource = (source: ThinkingAliasSource) => {
    setSelectedSourceId(source.id);
    setModelPickerOpen(false);
    setSearch('');
  };

  const chooseEffort = (nextEffort: string) => {
    setEffort(nextEffort);
  };

  const handleModelSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setModelPickerOpen(false);
      setSearch('');
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!modelPickerOpen) {
        setModelPickerOpen(true);
        return;
      }
      if (!filteredSources.length) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveSourceIndex((current) => (
        (current + direction + filteredSources.length) % filteredSources.length
      ));
      return;
    }
    if (event.key === 'Enter' && modelPickerOpen && filteredSources[activeSourceIndex]) {
      event.preventDefault();
      chooseSource(filteredSources[activeSourceIndex]);
    }
  };

  const normalizedEffort = effort.trim().toLowerCase();
  const customEffortSelected = Boolean(
    normalizedEffort && !effortOptions.some((option) => option.value === normalizedEffort),
  );

  const createAlias = async () => {
    if (!selectedSource) {
      setError('请先选择原模型');
      return;
    }
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) {
      setError('别名模型不能为空');
      return;
    }
    if (!normalizedEffort) {
      setError('思考强度不能为空');
      return;
    }
    setBusyAlias(normalizedAlias);
    setBusyAction('create');
    setError('');
    setNotice('');
    try {
      const nextEntries = await invoke<ThinkingAliasEntry[]>('create_thinking_alias', {
        sourceId: selectedSource.id,
        alias: normalizedAlias,
        effort: normalizedEffort,
      });
      setEntries(nextEntries);
      setNotice(`已创建 ${normalizedAlias}，思考强度固定为 ${normalizedEffort}`);
      setAlias('');
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusyAlias('');
      setBusyAction('');
    }
  };

  const deleteAlias = async (entry: ThinkingAliasEntry) => {
    if (!window.confirm(
      `确定删除别名模型「${entry.alias}」吗？\n将同时移除对应的思考强度覆盖规则。`,
    )) return;
    setBusyAlias(entry.alias);
    setBusyAction('delete');
    setError('');
    setNotice('');
    try {
      const nextEntries = await invoke<ThinkingAliasEntry[]>('delete_thinking_alias', {
        alias: entry.alias,
      });
      setEntries(nextEntries);
      setNotice(`已删除 ${entry.alias}`);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusyAlias('');
      setBusyAction('');
    }
  };

  return (
    <section className="page management-page thinking-alias-page">
      <header className="management-header">
        <div>
          <span>Model Alias</span>
          <h1>思考别名</h1>
        </div>
      </header>

      <div className="thinking-alias-feedback" aria-live="polite">
        {error ? <div className="management-alert error">{error}</div> : null}
        {!error && notice ? <div className="management-alert success">{notice}</div> : null}
      </div>

      <div className="thinking-alias-guide">
        <BrainCircuit size={20} />
        <div className="thinking-alias-guide-copy">
          <strong>为原模型新增一个固定思考强度的自定义别名</strong>
          <p>别名名称由你填写，客户端调用它时 CPA 才会注入所选思考强度；直接调用原模型时，原有名称、配置和行为全部保持不变。</p>
          <span>原模型不受影响</span>
        </div>
        <div className="thinking-alias-flow" aria-label="思考别名工作流程">
          <span><small>原模型</small><code>deepseek-v4-pro</code></span>
          <ArrowRight size={14} />
          <div>
            <span><small>直接调用</small><code>deepseek-v4-pro · 保持不变</code></span>
            <span><small>别名调用</small><code>deepseek-v4-pro-max · 固定max强度</code></span>
          </div>
        </div>
      </div>

      <div className="thinking-alias-workbench">
        <section className="panel thinking-alias-builder">
          <div className="thinking-alias-panel-heading">
            <span><GitFork size={18} /></span>
            <div>
              <h2>创建思考别名</h2>
              <p>支持 Codex OAuth、Codex API 和 OpenAI 兼容接入</p>
            </div>
          </div>

          <div className="thinking-alias-field thinking-model-field">
            <label htmlFor="thinking-model-search">原模型</label>
            <div className="thinking-model-picker" ref={modelPickerRef}>
              <div className="thinking-model-search">
                {loading ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}
                <input
                  id="thinking-model-search"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={modelPickerOpen}
                  aria-controls="thinking-model-options"
                  aria-activedescendant={modelPickerOpen && filteredSources[activeSourceIndex]
                    ? `thinking-model-option-${activeSourceIndex}`
                    : undefined}
                  value={modelPickerOpen ? search : selectedSource?.model ?? ''}
                  onFocus={(event) => {
                    setSearch(selectedSource?.model ?? '');
                    setModelPickerOpen(true);
                    event.currentTarget.select();
                  }}
                  onChange={(event) => {
                    setSearch(event.currentTarget.value);
                    setModelPickerOpen(true);
                  }}
                  onKeyDown={handleModelSearchKeyDown}
                  placeholder={loading ? '正在读取模型' : '搜索并选择原模型'}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={loading}
                />
                {!modelPickerOpen && selectedSource ? (
                  <span className="thinking-source-kind">
                    {thinkingAliasSourceKindLabel(selectedSource.kind)}
                  </span>
                ) : null}
              </div>
              {modelPickerOpen ? (
                <div
                  className="thinking-model-list"
                  id="thinking-model-options"
                  role="listbox"
                  aria-label="可用原模型"
                >
                  {filteredSources.length === 0 ? (
                    <div className="thinking-model-empty">
                      {sources.length ? '没有匹配的模型或来源' : '当前没有可选模型'}
                    </div>
                  ) : filteredSources.map((source, index) => {
                    const selected = source.id === selectedSourceId;
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        id={`thinking-model-option-${index}`}
                        className={`${selected ? 'selected ' : ''}${index === activeSourceIndex ? 'active' : ''}`.trim()}
                        key={source.id}
                        onMouseEnter={() => setActiveSourceIndex(index)}
                        onClick={() => chooseSource(source)}
                        disabled={Boolean(busyAlias)}
                      >
                        <span className="thinking-model-option-copy">
                          <span>
                            <strong title={source.model}>{source.model}</strong>
                            {source.displayName && source.displayName !== source.model
                              ? <small>{source.displayName}</small>
                              : null}
                          </span>
                          <span className="thinking-model-source">
                            <em>{thinkingAliasSourceKindLabel(source.kind)}</em>
                            <small title={thinkingAliasSourceDetail(source)}>
                              {thinkingAliasSourceDetail(source)}
                            </small>
                          </span>
                        </span>
                        {selected ? <Check size={15} /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            {selectedSource ? (
              <div className="thinking-model-selection">
                <span>{thinkingAliasSourceKindLabel(selectedSource.kind)}</span>
                <strong title={thinkingAliasSourceDetail(selectedSource)}>
                  来源：{thinkingAliasSourceDetail(selectedSource)}
                </strong>
              </div>
            ) : (
              <small className="thinking-model-hint">同名模型会按 Codex OAuth、Codex API 和 OpenAI 兼容来源分别列出</small>
            )}
          </div>

          <div className="thinking-alias-field">
            <div className="thinking-field-heading">
              <strong>思考强度</strong>
              <span>选择常用等级，或输入上游支持的自定义值</span>
            </div>
            <div className="thinking-effort-options">
              {effortOptions.map((option) => (
                <button
                  type="button"
                  className={effort.trim().toLowerCase() === option.value ? 'active' : ''}
                  key={option.value}
                  onClick={() => {
                    chooseEffort(option.value);
                    setCustomEffortOpen(false);
                  }}
                  disabled={Boolean(busyAlias)}
                  title={option.hint}
                >
                  {option.label}
                </button>
              ))}
              <button
                type="button"
                className={customEffortSelected ? 'active custom' : 'custom'}
                onClick={() => {
                  if (!customEffortSelected) chooseEffort('');
                  setCustomEffortOpen(true);
                }}
                disabled={Boolean(busyAlias)}
                title={customEffortSelected
                  ? `自定义等级：${normalizedEffort}`
                  : '输入模型提供商支持的其他思考等级'}
              >
                {customEffortSelected ? normalizedEffort : '自定义'}
              </button>
            </div>
            {customEffortOpen ? <div className="thinking-effort-custom">
              <input
                id="thinking-effort-custom"
                value={customEffortSelected ? effort : ''}
                onChange={(event) => chooseEffort(event.currentTarget.value)}
                placeholder="例如 minimal、auto、ultra 或厂商等级"
                maxLength={64}
                spellCheck={false}
                autoFocus
                disabled={Boolean(busyAlias)}
              />
              <button
                type="button"
                className="icon-button quiet"
                onClick={() => setCustomEffortOpen(false)}
                title="收起自定义输入"
                aria-label="收起自定义输入"
              >
                <X size={14} />
              </button>
              <small>仅填写目标模型实际支持的等级名称</small>
            </div> : null}
          </div>

          <div className="thinking-alias-field">
            <div className="thinking-field-heading">
              <strong>别名模型名称</strong>
              <span>由你填写，仅新增入口，不会改名原模型</span>
            </div>
            <input
              id="thinking-alias-name"
              className="thinking-alias-input"
              value={alias}
              onChange={(event) => setAlias(event.currentTarget.value)}
              placeholder={selectedSource
                ? `例如 ${selectedSource.model}-${normalizedEffort || 'high'}`
                : '先选择原模型，再填写客户端使用的别名'}
              disabled={Boolean(busyAlias)}
            />
          </div>

          <div className="thinking-alias-preview">
            <BrainCircuit size={18} />
            <div>
              <span>{selectedSource?.model || '未选择模型'} <ArrowRight size={13} /> {alias || '请输入别名模型名称'}</span>
              <code>{selectedSource?.protocol === 'openai' ? 'reasoning_effort' : 'reasoning.effort'} = {normalizedEffort || '未填写'}</code>
            </div>
          </div>

          <button
            type="button"
            className="primary-button thinking-alias-create"
            onClick={() => void createAlias()}
            disabled={loading || Boolean(busyAlias) || !selectedSource || !effort.trim() || !alias.trim()}
          >
            {busyAction === 'create' ? <LoaderCircle size={16} className="spin" /> : <GitFork size={16} />}
            {busyAction === 'create' ? '创建中' : '创建别名'}
          </button>
        </section>

        <section className="panel thinking-alias-list-panel">
          <div className="thinking-alias-list-heading">
            <div>
              <h2>已创建别名</h2>
              <span>每个别名都保留原模型、来源和固定思考强度</span>
            </div>
            <strong>{entries.length}</strong>
          </div>

          <div className="thinking-alias-list">
            {loading ? (
              <div className="management-loading"><LoaderCircle size={20} className="spin" />读取配置中</div>
            ) : entries.length === 0 ? (
              <div className="management-empty">
                <GitFork size={25} />
                <strong>尚未创建思考别名</strong>
                <span>从左侧选择模型和强度即可创建</span>
              </div>
            ) : entries.map((entry) => (
              <article className="thinking-alias-row" key={`${entry.kind}:${entry.provider}:${entry.alias}`}>
                <div className="thinking-alias-route">
                  <div className="thinking-alias-route-source">
                    <span title={entry.sourceModel}>{entry.sourceModel}</span>
                    <small>
                      <em>{thinkingAliasSourceKindLabel(entry.kind)}</em>
                      <span title={thinkingAliasProviderDetail(entry.kind, entry.provider)}>
                        {thinkingAliasProviderDetail(entry.kind, entry.provider)}
                      </span>
                    </small>
                  </div>
                  <ArrowRight size={14} />
                  <strong title={entry.alias}>{entry.alias}</strong>
                </div>
                <span className={`thinking-effort-badge ${entry.effort ? '' : 'missing'}`}>
                  {entry.effort ?? '未绑定强度'}
                </span>
                <button
                  type="button"
                  className="icon-button danger"
                  onClick={() => void deleteAlias(entry)}
                  disabled={Boolean(busyAlias)}
                  title={`删除 ${entry.alias}`}
                >
                  {busyAction === 'delete' && busyAlias === entry.alias
                    ? <LoaderCircle size={15} className="spin" />
                    : <Trash2 size={15} />}
                </button>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
