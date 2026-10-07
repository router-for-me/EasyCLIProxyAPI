import type { ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { providerText, type ProviderTemplateMessage } from '../i18n/providerTemplate';
import { isRecord, readString } from '../services/managementApi';
import '../styles/provider-template.css';

type Value = Record<string, unknown>;
type Change = (value: Value) => void;
const changed = (value: Value, field: string, next: unknown): Value => {
  const result = { ...value };
  if (next === undefined) delete result[field]; else result[field] = next;
  return result;
};
const lines = (value: unknown) => Array.isArray(value) ? value.map(String).join('\n') : '';

export function ProviderField({ value, onChange, field, label, kind = 'boolean', initial, hint, choices }: {
  value: Value; onChange: Change; field: string; label: ProviderTemplateMessage;
  kind?: 'boolean' | 'text' | 'number' | 'lines' | 'select'; initial?: unknown; hint?: ProviderTemplateMessage;
  choices?: { value: string; label: string }[];
}) {
  const { locale } = useI18n();
  const p = (key: ProviderTemplateMessage) => providerText(key, locale);
  const current = value[field];
  const enabled = current != null;
  const set = (next: unknown) => onChange(changed(value, field, next));
  return <div className="provider-template-field">
    {kind === 'boolean' ? <label><span>{p(label)}</span>
      <select aria-label={p(label)} value={enabled ? String(current) : ''} onChange={(event) => set(event.currentTarget.value === '' ? undefined : event.currentTarget.value === 'true')}>
        <option value="">{p('inherit')}</option><option value="true">{p('enabled')}</option><option value="false">{p('disabled')}</option>
      </select></label> : <>
      <label className="provider-template-toggle"><input type="checkbox" checked={enabled} onChange={(event) => set(event.currentTarget.checked
        ? structuredClone(initial ?? (kind === 'number' ? 0 : kind === 'lines' ? [] : '')) : undefined)} /><span>{p(label)}</span></label>
      {enabled ? kind === 'lines' ? <textarea aria-label={p(label)} rows={3} value={lines(current)} onChange={(event) => set(event.currentTarget.value.split(/\r?\n/))} onBlur={(event) => set(event.currentTarget.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))} />
        : kind === 'select' ? <select aria-label={p(label)} value={String(current)} onChange={(event) => set(event.currentTarget.value)}>
          {!choices?.some((choice) => choice.value === current) ? <option value={String(current)}>{String(current)}</option> : null}
          {choices?.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select> : <input aria-label={p(label)} type={kind} step={kind === 'number' ? '1' : undefined} value={String(current)} onChange={(event) => set(kind === 'number' && event.currentTarget.value !== '' ? Number(event.currentTarget.value) : event.currentTarget.value)} /> : null}
    </>}
    {hint ? <small>{p(hint)}</small> : null}
  </div>;
}

export function ProviderErrorRules({ value, onChange, inherited }: { value: Value; onChange: Change; inherited?: unknown }) {
  const { locale } = useI18n();
  const p = (key: ProviderTemplateMessage) => providerText(key, locale);
  const field = 'request-scoped-errors';
  const rules = Array.isArray(value[field]) ? value[field] as unknown[] : [];
  const set = (next: unknown) => onChange(changed(value, field, next));
  const actions = ['stop', 'stop-and-cooldown', 'continue', 'continue-and-cooldown'] as const;
  return <details className="provider-template-section">
    <summary>{p('errors')}{value[field] != null ? ` · ${rules.length}` : ''}</summary>
    <p className="provider-group-hint">{p('errorsHint')}</p>
    <label className="provider-template-toggle"><input type="checkbox" checked={value[field] != null}
      onChange={(event) => set(event.currentTarget.checked ? structuredClone(inherited ?? []) : undefined)} /><span>{p('configure')}</span></label>
    {value[field] != null ? <div className="provider-template-rules">
      {rules.map((raw, index) => {
        const rule = isRecord(raw) ? raw : {};
        const update = (next: Value) => set(rules.map((item, i) => i === index ? next : item));
        return <fieldset key={index} className="provider-template-rule"><legend>{index + 1}</legend>
          <div className="provider-template-grid">
            <label><span>{p('status')}</span><input aria-label={p('status')} type="number" min="100" max="599" step="1" value={String(rule.status ?? '')} onChange={(event) => update({ ...rule, status: event.currentTarget.value === '' ? '' : Number(event.currentTarget.value) })} /></label>
            <label><span>{p('action')}</span><select aria-label={p('action')} value={readString(rule, 'action')} onChange={(event) => update({ ...rule, action: event.currentTarget.value })}>
              {!actions.some((action) => action === rule.action) ? <option value={readString(rule, 'action')}>{readString(rule, 'action')}</option> : null}
              {actions.map((action) => <option key={action} value={action}>{p(action)}</option>)}
            </select></label>
            <ProviderField value={rule} onChange={update} field="match" label="match" kind="lines" />
            <ProviderField value={rule} onChange={update} field="match-regexr" label="regex" kind="lines" />
          </div>
          <button type="button" className="secondary-button compact-button" onClick={() => set(rules.filter((_, i) => i !== index))}><Trash2 size={14} />{p('remove')}</button>
        </fieldset>;
      })}
      <button type="button" className="secondary-button compact-button" onClick={() => set([...rules, { status: 400, action: 'stop' }])}><Plus size={14} />{p('addRule')}</button>
    </div> : null}
  </details>;
}

export function ProviderGroupTemplateFields({ value, onChange, section, includeErrors = true }: { value: Value; onChange: Change; section: string; includeErrors?: boolean }) {
  return <div className="provider-template-fields">
    <ProviderField value={value} onChange={onChange} field="request-retry" label="retry" kind="number" initial={0} hint="retryHint" />
    {section === 'openai-compatibility' ? <ProviderField value={value} onChange={onChange} field="support-prompt-cache-key" label="promptCache" /> : null}
    {includeErrors && section !== 'vertex-api-key' ? <ProviderErrorRules value={value} onChange={onChange} /> : null}
  </div>;
}

export function ProviderKeyTemplateFields({ value, onChange, section, inherited }: { value: Value; onChange: Change; section: string; inherited: Value }) {
  const { locale } = useI18n();
  return <div className="provider-template-fields">
    {!['vertex-api-key', 'openai-compatibility'].includes(section) ? <ProviderErrorRules value={value} onChange={onChange} inherited={inherited['request-scoped-errors']} /> : null}
    {section === 'codex-api-key' ? <div className="provider-template-grid">
      <ProviderField value={value} onChange={onChange} field="disable-codex-cloaking" label="noCloak" />
      <ProviderField value={value} onChange={onChange} field="alpha-search" label="alpha" />
    </div> : null}
    {section === 'claude-api-key' ? <div className="provider-template-grid">
      <ProviderField value={value} onChange={onChange} field="rebuild-mid-system-message" label="rebuild" />
      <ProviderField value={value} onChange={onChange} field="fingerprint-profile" label="fingerprint" kind="select" choices={[
        { value: '', label: providerText('caller', locale) }, { value: 'claude-code-cli', label: 'Claude Code CLI' },
      ]} />
      <ProviderField value={value} onChange={onChange} field="experimental-cch-signing" label="cch" hint="deprecated" />
    </div> : null}
  </div>;
}

export function ProviderModelFields({ value, onChange, section, children }: { value: Value; onChange: Change; section: string; children?: ReactNode }) {
  const { locale } = useI18n();
  const thinking = isRecord(value.thinking) ? value.thinking : {};
  const setThinking = (next: Value) => onChange({ ...value, thinking: next });
  return <details className="provider-template-section provider-model-options">
    <summary>{providerText('options', locale)}</summary>
    <p className="provider-group-hint">{providerText('modelHint', locale)}</p>
    <div className="provider-template-grid">
      <ProviderField value={value} onChange={onChange} field="display-name" label="display" kind="text" />
      {section !== 'vertex-api-key' ? <>
        <ProviderField value={value} onChange={onChange} field="max-context-length" label="context" kind="number" />
        <ProviderField value={value} onChange={onChange} field="is-compat" label="compat" />
      </> : null}
      <ProviderField value={value} onChange={onChange} field="force-mapping" label="force" />
      {['codex-api-key', 'xai-api-key', 'meta-api-key'].includes(section) ? <ProviderField value={value} onChange={onChange} field="support-configuration-update" label="configuration" /> : null}
      {section === 'openai-compatibility' ? <>
        <ProviderField value={value} onChange={onChange} field="image" label="image" hint="imageHint" />
        <ProviderField value={value} onChange={onChange} field="input-modalities" label="input" kind="lines" hint="linesHint" />
        <ProviderField value={value} onChange={onChange} field="output-modalities" label="output" kind="lines" hint="linesHint" />
        <ProviderField value={value} onChange={onChange} field="use-max-completion-tokens" label="completion" />
      </> : null}
    </div>
    <label className="provider-template-toggle"><input type="checkbox" checked={value.thinking != null} onChange={(event) => onChange(changed(value, 'thinking', event.currentTarget.checked ? {} : undefined))} /><span>{providerText('thinking', locale)}</span></label>
    {value.thinking != null ? <div className="provider-template-grid">
      <ProviderField value={thinking} onChange={setThinking} field="levels" label="levels" kind="lines" hint="linesHint" />
      <ProviderField value={thinking} onChange={setThinking} field="min" label="min" kind="number" />
      <ProviderField value={thinking} onChange={setThinking} field="max" label="max" kind="number" />
      <ProviderField value={thinking} onChange={setThinking} field="zero-allowed" label="zero" />
      <ProviderField value={thinking} onChange={setThinking} field="dynamic-allowed" label="dynamic" />
    </div> : null}{children}
  </details>;
}
