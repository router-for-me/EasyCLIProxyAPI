import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, LoaderCircle, RefreshCw, RotateCcw, Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import {
  cloneCodexModelConfiguration,
  codexReasoningEfforts,
  sameCodexModelConfiguration,
  toggleCodexReasoningLevel,
  validateCodexModelConfiguration,
  type CodexCatalogEditorModel,
  type CodexCatalogEditorSaveResult,
  type CodexCatalogEditorSnapshot,
  type CodexModelConfiguration,
  type CodexReasoningEffort,
} from '../services/codexModelCatalog';

type CodexModelCatalogDialogProps = {
  onClose: () => void;
  onSaved: () => void | Promise<void>;
};

const cloneModel = (model: CodexCatalogEditorModel): CodexCatalogEditorModel => ({
  ...model,
  configuration: cloneCodexModelConfiguration(model.configuration),
  defaults: cloneCodexModelConfiguration(model.defaults),
});

const cloneModels = (snapshot: CodexCatalogEditorSnapshot) => snapshot.models.map(cloneModel);

export function CodexModelCatalogDialog({ onClose, onSaved }: CodexModelCatalogDialogProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<CodexCatalogEditorSnapshot | null>(null);
  const [models, setModels] = useState<CodexCatalogEditorModel[]>([]);
  const [selectedSlug, setSelectedSlug] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const next = await invoke<CodexCatalogEditorSnapshot>('get_codex_model_catalog_editor');
      setSnapshot(next);
      setModels(cloneModels(next));
      setSelectedSlug((current) => next.models.some((model) => model.slug === current)
        ? current
        : next.models[0]?.slug ?? '');
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!snapshot || snapshot.models.length !== models.length) return false;
    return models.some((model) => {
      const saved = snapshot.models.find((candidate) => candidate.slug === model.slug);
      return !saved || !sameCodexModelConfiguration(model.configuration, saved.configuration);
    });
  }, [models, snapshot]);

  const filteredModels = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return models;
    return models.filter((model) => model.slug.toLocaleLowerCase().includes(query)
      || model.configuration.display_name.toLocaleLowerCase().includes(query));
  }, [models, search]);

  const activeModel = models.find((model) => model.slug === selectedSlug) ?? null;
  const activeCustomized = activeModel
    ? !sameCodexModelConfiguration(activeModel.configuration, activeModel.defaults)
    : false;

  const updateActive = (update: (configuration: CodexModelConfiguration) => CodexModelConfiguration) => {
    setModels((current) => current.map((model) => model.slug === selectedSlug
      ? { ...model, configuration: update(model.configuration) }
      : model));
    setError('');
    setNotice('');
  };

  const updateField = <Key extends keyof CodexModelConfiguration,>(
    field: Key,
    value: CodexModelConfiguration[Key],
  ) => updateActive((current) => ({ ...current, [field]: value }));

  const toggleReasoning = (
    effort: CodexReasoningEffort,
    enabled: boolean,
    defaults: CodexModelConfiguration['supported_reasoning_levels'],
  ) => updateActive((current) => toggleCodexReasoningLevel(current, effort, enabled, defaults));

  const toggleModality = (modality: 'text' | 'image', enabled: boolean) => updateActive((current) => ({
    ...current,
    input_modalities: (['text', 'image'] as const).filter((candidate) => candidate === modality
      ? enabled
      : current.input_modalities.includes(candidate)),
  }));

  const requestClose = () => {
    if (saving) return;
    if (dirty) setDiscardConfirmOpen(true);
    else onClose();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (discardConfirmOpen) setDiscardConfirmOpen(false);
      else requestClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const restoreModel = () => {
    if (!activeModel) return;
    updateActive(() => cloneCodexModelConfiguration(activeModel.defaults));
    setNotice(t('agents.catalog.restored'));
  };

  const restoreAll = () => {
    setModels((current) => current.map((model) => ({
      ...model,
      configuration: cloneCodexModelConfiguration(model.defaults),
    })));
    setError('');
    setNotice(t('agents.catalog.restored'));
  };

  const save = async () => {
    if (!snapshot || saving) return;
    for (const model of models) {
      const validationKey = validateCodexModelConfiguration(model.configuration);
      if (validationKey) {
        setSelectedSlug(model.slug);
        setError(t(validationKey));
        setNotice('');
        return;
      }
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await invoke<CodexCatalogEditorSaveResult>('save_codex_model_catalog_editor', {
        request: {
          revision: snapshot.revision,
          models: models.map((model) => ({
            slug: model.slug,
            configuration: model.configuration,
          })),
        },
      });
      setSnapshot(result.snapshot);
      setModels(cloneModels(result.snapshot));
      setNotice(result.synchronizationError
        ? t('agents.catalog.syncFailed', { error: result.synchronizationError })
        : t('agents.catalog.saved'));
      await onSaved();
    } catch (requestError) {
      const message = String(requestError);
      setError(message.includes('CODEX_MODEL_CATALOG_CHANGED')
        ? t('agents.catalog.changed')
        : message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="config-dialog-backdrop codex-catalog-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target) requestClose();
    }}>
      <section className="config-dialog codex-catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-catalog-title">
        <header className="config-dialog-heading codex-catalog-heading">
          <div>
            <h2 id="codex-catalog-title">{t('agents.catalog.title')}</h2>
            <p>{t('agents.catalog.subtitle')}</p>
          </div>
          <button type="button" className="icon-button quiet" onClick={requestClose} disabled={saving} aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </header>

        <div className="codex-catalog-body">
          <aside className="codex-catalog-sidebar">
            <div className="codex-catalog-search">
              <Search size={15} aria-hidden />
              <input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder={t('agents.catalog.search')} />
            </div>
            <div className="codex-catalog-models" role="listbox" aria-label={t('agents.catalog.title')}>
              {loading ? (
                <div className="codex-catalog-state"><LoaderCircle size={18} className="spin" />{t('agents.catalog.loading')}</div>
              ) : filteredModels.length ? filteredModels.map((model) => {
                const customized = !sameCodexModelConfiguration(model.configuration, model.defaults);
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={model.slug === selectedSlug}
                    className={model.slug === selectedSlug ? 'active' : ''}
                    key={model.slug}
                    onClick={() => setSelectedSlug(model.slug)}
                  >
                    <strong>{model.configuration.display_name}</strong>
                    <span>{model.slug}</span>
                    <small>
                      {model.hasOfficialTemplate ? t('agents.catalog.official') : t('agents.catalog.fallback')}
                      {customized ? ` · ${t('agents.catalog.customized')}` : ''}
                    </small>
                  </button>
                );
              }) : <div className="codex-catalog-state">{t('agents.catalog.empty')}</div>}
            </div>
            <button type="button" className="secondary-button codex-catalog-reload" onClick={() => void load()} disabled={loading || saving || dirty}>
              <RefreshCw size={15} className={loading ? 'spin' : ''} />
              {t('agents.catalog.reload')}
            </button>
          </aside>

          <main className="codex-catalog-editor">
            {activeModel ? (
              <>
                <div className="codex-catalog-model-heading">
                  <div>
                    <h3>{activeModel.slug}</h3>
                    <span className={activeCustomized ? 'customized' : ''}>
                      {activeModel.hasOfficialTemplate ? t('agents.catalog.official') : t('agents.catalog.fallback')}
                      {activeCustomized ? ` · ${t('agents.catalog.customized')}` : ''}
                    </span>
                  </div>
                  <button type="button" className="secondary-button compact-button" onClick={restoreModel} disabled={!activeCustomized || saving}>
                    <RotateCcw size={15} />{t('agents.catalog.resetModel')}
                  </button>
                </div>

                <div className="codex-catalog-form">
                  <label><span>{t('agents.catalog.displayName')}</span><input value={activeModel.configuration.display_name} onChange={(event) => updateField('display_name', event.currentTarget.value)} /></label>
                  <label className="wide"><span>{t('agents.catalog.description')}</span><textarea value={activeModel.configuration.description ?? ''} onChange={(event) => updateField('description', event.currentTarget.value || null)} /></label>
                  <label><span>{t('agents.catalog.context')}</span><input type="number" min="1" value={Number.isFinite(activeModel.configuration.context_window) ? activeModel.configuration.context_window : ''} onChange={(event) => updateField('context_window', event.currentTarget.value ? Number(event.currentTarget.value) : Number.NaN)} /></label>
                  <label><span>{t('agents.catalog.maximum')}</span><input type="number" min="1" value={Number.isFinite(activeModel.configuration.max_context_window) ? activeModel.configuration.max_context_window : ''} onChange={(event) => updateField('max_context_window', event.currentTarget.value ? Number(event.currentTarget.value) : Number.NaN)} /></label>
                  <label><span>{t('agents.catalog.percent')}</span><input type="number" min="1" max="100" value={Number.isFinite(activeModel.configuration.effective_context_window_percent) ? activeModel.configuration.effective_context_window_percent : ''} onChange={(event) => updateField('effective_context_window_percent', event.currentTarget.value ? Number(event.currentTarget.value) : Number.NaN)} /></label>
                  <label><span>{t('agents.catalog.compact')}</span><input type="number" min="1" placeholder={t('agents.catalog.automatic')} value={activeModel.configuration.auto_compact_token_limit ?? ''} onChange={(event) => updateField('auto_compact_token_limit', event.currentTarget.value ? Number(event.currentTarget.value) : null)} /></label>

                  <fieldset className="wide codex-catalog-choice-group">
                    <legend>{t('agents.catalog.reasoning')}</legend>
                    <div className="codex-catalog-chips">
                      {codexReasoningEfforts.map((effort) => {
                        const checked = activeModel.configuration.supported_reasoning_levels.some((level) => level.effort === effort);
                        return <label key={effort} className={checked ? 'selected' : ''}><input type="checkbox" checked={checked} onChange={(event) => toggleReasoning(effort, event.currentTarget.checked, activeModel.defaults.supported_reasoning_levels)} /><span>{checked ? <Check size={13} /> : null}{effort}</span></label>;
                      })}
                    </div>
                  </fieldset>

                  <label><span>{t('agents.catalog.defaultReasoning')}</span><select value={activeModel.configuration.default_reasoning_level ?? ''} onChange={(event) => updateField('default_reasoning_level', (event.currentTarget.value || null) as CodexReasoningEffort | null)}><option value="">{t('agents.catalog.clientDefault')}</option>{activeModel.configuration.supported_reasoning_levels.map((level) => <option key={level.effort} value={level.effort}>{level.effort}</option>)}</select></label>

                  <fieldset className="codex-catalog-choice-group">
                    <legend>{t('agents.catalog.modalities')}</legend>
                    <div className="codex-catalog-checkboxes">
                      {(['text', 'image'] as const).map((modality) => <label key={modality}><input type="checkbox" checked={activeModel.configuration.input_modalities.includes(modality)} onChange={(event) => toggleModality(modality, event.currentTarget.checked)} />{t(`agents.catalog.${modality}`)}</label>)}
                    </div>
                  </fieldset>

                  <label className="codex-catalog-switch"><input type="checkbox" checked={activeModel.configuration.visibility === 'list'} onChange={(event) => updateField('visibility', event.currentTarget.checked ? 'list' : 'hide')} /><span>{t('agents.catalog.visible')}</span></label>
                  <label className="codex-catalog-switch"><input type="checkbox" checked={activeModel.configuration.supports_parallel_tool_calls} onChange={(event) => updateField('supports_parallel_tool_calls', event.currentTarget.checked)} /><span>{t('agents.catalog.parallel')}</span></label>
                </div>
                <p className="codex-catalog-hint">{t('agents.catalog.capabilityHint')}</p>
              </>
            ) : !loading ? <div className="codex-catalog-state">{t('agents.catalog.empty')}</div> : null}
          </main>
        </div>

        <footer className="codex-catalog-footer">
          <div>
            {error ? <span className="agent-inline-message error" role="alert">{error}</span> : null}
            {!error && notice ? <span className="agent-inline-message" role="status">{notice}</span> : null}
            {!error && !notice ? <span>{dirty ? t('agents.catalog.unsaved') : t('agents.catalog.saveHint')}</span> : null}
          </div>
          <div>
            <button type="button" className="secondary-button" onClick={restoreAll} disabled={!models.some((model) => !sameCodexModelConfiguration(model.configuration, model.defaults)) || saving}>
              <RotateCcw size={15} />{t('agents.catalog.resetAll')}
            </button>
            <button type="button" className="secondary-button" onClick={requestClose} disabled={saving}>{t('common.cancel')}</button>
            <button type="button" className="primary-button" onClick={() => void save()} disabled={!snapshot || !dirty || saving}>
              {saving ? <LoaderCircle size={16} className="spin" /> : null}{saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </footer>

        {discardConfirmOpen ? (
          <div className="codex-catalog-confirm">
            <div role="alertdialog" aria-modal="true">
              <strong>{t('agents.catalog.unsaved')}</strong>
              <span>{t('agents.catalog.discardHint')}</span>
              <div>
                <button type="button" className="secondary-button" onClick={() => setDiscardConfirmOpen(false)}>{t('agents.catalog.keepEditing')}</button>
                <button type="button" className="danger-button" onClick={onClose}>{t('agents.catalog.discard')}</button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
