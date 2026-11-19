import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, Terminal } from 'lucide-react';
import appLogo from '../../assets/logo.jpg';
import openclawIcon from '../../assets/icons/openclaw.svg';
import hermesIcon from '../../assets/icons/hermes.png';
import workbuddyIcon from '../../assets/icons/workbuddy.png';
import grokIcon from '../../assets/icons/grok.svg';
import { BrandIcon } from '../BrandIcon';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import { routingCooldownSeconds, routingFinishedAt, routingAgentId, routingDestinationId, type buildLiveRouting, type RoutingNode, type RoutingAgent, type RoutingTarget } from '../../services/usageRouting';
import type { UsageRecord } from '../../services/usage';
import { DEFAULT_ROUTING_DISPLAY, groupRoutingTargets, orderedRoutingRecords, projectRoutingGroups, routingRecordForNode, routingRowRelated, routingGroupControlId, type RoutingDisplay, type RoutingGroup, type RoutingRow } from '../../services/usageRoutingView';

const CLIENT_ICONS: Readonly<Record<string, string>> = { openclaw: openclawIcon, hermes: hermesIcon, workbuddy: workbuddyIcon, grok: grokIcon };
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
type LinkState = 'idle' | 'recorded' | 'flowing' | 'failing';
type LinkTraffic = { finishedAt: number; failed: boolean; active: boolean };

function indexTraffic(records: UsageRecord[], packets: UsageRecord[]) {
  const agents = new Map<string, LinkTraffic>();
  const targets = new Map<string, LinkTraffic>();
  const add = (record: UsageRecord, fresh: boolean) => {
    const traffic = {
      finishedAt: routingFinishedAt(record),
      failed: record.failed && !record.canceled,
      active: fresh && !record.failed && !record.canceled,
    };
    for (const [collection, id] of [[agents, routingAgentId(record)], [targets, routingDestinationId(record)]] as const) {
      const previous = collection.get(id);
      if (!previous || traffic.finishedAt > previous.finishedAt) collection.set(id, traffic);
      else if (traffic.finishedAt === previous.finishedAt) {
        const failed = previous.failed || traffic.failed;
        collection.set(id, { ...traffic, failed, active: !failed && (previous.active || traffic.active) });
      }
    }
  };
  // API order is not chronological. The newest completed request determines state.
  records.forEach((record) => add(record, false));
  packets.forEach((record) => add(record, true));
  return { agents, targets };
}

function linkState(node: RoutingNode, traffic: LinkTraffic | undefined, paused: boolean): LinkState {
  if (node.count <= 0) return 'idle';
  if (node.failed || traffic?.failed || (node.failures > 0 && node.failures / node.count >= 0.5)) return 'failing';
  return traffic?.active && !paused && !node.cooldown ? 'flowing' : 'recorded';
}

function linkStyle(node: RoutingNode, state: LinkState, peak: number): CSSProperties {
  const volume = peak > 0 ? Math.sqrt(Math.min(1, node.count / peak)) : 0;
  return {
    strokeWidth: node.count > 0 ? Math.min(2.4, 1.6 + 0.8 * volume) : 1.2,
    opacity: state === 'idle' ? 0.22 : state === 'flowing' ? 0.85 : 0.28 + 0.24 * volume,
  };
}

function buildEdge(from: [number, number], to: [number, number]): string {
  const dx = Math.max(16, Math.abs(to[0] - from[0]) * 0.5);
  return `M ${from[0].toFixed(1)} ${from[1].toFixed(1)} C ${(from[0] + dx).toFixed(1)} ${from[1].toFixed(1)}, ${(to[0] - dx).toFixed(1)} ${to[1].toFixed(1)}, ${to[0].toFixed(1)} ${to[1].toFixed(1)}`;
}

