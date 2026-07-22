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
import { getCurrentLocale, translate, useI18n } from '../i18n';

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

const effortOptions = [
  { value: 'low', label: 'Low', hintKey: 'aliases.effort.low' },
  { value: 'medium', label: 'Medium', hintKey: 'aliases.effort.medium' },
  { value: 'high', label: 'High', hintKey: 'aliases.effort.high' },
  { value: 'xhigh', label: 'XHigh', hintKey: 'aliases.effort.xhigh' },
  { value: 'max', label: 'Max', hintKey: 'aliases.effort.max' },
] as const satisfies ReadonlyArray<{ value: PresetThinkingEffort; label: string; hintKey: string }>;

export const thinkingAliasSourceKindLabel = (kind: string) => {
  if (kind === 'codex-oauth') return 'Codex OAuth';
  if (kind === 'codex-api') return 'Codex API';
  if (kind === 'openai-compatible') return translate(getCurrentLocale(), 'aliases.source.openAiCompatible');
  return translate(getCurrentLocale(), 'aliases.source.other');
};

const thinkingAliasProviderDetail = (kind: string, provider: string) => (
  provider === thinkingAliasSourceKindLabel(kind)
    ? translate(getCurrentLocale(), 'aliases.source.available')
    : provider
);

const thinkingAliasSourceDetail = (source: ThinkingAliasSource) => (
  thinkingAliasProviderDetail(source.kind, source.provider)
);

