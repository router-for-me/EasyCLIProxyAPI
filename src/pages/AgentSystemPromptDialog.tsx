import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, RefreshCw, RotateCcw, Search, X } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { Checkbox } from '../components/Checkbox';
import { Select } from '../components/Select';
import { MessageNotice } from '../appNotice';
import { useConfirmation } from '../components/ConfirmationDialog';
import { useI18n } from '../i18n';
import type { AgentClientId } from '../services/agents';
import {
  getAgentSystemPromptEditor,
  saveAgentSystemPromptEditor,
  type AgentSystemPromptEditorModel,
  type AgentSystemPromptEditorSnapshot,
  type PromptRewriteMode,
} from '../services/agentSystemPrompts';

const DEFAULT_TARGET_ID = '__default__';

type DraftState = {
  defaultCustomized: boolean;
  defaultPrompt: string;
  defaultMode: PromptRewriteMode;
  defaultPreserveDynamicContext: boolean;
  models: AgentSystemPromptEditorModel[];
};

function snapshotToDraft(snapshot: AgentSystemPromptEditorSnapshot): DraftState {
  return {
    defaultCustomized: snapshot.defaultCustomized,
    defaultPrompt: snapshot.defaultPrompt,
    defaultMode: snapshot.defaultMode,
    defaultPreserveDynamicContext: snapshot.defaultPreserveDynamicContext,
    models: snapshot.models.map((item) => ({ ...item })),
  };
}

function sameDraftAndSnapshot(
  draft: DraftState | null,
  snapshot: AgentSystemPromptEditorSnapshot | null,
): boolean {
  if (!draft || !snapshot) return true;
  if (draft.defaultCustomized !== snapshot.defaultCustomized) return false;
  if (draft.defaultCustomized) {
    if (draft.defaultPrompt !== snapshot.defaultPrompt) return false;
    if (draft.defaultMode !== snapshot.defaultMode) return false;
    if (draft.defaultPreserveDynamicContext !== snapshot.defaultPreserveDynamicContext) return false;
  }
  if (draft.models.length !== snapshot.models.length) return false;
  for (let i = 0; i < draft.models.length; i += 1) {
    const a = draft.models[i];
    const b = snapshot.models.find((candidate) => candidate.id === a.id);
    if (!b) return false;
    if (a.customized !== b.customized) return false;
    if (a.customized) {
      if (a.prompt !== b.prompt) return false;
      if (a.mode !== b.mode) return false;
      if (a.preserveDynamicContext !== b.preserveDynamicContext) return false;
    }
  }
  return true;
}

