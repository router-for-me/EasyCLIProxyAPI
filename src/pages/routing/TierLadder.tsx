import { Fragment, useState, type ReactNode } from 'react';
import { DndContext, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { ArrowDown, ArrowUp, GripVertical, Plus } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { RoutingBoard, RoutingMember, RoutingSettings } from '../../services/routing';
import { moveMember, splitMember, stepMember, type RouteMember, type RoutePreview, type RouteStep, type RoutingDraft, type RoutingDropTarget, type RoutingTier } from './routingPlan';
import codex from '../../assets/icons/codex.svg';
import claude from '../../assets/icons/claude.svg';
import gemini from '../../assets/icons/gemini.svg';
import deepseek from '../../assets/icons/deepseek.svg';
import kimi from '../../assets/icons/kimi-light.svg';
import vertex from '../../assets/icons/vertex.svg';
import meta from '../../assets/icons/meta.svg';
import antigravity from '../../assets/icons/antigravity.svg';
import copilot from '../../assets/icons/copilot.svg';
import openai from '../../assets/icons/openai-light.svg';
import grok from '../../assets/icons/grok.svg';

const brands: [string, string][] = [['antigravity', antigravity], ['copilot', copilot], ['codex', codex], ['claude', claude], ['deepseek', deepseek], ['kimi', kimi], ['vertex', vertex], ['gemini', gemini], ['meta', meta], ['xai', grok], ['grok', grok]];
function brandIcon(member: RoutingMember) {
  const identity = `${member.family} ${member.name} ${member.remark ?? ''}`.toLowerCase();
  return brands.find(([brand]) => identity.includes(brand))?.[1] ?? openai;
}

function MemberCard({ member, draft, routeMember, disabled, isAlone, onChange }: {
  member: RoutingMember; draft: RoutingDraft; routeMember?: RouteMember; disabled: boolean; isAlone: boolean; onChange: (draft: RoutingDraft) => void;
}) {
  const { t, formatNumber } = useI18n();
  const [weightOpen, setWeightOpen] = useState(false);
  const locked = disabled || member.runtimeOnly;
  const { attributes, listeners, setNodeRef, isDragging, transform } = useDraggable({ id: member.key, disabled: locked });
  const state = routeMember?.state;
  const weights = draft.weights[member.key] ?? member.weights;
  const step = (direction: 'up' | 'down') => onChange({ ...draft, tiers: stepMember(draft.tiers, member.key, direction) });
  const displayName = member.remark || member.name;
  const hasDistinctRemark = Boolean(member.remark && member.remark !== member.name);
  return <article ref={setNodeRef} className={`routing-card${isDragging ? ' routing-card-dragging' : ''}`} tabIndex={locked ? undefined : 0}
    style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
    aria-label={t('routing.drag', { name: displayName })} onKeyDown={event => {
      if (!locked && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); step(event.key === 'ArrowUp' ? 'up' : 'down'); }
    }}>
    <div className="routing-card-face">
      <button type="button" className="icon-button quiet tiny-button routing-grip" {...attributes} {...listeners} disabled={locked} aria-label={t('routing.drag', { name: displayName })}><GripVertical size={15} /></button>
      <img className="routing-brand" src={brandIcon(member)} alt="" width={20} height={20} />
      <div className="routing-card-text"><strong className="routing-card-name" title={hasDistinctRemark ? `${member.remark} (${member.name})` : member.name}>{displayName}</strong><span className="routing-card-sub">
        {hasDistinctRemark && <span className="routing-card-raw-name">{member.name} · </span>}
        {t(member.kind === 'credential' || member.credentialName ? 'routing.oauth' : 'routing.apiKey')}{t('routing.familyDetail', { family: member.family })}
        {(member.keyCount ?? weights.length) > 1 && t('routing.keyCount', { count: member.keyCount ?? weights.length })}
        {member.prefix && <code>{t('routing.prefixDetail', { prefix: member.prefix })}</code>}
      </span></div>
      <div className="routing-card-end" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        {member.disabled && <span className="routing-status-pill">{t('routing.disabled')}</span>}
        {member.unavailable && <span className="routing-status-pill">{t('routing.unavailable')}</span>}
        {member.runtimeOnly && <span className="routing-status-pill">{t('routing.fixed')}</span>}
        {state === 'excluded' && <span className="routing-status-pill">{t('routing.excluded')}</span>}
        {(state === 'serving' || state === 'standby') && <span className={`routing-card-share${state === 'serving' ? ' routing-share-primary' : ''}`}>{routeMember?.share == null ? t('routing.sequential') : formatNumber(routeMember.share, { style: 'percent', maximumFractionDigits: 1 })}</span>}
        {draft.settings.strategy === 'weighted-round-robin' && <div className="routing-weight-editor"><button type="button" className="secondary-button tiny-button" disabled={locked} aria-label={t('routing.weight')} aria-expanded={weightOpen} onClick={() => setWeightOpen(value => !value)}>{t('routing.weightTotal', { count: weights.reduce<number>((sum, value) => sum + (value ?? 1), 0) })}</button>{weightOpen && <div className="routing-weight-fields">{weights.map((weight, index) => <label key={index}>{t('routing.weightIndex', { index: index + 1 })}<input type="number" step={1} min={0} max={1000000} placeholder={t('routing.weightPlaceholder')} disabled={locked} value={weight ?? ''} onChange={event => onChange({ ...draft, weights: { ...draft.weights, [member.key]: weights.map((value, position) => position === index ? event.target.value === '' ? null : event.target.valueAsNumber : value) } })} /></label>)}</div>}</div>}
        {!member.runtimeOnly && <div className="routing-card-steps">
          <button type="button" className="icon-button quiet tiny-button" disabled={locked} title={t('routing.stepUp')} aria-label={t('routing.stepUp')} onClick={() => step('up')}><ArrowUp size={13} /></button>
          <button type="button" className="icon-button quiet tiny-button" disabled={locked} title={t('routing.stepDown')} aria-label={t('routing.stepDown')} onClick={() => step('down')}><ArrowDown size={13} /></button>
          {!isAlone && <button type="button" className="icon-button quiet tiny-button" disabled={locked} title={t('routing.split')} aria-label={t('routing.split')} onClick={() => onChange({ ...draft, tiers: splitMember(draft.tiers, member.key, 'below') })}><Plus size={13} /></button>}
        </div>}
      </div>
    </div>
  </article>;
}