export function RoutingMap({ view, packets, now, paused = false, display = DEFAULT_ROUTING_DISPLAY,
  onToggleGroup, focusedRecord, onFocusRecord }: {
  view: ReturnType<typeof buildLiveRouting>;
  packets: UsageRecord[];
  now: number;
  paused?: boolean;
  display?: RoutingDisplay;
  onToggleGroup?: (group: RoutingGroup) => void;
  focusedRecord?: UsageRecord;
  onFocusRecord?: (record: UsageRecord) => void;
}) {
  const { t, formatNumber } = useI18n();
  const privacy = usePrivacyMask();
  const controlsPrefix = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [modelEdges, setModelEdges] = useState<Record<string, string>>({});
  const [targetEdges, setTargetEdges] = useState<Record<string, string>>({});
  const lastFocusedTarget = useRef<{ element: HTMLElement; id: string } | undefined>(undefined);
  const groups = useMemo(() => groupRoutingTargets(view.targets), [view.targets]);
  const projection = useMemo(() => projectRoutingGroups(groups, display), [groups, display]);

  const updatePaths = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const gatewayEl = container.querySelector<HTMLElement>('[data-route-gateway]');
    if (!gatewayEl) return;
    const gwRect = gatewayEl.getBoundingClientRect();

    const railInEl = gatewayEl.querySelector<HTMLElement>('.gateway-rail-in');
    const railOutEl = gatewayEl.querySelector<HTMLElement>('.gateway-rail-out');

    const gwLeft = railInEl
      ? railInEl.getBoundingClientRect().left - cRect.left + railInEl.getBoundingClientRect().width / 2
      : gwRect.left - cRect.left;
    const gwRight = railOutEl
      ? railOutEl.getBoundingClientRect().left - cRect.left + railOutEl.getBoundingClientRect().width / 2
      : gwRect.right - cRect.left;
    const gwCenterY = gwRect.top - cRect.top + gwRect.height / 2;

    const modelEls = container.querySelectorAll<HTMLElement>('[data-route-model]');
    const N = modelEls.length;
    const newModelEdges: Record<string, string> = {};
    modelEls.forEach((el, i) => {
      const key = el.getAttribute('data-route-model') || String(i);
      const portEl = el.querySelector<HTMLElement>('.port-out') || el;
      const pRect = portEl.getBoundingClientRect();
      const x1 = pRect.left - cRect.left + pRect.width / 2;
      const y1 = pRect.top - cRect.top + pRect.height / 2;
      const dockY = gwCenterY + (i - (N - 1) / 2) * 8;
      newModelEdges[key] = buildEdge([x1, y1], [gwLeft, dockY]);
    });
    setModelEdges(newModelEdges);

    const targetEls = container.querySelectorAll<HTMLElement>('[data-route-target]');
    const M = targetEls.length;
    const newTargetEdges: Record<string, string> = {};
    targetEls.forEach((el, j) => {
      const key = el.getAttribute('data-route-target') || String(j);
      const portEl = el.querySelector<HTMLElement>('.port-in') || el;
      const pRect = portEl.getBoundingClientRect();
      const x2 = pRect.left - cRect.left + pRect.width / 2;
      const y2 = pRect.top - cRect.top + pRect.height / 2;
      const dockY = gwCenterY + (j - (M - 1) / 2) * Math.min(8, 40 / Math.max(1, M - 1));
      const parentId = el.getAttribute('data-route-parent');
      const parent = parentId ? [...targetEls].find(node => node.getAttribute('data-route-target') === parentId) : undefined;
      const parentPort = parent?.querySelector<HTMLElement>('.port-in')?.getBoundingClientRect();
      newTargetEdges[key] = buildEdge(parentPort
        ? [parentPort.left - cRect.left + parentPort.width / 2, parentPort.top - cRect.top + parentPort.height / 2]
        : [gwRight, dockY], [x2, y2]);
    });
    setTargetEdges(newTargetEdges);
  }, []);

  useIsomorphicLayoutEffect(() => {
    updatePaths();
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => updatePaths());
    ro.observe(el);
    const nodes = el.querySelectorAll('[data-route-model], [data-route-target], [data-route-gateway]');
    nodes.forEach((node) => ro.observe(node));
    return () => ro.disconnect();
  }, [view.agents, projection.rows, updatePaths]);

  useIsomorphicLayoutEffect(() => {
    const previous = lastFocusedTarget.current;
    if (!previous || previous.element.isConnected) return;
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) {
      lastFocusedTarget.current = undefined;
      return;
    }
    const visibleId = projection.endpointByTarget.get(previous.id) || previous.id;
    const element = [...(containerRef.current?.querySelectorAll<HTMLElement>('[data-route-target]') || [])]
      .find(node => node.getAttribute('data-route-target') === visibleId);
    const control = element?.querySelector<HTMLElement>('.routing-group-toggle') || element?.querySelector<HTMLElement>('.routing-node-focus')
      || containerRef.current?.querySelector<HTMLElement>('.routing-group-toggle, .routing-node-focus');
    control?.focus({ preventScroll: true });
    lastFocusedTarget.current = undefined;
  }, [projection]);

  const traffic = useMemo(() => indexTraffic(view.records, packets), [view.records, packets]);
  const peakModel = Math.max(1, ...view.agents.map((node) => node.count));
  const peakTarget = Math.max(1, ...projection.rows.map(row => row.node.count));
  const focusedAgent = focusedRecord ? routingAgentId(focusedRecord) : undefined;
  const relatedRow = (row: RoutingRow) => !focusedRecord || routingRowRelated(row, focusedRecord);
  const rowTraffic = (row: RoutingRow): LinkTraffic | undefined => {
    const samples = row.targetIds.map(id => {
      const item = traffic.targets.get(id);
      return item ? { ...item, active: item.active && !view.targets.find(target => target.id === id)?.cooldown } : undefined;
    }).filter((item): item is LinkTraffic => !!item);
    if (!samples.length) return undefined;
    const finishedAt = Math.max(...samples.map(item => item.finishedAt));
    const latest = samples.filter(item => item.finishedAt === finishedAt);
    const failed = latest.some(item => item.failed);
    return { finishedAt, failed, active: !failed && latest.some(item => item.active) };
  };
  const renderLink = (node: RoutingNode, side: 'model' | 'target', index: number, row?: RoutingRow) => {
    const models = side === 'model';
    const latest = models ? traffic.agents.get(node.id) : row ? rowTraffic(row) : undefined;
    const state = linkState(node, latest, paused);
    const related = models ? !focusedAgent || focusedAgent === node.id : !row || relatedRow(row);
    const offset = index - ((models ? view.agents : projection.rows).length - 1) / 2;
    const d = (models ? modelEdges : targetEdges)[node.id] ?? (models
      ? buildEdge([240, 120 + offset * 44], [420, 120 + offset * 8])
      : buildEdge([580, 120 + offset * 8], [760, 120 + offset * 44]));
    const attributes = models ? { 'data-model': node.id, 'data-agent': node.id } : { 'data-target': node.id, 'data-agent': row?.group.agentId };
    const style = linkStyle(node, state, models ? peakModel : peakTarget);
    return (
      <g key={node.id}>
        <path
          className={`routing-edge routing-edge-${state}${state === 'flowing' ? ' routing-edge-flow' : ''}${related && focusedRecord ? ' routing-edge-focused' : ''}`}
          {...attributes}
          d={d}
          style={{ ...style, opacity: related ? style.opacity : Math.max(0.18, Number(style.opacity) * 0.6) }}
        />
        {state === 'flowing' ? (
          <circle key={latest?.finishedAt} className="routing-packet" r="2.5" {...attributes}>
            <animateMotion dur="1.6s" repeatCount="1" fill="freeze" path={d} />
          </circle>
        ) : null}
      </g>
    );
  };

  const clientName = (agent: RoutingAgent | undefined) => agent?.client.name || t(!agent || agent.client.id === 'unknown' ? 'routing.unknownClient' : 'routing.otherClient');
  const focusNode = (agentId?: string, targetIds?: string[]) => {
    const record = routingRecordForNode(view.records, { agentId, targetIds });
    if (record) onFocusRecord?.(record);
  };
  const mark = (icon: string) => (
    <span className="routing-node-mark" data-monochrome={/^(openai|opencode|kimi|pi|grok|copilot)$/i.test(icon) || undefined}>
      {Object.prototype.hasOwnProperty.call(CLIENT_ICONS, icon) ? <img src={CLIENT_ICONS[icon]} width={22} height={22} alt="" aria-hidden="true" />
        : icon ? <BrandIcon name={icon} size={22} /> : <Terminal size={22} aria-hidden="true" />}
    </span>
  );
  const renderAgent = (node: RoutingAgent) => {
    const state = linkState(node, traffic.agents.get(node.id), paused);
    const record = focusedAgent === node.id ? focusedRecord : orderedRoutingRecords(view.records).find(item => routingAgentId(item) === node.id);
    const name = privacy.text(clientName(node));
    return (
      <div key={node.id} className={`routing-node node-${state}${focusedAgent === node.id ? ' node-focused' : focusedAgent ? ' node-unrelated' : ''}`}
        data-route-model={node.id} data-route-agent={node.id}>
        <button type="button" className="routing-node-focus" aria-pressed={focusedAgent === node.id} onClick={() => focusNode(node.id)}>
          {mark(node.client.icon || '')}
          <span className="routing-row-text">
            <span className="routing-row-heading"><span className="routing-row-name" title={name}>{name}</span></span>
            {record ? <span className="routing-row-credential">{privacy.text(record.alias || record.model)}</span> : null}
            {node.failures ? <span className="routing-row-failures">{t('routing.failures', { count: formatNumber(node.failures) })}</span> : null}
          </span>
        </button>
        <span className="routing-port port-out" aria-hidden="true" />
      </div>
    );
  };
  const renderTarget = (row: RoutingRow, open: boolean, controlsId?: string) => {
    const { node, group, kind } = row;
    const summary = kind === 'group';
    const state = linkState(node, rowTraffic(row), paused);
    const cooldown = !summary ? node.cooldown : undefined;
    const related = relatedRow(row);
    const name = privacy.text(kind === 'credential' ? node.name : group.model || node.name);
    const subline = summary ? t('routing.credentialCount', { count: group.credentialCount })
      : kind === 'credential' ? '' : [node.name, node.provider && node.provider !== node.name ? node.provider : ''].filter(Boolean).join(' · ');
    return (
      <div key={node.id} className={`routing-node node-${state}${cooldown || (summary && group.coolingCount === group.credentialCount) ? ' node-resting' : ''}${kind === 'credential' ? ' routing-credential-row' : ''}${focusedRecord && related ? ' node-focused' : focusedRecord ? ' node-unrelated' : ''}`}
        data-route-target={node.id} data-route-agent-id={group.agentId} data-route-parent={row.parentId} data-routing-kind={kind}>
        <span className="routing-port port-in" aria-hidden="true" />
        <button type="button" className="routing-node-focus" disabled={!node.count} aria-pressed={!!focusedRecord && related} onClick={() => focusNode(group.agentId, row.targetIds)}>
          {kind !== 'credential' ? mark(node.provider || '') : null}
          <span className="routing-row-text">
            <span className="routing-row-heading">
              <span className="routing-row-name" title={name}>{name}</span>
              {kind !== 'credential' && group.agentId ? <span className="routing-row-origin">{clientName(view.agents.find(item => item.id === group.agentId))}</span> : null}
            </span>
            {subline ? <span className="routing-row-credential">{privacy.text(subline)}{summary && node.provider ? ` · ${privacy.text(node.provider)}` : ''}</span> : null}
            <span className="routing-node-details">
              {node.count > 0 && (!summary || !open) ? <span className="routing-row-meta">{formatNumber(node.count)} · {formatNumber(Math.round(node.latency))} ms</span> : null}
              <span className="routing-node-state">
                {summary ? <>
                  {node.failures > 0 ? <span className="routing-row-failures">{t('routing.failures', { count: formatNumber(node.failures) })}</span> : null}
                  {group.coolingCount > 0 ? <span className="routing-cooldown-pill">{t('routing.coolingCount', { count: group.coolingCount })}</span> : null}
                </> : cooldown ? <span className="routing-cooldown-pill">{t('routing.cooldown', { seconds: routingCooldownSeconds(cooldown, now) })}</span>
                  : node.failures > 0 ? <span className="routing-row-failures routing-failure-pill">{t('routing.failures', { count: formatNumber(node.failures) })}</span> : null}
              </span>
            </span>
          </span>
        </button>
        {summary ? <button type="button" className="routing-group-toggle" aria-label={t(open ? 'routing.collapseCredentials' : 'routing.expandCredentials', { model: name })}
          aria-expanded={open} aria-controls={controlsId} onClick={() => onToggleGroup?.(group)}>
          <ChevronDown size={16} aria-hidden="true" className={open ? 'open' : ''} />
        </button> : null}
      </div>
    );
  };

  return (
    <div className="live-routing-map" data-testid="routing-map" ref={containerRef} onFocusCapture={event => {
      const element = event.target as HTMLElement;
      const target = element.closest<HTMLElement>('[data-route-target]');
      if (target?.dataset.routeTarget) lastFocusedTarget.current = { element, id: target.dataset.routeTarget };
      else lastFocusedTarget.current = undefined;
    }}>
      <svg className="live-routing-edges" aria-hidden="true">
        {view.agents.length ? view.agents.map((node, index) => renderLink(node, 'model', index)) : (
          <path className="routing-edge routing-edge-ghost" data-model="__ghost__" d={modelEdges['__ghost__'] || 'M 240 120 C 330 120, 330 120, 420 120'} />
        )}
        {projection.rows.length ? projection.rows.map((row, index) => renderLink(row.node, 'target', index, row)) : (
          <path className="routing-edge routing-edge-ghost" data-target="__ghost__" d={targetEdges['__ghost__'] || 'M 580 120 C 670 120, 670 120, 760 120'} />
        )}
      </svg>
      <div className="routing-map-column routing-map-models">
        <div className="routing-column-head"><span>{t('routing.agents')}</span><span className="routing-column-count">{formatNumber(view.agents.length)}</span></div>
        <div className="routing-node-list">{view.agents.length ? view.agents.map(renderAgent) : (
          <div className="routing-node node-ghost" data-route-model="__ghost__" data-route-agent="__ghost__"><span className="routing-row-text"><span className="routing-row-name">{t('routing.waiting')}</span></span><span className="routing-port port-out port-ghost" aria-hidden="true" /></div>
        )}</div>
      </div>
      <div className="routing-map-center">
        <div className={`routing-gateway${view.records.length === 0 ? ' gateway-idle' : ''}`} data-route-gateway="true">
          <span className="gateway-rail gateway-rail-in" aria-hidden="true" /><span className="gateway-rail gateway-rail-out" aria-hidden="true" />
          <span className="gateway-mark" aria-hidden="true"><img src={appLogo} width={30} height={30} alt="" /></span><span className="gateway-name">{t('routing.gateway')}</span>
        </div>
      </div>
      <div className="routing-map-column routing-map-targets">
        <div className="routing-column-head"><span>{t('routing.destinations')}</span><span className="routing-column-count">{formatNumber(groups.length)}</span></div>
        <div className="routing-node-list">{projection.sections.length ? projection.sections.map(section => {
          const controlsId = `${controlsPrefix}-credentials-${routingGroupControlId(section.group.id)}`;
          return <div className="routing-group" key={section.group.id} data-routing-group={section.group.id}>
            {renderTarget(section.summary, section.open, controlsId)}
            {section.group.targets.length > 1 ? <div id={controlsId} className="routing-group-children" hidden={!section.open}>
              {section.children.map(row => renderTarget(row, false))}
            </div> : null}
          </div>;
        }) : (
          <div className="routing-node node-ghost" data-route-target="__ghost__"><span className="routing-port port-in port-ghost" aria-hidden="true" /><span className="routing-row-text"><span className="routing-row-name">{t('routing.waiting')}</span></span></div>
        )}</div>
      </div>
    </div>
  );
}