export function AgentSystemPromptDialog({
  client,
  clientName,
  onClose,
  onSaved,
}: {
  client: AgentClientId;
  clientName: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [snapshot, setSnapshot] = useState<AgentSystemPromptEditorSnapshot | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<string>(DEFAULT_TARGET_ID);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const next = await getAgentSystemPromptEditor(client);
      setSnapshot(next);
      setDraft(snapshotToDraft(next));
      setSelectedTarget((current) => (
        current === DEFAULT_TARGET_ID || next.models.some((m) => m.id === current)
          ? current
          : DEFAULT_TARGET_ID
      ));
    } catch (requestError) {
      setSnapshot(null);
      setDraft(null);
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => !sameDraftAndSnapshot(draft, snapshot), [draft, snapshot]);

  const filteredModels = useMemo(() => {
    if (!draft) return [];
    const query = search.trim().toLowerCase();
    if (!query) return draft.models;
    return draft.models.filter((item) => item.id.toLowerCase().includes(query));
  }, [draft, search]);

  const isDefaultSelected = selectedTarget === DEFAULT_TARGET_ID;
  const activeModel = useMemo(
    () => (isDefaultSelected || !draft ? null : draft.models.find((m) => m.id === selectedTarget) ?? null),
    [draft, isDefaultSelected, selectedTarget],
  );

  const updateDefaultPrompt = (nextPrompt: string) => {
    if (!snapshot) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const customized =
        nextPrompt !== snapshot.builtinDefaultPrompt
        || prev.defaultMode !== 'replace'
        || !prev.defaultPreserveDynamicContext;
      return {
        ...prev,
        defaultCustomized: customized,
        defaultPrompt: nextPrompt,
        models: prev.models.map((item) => (
          item.customized
            ? { ...item, defaultPrompt: nextPrompt }
            : { ...item, prompt: nextPrompt, defaultPrompt: nextPrompt }
        )),
      };
    });
    setError('');
    setNotice('');
  };

  const updateDefaultMode = (nextMode: PromptRewriteMode) => {
    if (!snapshot) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const customized =
        prev.defaultPrompt !== snapshot.builtinDefaultPrompt
        || nextMode !== 'replace'
        || !prev.defaultPreserveDynamicContext;
      return {
        ...prev,
        defaultCustomized: customized,
        defaultMode: nextMode,
      };
    });
    setError('');
    setNotice('');
  };

  const updateDefaultPreserveDynamic = (checked: boolean) => {
    if (!snapshot) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const customized =
        prev.defaultPrompt !== snapshot.builtinDefaultPrompt
        || prev.defaultMode !== 'replace'
        || !checked;
      return {
        ...prev,
        defaultCustomized: customized,
        defaultPreserveDynamicContext: checked,
      };
    });
    setError('');
    setNotice('');
  };

  const updateActiveModel = (
    updater: (current: AgentSystemPromptEditorModel) => AgentSystemPromptEditorModel,
  ) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        models: prev.models.map((item) => (item.id === selectedTarget ? updater(item) : item)),
      };
    });
    setError('');
    setNotice('');
  };

  const resetCurrentTarget = () => {
    if (!snapshot || !draft) return;
    if (isDefaultSelected) {
      const restored = snapshot.builtinDefaultPrompt;
      setDraft((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          defaultCustomized: false,
          defaultPrompt: restored,
          defaultMode: 'replace',
          defaultPreserveDynamicContext: true,
          models: prev.models.map((item) => (
            item.customized
              ? { ...item, defaultPrompt: restored }
              : { ...item, prompt: restored, defaultPrompt: restored }
          )),
        };
      });
    } else if (activeModel) {
      updateActiveModel((item) => ({
        ...item,
        customized: false,
        prompt: draft.defaultPrompt,
        defaultPrompt: draft.defaultPrompt,
        mode: 'replace',
        preserveDynamicContext: true,
      }));
    }
    setError('');
    setNotice(t('agents.catalog.restored'));
  };

  const resetAllTargets = () => {
    if (!snapshot) return;
    const restored = snapshot.builtinDefaultPrompt;
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        defaultCustomized: false,
        defaultPrompt: restored,
        defaultMode: 'replace',
        defaultPreserveDynamicContext: true,
        models: prev.models.map((item) => ({
          ...item,
          customized: false,
          prompt: restored,
          defaultPrompt: restored,
          mode: 'replace',
          preserveDynamicContext: true,
        })),
      };
    });
    setError('');
    setNotice(t('agents.catalog.restored'));
  };

  const requestClose = async () => {
    if (saving) return;
    if (dirty) {
      const confirmed = await askConfirmation({
        title: t('agents.catalog.unsaved'),
        message: t('agents.catalog.discardHint'),
        confirmText: t('agents.catalog.discard'),
        cancelText: t('agents.catalog.keepEditing'),
        variant: 'danger',
      });
      if (!confirmed) return;
    }
    onClose();
  };

  const save = async () => {
    if (!draft || !snapshot || saving) return;
    if (draft.defaultCustomized && !draft.defaultPrompt.trim()) {
      setError(t('agents.systemPrompt.emptyError'));
      setSelectedTarget(DEFAULT_TARGET_ID);
      return;
    }
    const invalidModel = draft.models.find((item) => item.customized && !item.prompt.trim());
    if (invalidModel) {
      setError(t('agents.systemPrompt.emptyError'));
      setSelectedTarget(invalidModel.id);
      return;
    }

    setSaving(true);
    setError('');
    setNotice('');
    try {
      const next = await saveAgentSystemPromptEditor({
        client,
        defaultCustomized: draft.defaultCustomized,
        defaultPrompt: draft.defaultPrompt,
        defaultMode: draft.defaultMode,
        defaultPreserveDynamicContext: draft.defaultPreserveDynamicContext,
        models: draft.models.map((item) => ({
          id: item.id,
          customized: item.customized,
          prompt: item.prompt,
          mode: item.mode,
          preserveDynamicContext: item.preserveDynamicContext,
        })),
      });
      setSnapshot(next);
      setDraft(snapshotToDraft(next));
      setNotice(t('agents.systemPrompt.saved'));
      await onSaved();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setSaving(false);
    }
  };

  const sourceLabelKey =
    snapshot?.defaultSource === 'installed'
      ? 'agents.systemPrompt.source.installed'
      : snapshot?.defaultSource === 'observed'
        ? 'agents.systemPrompt.source.observed'
        : 'agents.systemPrompt.source.template';

  const currentCustomized = isDefaultSelected
    ? Boolean(draft?.defaultCustomized)
    : Boolean(activeModel?.customized);

  const currentMode: PromptRewriteMode = isDefaultSelected
    ? (draft?.defaultMode ?? 'replace')
    : (activeModel?.mode ?? 'replace');

  const currentPreserveDynamic = isDefaultSelected
    ? Boolean(draft?.defaultPreserveDynamicContext ?? true)
    : Boolean(activeModel?.preserveDynamicContext ?? true);

  const currentPromptValue = isDefaultSelected
    ? (draft?.defaultPrompt ?? '')
    : (activeModel?.prompt ?? '');

  const hasAnyCustomization = Boolean(
    draft?.defaultCustomized || draft?.models.some((item) => item.customized),
  );

  return (
    <Dialog
      className="config-dialog codex-catalog-dialog"
      backdropClassName="codex-catalog-backdrop"
      labelledBy="agent-system-prompt-title"
      onClose={() => void requestClose()}
      closeDisabled={saving}
      dismissOnBackdrop
    >
      <header className="config-dialog-heading codex-catalog-heading">
        <div>
          <h2 id="agent-system-prompt-title">
            {t('agents.systemPrompt.title', { name: clientName })}
          </h2>
          <p>{t('agents.systemPrompt.subtitle', { name: clientName })}</p>
        </div>
        <button
          type="button"
          className="icon-button quiet"
          onClick={() => void requestClose()}
          disabled={saving}
          aria-label={t('common.close')}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className="surface-section codex-catalog-body">
        <aside className="codex-catalog-sidebar">
          <div className="codex-catalog-search search-control" data-size="default">
            <Search size={15} aria-hidden />
            <input
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder={t('agents.catalog.search')}
            />
          </div>

          <div
            className="codex-catalog-models"
            role="listbox"
            aria-label={t('agents.systemPrompt.title', { name: clientName })}
          >
            {loading ? (
              <div className="codex-catalog-state">
                <LoaderCircle size={18} className="spin" />
                {t('agents.catalog.loading')}
              </div>
            ) : draft ? (
              <>
                <div className="codex-catalog-row">
                  <button
                    type="button"
                    role="option"
                    aria-selected={isDefaultSelected}
                    className={isDefaultSelected ? 'active' : ''}
                    onClick={() => setSelectedTarget(DEFAULT_TARGET_ID)}
                  >
                    <div className="codex-catalog-model-row-top">
                      <strong>{t('agents.systemPrompt.defaultTarget')}</strong>
                    </div>
                    <span>{t('agents.systemPrompt.defaultScopeHint')}</span>
                    <small>
                      {t(sourceLabelKey)}
                      {draft.defaultCustomized ? ` · ${t('agents.catalog.customized')}` : ''}
                    </small>
                  </button>
                </div>

                {filteredModels.map((model) => (
                  <div className="codex-catalog-row" key={model.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedTarget === model.id}
                      className={selectedTarget === model.id ? 'active' : ''}
                      onClick={() => setSelectedTarget(model.id)}
                    >
                      <div className="codex-catalog-model-row-top">
                        <strong>{model.id}</strong>
                      </div>
                      <small>
                        {model.customized
                          ? t('agents.catalog.customized')
                          : t('agents.systemPrompt.inherited')}
                      </small>
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <div className="codex-catalog-state">{t('agents.catalog.empty')}</div>
            )}
          </div>
        </aside>

        <main className="codex-catalog-editor">
          {draft && !loading && (isDefaultSelected || activeModel) ? (
            <>
              <div className="codex-catalog-model-heading">
                <div>
                  <h3>
                    {isDefaultSelected
                      ? t('agents.systemPrompt.defaultTarget')
                      : activeModel?.id}
                  </h3>
                  <span className={currentCustomized ? 'customized' : ''}>
                    {isDefaultSelected
                      ? t(sourceLabelKey)
                      : t('agents.systemPrompt.inherited')}
                    {currentCustomized ? ` · ${t('agents.catalog.customized')}` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button small-button"
                  onClick={resetCurrentTarget}
                  disabled={saving || !currentCustomized}
                >
                  <RotateCcw size={14} />
                  {t('agents.systemPrompt.resetCurrent')}
                </button>
              </div>

              <div className="codex-catalog-form">
                <label className="wide">
                  <span>{t('agents.systemPrompt.mode')}</span>
                  <Select
                    value={currentMode}
                    onChange={(event) => {
                      const nextMode = event.currentTarget.value as PromptRewriteMode;
                      if (isDefaultSelected) {
                        updateDefaultMode(nextMode);
                      } else if (activeModel) {
                        updateActiveModel((item) => ({
                          ...item,
                          customized: true,
                          mode: nextMode,
                        }));
                      }
                    }}
                  >
                    <option value="replace">{t('agents.systemPrompt.mode.replace')}</option>
                    <option value="prepend">{t('agents.systemPrompt.mode.prepend')}</option>
                    <option value="append">{t('agents.systemPrompt.mode.append')}</option>
                  </Select>
                </label>

                {currentMode === 'replace' ? (
                  <label className="wide codex-catalog-option">
                    <Checkbox
                      checked={currentPreserveDynamic}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        if (isDefaultSelected) {
                          updateDefaultPreserveDynamic(checked);
                        } else if (activeModel) {
                          updateActiveModel((item) => ({
                            ...item,
                            customized: true,
                            preserveDynamicContext: checked,
                          }));
                        }
                      }}
                    />
                    <span>{t('agents.systemPrompt.preserveDynamic')}</span>
                  </label>
                ) : null}

                <label className="wide">
                  <span>{t('agents.systemPrompt.fieldLabel')}</span>
                  <textarea
                    className="codex-catalog-system-prompt"
                    rows={14}
                    spellCheck={false}
                    value={currentPromptValue}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (isDefaultSelected) {
                        updateDefaultPrompt(value);
                      } else if (activeModel) {
                        updateActiveModel((item) => ({
                          ...item,
                          customized:
                            value !== draft.defaultPrompt
                            || item.mode !== 'replace'
                            || !item.preserveDynamicContext,
                          prompt: value,
                        }));
                      }
                    }}
                    aria-describedby="agent-system-prompt-hint"
                  />
                  <small id="agent-system-prompt-hint">
                    {isDefaultSelected
                      ? t('agents.systemPrompt.fieldHintDefault', { name: clientName })
                      : t('agents.systemPrompt.fieldHintModel', { model: activeModel?.id ?? '' })}
                  </small>
                </label>
              </div>

              {currentMode === 'replace' ? (
                <p className="codex-catalog-hint">
                  {t('agents.systemPrompt.preserveDynamicHint')}
                </p>
              ) : null}
              <p className="codex-catalog-hint" role="note">
                {snapshot?.proxyActive && snapshot.proxyPort
                  ? t('agents.systemPrompt.proxyActiveNotice', { port: snapshot.proxyPort })
                  : t('agents.systemPrompt.proxyInactiveNotice')}
              </p>
            </>
          ) : !loading ? (
            <div className="codex-catalog-state">{t('agents.catalog.empty')}</div>
          ) : null}
        </main>
      </div>

      <footer className="codex-catalog-footer">
        <div className="codex-catalog-footer-sidebar">
          <button
            type="button"
            className="secondary-button codex-catalog-reload"
            onClick={() => void load()}
            disabled={loading || saving || dirty}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            {t('agents.catalog.reload')}
          </button>
        </div>
        <div className="codex-catalog-footer-hint">
          {error ? <MessageNotice message={error} onDismiss={() => setError('')} /> : null}
          <MessageNotice tone="success" message={!error ? notice : null} onDismiss={() => setNotice('')} />
          <span>{dirty ? t('agents.catalog.unsaved') : t('agents.catalog.saveHint')}</span>
        </div>
        <div className="codex-catalog-footer-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={resetAllTargets}
            disabled={loading || saving || !hasAnyCustomization}
          >
            {t('agents.systemPrompt.resetAll')}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void requestClose()}
            disabled={saving}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void save()}
            disabled={!snapshot || !dirty || loading || saving}
          >
            {saving ? <LoaderCircle size={16} className="spin" /> : null}
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </footer>

      {confirmationDialog}
    </Dialog>
  );
}
