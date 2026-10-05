import { useState } from 'react';
import { Plus, Undo2, X } from 'lucide-react';
import { AgentModelPicker } from './AgentModelPicker';
import type { ModelOption } from '../services/modelService';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { isRecord } from '../services/managementApi';
import { normalizeOAuthProvider } from '../services/authFiles';

type Advanced = Record<string, unknown>;
type AliasRow = Record<string, unknown>;

const claudeKeys = ['cloak_mode', 'cloak_strict_mode', 'cloak_cache_user_id', 'cloak_sensitive_words', 'fingerprint_profile'] as const;

export function credentialProviderKey(name: string, provider = ''): string {
  const explicit = normalizeOAuthProvider(provider);
  if (explicit) return explicit;
  const prefix = name.trim().toLowerCase().replace(/\.json$/i, '').split('-')[0] ?? '';
  return normalizeOAuthProvider(prefix);
}

export function showsClaudeCredentialSettings(provider: string, advanced: Advanced): boolean {
  return provider === 'claude' || claudeKeys.some((key) => advanced[key] !== undefined);
}

function withoutKey(advanced: Advanced, key: string, value: unknown): Advanced {
  const next = { ...advanced };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function wordsValue(value: unknown): string {
  if (Array.isArray(value)) return value.filter((word): word is string => typeof word === 'string').join(', ');
  return typeof value === 'string' ? value : '';
}

function aliasRows(value: unknown): AliasRow[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function CredentialAdvancedFields({
  name, provider = '', advanced, models = [], modelsLoading = false, modelsError = '', onChange, disabled = false,
}: {
  name: string;
  provider?: string;
  advanced: Advanced;
  models?: ModelOption[];
  modelsLoading?: boolean;
  modelsError?: string;
  onChange: (advanced: Advanced) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const resolvedProvider = credentialProviderKey(name, provider);
  const showClaude = showsClaudeCredentialSettings(resolvedProvider, advanced);
  const aliases = aliasRows(advanced.model_aliases);
  const aliasesSet = Array.isArray(advanced.model_aliases);
  const [wordsDraft, setWordsDraft] = useState<string | null>(null);
  const setField = (key: string, value: unknown) => onChange(withoutKey(advanced, key, value));
  const tri = (value: unknown) => value === true ? 'true' : value === false ? 'false' : '';
  const choice = (label: MessageKey, key: string, options: ReadonlyArray<{ value: string; label: MessageKey }>) => {
    const current = textValue(advanced[key]);
    return (
      <label className="credential-settings-field">
        <span>{t(label)}</span>
        <select value={options.some((option) => option.value === current) ? current : ''} disabled={disabled} onChange={(event) => setField(key, event.currentTarget.value || undefined)}>
          <option value="">{t('authFiles.settings.inherit')}</option>
          {options.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
        </select>
      </label>
    );
  };
  const boolChoice = (label: MessageKey, key: 'cloak_strict_mode' | 'cloak_cache_user_id') => (
    <label className="credential-settings-field">
      <span>{t(label)}</span>
      <select value={tri(advanced[key])} disabled={disabled} onChange={(event) => setField(key, event.currentTarget.value === '' ? undefined : event.currentTarget.value === 'true')}>
        <option value="">{t('authFiles.settings.inherit')}</option>
        <option value="true">{t('common.enable')}</option>
        <option value="false">{t('common.disable')}</option>
      </select>
    </label>
  );
  const updateAlias = (index: number, patch: AliasRow) => {
    const next = aliases.map((row, rowIndex) => {
      if (rowIndex !== index) return row;
      const merged = { ...row, ...patch };
      Object.entries(patch).forEach(([key, value]) => { if (value === undefined) delete merged[key]; });
      return merged;
    });
    setField('model_aliases', next);
  };

  return (
    <>
      <section className="credential-settings-section">
        <h3>{t('authFiles.settings.aliases')}</h3>
        <p className="credential-settings-lead">{t('authFiles.settings.aliasesHint')}</p>
        {aliases.length ? <div className="credential-alias-list">
          {aliases.map((row, index) => <div className="credential-alias-card" key={index}>
            <div className="credential-alias-card-heading">
              <strong>{t('authFiles.settings.aliasItem', { index: index + 1 })}</strong>
              <button type="button" className="icon-button quiet" disabled={disabled} aria-label={t('authFiles.settings.aliasRemove', { index: index + 1 })} onClick={() => setField('model_aliases', aliases.filter((_, rowIndex) => rowIndex !== index))}><X size={15} /></button>
            </div>
            <div className="credential-alias-fields">
              <label className="credential-settings-field">
                <span>{t('authFiles.settings.aliasUpstream')}</span>
                <AgentModelPicker models={models} value={textValue(row.name)} loading={modelsLoading} error={modelsError} disabled={disabled}
                  editable={{ label: t('authFiles.settings.aliasUpstream'), placeholder: t('authFiles.settings.aliasModelPlaceholder'), maxLength: 240 }}
                  menuClassName="credential-model-menu" onChange={(value) => updateAlias(index, { name: value })} />
              </label>
              <label className="credential-settings-field">
                <span>{t('authFiles.settings.aliasClient')}</span>
                <AgentModelPicker models={models} value={textValue(row.alias)} loading={modelsLoading} error={modelsError} disabled={disabled}
                  editable={{ label: t('authFiles.settings.aliasClient'), placeholder: t('authFiles.settings.aliasModelPlaceholder'), maxLength: 240 }}
                  menuClassName="credential-model-menu" onChange={(value) => updateAlias(index, { alias: value })} />
              </label>
              <label className="credential-settings-field">
                <span>{t('authFiles.settings.aliasDisplay')}</span>
                <input value={textValue(row['display-name'])} disabled={disabled} autoComplete="off" spellCheck={false} onChange={(event) => updateAlias(index, { 'display-name': event.currentTarget.value.trim() ? event.currentTarget.value : undefined })} />
              </label>
            </div>
            <div className="credential-alias-checks">
              <label><input type="checkbox" checked={row.fork === true} disabled={disabled} onChange={(event) => updateAlias(index, { fork: event.currentTarget.checked })} />{t('authFiles.settings.aliasFork')}</label>
              <label><input type="checkbox" checked={row['force-mapping'] === true} disabled={disabled} onChange={(event) => updateAlias(index, { 'force-mapping': event.currentTarget.checked })} />{t('authFiles.settings.aliasForce')}</label>
            </div>
          </div>)}
        </div> : aliasesSet ? <p className="credential-settings-lead">{t('authFiles.settings.aliasCleared')}</p> : null}
        <div className="credential-settings-inline-actions">
          <button type="button" className="secondary-button compact-button" disabled={disabled} onClick={(event) => { const scroller = event.currentTarget.closest('.credential-settings-body'); const top = scroller?.scrollTop ?? 0; setField('model_aliases', [...aliases, { name: '', alias: '' }]); requestAnimationFrame(() => { if (scroller) scroller.scrollTop = top; }); }}><Plus size={14} />{t('authFiles.settings.aliasAdd')}</button>
          {aliasesSet ? <button type="button" className="secondary-button compact-button" disabled={disabled} onClick={() => setField('model_aliases', undefined)}><Undo2 size={14} />{t('authFiles.settings.aliasInherit')}</button> : null}
        </div>
      </section>
      {showClaude ? <section className="credential-settings-section">
        <h3>{t('authFiles.settings.claude')}</h3>
        <p className="credential-settings-lead">{t('authFiles.settings.claudeHint')}</p>
        <div className="credential-settings-grid">
          {choice('authFiles.settings.cloak_mode', 'cloak_mode', [
            { value: 'auto', label: 'authFiles.settings.cloak_mode.auto' },
            { value: 'always', label: 'authFiles.settings.cloak_mode.always' },
            { value: 'never', label: 'authFiles.settings.cloak_mode.never' },
          ])}
          {boolChoice('authFiles.settings.cloak_strict_mode', 'cloak_strict_mode')}
          {boolChoice('authFiles.settings.cloak_cache_user_id', 'cloak_cache_user_id')}
          {choice('authFiles.settings.fingerprint_profile', 'fingerprint_profile', [
            { value: 'claude-code-cli', label: 'authFiles.settings.fingerprint_profile.claude-code-cli' },
            { value: 'oauth-cli', label: 'authFiles.settings.fingerprint_profile.oauth-cli' },
          ])}
          <label className="credential-settings-field credential-settings-span">
            <span>{t('authFiles.settings.cloak_sensitive_words')}</span>
            <input value={wordsDraft ?? wordsValue(advanced.cloak_sensitive_words)} disabled={disabled} autoComplete="off" spellCheck={false}
              placeholder={t('authFiles.settings.cloakWordsPlaceholder')}
              onChange={(event) => {
                const text = event.currentTarget.value;
                setWordsDraft(text);
                const words = text.split(',').map((word) => word.trim()).filter(Boolean);
                setField('cloak_sensitive_words', words.length ? words : undefined);
              }}
              onBlur={() => setWordsDraft(null)} />
            <small>{t('authFiles.settings.cloakWordsHint')}</small>
          </label>
        </div>
      </section> : null}
      <section className="credential-settings-section">
        <div className="credential-settings-grid">
          <label className="credential-settings-field">
            <span>{t('authFiles.settings.timezone')}</span>
            <input value={textValue(advanced.timezone)} disabled={disabled} autoComplete="off" spellCheck={false} placeholder="Asia/Shanghai"
              onChange={(event) => setField('timezone', event.currentTarget.value)}
              onBlur={(event) => setField('timezone', event.currentTarget.value.trim() || undefined)} />
            <small>{t('authFiles.settings.timezoneHint')}</small>
          </label>
        </div>
      </section>
    </>
  );
}

export function headerEntries(value: string): Array<{ name: string; value: string }> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(value.trim() || '{}'); } catch { return null; }
  if (!isRecord(parsed) || Object.values(parsed).some((item) => typeof item !== 'string')) return null;
  return Object.entries(parsed).map(([name, item]) => ({ name, value: String(item) }));
}

export function CredentialHeadersEditor({ value, onChange, disabled = false }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const parsed = headerEntries(value);
  const [rows, setRows] = useState<Array<{ name: string; value: string }> | null>(null);
  const visible = rows ?? parsed ?? [];
  const write = (next: Array<{ name: string; value: string }>) => {
    setRows(next);
    const headers: Record<string, string> = {};
    next.forEach((row) => {
      if (row.name.trim() || row.value.trim()) headers[row.name] = row.value;
    });
    onChange(JSON.stringify(headers, null, 2));
  };
  if (parsed === null) {
    return (
      <label className="credential-settings-field">
        <span>{t('authFiles.settings.headers')} <code>headers</code></span>
        <textarea className="credential-settings-json" rows={5} value={value} disabled={disabled} spellCheck={false} autoComplete="off" onChange={(event) => onChange(event.currentTarget.value)} />
        <small>{t('authFiles.settings.headersHint')}</small>
      </label>
    );
  }
  return (
    <div className="credential-settings-field">
      <span>{t('authFiles.settings.headers')}</span>
      {visible.length ? <div className="credential-header-list">
        {visible.map((row, index) => <div className="credential-header-row" key={index}>
          <input aria-label={t('authFiles.settings.headerName')} value={row.name} disabled={disabled} autoComplete="off" spellCheck={false} placeholder={t('authFiles.settings.headerName')}
            onChange={(event) => write(visible.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.currentTarget.value } : item))} />
          <input aria-label={t('authFiles.settings.headerValue')} value={row.value} disabled={disabled} autoComplete="off" spellCheck={false} placeholder={t('authFiles.settings.headerValue')}
            onChange={(event) => write(visible.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.currentTarget.value } : item))} />
          <button type="button" className="icon-button quiet" disabled={disabled} aria-label={t('authFiles.settings.headerRemove', { name: row.name || String(index + 1) })}
            onClick={() => write(visible.filter((_, itemIndex) => itemIndex !== index))}><X size={15} /></button>
        </div>)}
      </div> : <p className="credential-settings-lead">{t('authFiles.settings.headersEmpty')}</p>}
      <div className="credential-settings-inline-actions">
        <button type="button" className="secondary-button compact-button" disabled={disabled} onClick={() => write([...visible, { name: '', value: '' }])}><Plus size={14} />{t('authFiles.settings.headerAdd')}</button>
      </div>
      <small>{t('authFiles.settings.headersRowHint')}</small>
    </div>
  );
}
