import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import { routingCooldownSeconds, routingModelId, routingTargetId, type buildLiveRouting } from '../../services/usageRouting';
import type { UsageRecord } from '../../services/usage';
import { usePresence } from './usePresence';

export function RoutingMap({ view, packets, now }: { view: ReturnType<typeof buildLiveRouting>; packets: UsageRecord[]; now: number }) {
  const { t, formatNumber } = useI18n();
  const privacy = usePrivacyMask();
  const models = usePresence(view.models);
  const targets = usePresence(view.targets);
  const height = Math.max(260, Math.max(models.length, targets.length) * 65 + 50);
  const center = height / 2;
  const modelY = (id: string) => 55 + models.findIndex(row => row.item.id === id) * 65;
  const targetY = (id: string) => 55 + targets.findIndex(row => row.item.id === id) * 65;
  const path = (modelId: string, targetId: string) => `M 270 ${modelY(modelId)} C 380 ${modelY(modelId)}, 380 ${center}, 500 ${center} S 620 ${targetY(targetId)}, 730 ${targetY(targetId)}`;
  return <div className="live-routing-map"><svg viewBox={`0 0 1000 ${height}`} role="img" aria-label={t('routing.live')}>
    <text x="20" y="16" className="routing-map-heading">{t('routing.models')}</text><text x="750" y="16" className="routing-map-heading">{t('routing.targets')}</text>
    {view.routes.filter(route => models.some(row => row.item.id === route.modelId) && targets.some(row => row.item.id === route.targetId)).map(route => <path className="routing-lane" key={route.id} d={path(route.modelId, route.targetId)}><title>{formatNumber(route.count)}</title></path>)}
    {packets.slice(0, 24).map(record => {
      const modelId = routingModelId(record); const targetId = routingTargetId(record);
      if (!models.some(row => row.item.id === modelId) || !targets.some(row => row.item.id === targetId)) return null;
      return <circle key={record.row_id || record.id} r="4" className={`routing-packet${record.failed && !record.canceled ? ' failed' : ''}`}>
        <animateMotion dur="1.8s" repeatCount="1" fill="freeze" path={path(modelId, targetId)} />
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.05;0.85;1" dur="1.8s" fill="freeze" />
      </circle>;
    })}
    <g className="routing-gateway" transform={`translate(445 ${center - 28})`}><rect width="110" height="56" rx="16" /><text x="55" y="33" textAnchor="middle">{t('routing.gateway')}</text></g>
    {[{ rows: models, side: 'model', x: 10 }, { rows: targets, side: 'target', x: 730 }].map(({ rows, side, x }) => rows.map(({ item, exiting }, index) => {
      const name = privacy.text(item.name);
      const cooldown = item.cooldown;
      const seconds = cooldown ? routingCooldownSeconds(cooldown, now) : 0;
      const summary = cooldown ? t('routing.cooldown', { seconds }) : `${formatNumber(item.count)} · ${Math.round(item.latency)} ms`;
      return <g key={`${side}:${item.id}`} className={`routing-map-node${exiting ? ' exiting' : ''}${cooldown ? ' cooling' : ''}`} style={{ transform: `translate(${x}px, ${30 + index * 65}px)` }}>
        <title>{name} · {summary} · {t('routing.failures', { count: item.failures })}</title><rect width="260" height="50" rx="10" />
        <text x="12" y="21" className="routing-node-name">{name.length > 30 ? `${name.slice(0, 29)}…` : name}</text>
        <text x="12" y="39" className="routing-node-detail">{summary}</text>
        {item.failures > 0 && <circle cx="245" cy="15" r="4" className="routing-failure-dot" />}
      </g>;
    }))}
  </svg></div>;
}
