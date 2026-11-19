import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, RefreshCw, RotateCcw, X } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { SystemPromptField } from './SystemPromptField';
import { Checkbox } from '../components/Checkbox';
import { Select } from '../components/Select';
import { Switch } from '../components/Switch';
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

// Model IDs are prefixed in the picker so they cannot collide with the agent scope.
const DEFAULT_TARGET_ID = '';
const modelTarget = (id: string) => `model:${id}`;

type DraftState = {
  overridesEnabled: boolean | null;
  defaultCustomized: boolean;
  defaultPrompt: string;
  defaultMode: PromptRewriteMode;
  defaultPreserveDynamicContext: boolean;
  models: AgentSystemPromptEditorModel[];
};

function supportsOverrideSwitch(client: AgentClientId): boolean {
  return client === 'claude-code' || client === 'claude-desktop';
}

function hasUncapturedClaudePrompt(snapshot: AgentSystemPromptEditorSnapshot): boolean {
  return snapshot.defaultSource === 'template'
    && supportsOverrideSwitch(snapshot.client);
}

function resetPrompt(snapshot: AgentSystemPromptEditorSnapshot): string {
  return hasUncapturedClaudePrompt(snapshot) ? '' : snapshot.builtinDefaultPrompt;
}

function snapshotToDraft(snapshot: AgentSystemPromptEditorSnapshot): DraftState {
  const uncapturedClaude = hasUncapturedClaudePrompt(snapshot);
  // The fallback template is not the original client prompt.
  const defaultPrompt = uncapturedClaude && !snapshot.defaultCustomized ? '' : snapshot.defaultPrompt;
  return {
    overridesEnabled: snapshot.overridesEnabled ?? null,
    defaultCustomized: snapshot.defaultCustomized,
    defaultPrompt,
    defaultMode: snapshot.defaultMode,
    defaultPreserveDynamicContext: snapshot.defaultPreserveDynamicContext,
    models: snapshot.models.map((item) => ({
      ...item,
      ...(uncapturedClaude && {
        prompt: item.customized ? item.prompt : defaultPrompt,
        defaultPrompt,
      }),
    })),
  };
}

// A TLS-enabled kernel only blocks turning rewriting on; clearing every override must stay
// possible so the plaintext loopback can be switched off.
function draftKeepsOverrides(draft: DraftState | null): boolean {
  if (!draft || draft.overridesEnabled === false) return false;
  return (
    (draft.defaultCustomized && draft.defaultPrompt.trim().length > 0) ||
    draft.models.some((item) => item.customized && item.prompt.trim().length > 0)
  );
}

