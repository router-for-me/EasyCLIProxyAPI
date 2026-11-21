import { useEffect, useMemo, useState } from 'react';
import { managementApi } from '../../services/managementApi';
import { useI18n } from '../../i18n';
import { selectedRemoteEndpoint } from '../../services/remoteCpa';
import { getUsageCollectorStatus, getUsageEvents, type UsageRecord } from '../../services/usage';
import { pollWhileActive, windowActivity } from '../../services/windowActivity';
import { onUsageRecordsUpdated } from '../../services/events';
import { buildLiveRouting, routingCooldowns, routingCredentials, routingFinishedAt, routingRecordId, type RoutingCooldown, type RoutingCredential } from '../../services/usageRouting';
import { RoutingSnapshot } from './RoutingSnapshot';
import './RoutingPanel.css';

export function RoutingPanel({ coreReady = true }: { coreReady?: boolean }) {
  const { t } = useI18n();
  const [paused, setPaused] = useState(false);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [cooldowns, setCooldowns] = useState<RoutingCooldown[]>([]);
  const [credentials, setCredentials] = useState<RoutingCredential[]>([]);
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
        const [events, credentials, collector] = await Promise.allSettled([
          getUsageEvents({ query: { page: 1, page_size: 200 } }),
          coreReady ? managementApi.get<unknown>('/credentials') : Promise.reject(new Error('Core not running')),
          selectedRemoteEndpoint() ? getUsageCollectorStatus() : Promise.resolve(null),
        ]);
        if (disposed || !windowActivity.active()) return;
        const received = Date.now();
        if (events.status === 'rejected') { setError(String(events.reason)); setPackets([]); }
        else {
          const items = events.value.items;
          const fresh = seen ? items.filter(record => !seen!.has(routingRecordId(record)) && routingFinishedAt(record) >= visibleSince && routingFinishedAt(record) >= received - 10_000) : [];
          seen = new Set(items.map(routingRecordId));
          setRecords(items); setPackets(fresh);
          const state = collector.status === 'fulfilled' ? collector.value : null;
          setError(collector.status === 'rejected' ? String(collector.reason) : state?.state === 'disabled' ? t('remote.usageDisabled') : state?.state === 'error' ? state.message : ''); setUpdated(received);
          setTruncated(events.value.total > 200 && items.length === 200 && routingFinishedAt(items[items.length - 1]) >= received - 60_000);
          if (packetTimer) clearTimeout(packetTimer);
          packetTimer = setTimeout(() => { if (!disposed) setPackets([]); }, 2000);
        }
        if (credentials.status === 'fulfilled') {
          try { setCooldowns(routingCooldowns(credentials.value, received)); setCredentials(routingCredentials(credentials.value)); setCooldownError(false); }
          catch { setCooldownError(true); setCooldowns([]); setCredentials([]); }
        } else { setCooldownError(coreReady); setCooldowns([]); setCredentials([]); }
        setNow(received);
      } finally { busy = false; }
    };
    let stopEvents: (() => void) | undefined;
    void onUsageRecordsUpdated(() => { void refresh(); }).then(stop => { if (disposed) stop(); else stopEvents = stop; }).catch(() => {});
    const stopPolling = pollWhileActive(() => { void refresh(); }, 3000, () => { seen = undefined; visibleSince = Date.now(); setPackets([]); });
    const stopClock = pollWhileActive(() => setNow(Date.now()), 1000);
    return () => { disposed = true; stopPolling(); stopClock(); stopEvents?.(); if (packetTimer) clearTimeout(packetTimer); };
  }, [paused, coreReady, t]);
  const view = useMemo(() => buildLiveRouting(records, cooldowns, now, credentials), [records, cooldowns, now, credentials]);
  return <RoutingSnapshot view={view} packets={packets} now={now} paused={paused}
    updated={updated} error={error} cooldownError={cooldownError} truncated={truncated}
    onTogglePause={() => { setPaused(value => !value); setPackets([]); }} />;
}
