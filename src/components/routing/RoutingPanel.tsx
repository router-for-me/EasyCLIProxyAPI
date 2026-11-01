import { useEffect, useMemo, useState } from 'react';
import { Activity, Pause, Play } from 'lucide-react';
import { useI18n } from '../../i18n';
import { managementApi } from '../../services/managementApi';
import { getUsageEvents, type UsageRecord } from '../../services/usage';
import { pollWhileActive, windowActivity } from '../../services/windowActivity';
import { onUsageRecordsUpdated } from '../../services/events';
import { buildLiveRouting, routingCooldowns, routingFinishedAt, routingRecordId, type RoutingCooldown } from '../../services/usageRouting';
import { RoutingMap } from './RoutingMap';
import './RoutingPanel.css';

export function RoutingPanel({ coreReady = true }: { coreReady?: boolean }) {
  const { t, formatDate } = useI18n();
  const [paused, setPaused] = useState(false);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [cooldowns, setCooldowns] = useState<RoutingCooldown[]>([]);
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
          try { setCooldowns(routingCooldowns(credentials.value, received)); setCooldownError(false); }
          catch { setCooldownError(true); setCooldowns([]); }
        } else { setCooldownError(coreReady); setCooldowns([]); }
        setNow(received);
      } finally { busy = false; }
    };
    let stopEvents: (() => void) | undefined;
    void onUsageRecordsUpdated(() => { void refresh(); }).then(stop => { if (disposed) stop(); else stopEvents = stop; }).catch(() => {});
    const stopPolling = pollWhileActive(() => { void refresh(); }, 3000, () => { seen = undefined; visibleSince = Date.now(); setPackets([]); });
    const stopClock = pollWhileActive(() => setNow(Date.now()), 1000);
    return () => { disposed = true; stopPolling(); stopClock(); stopEvents?.(); if (packetTimer) clearTimeout(packetTimer); };
  }, [paused, coreReady]);
  const view = useMemo(() => buildLiveRouting(records, cooldowns, now), [records, cooldowns, now]);
  return <section className={`panel surface-panel live-routing-panel${paused ? ' paused' : ''}`} aria-label={t('routing.live')}>
    <header className="live-routing-heading"><div><h2><Activity size={18} />{t('routing.live')}<span className="live-routing-count">{t('routing.requests', { count: view.records.length })}</span></h2><p>{t('routing.liveDescription')}</p></div>
      <button type="button" className="icon-button quiet" aria-label={t(paused ? 'routing.resume' : 'routing.pause')} title={t(paused ? 'routing.resume' : 'routing.pause')} onClick={() => { setPaused(value => !value); setPackets([]); }}>{paused ? <Play size={16} /> : <Pause size={16} />}</button>
    </header>
    {error && <p role="status" className="live-routing-warning">{error}</p>}
    {cooldownError && <p className="live-routing-warning">{t('routing.cooldownsUnavailable')}</p>}
    {view.models.length || view.targets.length ? <RoutingMap view={view} packets={packets} now={now} /> : <div className="live-routing-empty"><Activity size={30} /><p>{t('routing.waiting')}</p></div>}
    <footer><span>{paused ? t('routing.paused') : updated ? t('routing.updated', { time: formatDate(updated, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : ''}</span>{(truncated || view.hidden) && <span>{t('routing.truncated')}</span>}</footer>
  </section>;
}
