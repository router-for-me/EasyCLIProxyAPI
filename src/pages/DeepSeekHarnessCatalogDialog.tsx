import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LoaderCircle, RefreshCw, RotateCcw, Search, Settings2, X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import {
  harnessDraft, harnessReasoningLevels, harnessSchema, isHarnessRecord, parseHarnessDraft, sameHarnessDraft, updateHarnessDraft,
  type HarnessDraft, type HarnessEditorSnapshot, type HarnessProfile,
} from '../services/deepSeekHarnessCatalog';

function HarnessFields({ group, draft, defaults = {}, prefix = '', api, onChange }: {
  group: string; draft: HarnessDraft; defaults?: HarnessProfile; prefix?: string; api: string;
  onChange: (next: HarnessDraft) => void;
}) {
  const { t } = useI18n();
  const label = (name: string) => t(`agents.harness.field.${name}` as MessageKey);
  return <div className="codex-catalog-form harness-catalog-form">{harnessSchema[group].map(field => {
    const key = `${prefix}${field.name}`;
    const value = draft[key] ?? '';
    const supplied = defaults[field.name] ?? field.default;
    const automatic = `${t('agents.harness.auto')}${supplied === undefined ? '' : ` (${typeof supplied === 'string' ? supplied : JSON.stringify(supplied)})`}`;
    const set = (next: string) => onChange(updateHarnessDraft(draft, key, next));
    if (field.apis && !field.apis.includes(api) && !value) return null;
    if (field.group) {
      const customized = Object.keys(draft).some(k => k.startsWith(`${key}.`));
      return <details className="harness-catalog-group" key={key}>
        <summary>{label(field.name)}{customized ? ` · ${t('agents.catalog.customized')}` : ''}</summary>
        <p className="codex-catalog-hint">{t(`agents.harness.hint.${field.name}` as MessageKey)}</p>
        <HarnessFields group={field.group} draft={draft} defaults={isHarnessRecord(supplied) ? supplied : {}} prefix={`${key}.`} api={api} onChange={onChange} />
        {customized ? <button type="button" className="secondary-button" onClick={() => onChange(Object.fromEntries(Object.entries(draft).filter(([k]) => !k.startsWith(`${key}.`))))}>{t('agents.harness.resetGroup')}</button> : null}
      </details>;
    }
    if (field.kind === 'reasoning') {
      let mapping: HarnessProfile = {};
      try { const parsed: unknown = JSON.parse(value || '{}'); if (isHarnessRecord(parsed)) mapping = parsed; } catch {}
      return <div className="harness-reasoning wide" key={key}>
        <label><span>{label(field.name)}</span><select aria-label={label(field.name)} value={!value ? '' : value === 'false' ? 'false' : 'custom'}
          onChange={e => set(e.currentTarget.value === 'custom' ? JSON.stringify({ off: null, low: 'low', medium: 'medium', high: 'high' }) : e.currentTarget.value)}>
          <option value="">{automatic}</option><option value="false">{t('agents.harness.reasoningDisabled')}</option><option value="custom">{t('agents.harness.reasoningCustom')}</option>
        </select></label>
        {value && value !== 'false' ? <div className="harness-reasoning-levels">{harnessReasoningLevels.map(level => <div key={level}>
          <label><input type="checkbox" checked={Object.prototype.hasOwnProperty.call(mapping, level)} onChange={e => {
            const next = { ...mapping }; if (e.currentTarget.checked) next[level] = level === 'off' ? null : level; else delete next[level]; set(JSON.stringify(next));
          }} />{level}</label>
          {Object.prototype.hasOwnProperty.call(mapping, level) ? <input aria-label={`${level} reasoning_effort`} value={String(mapping[level] ?? '')} placeholder={level === 'off' ? t('agents.harness.noWireValue') : level}
            onChange={e => set(JSON.stringify({ ...mapping, [level]: level === 'off' && !e.currentTarget.value ? null : e.currentTarget.value }))} /> : null}
        </div>)}</div> : null}
        <small>{t('agents.harness.hint.reasoningEfforts')}</small>
      </div>;
    }
    const jsonField = ['headers', 'kwargs', 'strings'].includes(field.kind);
    return <label key={key} className={jsonField ? 'wide' : undefined}>
      <span title={field.name}>{label(field.name)}{Object.prototype.hasOwnProperty.call(draft, key) ? <small className="harness-override">{t('agents.catalog.customized')}</small> : null}</span>
      {['enum', 'boolean', 'modalities'].includes(field.kind) ? <select aria-label={label(field.name)} value={value} onChange={e => set(e.currentTarget.value)}>
        <option value="">{automatic}</option>
        {field.kind === 'boolean' ? <><option value="true">{t('agents.harness.yes')}</option><option value="false">{t('agents.harness.no')}</option></> : null}
        {field.kind === 'enum' ? field.values!.map(v => <option key={v} value={v}>{v}</option>) : null}
        {field.kind === 'modalities' ? <>{field.name === 'input' ? <option value="[]">{t('agents.harness.providerInput')}</option> : null}<option value='["text"]'>{t('agents.harness.textOnly')}</option><option value='["text","image"]'>{t('agents.harness.textImage')}</option><option value='["image"]'>{t('agents.catalog.image')}</option></> : null}
      </select> : jsonField ? <textarea aria-label={label(field.name)} rows={4} spellCheck={false} value={value} placeholder={JSON.stringify(supplied ?? field.example, null, 2) ?? automatic} onChange={e => set(e.currentTarget.value)} />
        : <input aria-label={label(field.name)} type={['integer', 'number'].includes(field.kind) ? 'number' : 'text'} min={field.min ?? field.exclusiveMin} max={field.max} step={field.kind === 'integer' ? 1 : 'any'} value={value} placeholder={automatic} onChange={e => set(e.currentTarget.value)} />}
      {['input', 'defaultInput', 'maxTokens', 'defaultMaxTokens', 'api', 'headers'].includes(field.name) ? <small>{t(`agents.harness.hint.${field.name}` as MessageKey)}</small> : null}
    </label>;
  })}</div>;
}

export function DeepSeekHarnessCatalogDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void | Promise<void> }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<HarnessEditorSnapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, HarnessDraft>>({});
  const [provider, setProvider] = useState<HarnessDraft>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<'close' | 'reload' | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const install = (next: HarnessEditorSnapshot) => {
    setSnapshot(next);
    setDrafts(Object.fromEntries(next.models.map(m => [m.id, harnessDraft(m.configuration, 'model')])));
    setProvider(harnessDraft(next.provider, 'provider'));
  };
  const load = useCallback(async () => {
    setLoading(true); setError(''); setNotice('');
    try {
      const next = await invoke<HarnessEditorSnapshot>('get_deepseek_harness_model_catalog_editor');
      install(next);
      setSelected(current => current && next.models.some(m => m.id === current) ? current : next.defaultModel ?? next.models[0]?.id ?? null);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const dirty = !!snapshot && (!sameHarnessDraft(provider, harnessDraft(snapshot.provider, 'provider'))
    || snapshot.models.some(m => !sameHarnessDraft(drafts[m.id] ?? {}, harnessDraft(m.configuration, 'model'))));
  const close = () => { if (!saving) { if (dirty) setConfirmation('close'); else onClose(); } };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); if (confirmation) setConfirmation(null); else close(); }
      if (event.key === 'Tab') {
        const scope = confirmation ? dialogRef.current?.querySelector('[role="alertdialog"]') : dialogRef.current;
        const targets = [...(scope?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary') ?? [])].filter(el => el.getClientRects().length);
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });
  const active = snapshot?.models.find(m => m.id === selected);
  const api = provider.api || 'openai-completions';
  const changed = () => { setNotice(''); setError(''); };
  const save = async () => {
    if (!snapshot || saving || loading) return;
    let request;
    try {
      let configuration;
      try { configuration = parseHarnessDraft(provider, 'provider', api); }
      catch (e) { setSelected(null); throw e; }
      request = { revision: snapshot.revision, provider: configuration, models: snapshot.models.map(m => {
        try { return { ...m, configuration: parseHarnessDraft(drafts[m.id] ?? {}, 'model', api) }; }
        catch (e) { setSelected(m.id); throw e; }
      }) };
    } catch (e) { setError(t('agents.harness.invalid', { field: String(e).replace(/^Error: /, '') })); return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const next = await invoke<HarnessEditorSnapshot>('save_deepseek_harness_model_catalog_editor', { request });
      install(next); setNotice(t(next.configured ? 'agents.harness.saved' : 'agents.harness.savedDraft'));
      await onSaved();
    } catch (e) { setError(String(e).includes('DSH_MODEL_CATALOG_CHANGED') ? t('agents.harness.changed') : String(e)); }
    finally { setSaving(false); }
  };
  return <div className="config-dialog-backdrop codex-catalog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <section ref={dialogRef} className="config-dialog codex-catalog-dialog harness-catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="harness-catalog-title">
      <header className="config-dialog-heading codex-catalog-heading"><div><h2 id="harness-catalog-title">{t('agents.harness.title')}</h2><p>{t('agents.harness.subtitle')}</p></div><button className="icon-button quiet" onClick={close} disabled={saving} aria-label={t('common.close')}><X size={18} /></button></header>
      <div className="codex-catalog-body">
        <aside className="codex-catalog-sidebar">
          <button className={`secondary-button harness-provider-button${selected === null ? ' active' : ''}`} onClick={() => setSelected(null)}><Settings2 size={16} />{t('agents.harness.provider')}</button>
          <div className="codex-catalog-search"><Search size={15} /><input aria-label={t('agents.catalog.search')} value={search} placeholder={t('agents.catalog.search')} onChange={e => setSearch(e.currentTarget.value)} /></div>
          <div className="codex-catalog-models" role="listbox" aria-label={t('agents.harness.title')}>
            {loading ? <div className="codex-catalog-state"><LoaderCircle className="spin" size={18} />{t('agents.catalog.loading')}</div> : snapshot?.models.filter(m => `${m.id} ${drafts[m.id]?.name ?? m.defaults.name ?? ''}`.toLowerCase().includes(search.toLowerCase())).map(m => <button role="option" aria-selected={selected === m.id} className={selected === m.id ? 'active' : ''} key={m.id} onClick={() => setSelected(m.id)}>
              <strong>{drafts[m.id]?.name || String(m.defaults.name ?? m.id)}</strong><span>{m.id}</span><small>{t(Object.keys(drafts[m.id] ?? {}).length ? 'agents.catalog.customized' : 'agents.harness.apiSource')}{m.id === snapshot.defaultModel ? ` · ${t('agents.harness.defaultModel')}` : ''}</small>
            </button>)}
            {!loading && snapshot?.models.length === 0 ? <div className="codex-catalog-state">{t('agents.catalog.empty')}</div> : null}
          </div>
          <button className="secondary-button codex-catalog-reload" disabled={loading || saving} onClick={() => dirty ? setConfirmation('reload') : void load()}><RefreshCw size={15} />{t('agents.catalog.reload')}</button>
        </aside>
        <main className="codex-catalog-editor"><fieldset disabled={loading || saving} className="harness-editor-fieldset">
          {snapshot && (active || selected === null) ? <>
            <div className="codex-catalog-model-heading"><div><h3>{active ? active.id : t('agents.harness.provider')}</h3><span>{t('agents.harness.inheritHint')}</span></div><button className="secondary-button" onClick={() => { if (active) setDrafts(current => ({ ...current, [active.id]: {} })); else setProvider({}); changed(); }}><RotateCcw size={14} />{t('agents.harness.reset')}</button></div>
            {active ? <p className="codex-catalog-hint" role="note">{t('agents.harness.apiInput', { value: Array.isArray(active.defaults.input) ? active.defaults.input.join(', ') : t('agents.harness.unknown') })}</p> : <p className="codex-catalog-hint">{t('agents.harness.managedConnection', { url: api === 'anthropic-messages' ? snapshot.baseUrl.replace(/\/v1$/, '') : snapshot.baseUrl })}</p>}
            <HarnessFields key={active?.id ?? 'provider'} group={active ? 'model' : 'provider'} draft={active ? drafts[active.id] ?? {} : provider} defaults={active?.defaults} api={api} onChange={next => { if (active) setDrafts(current => ({ ...current, [active.id]: next })); else setProvider(next); changed(); }} />
          </> : null}
        </fieldset></main>
      </div>
      <footer className="codex-catalog-footer"><div aria-live="polite">{error ? <span className="agent-inline-message error" role="alert">{error}</span> : notice ? <span role="status">{notice}</span> : <span>{t(dirty ? 'agents.catalog.unsaved' : 'agents.harness.saveHint')}</span>}</div><div>
        <button className="secondary-button" disabled={loading || saving || !snapshot} onClick={() => { setDrafts(Object.fromEntries(snapshot!.models.map(m => [m.id, {}]))); setProvider({}); changed(); }}>{t('agents.catalog.resetAll')}</button>
        <button className="secondary-button" disabled={saving} onClick={close}>{t('common.cancel')}</button><button className="primary-button" disabled={!dirty || loading || saving} onClick={() => void save()}>{saving ? <LoaderCircle size={16} className="spin" /> : null}{t(saving ? 'common.saving' : 'common.save')}</button>
      </div></footer>
      {confirmation ? <div className="codex-catalog-confirm"><div role="alertdialog" aria-modal="true" aria-label={t('agents.catalog.unsaved')}><strong>{t('agents.catalog.unsaved')}</strong><span>{t('agents.catalog.discardHint')}</span><div><button autoFocus className="secondary-button" onClick={() => setConfirmation(null)}>{t('agents.catalog.keepEditing')}</button><button className="danger-button" onClick={() => { if (confirmation === 'close') onClose(); else { setConfirmation(null); void load(); } }}>{t('agents.catalog.discard')}</button></div></div></div> : null}
    </section>
  </div>;
}
