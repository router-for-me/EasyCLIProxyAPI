import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Switch } from '../../components/Switch';
import { Checkbox } from '../../components/Checkbox';
import { Notice } from '../../components/Notice';
import {
  MODEL_FALLBACK_MAX_HOPS, normalizeModelFallbackCondition, parseModelList, readModelFallback, saveModelFallback,
  validateModelFallback, type ModelFallbackSettings,
} from '../../services/modelFallback';

/** Conditions always offered as toggles; other configured valid codes are kept and shown too. */
const conditionChoices = ['429', '529', 'quota_exhausted', 'auth_unavailable', '408', '500', '502', '503', '504', '5xx'];

type ChainRow = { model: string; targets: string };
export type ModelFallbackDraft = { enabled: boolean; maxHops: number; on: string[]; rows: ChainRow[] };
type FallbackApi = Parameters<typeof readModelFallback>[0];

export function draftFromModelFallback(settings: ModelFallbackSettings): ModelFallbackDraft {
  return {
    enabled: settings.enabled, maxHops: settings.maxHops, on: [...settings.on],
    rows: settings.chains.map(chain => ({ model: chain.model, targets: chain.targets.join(', ') })),
  };
}

export function modelFallbackFromDraft(draft: ModelFallbackDraft): ModelFallbackSettings {
  return {
    enabled: draft.enabled, maxHops: draft.maxHops, on: [...draft.on],
    chains: draft.rows.map(row => ({ model: row.model.trim(), targets: parseModelList(row.targets) })),
  };
}

const sameDraft = (left: ModelFallbackDraft, right: ModelFallbackDraft) =>
  JSON.stringify(modelFallbackFromDraft(left)) === JSON.stringify(modelFallbackFromDraft(right));

