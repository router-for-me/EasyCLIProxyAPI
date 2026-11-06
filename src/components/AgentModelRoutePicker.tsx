import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { AgentModelPicker, type AgentModelPickerProps } from './AgentModelPicker';
import { Notice } from './Notice';
import { useI18n } from '../i18n';
import { APP_NAVIGATION_REQUEST_EVENT } from '../navigation';
import type { AgentClientId } from '../services/agents';
import type { ModelOption } from '../services/modelService';
import {
  moveAgentFallback, readAgentModelFallback, saveAgentModelFallback, validAgentFallbackTargets,
  type AgentModelFallback,
} from '../services/agentModelFallback';
import './AgentModelRoutePicker.css';

type RouteContext = {
  client: AgentClientId;
  models: ModelOption[];
  onPrepared: (route: AgentModelFallback) => void;
  onState: (slot: string, state: { busy: boolean; dirty: boolean }) => void;
};
export const AgentModelFallbackContext = createContext<RouteContext | null>(null);

/** A model picker with an optional, isolated fallback chain for this client slot. */
export function AgentModelRoutePicker(props: AgentModelPickerProps & { slot: string }) {
  const scope = useContext(AgentModelFallbackContext);
  if (!scope) return <AgentModelPicker {...props} />;
  return <ScopedModelRoutePicker key={`${scope.client}:${props.slot}`} {...props} scope={scope} />;
}