function sameDraftAndSnapshot(
  draft: DraftState | null,
  snapshot: AgentSystemPromptEditorSnapshot | null,
): boolean {
  if (!draft || !snapshot) return true;
  if (draft.overridesEnabled !== (snapshot.overridesEnabled ?? null)) return false;
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
        current === DEFAULT_TARGET_ID || next.models.some((m) => modelTarget(m.id) === current)
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

  const isDefaultSelected = selectedTarget === DEFAULT_TARGET_ID;
  const activeModel = useMemo(
    () => (isDefaultSelected || !draft ? null : draft.models.find((m) => modelTarget(m.id) === selectedTarget) ?? null),
    [draft, isDefaultSelected, selectedTarget],
  );

  const uncapturedClaude = snapshot !== null && hasUncapturedClaudePrompt(snapshot);

  const updateDefaultPrompt = (nextPrompt: string) => {
    if (!snapshot) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const customized = uncapturedClaude
        ? nextPrompt !== '' || snapshot.defaultCustomized
        : nextPrompt !== snapshot.builtinDefaultPrompt
          || prev.defaultMode !== 'replace'
          || !prev.defaultPreserveDynamicContext;
      return {
        ...prev,
        defaultCustomized: customized,
        defaultPrompt: nextPrompt,
        defaultMode: customized ? prev.defaultMode : 'replace',
        defaultPreserveDynamicContext: customized ? prev.defaultPreserveDynamicContext : true,
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
      if (!prev || (uncapturedClaude && !prev.defaultPrompt.trim())) return prev;
      const customized =
        uncapturedClaude || prev.defaultPrompt !== snapshot.builtinDefaultPrompt
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
      if (!prev || (uncapturedClaude && !prev.defaultPrompt.trim())) return prev;
      const customized =
        uncapturedClaude || prev.defaultPrompt !== snapshot.builtinDefaultPrompt
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
        models: prev.models.map((item) => (modelTarget(item.id) === selectedTarget ? updater(item) : item)),
      };
    });
    setError('');
    setNotice('');
  };

  const resetCurrentTarget = () => {
    if (!snapshot || !draft) return;
    if (isDefaultSelected) {
      const restored = resetPrompt(snapshot);
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
    const restored = resetPrompt(snapshot);
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
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
        message: t('agents.systemPrompt.discardHint'),
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
      setNotice('');
      setError(t('agents.systemPrompt.emptyError'));
      setSelectedTarget(DEFAULT_TARGET_ID);
      return;
    }
    const invalidModel = draft.models.find((item) => item.customized && !item.prompt.trim());
    if (invalidModel) {
      setNotice('');
      setError(t('agents.systemPrompt.emptyError'));
      setSelectedTarget(modelTarget(invalidModel.id));
      return;
    }

    setSaving(true);
    setError('');
    setNotice('');
    try {
      const next = await saveAgentSystemPromptEditor({
        client,
        ...(supportsOverrideSwitch(client) && { overridesEnabled: draft.overridesEnabled }),
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
        : uncapturedClaude
          ? 'agents.systemPrompt.source.uncaptured'
          : 'agents.systemPrompt.source.template';

  const currentCustomized = isDefaultSelected
    ? Boolean(draft?.defaultCustomized)
    : Boolean(activeModel?.customized);

  const supportsSwitch = supportsOverrideSwitch(client);
  const hasClaudeDefaultOverride = supportsSwitch && Boolean(draft?.defaultCustomized && draft.defaultPrompt.trim());
  const inheritsClaudeOverride = hasClaudeDefaultOverride && !isDefaultSelected && !currentCustomized;

  const currentMode: PromptRewriteMode = isDefaultSelected || inheritsClaudeOverride
    ? (draft?.defaultMode ?? 'replace')
    : (activeModel?.mode ?? 'replace');

  const currentPreserveDynamic = isDefaultSelected || inheritsClaudeOverride
    ? (draft?.defaultPreserveDynamicContext ?? true)
    : (activeModel?.preserveDynamicContext ?? true);

  const currentPromptValue = isDefaultSelected
    ? (draft?.defaultPrompt ?? '')
    : (activeModel?.prompt ?? '');

  const hasSavedModelOverride = Boolean(snapshot?.models.find((item) => modelTarget(item.id) === selectedTarget)?.customized);
  const hasSavedRules = Boolean(snapshot?.defaultCustomized || snapshot?.models.some((item) => item.customized));
  const savedSwitchOn = snapshot?.overridesEnabled ?? hasSavedRules;
  const switchOn = draft?.overridesEnabled ?? draftKeepsOverrides(draft);
  const hasSavedOverride = Boolean(snapshot?.defaultCustomized || hasSavedModelOverride);
  const showRewriteOptions = !uncapturedClaude || Boolean(currentPromptValue.trim());
  const showBlankHint = uncapturedClaude && !currentCustomized && !inheritsClaudeOverride;
  const inheritedLabelKey = hasClaudeDefaultOverride
    ? 'agents.systemPrompt.inheritedOverride'
    : 'agents.systemPrompt.inherited';

  const updateCurrentPrompt = (value: string) => {
    if (!draft) return;
    if (isDefaultSelected) {
      updateDefaultPrompt(value);
    } else if (activeModel) {
      updateActiveModel((item) => {
        const customized = uncapturedClaude && value === '' && draft.defaultPrompt === ''
          ? hasSavedModelOverride
          : value !== draft.defaultPrompt || item.mode !== 'replace' || !item.preserveDynamicContext;
        return {
          ...item,
          customized,
          prompt: value,
          mode: supportsSwitch ? (customized ? currentMode : 'replace') : item.mode,
          preserveDynamicContext: supportsSwitch
            ? (customized ? currentPreserveDynamic : true)
            : item.preserveDynamicContext,
        };
      });
    }
  };

  const hasAnyCustomization = Boolean(
    draft?.defaultCustomized || draft?.models.some((item) => item.customized),
  );

  const scopeHint = isDefaultSelected
    ? t('agents.systemPrompt.defaultScopeHint')
    : currentCustomized ? t('agents.systemPrompt.modelScopeHint') : t(inheritedLabelKey);
  const invalid = error === t('agents.systemPrompt.emptyError') && !currentPromptValue.trim();

  return (
    <Dialog
      className="config-dialog agent-prompt-dialog"
      backdropClassName="codex-catalog-backdrop"
      labelledBy="agent-system-prompt-title"
      onClose={() => void requestClose()}
      closeDisabled={saving}
      dismissOnBackdrop
    >
      <header className="config-dialog-heading agent-prompt-heading">
        <div>
          <h2 id="agent-system-prompt-title">{t('agents.systemPrompt.title', { name: clientName })}</h2>
          {uncapturedClaude ? <p>{t('agents.systemPrompt.subtitle.uncaptured', { name: clientName })}</p> : null}
        </div>
        <button type="button" className="icon-button quiet" onClick={() => void requestClose()}
          disabled={saving} aria-label={t('common.close')}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className="agent-prompt-body">
        {loading ? (
          <div className="codex-catalog-state" role="status">
            <LoaderCircle size={18} className="spin" aria-hidden="true" />{t('agents.catalog.loading')}
          </div>
        ) : draft && snapshot ? (
          <>
            <div className="agent-prompt-scope surface-section">
              <div className="agent-prompt-select">
                <label htmlFor="agent-prompt-scope">{t('agents.systemPrompt.scope')}</label>
                <Select id="agent-prompt-scope" value={selectedTarget} disabled={saving}
                  aria-describedby="agent-prompt-scope-hint"
                  onChange={(event) => {
                    setSelectedTarget(event.currentTarget.value);
                    if (error === t('agents.systemPrompt.emptyError')) setError('');
                  }}>
                  <option value={DEFAULT_TARGET_ID}>{t('agents.systemPrompt.defaultTarget')}</option>
                  {draft.models.length ? (
                    <optgroup label={t('agents.systemPrompt.modelsHeader')}>
                      {draft.models.map((model) => (
                        <option key={model.id} value={modelTarget(model.id)}>
                          {model.id}{model.customized ? ` · ${t('agents.catalog.customized')}` : ''}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </Select>
              </div>
              {supportsSwitch ? (
                <Switch label={t('agents.systemPrompt.overridesEnabled')} checked={switchOn} disabled={saving}
                  aria-describedby="agent-prompt-switch-hint" onChange={(event) => {
                    const overridesEnabled = event.currentTarget.checked;
                    setDraft((prev) => prev && { ...prev, overridesEnabled });
                    setError('');
                    setNotice('');
                  }} />
              ) : null}
              <small id="agent-prompt-scope-hint">
                <span>{scopeHint}</span>
                {isDefaultSelected && !currentCustomized ? ` · ${t(sourceLabelKey)}` : ''}
                {uncapturedClaude && !hasSavedOverride ? (
                  <span className="agent-prompt-inline-status">{t('agents.systemPrompt.overrideInactive')}</span>
                ) : null}
              </small>
              {supportsSwitch ? (
                <small id="agent-prompt-switch-hint">{t('agents.systemPrompt.overridesEnabledHint')}</small>
              ) : null}
            </div>

            <SystemPromptField value={currentPromptValue} disabled={saving} invalid={invalid}
              hint={t(showBlankHint ? 'agents.systemPrompt.fieldHintUncaptured' : 'agents.systemPrompt.resetHint')}
              onChange={updateCurrentPrompt} />

            {showRewriteOptions ? (
              <div className="agent-prompt-options surface-section">
                <div className="agent-prompt-select">
                  <label htmlFor="agent-prompt-mode">{t('agents.systemPrompt.mode')}</label>
                  <Select id="agent-prompt-mode" value={currentMode} disabled={saving} onChange={(event) => {
                    const mode = event.currentTarget.value as PromptRewriteMode;
                    if (isDefaultSelected) updateDefaultMode(mode);
                    else if (activeModel) updateActiveModel((item) => ({ ...item, customized: true, mode, preserveDynamicContext: currentPreserveDynamic }));
                  }}>
                    <option value="replace">{t('agents.systemPrompt.mode.replace')}</option>
                    <option value="prepend">{t('agents.systemPrompt.mode.prepend')}</option>
                    <option value="append">{t('agents.systemPrompt.mode.append')}</option>
                  </Select>
                </div>
                {currentMode === 'replace' ? (
                  <label className="agent-prompt-context">
                    <Checkbox checked={currentPreserveDynamic} disabled={saving} onChange={(event) => {
                      const preserveDynamicContext = event.currentTarget.checked;
                      if (isDefaultSelected) updateDefaultPreserveDynamic(preserveDynamicContext);
                      else if (activeModel) updateActiveModel((item) => ({ ...item, customized: true, mode: currentMode, preserveDynamicContext }));
                    }} />
                    <span>{t('agents.systemPrompt.preserveDynamic')}</span>
                  </label>
                ) : null}
              </div>
            ) : null}
            <div className="agent-prompt-tools">
              <button type="button" className="secondary-button" onClick={resetCurrentTarget}
                disabled={saving || !currentCustomized}>
                <RotateCcw size={14} aria-hidden="true" />
                {t(isDefaultSelected ? 'agents.systemPrompt.resetDefault' : 'agents.systemPrompt.resetModel')}
              </button>
              <button type="button" className="secondary-button" onClick={resetAllTargets}
                disabled={saving || !hasAnyCustomization}>
                {t('agents.systemPrompt.resetAll')}
              </button>
            </div>
          </>
        ) : null}
      </div>

      <footer className="agent-prompt-footer">
        <div className="agent-prompt-status">
          {error ? <MessageNotice message={error} onDismiss={() => setError('')} /> : null}
          <MessageNotice tone="success" message={!error ? notice : null} onDismiss={() => setNotice('')} />
          {snapshot?.coreTlsEnabled ? (
            <div role="note">{t(supportsSwitch ? 'agents.systemPrompt.claudeTlsNotice' : 'agents.systemPrompt.tlsBlockedNotice')}</div>
          ) : snapshot?.proxyActive ? (
            <div role="note">{t('agents.systemPrompt.proxyActiveNotice')}</div>
          ) : supportsSwitch && snapshot ? (
            <div role="note">{t(!savedSwitchOn && hasSavedRules
              ? 'agents.systemPrompt.overridesPaused' : 'agents.systemPrompt.proxyInactiveNotice')}</div>
          ) : null}
          {supportsSwitch && savedSwitchOn !== switchOn ? (
            <div role="status">{t(savedSwitchOn ? 'agents.systemPrompt.pendingPause' : 'agents.systemPrompt.pendingEnable')}</div>
          ) : null}
          {dirty ? <div role="status">{t('agents.catalog.unsaved')}</div> : null}
        </div>
        <div className="agent-prompt-footer-row">
          <div className="agent-prompt-tools">
            <button type="button" className="secondary-button" onClick={() => void load()}
              disabled={loading || saving || dirty}>
              <RefreshCw size={15} aria-hidden="true" />{t('agents.catalog.reload')}
            </button>
          </div>
          <div className="agent-prompt-actions">
            <button type="button" className="secondary-button" onClick={() => void requestClose()} disabled={saving}>
              {t('common.cancel')}
            </button>
            <button type="button" className="primary-button" onClick={() => void save()}
              disabled={!snapshot || !dirty || loading || saving || (snapshot.coreTlsEnabled && draftKeepsOverrides(draft))}>
              {saving ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </footer>
      {confirmationDialog}
    </Dialog>
  );
}
