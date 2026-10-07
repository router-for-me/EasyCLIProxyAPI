import { RequestFailureAction } from './RequestFailureAction';
import { subscribeActivity } from '../services/activitySubscription';
import { explicitReasoning, failureKind, type ConfiguredModel } from '../services/connectionPresentation';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { connectionEvidence, type ConnectionStatus } from '../services/connectionEvidence';
import { loadDashboardActivity, privateText, type DashboardRequest } from '../services/dashboardActivity';
import { readDashboardPreference } from '../services/dashboardPreferences';
import { managementApi, normalizeAuthIndex, responseList } from '../services/managementApi';
import { providerForFile, type AuthFile } from '../services/quotaService';
import { privateAccountLabel } from '../services/accountPrivacy';
import { readAccountNames } from '../services/accountNames';

export function ConnectionOverview({ status, busy, detectionFailed, onReview, onDetect, configuredModels = [] }: {
  configuredModels?: ConfiguredModel[]; status: ConnectionStatus | null; busy: boolean; detectionFailed: boolean; onReview: () => void; onDetect: () => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<DashboardRequest[]>([]);
  const [files, setFiles] = useState<AuthFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [payload, setPayload] = useState<unknown>(null);
  const [payloadLoaded, setPayloadLoaded] = useState(false);
  const reload = useRef<() => void>(() => {});
  const [names] = useState(readAccountNames);
  const [hidden] = useState(() => readDashboardPreference('hideEmails', ['true', 'false'], 'false') === 'true');
  useEffect(() => {
    let active = true;
    setLoaded(false); setError(false); setItems([]); setFiles([]);
    const subscription = subscribeActivity(async () => {
      if (active) setRefreshing(true);
      try {
        const data = await loadDashboardActivity();
        if (active) { setItems(data.items); setNow(Date.now()); setLoaded(true); setError(false); }
      } catch { if (active) setError(true); }
      finally { if (active) setRefreshing(false); }
    });
    reload.current = subscription.request;
    void managementApi.get('/credentials').then(data => { if (active) setFiles(responseList(data, 'files')); }).catch(() => {});
    setPayloadLoaded(false); setPayload(null);
    void managementApi.get('/config/requests/payload').then(data => { if (active) { setPayload(data); setPayloadLoaded(true); } }).catch(() => {});
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { active = false; subscription.dispose(); window.clearInterval(timer); };

  }, [status]);
  const evidence = connectionEvidence(status, items, now);
  const stage = detectionFailed ? 'attention' : error && evidence.stage === 'verified' ? 'configured' : evidence.stage;
  const latest = evidence.latest;
  const file = latest?.auth_index ? files.find(file => normalizeAuthIndex(file.auth_index ?? file.authIndex) === normalizeAuthIndex(latest.auth_index)) : undefined;
  const account = file ? (!hidden && names[privateAccountLabel(file, providerForFile(file) ?? String(file.provider ?? 'other'))])
    || privateAccountLabel(file, providerForFile(file) ?? String(file.provider ?? 'other')) : null;
  return <section className={`connection-overview connection-${stage}`} aria-label={t('connection.title')}>
    <div className="connection-overview-heading"><div><span>{t('connection.title')}</span><h2>{t(`connection.${stage}`)}</h2></div>
      <button type="button" className="secondary-button compact-button" disabled={busy || stage === 'checking' || stage === 'unsupported'}
        onClick={stage === 'notDetected' ? onDetect : onReview}>{t(stage === 'notDetected' ? 'connection.detectAction' : stage === 'attention' ? 'connection.fixAction' : stage === 'detected' ? 'connection.connectAction' : 'connection.reviewAction')}</button></div>
    <p>{t(`connection.${stage}Hint`)}</p>
    <ol className="connection-stages" aria-label={t('connection.progress')}>
      {(['detected', 'configured', 'verified'] as const).map((step, i) => <li key={step} className={stage === 'verified' || stage === 'configured' && i < 2 || status?.installed && i === 0 ? 'complete' : ''}>{t(`connection.${step}`)}</li>)}
    </ol>
    {configuredModels.length > 0 && status?.connectionState === 'configured' && !status.codexNativeOauth && <details className="ux-models"><summary>{t('ux.configuredModels')} · {configuredModels.length}</summary>
      <p>{t('ux.modelHint')}</p><ul>{configuredModels.map((model, i) => {
        const level = explicitReasoning(payload, model);
        return <li key={`${model.alias ?? model.model}-${i}`}><strong>{privateText(model.model, hidden)}</strong>{model.alias && <code>{privateText(model.alias, hidden)}</code>}<span>{t(!payloadLoaded ? 'ux.reasoningUnknown' : level ? 'ux.reasoning' : 'ux.reasoningDefault', { level: level ?? '' })}</span></li>;
      })}</ul></details>}
    <div className="connection-evidence"><strong>{t('connection.evidence')}</strong>
      {latest ? <><span>{t(latest.failed ? 'connection.failed' : 'connection.succeeded')} · <time dateTime={latest.timestamp}>{new Date(latest.timestamp).toLocaleString()}</time></span><span>{privateText(latest.model, hidden)}{account ? ` · ${account}` : ''}</span></>
        : <span>{t(error ? 'connection.unavailable' : loaded ? 'connection.noEvidence' : 'connection.loading')}</span>}
      {latest && <small>{latest.reasoning_effort ? t('ux.recordedReasoning', { level: privateText(latest.reasoning_effort, hidden) }) : t('ux.noRecordedReasoning')}</small>}
      {latest?.failed && <div className="ux-failure"><p>{t(`ux.${failureKind(latest)}`)}</p><RequestFailureAction record={latest} /></div>}
      {error && <small role="status">{t('ux.connectionStale')}</small>}
      <button type="button" className="secondary-button compact-button" disabled={busy || refreshing} onClick={() => reload.current()}>{t(refreshing ? 'accountDashboard.refreshing' : 'ux.connectionRefresh')}</button>
      <small>{t('connection.evidenceHint')}</small>
    </div>
  </section>;
}
