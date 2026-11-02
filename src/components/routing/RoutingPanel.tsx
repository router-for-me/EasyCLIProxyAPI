import { useEffect, useMemo, useState } from 'react';
import { Activity, Pause, Play, GitBranch, Timer, ShieldCheck, Radio, Zap } from 'lucide-react';
import { useI18n } from '../../i18n';
import { managementApi } from '../../services/managementApi';
import { getUsageEvents, type UsageRecord } from '../../services/usage';
import { pollWhileActive, windowActivity } from '../../services/windowActivity';
import { onUsageRecordsUpdated } from '../../services/events';
import { buildLiveRouting, routingCooldowns, routingCredentials, routingFinishedAt, routingRecordId, routingCooldownSeconds, type RoutingCooldown, type RoutingCredential } from '../../services/usageRouting';
import { usePrivacyMask } from '../../privacy';
import { RoutingMap } from './RoutingMap';
import './RoutingPanel.css';

export function RoutingPanel({ coreReady = true }: { coreReady?: boolean }) {
  const { t, formatDate, formatNumber } = useI18n();
  const privacy = usePrivacyMask();
  const [paused, setPaused] = useState(false);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [cooldowns, setCooldowns] = useState<RoutingCooldown[]>([]);
  const [credentials, setCredentials] = useState<RoutingCredential[]>([]);
  const [credentialsKnown, setCredentialsKnown] = useState(false);
  const [packets, setPackets] = useState<UsageRecord[]>([]);
  const [now, setNow] = useState(Date.now());
  const [updated, setUpdated] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [cooldownError, setCooldownError] = useState(false);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    if (paused) return;
    let disposed = false; let busy = false;
    let seen: Set<string> | undefined;
    let visibleSince = Date.now();
    let packetTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (busy || disposed || !windowActivity.active()) return;
      busy = true;
      try {
        const [events, credentials] = await Promise.allSettled([
          getUsageEvents({ query: { page: 1, page_size: 200 } }),
          coreReady ? managementApi.get<unknown>('/credentials') : Promise.reject(new Error('Core not running')),
        ]);
        if (disposed || !windowActivity.active()) return;
        const received = Date.now();
        if (events.status === 'rejected') { setError(String(events.reason)); setPackets([]); }
        else {
          const items = events.value.items;
          const fresh = seen ? items.filter(record => !seen!.has(routingRecordId(record)) && routingFinishedAt(record) >= visibleSince && routingFinishedAt(record) >= received - 10_000) : [];
          seen = new Set(items.map(routingRecordId));
          setRecords(items); setPackets(fresh); setError(''); setUpdated(received);
          setTruncated(events.value.total > 200 && items.length === 200 && routingFinishedAt(items[items.length - 1]) >= received - 60_000);
          if (packetTimer) clearTimeout(packetTimer);
          packetTimer = setTimeout(() => { if (!disposed) setPackets([]); }, 2000);
        }
        if (credentials.status === 'fulfilled') {
          try { setCooldowns(routingCooldowns(credentials.value, received)); setCredentials(routingCredentials(credentials.value)); setCredentialsKnown(true); setCooldownError(false); }
          catch { setCooldownError(true); setCooldowns([]); setCredentials([]); setCredentialsKnown(false); }
        } else { setCooldownError(coreReady); setCooldowns([]); setCredentials([]); setCredentialsKnown(false); }
        setNow(received);
      } finally { busy = false; }
    };
    let stopEvents: (() => void) | undefined;
    void onUsageRecordsUpdated(() => { void refresh(); }).then(stop => { if (disposed) stop(); else stopEvents = stop; }).catch(() => {});
    const stopPolling = pollWhileActive(() => { void refresh(); }, 3000, () => { seen = undefined; visibleSince = Date.now(); setPackets([]); });
    const stopClock = pollWhileActive(() => setNow(Date.now()), 1000);
    return () => { disposed = true; stopPolling(); stopClock(); stopEvents?.(); if (packetTimer) clearTimeout(packetTimer); };
  }, [paused, coreReady]);
  const view = useMemo(() => buildLiveRouting(records, cooldowns, now, credentials), [records, cooldowns, now, credentials]);
  const metrics = [
    { label: t('routing.activeFlows'), value: formatNumber(view.metrics.flows), detail: t('routing.flowDetail'), icon: GitBranch },
    { label: t('routing.windowRequests'), value: formatNumber(view.metrics.requests), detail: `${view.metrics.qps.toFixed(2)} QPS · ${t('routing.windowAverage')}`, icon: Zap },
    { label: t('routing.avgLatency'), value: view.metrics.latency === null ? '—' : `${formatNumber(Math.round(view.metrics.latency))} ms`, detail: t('routing.failures', { count: view.metrics.failures }), icon: Timer },
    { label: t('routing.credentialHealth'), value: credentialsKnown ? `${view.metrics.ready} / ${view.metrics.cooling}` : '— / —', detail: t('routing.healthDetail'), icon: ShieldCheck },
  ];
  return <section className={`panel surface-panel live-routing-panel${paused ? ' paused' : ''}`} aria-label={t('routing.live')}>
    <header className="live-routing-heading"><div><h2><Activity size={18} />{t('routing.live')}<span className="live-routing-count">{t('routing.requests', { count: view.records.length })}</span></h2><p>{t('routing.liveDescription')}</p></div>
      <button type="button" className="icon-button quiet" aria-label={t(paused ? 'routing.resume' : 'routing.pause')} title={t(paused ? 'routing.resume' : 'routing.pause')} onClick={() => { setPaused(value => !value); setPackets([]); }}>{paused ? <Play size={16} /> : <Pause size={16} />}</button>
    </header>
    {error && <p role="status" className="live-routing-warning">{error}</p>}
    {cooldownError && <p className="live-routing-warning">{t('routing.cooldownsUnavailable')}</p>}
    <div className="routing-metrics">{metrics.map(({ label, value, detail, icon: Icon }) => <div className="routing-metric" key={label}><span className="routing-metric-label"><Icon size={15} />{label}</span><strong>{value}</strong><small>{detail}</small></div>)}</div>
    {!view.records.length && <div className="routing-standby">
      <div className="routing-standby-intro"><div className="routing-radar"><Radio size={25} /></div><div><h3>{t(paused ? 'routing.paused' : 'routing.monitoring')}</h3><p>{t('routing.standbyHint')}</p></div><span className="routing-monitor-badge">{t('routing.windowBadge')}</span></div>
      <div className="routing-ready-list">{credentials.slice(0, 6).map(credential => {
        const cooldown = cooldowns.find(item => item.id === credential.id && routingCooldownSeconds(item, now) > 0);
        const blocked = credential.disabled || credential.unavailable;
        return <div className={`routing-ready-target${cooldown ? ' cooling' : ''}${blocked ? ' unavailable' : ''}`} key={credential.id}><span className="routing-status-dot" /><div><strong>{privacy.text(credential.name || credential.provider)}</strong><small>{privacy.text(credential.provider)}</small></div><span>{cooldown ? t('routing.cooldown', { seconds: routingCooldownSeconds(cooldown, now) }) : t(blocked ? 'routing.notReady' : 'routing.ready')}</span></div>;
      })}</div>
      <p className="routing-standby-note">{t(!credentialsKnown ? 'routing.inventoryUnknown' : !credentials.length ? 'routing.noTargets' : 'routing.inventoryCount', { count: credentials.length })}</p>
    </div>}
    {(view.models.length > 0 || view.targets.length > 0) && <RoutingMap view={view} packets={packets} now={now} />}
    <footer><span>{paused ? t('routing.paused') : updated ? t('routing.updated', { time: formatDate(updated, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : ''}</span>{(truncated || view.hidden) && <span>{t('routing.truncated')}</span>}</footer>
  </section>;
}