function TierLink({ index, dragging, first }: { index: number; dragging: boolean; first: boolean }) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: `gap:${index}`, data: { kind: 'gap', index } satisfies RoutingDropTarget, disabled: !dragging });
  return <div ref={setNodeRef} className={`routing-link${dragging ? ' routing-link-active' : ''}${isOver ? ' routing-link-over' : ''}`}><span>{dragging ? t('routing.newTierHere') : first ? '' : t('routing.fallthrough')}</span></div>;
}

function TierBand({ tier, index, priority, step, strategy, disabled, children }: {
  tier: RoutingTier; index: number; priority: number; step?: RouteStep; strategy: RoutingSettings['strategy']; disabled: boolean; children: ReactNode;
}) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: `tier:${tier.id}`, data: { kind: 'tier', tierId: tier.id } satisfies RoutingDropTarget, disabled });
  const sharing = (step?.members.filter(member => member.state === 'serving' || member.state === 'standby').length ?? 0) > 1;
  const sharingKeys = { 'round-robin': 'routing.sharingRoundRobin', 'weighted-round-robin': 'routing.sharingWeighted', 'fill-first': 'routing.sharingSequential' } as const;
  return <section ref={setNodeRef} className={`routing-tier${step?.isPrimary ? ' routing-tier-primary' : ''}${!step ? ' routing-tier-skipped' : ''}${isOver ? ' routing-tier-over' : ''}`} aria-label={t('routing.tierNumber', { number: index + 1 })}>
    <div className="routing-tier-gutter"><span className="routing-tier-step">{index + 1}</span><div><h2 className="routing-tier-name">{t('routing.tierNumber', { number: index + 1 })}</h2><span className="routing-tier-priority">{t('routing.priorityValue', { priority })}</span></div></div>
    <div className="routing-tier-body"><p className="routing-tier-role">{t(step?.isPrimary ? 'routing.serving' : step ? 'routing.standby' : 'routing.skipped')}{sharing && t(sharingKeys[strategy])}</p><div className="routing-tier-cards">{children}</div></div>
  </section>;
}

