import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import appLogo from '../../assets/logo.jpg';
import { BrandIcon } from '../BrandIcon';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import { routingCooldownSeconds, type buildLiveRouting } from '../../services/usageRouting';
import type { UsageRecord } from '../../services/usage';

const ROUTE_COLORS = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function RoutingMap({
  view,
  packets,
  now,
}: {
  view: ReturnType<typeof buildLiveRouting>;
  packets: UsageRecord[];
  now: number;
}) {
  const { t, formatNumber } = useI18n();
  const privacy = usePrivacyMask();
  const containerRef = useRef<HTMLDivElement>(null);

  const [modelPaths, setModelPaths] = useState<Record<string, string>>({});
  const [targetPaths, setTargetPaths] = useState<Record<string, string>>({});

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
    const newModelPaths: Record<string, string> = {};
    modelEls.forEach((el, i) => {
      const key = el.getAttribute('data-route-model') || String(i);
      const portEl = el.querySelector<HTMLElement>('.port-out') || el;
      const pRect = portEl.getBoundingClientRect();
      const x1 = pRect.left - cRect.left + pRect.width / 2;
      const y1 = pRect.top - cRect.top + pRect.height / 2;
      const dockY = gwCenterY + (i - (N - 1) / 2) * 8;
      const x2 = gwLeft;
      const y2 = dockY;
      const dx = Math.max(20, Math.abs(x2 - x1) * 0.5);
      const cx1 = x1 + dx;
      const cx2 = x2 - dx;
      newModelPaths[key] = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${cx1.toFixed(1)} ${y1.toFixed(1)}, ${cx2.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    });
    setModelPaths(newModelPaths);

    const targetEls = container.querySelectorAll<HTMLElement>('[data-route-target]');
    const M = targetEls.length;
    const newTargetPaths: Record<string, string> = {};
    targetEls.forEach((el, j) => {
      const key = el.getAttribute('data-route-target') || String(j);
      const portEl = el.querySelector<HTMLElement>('.port-in') || el;
      const pRect = portEl.getBoundingClientRect();
      const x2 = pRect.left - cRect.left + pRect.width / 2;
      const y2 = pRect.top - cRect.top + pRect.height / 2;
      const dockY = gwCenterY + (j - (M - 1) / 2) * 8;
      const x1 = gwRight;
      const y1 = dockY;
      const dx = Math.max(20, Math.abs(x2 - x1) * 0.5);
      const cx1 = x1 + dx;
      const cx2 = x2 - dx;
      newTargetPaths[key] = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${cx1.toFixed(1)} ${y1.toFixed(1)}, ${cx2.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    });
    setTargetPaths(newTargetPaths);
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
  }, [view.models, view.targets, updatePaths]);

  const hasActivity = packets.length > 0 || view.records.length > 0;

  return (
    <div className="live-routing-map" data-testid="routing-map" ref={containerRef}>
      <svg className="live-routing-edges" aria-hidden="true">
        {view.models.length === 0 ? (
          <path
            className="routing-edge routing-edge-ghost"
            data-model="__ghost__"
            d={modelPaths['__ghost__'] || 'M 240 120 C 330 120, 330 120, 420 120'}
          />
        ) : (
          view.models.map((item, index) => {
            const color = ROUTE_COLORS[index % ROUTE_COLORS.length];
            const defaultD = `M 240 ${120 + (index - (view.models.length - 1) / 2) * 44} C 330 ${120 + (index - (view.models.length - 1) / 2) * 44}, 330 ${120 + (index - (view.models.length - 1) / 2) * 8}, 420 ${120 + (index - (view.models.length - 1) / 2) * 8}`;
            const d = modelPaths[item.id] || defaultD;
            const isActive = hasActivity && (packets.length > 0 || item.count > 0);
            return (
              <g key={item.id}>
                <path
                  className="routing-edge"
                  data-model={item.id}
                  d={d}
                  style={{ stroke: color }}
                />
                {isActive && (
                  <>
                    <path
                      className="routing-edge routing-edge-flow"
                      data-model={item.id}
                      d={d}
                      style={{ stroke: color }}
                    />
                    <circle className="routing-packet" r="3" fill={color}>
                      <animateMotion dur="1.5s" repeatCount="indefinite" path={d} />
                    </circle>
                  </>
                )}
              </g>
            );
          })
        )}

        {view.targets.length === 0 ? (
          <path
            className="routing-edge routing-edge-ghost"
            data-target="__ghost__"
            d={targetPaths['__ghost__'] || 'M 580 120 C 670 120, 670 120, 760 120'}
          />
        ) : (
          view.targets.map((item, index) => {
            const route = view.routes.find((r) => r.targetId === item.id);
            const modelIndex = route ? view.models.findIndex((m) => m.id === route.modelId) : -1;
            const color = modelIndex >= 0 ? ROUTE_COLORS[modelIndex % ROUTE_COLORS.length] : ROUTE_COLORS[index % ROUTE_COLORS.length];
            const defaultD = `M 580 ${120 + (index - (view.targets.length - 1) / 2) * 8} C 670 ${120 + (index - (view.targets.length - 1) / 2) * 8}, 670 ${120 + (index - (view.targets.length - 1) / 2) * 44}, 760 ${120 + (index - (view.targets.length - 1) / 2) * 44}`;
            const d = targetPaths[item.id] || defaultD;
            const isActive = hasActivity && (packets.length > 0 || item.count > 0);
            return (
              <g key={item.id}>
                <path
                  className="routing-edge"
                  data-target={item.id}
                  d={d}
                  style={{ stroke: color }}
                />
                {isActive && (
                  <>
                    <path
                      className="routing-edge routing-edge-flow"
                      data-target={item.id}
                      d={d}
                      style={{ stroke: color }}
                    />
                    <circle className="routing-packet" r="3" fill={color}>
                      <animateMotion dur="1.5s" repeatCount="indefinite" path={d} />
                    </circle>
                  </>
                )}
              </g>
            );
          })
        )}
      </svg>

      <div className="routing-map-column">
        <div className="routing-column-head">
          <span>{t('routing.models')}</span>
          <span className="routing-column-count">{view.models.length}</span>
        </div>
        {view.models.length === 0 ? (
          <div className="routing-node node-ghost" data-route-model="__ghost__">
            <span className="routing-row-text">
              <span className="routing-row-name">{t('routing.waiting')}</span>
              <span className="routing-row-meta">{t('routing.liveDescription')}</span>
            </span>
            <span className="routing-port port-out port-ghost" aria-hidden="true" />
          </div>
        ) : (
          view.models.map((item, index) => {
            const name = privacy.text(item.name);
            const color = ROUTE_COLORS[index % ROUTE_COLORS.length];
            return (
              <div
                key={item.id}
                className="routing-node"
                data-route-model={item.id}
                style={{ '--route-color': color } as CSSProperties}
              >
                <span className="routing-node-mark">
                  <BrandIcon name={item.provider || item.name} size={18} />
                </span>
                <span className="routing-row-text">
                  <span className="routing-row-name" title={name}>{name}</span>
                  <span className="routing-row-meta">
                    {formatNumber(item.count)} · {Math.round(item.latency)} ms
                    {item.failures > 0 ? (
                      <span className="routing-row-failures"> · {t('routing.failures', { count: item.failures })}</span>
                    ) : null}
                  </span>
                </span>
                <span className="routing-port port-out" aria-hidden="true" />
              </div>
            );
          })
        )}
      </div>

      <div className="routing-map-center">
        <div
          className={`routing-gateway${view.records.length === 0 ? ' gateway-idle' : ''}`}
          data-route-gateway="true"
        >
          <span className="gateway-rail gateway-rail-in" />
          <span className="gateway-rail gateway-rail-out" />
          <span className="gateway-mark">
            <img src={appLogo} width={22} height={22} alt="" />
          </span>
          <span className="gateway-name">{t('routing.gateway')}</span>
          <span className="gateway-meta">
            {view.records.length ? t('routing.requests', { count: view.metrics.requests }) : t('routing.waiting')}
          </span>
        </div>
      </div>

      <div className="routing-map-column">
        <div className="routing-column-head">
          <span>{t('routing.targets')}</span>
          <span className="routing-column-count">{view.targets.length}</span>
        </div>
        {view.targets.length === 0 ? (
          <div className="routing-node node-ghost" data-route-target="__ghost__">
            <span className="routing-port port-in port-ghost" aria-hidden="true" />
            <span className="routing-row-text">
              <span className="routing-row-name">{t('routing.waiting')}</span>
              <span className="routing-row-meta">{t('routing.standbyHint')}</span>
            </span>
          </div>
        ) : (
          view.targets.map((item) => {
            const name = privacy.text(item.name);
            const cooldown = item.cooldown;
            const seconds = cooldown ? routingCooldownSeconds(cooldown, now) : 0;
            return (
              <div
                key={item.id}
                className={`routing-node${cooldown ? ' node-resting' : ''}`}
                data-route-target={item.id}
              >
                <span className="routing-port port-in" aria-hidden="true" />
                <span className="routing-node-mark">
                  <BrandIcon name={item.provider || cooldown?.provider || item.name} size={18} />
                </span>
                <span className="routing-row-text">
                  <span className="routing-row-name" title={name}>{name}</span>
                  <span className="routing-row-meta">{privacy.text(item.provider || cooldown?.provider || '—')}</span>
                </span>
                <span className="routing-node-state">
                  {cooldown ? (
                    <span className="routing-cooldown-pill">{t('routing.cooldown', { seconds })}</span>
                  ) : (
                    <span className="routing-row-meta">{formatNumber(item.count)} · {Math.round(item.latency)} ms</span>
                  )}
                  {item.failures > 0 ? (
                    <span className="routing-row-failures">{t('routing.failures', { count: item.failures })}</span>
                  ) : null}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