function ScopedModelRoutePicker({ slot, scope, ...picker }: AgentModelPickerProps & { slot: string; scope: RouteContext }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState<AgentModelFallback | null>(null);
  const [draft, setDraft] = useState<AgentModelFallback | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState<AgentModelFallback | null>(null);
  const generation = useRef(0);
  const current = useRef({ picker, scope });
  current.current = { picker, scope };
  const dirty = !!baseline && !!draft && (baseline.primary !== draft.primary || JSON.stringify(baseline.fallbacks) !== JSON.stringify(draft.fallbacks));
  const isManaged = picker.value.startsWith('claude-cpa-fallback-');
  const scopeID = `${scope.client}:${slot}`;

  const load = async () => {
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const route = await readAgentModelFallback({ client: scope.client, slot, model: picker.value });
      if (generation.current !== request) return;
      setBaseline(route); setDraft(route);
      if (route.fallbacks.length) setOpen(true);
    } catch (failure) {
      if (generation.current === request) setError(String(failure));
    } finally { if (generation.current === request) setLoading(false); }
  };

  useEffect(() => {
    setBaseline(null); setDraft(null); setError('');
    if (isManaged) setOpen(true);
    if (open || isManaged) void load();
    return () => { generation.current++; };
    // A new selected model starts a new edit scope. Refresh explicitly after conflicts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.client, slot, picker.value]);

  useEffect(() => {
    current.current.scope.onState(scopeID, { busy: saving, dirty });
  }, [scopeID, saving, dirty]);
  useEffect(() => () => current.current.scope.onState(scopeID, { busy: false, dirty: false }), [scopeID]);

  useEffect(() => {
    const navigate = (event: Event) => {
      if (event.defaultPrevented) return;
      if (saving || (dirty && !window.confirm(t('routing.leave')))) event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (saving || dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener(APP_NAVIGATION_REQUEST_EVENT, navigate);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener(APP_NAVIGATION_REQUEST_EVENT, navigate);
      window.removeEventListener('beforeunload', unload);
    };
  }, [dirty, saving, t]);

  useEffect(() => {
    if (!prepared || !scope.models.some(model => model.name === prepared.model)) return;
    // Parent has inserted the new alias into its model catalog. Selection handlers
    // can now validate it using the current render, not a stale models closure.
    current.current.picker.onChange(prepared.model);
    setPrepared(null);
  }, [prepared, scope.models]);

  const save = async () => {
    if (!draft || !baseline || saving) return;
    const request = ++generation.current;
    setSaving(true); setError('');
    try {
      const route = await saveAgentModelFallback({ client: scope.client, slot, model: picker.value }, draft);
      if (generation.current !== request) return;
      setBaseline(route); setDraft(route);
      current.current.scope.onPrepared(route);
      setPrepared(route);
    } catch (failure) {
      if (generation.current === request) setError(String(failure));
    } finally { if (generation.current === request) setSaving(false); }
  };

  const primary = draft?.primary ?? picker.value;
  const selectPrimary = (value: string) => {
    if (draft && (draft.fallbacks.length > 0 || isManaged)) setDraft({ ...draft, primary: value });
    else picker.onChange(value);
  };
  const locked = picker.disabled || saving || loading;
  const allModels = scope.models.filter(model => !model.name.startsWith('claude-cpa-fallback-'));
  const targets = draft?.fallbacks ?? [];
  return <div className="agent-model-route" data-slot={slot}>
    <AgentModelPicker {...picker} models={picker.models.filter(model => !model.name.startsWith('claude-cpa-fallback-'))}
      value={primary} preserveValue disabled={locked} onChange={selectPrimary} />
    <button type="button" className="link-button" aria-expanded={open} disabled={picker.disabled || saving || !picker.value}
      onClick={() => { const next = !open; setOpen(next); if (next && !baseline && !loading) void load(); }}>
      {t('routing.agentFallback.title')}{targets.length ? ` (${targets.length})` : ''}
    </button>
    {open && <div className="agent-model-route-details">
      <p className="agent-model-hint">{t('routing.agentFallback.description')}</p>
      {loading && <p className="agent-model-hint">{t('routing.loading')}</p>}
      {error && <Notice tone="error" variant="text" action={
        <button type="button" className="secondary-button compact-button" disabled={saving || loading} onClick={() => { if (!dirty || window.confirm(t('routing.leave'))) void load(); }}>{t('routing.refresh')}</button>
      }>{error}</Notice>}
      {draft && <>
        {targets.map((model, index) => <div className="agent-model-route-target" key={index}>
          <span className="agent-model-route-index">{t('routing.agentFallback.target', { index: index + 1 })}</span>
          <AgentModelPicker models={allModels} value={model} preserveValue loading={picker.loading} error={picker.error}
            disabled={locked} onRefresh={picker.onRefresh} onChange={value => setDraft({ ...draft, fallbacks: targets.map((entry, i) => i === index ? value : entry) })} />
          <div className="agent-model-route-actions">
            <button type="button" className="icon-button quiet" disabled={locked || index === 0} aria-label={t('routing.agentFallback.up')} title={t('routing.agentFallback.up')} onClick={() => setDraft({ ...draft, fallbacks: moveAgentFallback(targets, index, -1) })}><ArrowUp size={14} /></button>
            <button type="button" className="icon-button quiet" disabled={locked || index === targets.length - 1} aria-label={t('routing.agentFallback.down')} title={t('routing.agentFallback.down')} onClick={() => setDraft({ ...draft, fallbacks: moveAgentFallback(targets, index, 1) })}><ArrowDown size={14} /></button>
            <button type="button" className="icon-button quiet" disabled={locked} aria-label={t('routing.agentFallback.remove')} title={t('routing.agentFallback.remove')} onClick={() => setDraft({ ...draft, fallbacks: targets.filter((_, i) => i !== index) })}><Trash2 size={14} /></button>
          </div>
        </div>)}
        <div className="agent-model-route-actions">
          <button type="button" className="secondary-button compact-button" disabled={locked || targets.length >= 8} onClick={() => setDraft({ ...draft, fallbacks: [...targets, ''] })}><Plus size={14} />{t('routing.agentFallback.add')}</button>
          <button type="button" className="secondary-button compact-button" disabled={locked || !dirty} onClick={() => { setDraft(baseline); setError(''); }}>{t('routing.reset')}</button>
          <button type="button" className="primary-button compact-button" disabled={locked || !dirty || !validAgentFallbackTargets(primary, targets)} onClick={() => void save()}>{t(saving ? 'routing.saving' : 'routing.agentFallback.use')}</button>
        </div>
        {dirty && !validAgentFallbackTargets(primary, targets) && <Notice tone="warn" variant="text">{t('routing.agentFallback.invalid')}</Notice>}
        <p className="agent-model-hint">{t('routing.agentFallback.applyHint')}</p>
      </>}
    </div>}
  </div>;
}