export function TierLadder({ board, draft, tierPriorities, preview, disabled, hideDisabled = false, onChange }: {
  board: RoutingBoard; draft: RoutingDraft; tierPriorities: number[]; preview: RoutePreview; disabled: boolean; hideDisabled?: boolean; onChange: (draft: RoutingDraft) => void;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const members = new Map(board.members.map(member => [member.key, member]));
  const steps = new Map(preview.steps.map(step => [step.tierId, step]));
  const activeMembers = preview.steps.find(step => step.isPrimary)?.members.filter(member => member.state === 'serving') ?? [];
  const activeCount = activeMembers.reduce((sum, member) => sum + (members.get(member.key)?.keyCount ?? members.get(member.key)?.weights.length ?? 0), 0);
  const hasVisibleTiers = draft.tiers.some(tier => tier.memberKeys.some(key => !hideDisabled || !members.get(key)?.disabled));
  return <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={() => setDragging(true)} onDragCancel={() => setDragging(false)} onDragEnd={({ active, over }) => {
    setDragging(false);
    const member = members.get(String(active.id));
    if (disabled || !member || member.runtimeOnly || !over) return;
    const target = over.data.current as RoutingDropTarget | undefined;
    if (target) onChange({ ...draft, tiers: moveMember(draft.tiers, member.key, target) });
  }}><div className="routing-flow">
    <div className="routing-flow-entry"><span className="routing-flow-node" /><strong>{t('routing.entry')}</strong><span>{t('routing.entrySummary', { count: activeCount, tiers: preview.steps.length })}</span></div>
    <TierLink index={0} dragging={dragging} first />
    {!hasVisibleTiers && <p className="routing-empty">{t('routing.empty')}</p>}
    {(() => {
      let visibleIndex = 0;
      return draft.tiers.map((tier, index) => {
        const visibleKeys = hideDisabled ? tier.memberKeys.filter(key => !members.get(key)?.disabled) : tier.memberKeys;
        if (hideDisabled && visibleKeys.length === 0) return null;
        const currentVisibleIndex = visibleIndex++;
        return <Fragment key={tier.id}><TierBand tier={tier} index={currentVisibleIndex} priority={tierPriorities[index]} step={steps.get(tier.id)} strategy={draft.settings.strategy} disabled={disabled}>
          {visibleKeys.map(key => { const member = members.get(key); return member ? <MemberCard key={key} member={member} draft={draft} routeMember={steps.get(tier.id)?.members.find(item => item.key === key) ?? { key, state: preview.states.get(key) ?? 'ineligible', share: null }} disabled={disabled} isAlone={tier.memberKeys.length === 1} onChange={onChange} /> : null; })}
        </TierBand><TierLink index={index + 1} dragging={dragging} first={false} /></Fragment>;
      });
    })()}
    <div className="routing-flow-exit"><span className="routing-flow-node" /><strong>{t('routing.exit')}</strong><span>{draft.settings.request_retry > 0 ? t('routing.exitRetry', { rounds: draft.settings.request_retry }) : t('routing.exitDirect')}</span></div>
  </div></DndContext>;
}
