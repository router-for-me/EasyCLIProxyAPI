import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { InlineNotice } from '../appNotice';
import { Switch } from './Switch';
import { Checkbox } from './Checkbox';
import { Check, RefreshCw } from 'lucide-react';
import { pollWhileActive } from '../services/windowActivity';
import {
  getAutoUpdateStatus, saveAutoUpdateSettings, retryAutoUpdate,
  validateAutoUpdateSettings, type AutoUpdateSettings, type AutoUpdateStatus,
} from '../services/autoUpdate';
import './AutoUpdatePanel.css';

export function AutoUpdatePanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<AutoUpdateStatus | null>(null);
  const [draft, setDraft] = useState<AutoUpdateSettings | null>(null);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(false);
  const mutating = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++revision.current; };
  }, []);
  useEffect(() => {
    let pending = false;
    const stop = pollWhileActive(() => {
      if (pending || mutating.current) return;
      pending = true;
      const epoch = revision.current;
      void getAutoUpdateStatus().then(result => {
        if (!mounted.current || epoch !== revision.current) return;
        setStatus(result);
        setReadError('');
        setDraft(current => current ?? result.settings);
      }).catch(nextError => {
        if (mounted.current && epoch === revision.current) setReadError(String(nextError));
      }).finally(() => { pending = false; });
    }, 5000);
    return () => { ++revision.current; stop(); };
  }, []);

  const action = async (operation: () => Promise<AutoUpdateStatus>, replaceDraft = false) => {
    ++revision.current;
    mutating.current = true;
    setSaving(true); setError('');
    try {
      const result = await operation();
      if (mounted.current) {
        setStatus(result);
        if (replaceDraft) setDraft(result.settings);
      }
    } catch (nextError) { if (mounted.current) setError(String(nextError)); }
    finally { mutating.current = false; ++revision.current; if (mounted.current) setSaving(false); }
  };
  const save = () => {
    if (!draft) return;
    const invalid = validateAutoUpdateSettings(draft);
    if (invalid) { setError(t(invalid)); return; }
    void action(() => saveAutoUpdateSettings(draft), true);
  };
  const change = (patch: Partial<AutoUpdateSettings>) => setDraft(current => current ? { ...current, ...patch } : current);
  const dirty = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(status?.settings));
  const disabled = saving || !draft || status?.phase === 'installing';
  return <section className="auto-update-panel surface-panel" aria-label={t('autoUpdate.title')}>
    <div className="auto-update-heading">
      <div className="auto-update-title"><RefreshCw size={18} aria-hidden="true" /><h2>{t('autoUpdate.title')}</h2>
        <Switch checked={draft?.enabled ?? false} onChange={event => change({ enabled: event.target.checked })}
          aria-label={t('autoUpdate.enabled')} title={t('autoUpdate.enabled')} disabled={Boolean(disabled)} />
      </div>
      <div className="auto-update-actions">
        {dirty && <span>{t('autoUpdate.unsaved')}</span>}
        {status?.phase === 'failed' && <button type="button" className="secondary-button compact-button" disabled={Boolean(disabled)}
          onClick={() => void action(retryAutoUpdate)}>{t('autoUpdate.retry')}</button>}
        <button type="button" className="primary-button compact-button" disabled={Boolean(disabled) || !dirty} onClick={save}><Check size={16} aria-hidden="true" />{t('common.save')}</button>
      </div>
    </div>
    <InlineNotice notice={error || readError ? { owner: 'auto-update-settings', message: error || readError, tone: 'error' } : null} onDismiss={() => { setError(''); setReadError(''); }} />
    {!draft ? <p>{t('common.loading')}</p> : <>
      <fieldset disabled={Boolean(disabled)} className="auto-update-fields">
        <legend className="sr-only">{t('autoUpdate.settings')}</legend>
        <div className="auto-update-row">
          <span className="auto-update-label">{t('autoUpdate.targets')}</span>
          <div className="auto-update-controls"><Checkbox checked={draft.updateApp} onChange={event => change({ updateApp: event.target.checked })} label={t('autoUpdate.app')} />
            <Checkbox checked={draft.updateCore} onChange={event => change({ updateCore: event.target.checked })} label={t('autoUpdate.core')} /></div>
        </div>
      </fieldset>
      <div className="auto-update-meta">
        <p className="auto-update-explanation">{t('autoUpdate.downloadHint')}</p>
        {status?.settings.enabled && <div className="auto-update-status" aria-live="polite">
          <strong>{t(`autoUpdate.phase.${status.phase}`)}</strong>
          {status?.version && <span>{t(status.target === 'core' ? 'autoUpdate.core' : 'autoUpdate.app')} {status.version}</span>}
        </div>}
      </div>
      <InlineNotice notice={status?.error ? { owner: 'auto-update-status', message: status.error, tone: 'error' } : null} />
    </>}
  </section>;
}