export function ThinkingAliasesPage() {
  const { t } = useI18n();
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
      setError(t('aliases.error.selectModel'));
      return;
    }
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) {
      setError(t('aliases.error.emptyAlias'));
      return;
    }
    if (!normalizedEffort) {
      setError(t('aliases.error.emptyEffort'));
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
      setNotice(t('aliases.created', { alias: normalizedAlias, effort: normalizedEffort }));
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
      t('aliases.deleteConfirm', { alias: entry.alias }),
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
      setNotice(t('aliases.deleted', { alias: entry.alias }));
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
          <h1>{t('aliases.title')}</h1>
        </div>
      </header>

      <div className="thinking-alias-feedback" aria-live="polite">
        {error ? <div className="management-alert error">{error}</div> : null}
        {!error && notice ? <div className="management-alert success">{notice}</div> : null}
      </div>

      <div className="thinking-alias-guide">
        <BrainCircuit size={20} />
        <div className="thinking-alias-guide-copy">
          <strong>{t('aliases.intro.title')}</strong>
          <p>{t('aliases.intro.description')}</p>
          <span>{t('aliases.intro.badge')}</span>
        </div>
        <div className="thinking-alias-flow" aria-label={t('aliases.flow.aria')}>
          <span><small>{t('aliases.flow.original')}</small><code>deepseek-v4-pro</code></span>
          <ArrowRight size={14} />
          <div>
            <span><small>{t('aliases.flow.direct')}</small><code>{t('aliases.flow.directValue')}</code></span>
            <span><small>{t('aliases.flow.alias')}</small><code>{t('aliases.flow.aliasValue')}</code></span>
          </div>
        </div>
      </div>

      <div className="thinking-alias-workbench">
        <section className="panel thinking-alias-builder">
          <div className="thinking-alias-panel-heading">
            <span><GitFork size={18} /></span>
            <div>
              <h2>{t('aliases.create.title')}</h2>
              <p>{t('aliases.create.description')}</p>
            </div>
          </div>

          <div className="thinking-alias-field thinking-model-field">
            <label htmlFor="thinking-model-search">{t('aliases.originalModel')}</label>
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
                  placeholder={loading ? t('aliases.loadingModels') : t('aliases.searchModel')}
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
                  aria-label={t('aliases.availableModels')}
                >
                  {filteredSources.length === 0 ? (
                    <div className="thinking-model-empty">
                      {sources.length ? t('aliases.noMatch') : t('aliases.noModels')}
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
                  {t('aliases.sourceLabel', { source: thinkingAliasSourceDetail(selectedSource) })}
                </strong>
              </div>
            ) : (
              <small className="thinking-model-hint">{t('aliases.sourceHint')}</small>
            )}
          </div>

          <div className="thinking-alias-field">
            <div className="thinking-field-heading">
              <strong>{t('aliases.effort.title')}</strong>
              <span>{t('aliases.effort.description')}</span>
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
                  title={t(option.hintKey)}
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
                  ? t('aliases.customLevel', { effort: normalizedEffort })
                  : t('aliases.customLevelHint')}
              >
                {customEffortSelected ? normalizedEffort : t('aliases.custom')}
              </button>
            </div>
            {customEffortOpen ? <div className="thinking-effort-custom">
              <input
                id="thinking-effort-custom"
                value={customEffortSelected ? effort : ''}
                onChange={(event) => chooseEffort(event.currentTarget.value)}
                placeholder={t('aliases.customPlaceholder')}
                maxLength={64}
                spellCheck={false}
                autoFocus
                disabled={Boolean(busyAlias)}
              />
              <button
                type="button"
                className="icon-button quiet"
                onClick={() => setCustomEffortOpen(false)}
                title={t('aliases.collapseCustom')}
                aria-label={t('aliases.collapseCustom')}
              >
                <X size={14} />
              </button>
              <small>{t('aliases.customHelp')}</small>
            </div> : null}
          </div>

          <div className="thinking-alias-field">
            <div className="thinking-field-heading">
              <strong>{t('aliases.aliasName.title')}</strong>
              <span>{t('aliases.aliasName.description')}</span>
            </div>
            <input
              id="thinking-alias-name"
              className="thinking-alias-input"
              value={alias}
              onChange={(event) => setAlias(event.currentTarget.value)}
              placeholder={selectedSource
                ? t('aliases.aliasName.example', { model: selectedSource.model, effort: normalizedEffort || 'high' })
                : t('aliases.aliasName.selectFirst')}
              disabled={Boolean(busyAlias)}
            />
          </div>

          <div className="thinking-alias-preview">
            <BrainCircuit size={18} />
            <div>
              <span>{selectedSource?.model || t('aliases.notSelected')} <ArrowRight size={13} /> {alias || t('aliases.enterAlias')}</span>
              <code>{selectedSource?.protocol === 'openai' ? 'reasoning_effort' : 'reasoning.effort'} = {normalizedEffort || t('aliases.notSet')}</code>
            </div>
          </div>

          <button
            type="button"
            className="primary-button thinking-alias-create"
            onClick={() => void createAlias()}
            disabled={loading || Boolean(busyAlias) || !selectedSource || !effort.trim() || !alias.trim()}
          >
            {busyAction === 'create' ? <LoaderCircle size={16} className="spin" /> : <GitFork size={16} />}
            {busyAction === 'create' ? t('aliases.creating') : t('aliases.create')}
          </button>
        </section>

        <section className="panel thinking-alias-list-panel">
          <div className="thinking-alias-list-heading">
            <div>
              <h2>{t('aliases.createdList.title')}</h2>
              <span>{t('aliases.createdList.description')}</span>
            </div>
            <strong>{entries.length}</strong>
          </div>

          <div className="thinking-alias-list">
            {loading ? (
              <div className="management-loading"><LoaderCircle size={20} className="spin" />{t('aliases.loadingConfig')}</div>
            ) : entries.length === 0 ? (
              <div className="management-empty">
                <GitFork size={25} />
                <strong>{t('aliases.empty.title')}</strong>
                <span>{t('aliases.empty.description')}</span>
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
                  {entry.effort ?? t('aliases.unboundEffort')}
                </span>
                <button
                  type="button"
                  className="icon-button danger"
                  onClick={() => void deleteAlias(entry)}
                  disabled={Boolean(busyAlias)}
                  title={t('aliases.delete', { alias: entry.alias })}
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
