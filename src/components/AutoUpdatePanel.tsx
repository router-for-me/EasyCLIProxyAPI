import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { InlineNotice } from '../appNotice';
import { Switch } from './Switch';
import { Checkbox } from './Checkbox';
import { Check } from 'lucide-react';
import { pollWhileActive } from '../services/windowActivity';
import {
  getAutoUpdateStatus, saveAutoUpdateSettings, retryAutoUpdate,
  validateAutoUpdateSettings, type AutoUpdateSettings, type AutoUpdateStatus,
} from '../services/autoUpdate';
import './AutoUpdatePanel.css';

type AutoUpdatePanelProps = {
  /** Renders as an inset block instead of a standalone card. */
  embedded?: boolean;
  /** False once the app reports that in-place updates are unavailable here. */
  enabled: boolean;
  /** Shown with the hints when the running build cannot update itself. */
  unavailableHint?: string;
  unsupportedReason?: string;
};

export function AutoUpdatePanel({ embedded = false, enabled, unavailableHint, unsupportedReason }: AutoUpdatePanelProps) {
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
  const busy = saving || !draft || status?.phase === 'installing';
  // A build that cannot update itself keeps its saved settings visible but locked.
  const unavailable = !enabled;
  const disabled = busy || unavailable;
  return <section className={`auto-update-panel${embedded ? ' auto-update-panel-inset' : ' surface-panel'}`} aria-label={t('autoUpdate.title')}>
    <div className="auto-update-heading">
      <h2 className="auto-update-title">{t('autoUpdate.title')}</h2>
      <div className="auto-update-actions">
        {dirty ? <span>{t('autoUpdate.unsaved')}</span> : null}
        {status?.phase === 'failed' ? <button type="button" className="link-button" disabled={Boolean(disabled)}
          onClick={() => void action(retryAutoUpdate)}>{t('autoUpdate.retry')}</button> : null}
        <Switch checked={draft?.enabled ?? false} onChange={event => change({ enabled: event.target.checked })}
          aria-label={t('autoUpdate.enabled')} title={t('autoUpdate.enabled')} disabled={Boolean(disabled)} />
        <button type="button" className="primary-button compact-button" disabled={Boolean(disabled) || !dirty} onClick={save}><Check size={15} aria-hidden="true" />{t('common.save')}</button>
      </div>
    </div>
    <InlineNotice notice={error || readError ? { owner: 'auto-update-settings', message: error || readError, tone: 'error' } : null} onDismiss={() => { setError(''); setReadError(''); }} />
    {!draft ? <p className="auto-update-note">{t('common.loading')}</p> : <>
      <fieldset disabled={Boolean(disabled) || !draft.enabled} className="auto-update-fields">
        <legend className="sr-only">{t('autoUpdate.settings')}</legend>
        <div className="auto-update-targets">
          <Checkbox className="auto-update-checkbox" checked={draft.updateApp} onChange={event => change({ updateApp: event.target.checked })} label={t('autoUpdate.app')} />
          <Checkbox className="auto-update-checkbox" checked={draft.updateCore} onChange={event => change({ updateCore: event.target.checked })} label={t('autoUpdate.core')} />
        </div>
      </fieldset>
      {unavailable ? <p className="auto-update-note">{unsupportedReason || unavailableHint}</p> : null}
      {status?.settings.enabled ? <div className="auto-update-status" aria-live="polite">
        <strong>{t(`autoUpdate.phase.${status.phase}`)}</strong>
        {status?.version ? <span>{t(status.target === 'core' ? 'autoUpdate.core' : 'autoUpdate.app')} {status.version}</span> : null}
      </div> : null}
      <InlineNotice notice={status?.error ? { owner: 'auto-update-status', message: status.error, tone: 'error' } : null} />
    </>}
  </section>;
}
