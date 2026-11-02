import { useId, type CSSProperties } from 'react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import { routingCooldownSeconds, routingModelId, routingTargetId, type buildLiveRouting } from '../../services/usageRouting';
import type { UsageRecord } from '../../services/usage';
import { usePresence } from './usePresence';

export function RoutingMap({ view, packets, now }: { view: ReturnType<typeof buildLiveRouting>; packets: UsageRecord[]; now: number }) {
  const { t, formatNumber } = useI18n();
  const privacy = usePrivacyMask();
  const gradientId = useId().replace(/:/g, '');
  const models = usePresence(view.models);
  const targets = usePresence(view.targets);
  const height = Math.max(230, Math.max(models.length, targets.length) * 84 + 60);
  const center = height / 2;
  const modelY = (id: string) => center + (models.findIndex(row => row.item.id === id) - (models.length - 1) / 2) * 84;
  const targetY = (id: string) => center + (targets.findIndex(row => row.item.id === id) - (targets.length - 1) / 2) * 84;
  const path = (modelId: string, targetId: string) => `M 270 ${modelY(modelId)} C 380 ${modelY(modelId)}, 380 ${center}, 500 ${center} S 620 ${targetY(targetId)}, 730 ${targetY(targetId)}`;
  return <div className="live-routing-map"><svg viewBox={`0 0 1000 ${height}`} role="img" aria-label={t('routing.live')}>
    <defs><linearGradient id={gradientId} x1="0%" x2="100%"><stop offset="0%" stopColor="var(--primary-color)" stopOpacity=".35" /><stop offset="50%" stopColor="var(--primary-color)" /><stop offset="100%" stopColor="var(--routing-flow-color, #14b8a6)" stopOpacity=".65" /></linearGradient></defs>
    <text x="20" y="16" className="routing-map-heading">{t('routing.models')}</text><text x="750" y="16" className="routing-map-heading">{t('routing.targets')}</text>
    {view.routes.filter(route => models.some(row => row.item.id === route.modelId) && targets.some(row => row.item.id === route.targetId)).map(route => <path className={`routing-lane${route.count >= 5 ? ' busy' : ''}${route.failed ? ' failed' : ''}`} style={{ stroke: route.failed ? 'var(--error-color)' : `url(#${gradientId})`, strokeWidth: 2 + Math.min(5, route.count / Math.max(1, view.records.length) * 5) }} key={route.id} d={path(route.modelId, route.targetId)}><title>{formatNumber(route.count)}</title></path>)}
    {packets.slice(0, 24).map(record => {
      const modelId = routingModelId(record); const targetId = routingTargetId(record);
      if (!models.some(row => row.item.id === modelId) || !targets.some(row => row.item.id === targetId)) return null;
      return <circle key={record.row_id || record.id} r="4" className={`routing-packet${record.failed && !record.canceled ? ' failed' : ''}`}>
        <animateMotion dur="1.8s" repeatCount="1" fill="freeze" path={path(modelId, targetId)} />
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.05;0.85;1" dur="1.8s" fill="freeze" />
      </circle>;
    })}
    <g className="routing-gateway" transform={`translate(410 ${center - 43})`}><circle className="routing-hub-pulse" cx="90" cy="43" r="57" /><rect width="180" height="86" rx="20" /><circle className="routing-hub-indicator" cx="90" cy="19" r="4" /><text x="90" y="45" textAnchor="middle">{t('routing.gatewayHub')}</text><text x="90" y="66" textAnchor="middle" className="routing-hub-detail">{formatNumber(view.metrics.requests)} / 60s</text></g>
    {[{ rows: models, side: 'model', x: 10 }, { rows: targets, side: 'target', x: 730 }].map(({ rows, side, x }) => rows.map(({ item, exiting }, index) => {
      const name = privacy.text(item.name);
      const cooldown = item.cooldown;
      const seconds = cooldown ? routingCooldownSeconds(cooldown, now) : 0;
      const summary = cooldown ? t('routing.cooldown', { seconds }) : `${formatNumber(item.count)} · ${Math.round(item.latency)} ms`;
      const provider = (item.provider || cooldown?.provider || item.name).toLowerCase();
      const brand = /claude|anthropic/.test(provider) ? { label: 'A', color: '#d97757' } : /gemini|google/.test(provider) ? { label: 'G', color: '#4285f4' } : /openai|codex|gpt/.test(provider) ? { label: 'O', color: '#10a37f' } : /deepseek/.test(provider) ? { label: 'D', color: '#536dfe' } : { label: '•', color: 'var(--primary-color)' };
      const share = item.count / Math.max(1, view.records.length);
      return <g key={`${side}:${item.id}`} className={`routing-map-node${exiting ? ' exiting' : ''}${cooldown ? ' cooling' : ''}`} style={{ transform: `translate(${x}px, ${center + (index - (rows.length - 1) / 2) * 84 - 34}px)`, '--routing-brand': brand.color } as CSSProperties}>
        <title>{name} · {privacy.text(item.provider || cooldown?.provider || '')} · {summary} · {t('routing.failures', { count: item.failures })} · {t('routing.distribution')}: {Math.round(share * 100)}%</title><rect className="routing-node-card" width="260" height="68" rx="13" />
        <rect className="routing-brand-badge" x="12" y="12" width="26" height="26" rx="8" /><text className="routing-brand-letter" x="25" y="30" textAnchor="middle">{brand.label}</text>
        <text x="47" y="25" className="routing-node-name">{name.length > 22 ? `${name.slice(0, 21)}…` : name}</text>
        {cooldown && <><rect className="routing-cooldown-badge" x="8" y="35" width="204" height="18" rx="6" /><rect className="routing-cooldown-badge" x="228" y="35" width="24" height="18" rx="6" /></>}
        <text x="12" y="49" className="routing-node-detail">{summary}</text>
        <text x="246" y="49" textAnchor="end" className="routing-node-detail">{cooldown ? 'Ⅱ' : `${Math.round(share * 100)}%`}</text>
        <rect className="routing-volume-track" x="12" y="57" width="236" height="3" rx="1.5" /><rect className="routing-volume-fill" x="12" y="57" width={236 * share} height="3" rx="1.5" />
        {item.failures > 0 && <circle cx="246" cy="14" r="4" className="routing-failure-dot" />}
      </g>;
    }))}
  </svg></div>;
}