export function ModelFallbackPanel({ disabled, onDirtyChange, onBusyChange, onSaveSettled, reloadToken, api, initial }: {
  disabled: boolean; onDirtyChange?: (dirty: boolean) => void; api?: FallbackApi;
  onBusyChange?: (busy: boolean) => void;
  onSaveSettled?: () => Promise<void> | void;
  reloadToken?: number;
  /** Preloaded settings; skips the initial read (used by tests and previews). */
  initial?: ModelFallbackSettings;
}) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<ModelFallbackDraft | null>(() => initial ? draftFromModelFallback(initial) : null);
  const [draft, setDraft] = useState<ModelFallbackDraft | null>(() => initial ? draftFromModelFallback(initial) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [readFailed, setReadFailed] = useState(false);
  const pending = useRef(false);
  const request = useRef(0);
  const changeBusy = useCallback((value: boolean) => {
    pending.current = value; setBusy(value); onBusyChange?.(value);
  }, [onBusyChange]);
  const accept = (settings: ModelFallbackSettings) => { const next = draftFromModelFallback(settings); setSaved(next); setDraft(next); };
  const load = useCallback(async () => {
    const id = ++request.current;
    changeBusy(true); setError(''); setStatus('');
    try {
      const settings = await readModelFallback(api);
      if (id === request.current) { accept(settings); setReadFailed(false); }
    } catch (failure) {
      if (id === request.current) { setError(String(failure)); setReadFailed(true); }
    } finally { if (id === request.current) changeBusy(false); }
  }, [api, changeBusy]);
  useEffect(() => {
    if (!initial || reloadToken) void load();
    return () => { ++request.current; changeBusy(false); };
  }, [initial, load, reloadToken, changeBusy]);
  const dirty = !!saved && !!draft && !sameDraft(saved, draft);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const reload = () => {
    if (!disabled && !pending.current && (!dirty || window.confirm(t('routing.leave')))) void load();
  };
  if (!draft) {
    return <section className="panel surface-panel routing-policy routing-fallback" aria-busy={busy}>
      <header><h2>{t('routing.fallback.title')}</h2><p>{t('routing.fallback.description')}</p></header>
      {error ? <Notice tone="error" variant="text">{error}</Notice> : <p className="routing-policy-hint">{t('routing.loading')}</p>}
      {error && <button type="button" className="secondary-button" disabled={disabled || busy} onClick={reload}><RefreshCw size={14} />{t('routing.refresh')}</button>}
    </section>;
  }
  const settings = modelFallbackFromDraft(draft);
  const invalid = validateModelFallback(settings);
  const locked = disabled || busy;
  const update = (patch: Partial<ModelFallbackDraft>) => { setDraft({ ...draft, ...patch }); setStatus(''); if (!readFailed) setError(''); };
  const updateRow = (index: number, patch: Partial<ChainRow>) => update({ rows: draft.rows.map((row, current) => current === index ? { ...row, ...patch } : row) });
  const toggleCondition = (condition: string, checked: boolean) =>
    update({ on: checked ? [...draft.on, condition] : draft.on.filter(item => item !== condition) });
  const choices = [...conditionChoices, ...draft.on.filter(item => !conditionChoices.includes(item) && normalizeModelFallbackCondition(item))];
  const save = async () => {
    if (disabled || pending.current || !saved || !dirty || invalid || readFailed) return;
    changeBusy(true); setError(''); setStatus('');
    try { accept(await saveModelFallback(settings, modelFallbackFromDraft(saved), api)); setStatus(t('routing.fallback.saved')); }
    catch (failure) { setError(String(failure)); }
    finally {
      // A rejected request may still have reached the core, so recheck the routing revision too.
      try { await onSaveSettled?.(); } catch (failure) { setError(String(failure)); }
      changeBusy(false);
    }
  };
  return <section className="panel surface-panel routing-policy routing-fallback" aria-busy={busy}>
    <header><h2>{t('routing.fallback.title')}</h2><p>{t('routing.fallback.description')}</p></header>
    <div className="routing-setting-row"><div><strong>{t('routing.fallback.enabled')}</strong><p>{t('routing.fallback.enabledDesc')}</p></div>
      <Switch disabled={locked} checked={draft.enabled} aria-label={t('routing.fallback.enabled')} onChange={event => update({ enabled: event.target.checked })} /></div>
    <label className="routing-setting-row routing-setting-row-described"><span className="routing-setting-text"><span>{t('routing.fallback.maxHops')}</span><span className="routing-setting-hint">{t('routing.fallback.maxHopsDesc', { max: MODEL_FALLBACK_MAX_HOPS })}</span></span>
      <input type="number" step={1} min={1} max={MODEL_FALLBACK_MAX_HOPS} disabled={locked} value={Number.isNaN(draft.maxHops) ? '' : draft.maxHops} onChange={event => update({ maxHops: event.target.valueAsNumber })} /></label>
    <fieldset className="routing-fallback-conditions" disabled={locked}>
      <legend>{t('routing.fallback.conditions')}</legend>
      <p className="routing-setting-hint">{t('routing.fallback.conditionsDesc')}</p>
      <div className="routing-fallback-chips">{choices.map(condition => {
        const label = /^\d+$/.test(condition) ? condition : t(`routing.fallback.condition.${condition as 'quota_exhausted' | 'auth_unavailable' | '5xx'}`);
        return <span key={condition} className={draft.on.includes(condition) ? 'routing-fallback-chip routing-fallback-chip-on' : 'routing-fallback-chip'}>
          <Checkbox checked={draft.on.includes(condition)} label={label} onChange={event => toggleCondition(condition, event.target.checked)} />
        </span>;
      })}</div>
    </fieldset>
    <div className="routing-fallback-chains">
      <span className="routing-policy-label">{t('routing.fallback.chains')}</span>
      <p className="routing-setting-hint">{t('routing.fallback.chainsDesc')}</p>
      {draft.rows.length === 0 && <p className="routing-setting-hint">{t('routing.fallback.noChains')}</p>}
      {draft.rows.map((row, index) => <div className="routing-fallback-chain" key={index}>
        <input aria-label={t('routing.fallback.model')} placeholder={t('routing.fallback.modelPlaceholder')} disabled={locked} value={row.model} onChange={event => updateRow(index, { model: event.target.value })} />
        <span aria-hidden="true">→</span>
        <input aria-label={t('routing.fallback.targets')} placeholder={t('routing.fallback.targetsPlaceholder')} disabled={locked} value={row.targets} onChange={event => updateRow(index, { targets: event.target.value })} />
        <button type="button" className="icon-button" disabled={locked} aria-label={t('routing.fallback.removeChain')} title={t('routing.fallback.removeChain')} onClick={() => update({ rows: draft.rows.filter((_, current) => current !== index) })}><Trash2 size={14} /></button>
      </div>)}
      <button type="button" className="secondary-button" disabled={locked} onClick={() => update({ rows: [...draft.rows, { model: '', targets: '' }] })}><Plus size={14} />{t('routing.fallback.addChain')}</button>
    </div>
    <p className="routing-setting-hint">{t('routing.fallback.homeNote')}</p>
    {dirty && invalid && <Notice tone="error" variant="text">{invalid}</Notice>}
    {error && <Notice tone="error" variant="text">{error}</Notice>}
    {status && <Notice tone="success" variant="text">{status}</Notice>}
    <div className="routing-fallback-actions">
      <button type="button" className="secondary-button" disabled={locked} onClick={reload}><RefreshCw size={14} />{t('routing.refresh')}</button>
      <button type="button" className="secondary-button" disabled={!dirty || locked} onClick={() => { if (saved) { setDraft(saved); setStatus(''); if (!readFailed) setError(''); } }}>{t('routing.reset')}</button>
      <button type="button" className="primary-button" disabled={locked || readFailed || !dirty || !!invalid} onClick={() => void save()}><Save size={14} />{t(busy ? 'routing.saving' : 'routing.fallback.save')}</button>
    </div>
  </section>;
}
