import { navigateHelp } from '../services/uxNavigation';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { quotaAvailability } from '../services/quotaAvailability';
import { fileName, quotaKey, type AuthFile, type QuotaState } from '../services/quotaService';
import { recoveryEvents, recoveredAccounts, failureIdentity } from '../services/overviewInsights';
import { resetCountdown } from '../services/accountDashboard';
import { readDashboardPreference, saveDashboardPreference } from '../services/dashboardPreferences';
import { requestClient, privateText, type DashboardRequest } from '../services/dashboardActivity';
import { failureKind } from '../services/connectionPresentation';
import { isRecord, managementApi } from '../services/managementApi';

type Props = { files: AuthFile[]; quotas: Record<string, QuotaState>; now: number; stale: boolean; labelFor: (file: AuthFile) => string };
export function RecoveryTimeline({ files, quotas, now, stale, labelFor }: Props) {
  const { t } = useI18n();
  const events = recoveryEvents(files, quotas, now, stale);
  return <details className="ux-insight"><summary>{t('ux.recovery')} · {events.length}</summary><p>{t('ux.recoveryHint')}</p>
    {events.length ? <ol className="ux-recovery">{events.map((event, i) => <li key={`${quotaKey(event.file)}-${i}`}>
      <strong>{labelFor(event.file)}</strong><span>{event.group || t(event.includedOnly ? 'ux.renewal' : 'ux.expected')}</span>
      <span>{resetCountdown(event.at, now)}</span><time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleString()}</time>
    </li>)}</ol> : <p>{t('ux.recoveryEmpty')}</p>}
  </details>;
}

export function AlternativeComparison({ files, quotas, now, stale, labelFor, onClose }: Props & { onClose: () => void }) {
  const { t } = useI18n();
  const candidates = files.filter(file => ['available', 'limited', 'creditBacked'].includes(quotaAvailability(file, quotas[quotaKey(file)], now, stale).kind));
  return <section className="ux-insight ux-alternatives" aria-label={t('ux.alternatives')}>
    <header><h3>{t('ux.alternatives')}</h3><button className="secondary-button compact-button" onClick={onClose}>{t('common.close')}</button></header>
    <p>{t('ux.alternativesHint')}</p>
    {candidates.length ? <div className="ux-comparison">{candidates.map(file => {
      const quota = quotas[quotaKey(file)]; const state = quotaAvailability(file, quota, now, stale);
      return <article key={quotaKey(file)}><h4>{labelFor(file)}</h4>
        <p>{t(state.kind === 'creditBacked' ? 'ux.creditCandidate' : state.kind === 'limited' ? 'ux.partialCandidate' : 'ux.candidate')}</p>
        {state.groups?.map(group => <small key={group.id}>{group.label}: {t(`availability.${group.kind}`)}</small>)}
        {quota?.fetchedAt && <small>{t('accountDashboard.quotaChecked', { time: new Date(quota.fetchedAt).toLocaleTimeString() })}</small>}
        <CandidateModels file={file} />
      </article>;
    })}</div> : <p>{t('availability.noMatches')}</p>}
  </section>;
}

function CandidateModels({ file }: { file: AuthFile }) {
  const { t } = useI18n();
  const [models, setModels] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true); setError(false);
    try {
      const result = await managementApi.get('/credentials/models', { name: fileName(file) });
      setModels(isRecord(result) && Array.isArray(result.models) ? result.models.filter(isRecord) : []);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return <div className="ux-model-catalog"><button className="secondary-button compact-button" disabled={busy} onClick={() => void load()}>{t(busy ? 'accountDashboard.loading' : 'ux.catalog')}</button>
    {error && <p role="status">{t('ux.catalogError')}</p>}
    {models && <ul>{models.map((model, i) => <li key={i}><strong>{privateText(String(model.id ?? model.name ?? '—'), true)}</strong>
      <small>{Array.isArray(model.input_modalities) && model.input_modalities.every(x => typeof x === 'string') ? t('ux.features', { types: model.input_modalities.join(', ') }) : t('ux.featuresUnknown')}</small>
      {typeof model.context_length === 'number' && model.context_length > 0 && <small>{t('ux.context', { count: model.context_length.toLocaleString() })}</small>}
    </li>)}</ul>}{models?.length === 0 && <p>{t('ux.catalogEmpty')}</p>}
  </div>;
}

export function OverviewAlerts({ files, quotas, now, stale, labelFor, items, activityStale }: Props & { items: DashboardRequest[] | undefined; activityStale: boolean }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(() => readDashboardPreference('overviewAlerts', ['true', 'false'], 'false') === 'true');
  const previous = useRef<Record<string, string>>({});
  const seen = useRef(new Set<string>());
  const initialized = useRef(false);
  const [alerts, setAlerts] = useState<{ key: string; text: string }[]>([]);
  useEffect(() => {
    const next = Object.fromEntries(files.map(file => [quotaKey(file), quotaAvailability(file, quotas[quotaKey(file)], now, stale).kind]));
    const recovered = stale ? [] : recoveredAccounts(previous.current, next);
    previous.current = next;
    const observedAt = Date.now();
    const failures = !activityStale && items ? items.filter(item => item.failed && !item.canceled && Date.parse(item.timestamp) <= observedAt && observedAt - Date.parse(item.timestamp) < 5 * 60_000) : [];
    const fresh = initialized.current ? failures.filter(item => !seen.current.has(failureIdentity(item))) : [];
    if (items && !activityStale) initialized.current = true;
    failures.forEach(item => seen.current.add(failureIdentity(item)));
    if (seen.current.size > 1000) seen.current = new Set(failures.map(failureIdentity));
    if (!enabled) return;
    const messages = recovered.flatMap(key => {
      const file = files.find(file => quotaKey(file) === key);
      return file ? [{ key, text: t('ux.recovered', { account: labelFor(file) }) }] : [];
    });
    // Group a burst by client and failure category rather than flooding the user.
    const grouped = new Map(fresh.map(item => [`${requestClient(item)}-${failureKind(item)}`, item]));
    grouped.forEach((item, key) => messages.push({ key, text: `${t('ux.failed', { client: requestClient(item) ?? t('ledger.unknownClient') })} ${t(`ux.${failureKind(item)}`)}` }));
    if (messages.length) setAlerts(current => [...current.filter(a => !messages.some(b => b.key === a.key)), ...messages].slice(-5));
  }, [files, quotas, now, stale, items, activityStale, enabled, labelFor, t]);
  return <div className="ux-alerts"><label><input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setAlerts([]); saveDashboardPreference('overviewAlerts', String(event.target.checked)); }} />{t('ux.alerts')}</label><small>{t('ux.alertHint')}</small>
    {enabled && alerts.length > 0 && <div role="status" aria-live="polite"><ul>{alerts.map(a => <li key={a.key}>{a.text}</li>)}</ul><button className="secondary-button compact-button" onClick={() => navigateHelp('agents')}>{t('ux.reviewConnection')}</button><button className="secondary-button compact-button" onClick={() => setAlerts([])}>{t('ux.dismissAlerts')}</button></div>}
  </div>;
}
