import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import { readString } from '../services/managementApi';
import { providerKeyDraft, type ProviderKeyDraft } from '../services/providerGroups';
import '../styles/provider-groups.css';

type Props = {
  keys: ProviderKeyDraft[];
  disabled: boolean;
  onChange: (keys: ProviderKeyDraft[]) => void;
};

export function ProviderGroupKeysEditor({ keys, disabled, onChange }: Props) {
  const { t } = useI18n();
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const set = (id: string, field: string, value: unknown) => {
    onChange(keys.map((draft) => {
      if (draft.id !== id) return draft;
      const next = { ...draft.value };
      if (value === undefined) delete next[field];
      else next[field] = value;
      const text = { ...draft.text };
      delete text[field];
      return { ...draft, value: next, text };
    }));
  };

  return <section className="provider-group-keys" aria-label={t('apiAccess.entries.keys')}>
    <div className="provider-group-heading">
      <strong>{t('apiAccess.entries.keys')}</strong>
      <button type="button" className="secondary-button compact-button" disabled={disabled}
        onClick={() => onChange([...keys, providerKeyDraft({ 'api-key': '' })])}>
        <Plus size={14} />{t('apiAccess.entries.addKey')}
      </button>
    </div>
    {!keys.length ? <p className="provider-group-hint">{t('apiAccess.entries.emptyKeys')}</p> : null}
    {keys.map((draft, index) => {
      const key = draft.value;
      const isVisible = Boolean(visible[draft.id]);
      return <fieldset className="provider-group-key" key={draft.id} disabled={disabled}>
        <legend>{t('apiAccess.entries.keyNumber', { number: index + 1 })}</legend>
        <div className="provider-group-key-main">
          <label><span>{t('apiAccess.field.key')}</span>
            <input type={isVisible ? 'text' : 'password'} autoComplete="off" spellCheck={false}
              aria-label={t('apiAccess.entries.keyNumber', { number: index + 1 })}
              value={readString(key, 'api-key')} placeholder="sk-..."
              onChange={(event) => set(draft.id, 'api-key', event.currentTarget.value)} />
          </label>
          <button type="button" className="secondary-button compact-button" aria-pressed={isVisible}
            onClick={() => setVisible((state) => ({ ...state, [draft.id]: !state[draft.id] }))}>
            {t(isVisible ? 'apiAccess.entries.hideKey' : 'apiAccess.entries.showKey')}
          </button>
          <button type="button" className="icon-button quiet danger"
            aria-label={t('apiAccess.entries.removeKey', { number: index + 1 })}
            onClick={() => onChange(keys.filter((item) => item.id !== draft.id))}>
            <Trash2 size={15} />
          </button>
        </div>
        <details className="provider-key-settings">
          <summary>{t('apiAccess.entries.keySettings')}</summary>
          <div className="provider-dialog-basic-grid">
            <label><span>{t('apiAccess.field.proxyUrl')}</span>
              <input value={readString(key, 'proxy-url')} placeholder="socks5://127.0.0.1:1080"
                onChange={(event) => set(draft.id, 'proxy-url', event.currentTarget.value || undefined)} />
            </label>
            <label><span>{t('apiAccess.entries.weight')}</span>
              <input type="number" max="1000000" step="1" value={key.weight == null ? '' : String(key.weight)}
                placeholder="1" onChange={(event) => set(draft.id, 'weight', event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value))} />
            </label>
          </div>
        </details>
      </fieldset>;
    })}
  </section>;
}
