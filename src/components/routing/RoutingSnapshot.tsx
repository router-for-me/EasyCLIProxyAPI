import { useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import { SelectMenu } from '../SelectMenu';
import { routingDestinationId, routingRecordId, type buildLiveRouting } from '../../services/usageRouting';
import { changeRoutingDisplay, LATEST_ROUTING_FOCUS, orderedRoutingRecords, resolveRoutingFocus, type RoutingDisplay, type RoutingFocus } from '../../services/usageRoutingView';
import type { UsageRecord } from '../../services/usage';
import { usageClientAgent } from '../../services/clientAgent';
import { RoutingMap } from './RoutingMap';
import { useRoutingDisplay } from './useRoutingDisplay';
import './RoutingPanel.css';

export function RoutingSnapshot({ view, packets, now, paused = false, onTogglePause, updated, error, cooldownError, truncated,
  initialFocus = LATEST_ROUTING_FOCUS, display: controlledDisplay, onDisplayChange }: {
  view: ReturnType<typeof buildLiveRouting>; packets: UsageRecord[]; now: number; paused?: boolean;
  onTogglePause?: () => void; updated?: number | null; error?: string; cooldownError?: boolean; truncated?: boolean;
  initialFocus?: RoutingFocus; display?: RoutingDisplay; onDisplayChange?: (display: RoutingDisplay) => void;
}) {
  const { t, formatNumber, formatDate } = useI18n();
  const privacy = usePrivacyMask();
  const [savedDisplay, saveDisplay] = useRoutingDisplay();
  const display = controlledDisplay || savedDisplay;
  const updateDisplay = onDisplayChange || saveDisplay;
  const [focus, setFocus] = useState<RoutingFocus>(initialFocus);
  const selection = resolveRoutingFocus(focus, view.records);
  const record = selection.record;
  const records = orderedRoutingRecords(view.records);
  const hasRecords = records.length > 0;
  const clientName = (item: UsageRecord) => {
    const client = usageClientAgent(item);
    return client.name || t(client.id === 'unknown' ? 'routing.unknownClient' : 'routing.otherClient');
  };
  const recordLabel = (item: UsageRecord) => {
    const target = view.targets.find(row => row.id === routingDestinationId(item));
    const label = target?.name || item.source_display || item.provider;
    return `${formatDate(item.timestamp, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${clientName(item)} · ${privacy.text(item.alias || item.model)} · ${privacy.text(label)}`;
  };
  const options = [...records];
  if (record && !options.some(item => routingRecordId(item) === routingRecordId(record))) options.push(record);
  const selectedValue = record ? routingRecordId(record) : focus.mode === 'pinned' ? focus.recordId : '';
  const requested = record?.alias || record?.model || '';
  const response = record?.response_model?.trim();
  const target = record ? view.targets.find(item => item.id === routingDestinationId(record)) : undefined;
  const credential = record ? target?.name || record.source_display || record.provider : '';
  const outcome = record ? t(record.canceled ? 'routing.recordCanceled' : record.failed ? 'routing.recordFailed' : 'routing.recordSucceeded') : '';
  const identity = record?.request_id || (record ? routingRecordId(record) : '');
  const safeIdentity = identity && /^[A-Za-z0-9_.:-]{1,128}$/.test(identity) && !/^(?:sk-|AIza|gh[pousr]_|Bearer)/i.test(identity) ? identity : '—';
  return (
    <section className={`panel surface-panel live-routing-panel${paused ? ' paused' : ''}${error ? ' has-error' : ''}`} aria-label={t('routing.live')}>
      <header className="live-routing-heading">
        <div className="live-routing-title"><h2>{t('routing.live')}</h2><span className="live-routing-state" role="status"><span aria-hidden="true" />{t(paused ? 'routing.paused' : error ? 'routing.unavailable' : 'routing.monitoring')}</span></div>
        <div className="live-routing-actions">
          <span className="live-routing-count">{t('routing.windowBadge')}</span>
          <SelectMenu value={display.depth} ariaLabel={t('routing.depth')} className="routing-depth-control"
            options={(['auto', 'models', 'credentials'] as const).map(value => ({ value, label: t(`routing.depth.${value}`) }))}
            onChange={value => updateDisplay(changeRoutingDisplay(display, { depth: value as RoutingDisplay['depth'] }))} />
          <button type="button" className="icon-button quiet" disabled={!onTogglePause} aria-label={t(paused ? 'routing.resume' : 'routing.pause')} title={t(paused ? 'routing.resume' : 'routing.pause')} onClick={onTogglePause}>
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
        </div>
      </header>
      <dl className="routing-window-metrics" aria-label={t('routing.windowBadge')}>
        <div><dt>{t('routing.windowRecords')}</dt><dd>{formatNumber(view.metrics.requests)}</dd></div>
        <div><dt>{t('routing.failedRecords')}</dt><dd className={view.metrics.failures ? 'routing-row-failures' : ''}>{formatNumber(view.metrics.failures)}</dd></div>
        <div><dt>{t('routing.observedPaths')}</dt><dd>{formatNumber(view.metrics.flows)}</dd></div>
      </dl>
      {error && hasRecords ? <p role="status" className="live-routing-warning">{error}</p> : null}
      {cooldownError ? <p className="live-routing-warning">{t('routing.cooldownsUnavailable')}</p> : null}
      {hasRecords || selection.expired ? <div className="routing-request-controls">
        <span className="routing-context-label">{t(selection.pinned ? 'routing.pinnedRecord' : 'routing.latestRecord')}</span>
        <SelectMenu value={selectedValue} ariaLabel={t('routing.recentRecords')} className="routing-record-control"
          options={selection.expired ? [{ value: selectedValue, label: t('routing.expiredSelection') }, ...options.map(item => ({ value: routingRecordId(item), label: recordLabel(item) }))]
            : options.map(item => ({ value: routingRecordId(item), label: recordLabel(item) }))}
          onChange={recordId => setFocus({ mode: 'pinned', recordId })} />
        {selection.pinned ? <button type="button" className="routing-text-button" onClick={() => setFocus(LATEST_ROUTING_FOCUS)}>{t('routing.backToLatest')}</button> : null}
      </div> : null}
      <RoutingMap view={view} packets={packets} now={now} paused={paused} display={display} error={error}
        onToggleGroup={group => updateDisplay(changeRoutingDisplay(display, { toggle: group }))}
        focusedRecord={record} onFocusRecord={item => setFocus({ mode: 'pinned', recordId: routingRecordId(item) })} />
      {record || selection.expired ? <div className="routing-request-context" aria-label={t('routing.selectedRecord')}>
        {record ? <>
          <div className="routing-request-identity"><strong>{clientName(record)}</strong><span>{privacy.text(requested)}{response && response !== requested ? ` → ${privacy.text(response)}` : ''}</span><span>{privacy.text(credential)}{record.provider && credential !== record.provider ? ` · ${privacy.text(record.provider)}` : ''}</span></div>
          <div className="routing-request-facts"><span className={record.failed && !record.canceled ? 'routing-row-failures' : ''}>{outcome}{record.failure_status ? ` · HTTP ${record.failure_status}` : ''}</span><span>{formatNumber(Math.round(record.latency_ms))} ms</span><time dateTime={record.timestamp}>{formatDate(record.timestamp, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span className="routing-request-id">{t('routing.recordId')}: {privacy.enabled ? privacy.identifier(safeIdentity) : safeIdentity}</span></div>
        </> : <span>{t('routing.recordExpired')}</span>}
      </div> : null}
      {updated != null || truncated ? <footer>{updated != null ? <span>{t('routing.updated', { time: formatDate(updated, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}</span> : null}{truncated ? <span>{t('routing.truncated')}</span> : null}</footer> : null}
    </section>
  );
}
