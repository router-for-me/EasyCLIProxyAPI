import { useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { GripVertical, Plus } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { RoutingMember } from '../../services/routing';

function MemberCard({ member, priorities, disabled, weighted, onChange }: {
  member: RoutingMember; priorities: number[]; disabled: boolean; weighted: boolean; onChange: (member: RoutingMember) => void;
}) {
  const { t } = useI18n();
  const locked = disabled || member.runtimeOnly;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: member.key, disabled: locked });
  return <article ref={setNodeRef} className={`routing-member${isDragging ? ' dragging' : ''}`} style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined }}>
    <button type="button" className="icon-button quiet routing-grip" aria-label={t('routing.drag', { name: member.name })} disabled={locked} {...attributes} {...listeners}><GripVertical size={17} /></button>
    <div className="routing-member-body"><strong title={member.name}>{member.name}</strong><span className="routing-member-family">{member.family}</span>
      <div className="routing-badges">{member.disabled && <span>{t('routing.disabled')}</span>}{member.unavailable && <span>{t('routing.unavailable')}</span>}{member.runtimeOnly && <span>{t('routing.runtime')}</span>}</div>
    </div>
    <label className="routing-move"><span>{t('routing.move')}</span><select disabled={locked} value={member.priority} onChange={event => onChange({ ...member, priority: Number(event.target.value) })}>{priorities.map(priority => <option key={priority} value={priority}>{priority}</option>)}</select></label>
    <div className="routing-weights">{member.weights.map((weight, index) => <label key={index}>{t('routing.weight')}{member.weights.length > 1 ? ` ${index + 1}` : ''}<input type="number" step={1} min={0} max={1000000} disabled={locked || !weighted} placeholder={t('routing.inherited')} value={weight ?? ''} onChange={event => onChange({ ...member, weights: member.weights.map((value, position) => position === index ? event.target.value === '' ? null : event.target.valueAsNumber : value) })} /></label>)}</div>
  </article>;
}

function Tier({ priority, children }: { priority: number; children: React.ReactNode }) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: `tier:${priority}` });
  return <section ref={setNodeRef} className={`routing-tier${isOver ? ' drop-active' : ''}`} aria-label={t('routing.tier', { priority })}>
    <div className="routing-tier-marker"><span>{priority}</span><h2>{t('routing.tier', { priority })}</h2></div>
    <div className="routing-tier-members">{children}<div className="routing-drop-hint">{t('routing.drop')}</div></div>
  </section>;
}

export function TierLadder({ members, disabled, weighted, onChange }: {
  members: RoutingMember[]; disabled: boolean; weighted: boolean; onChange: (members: RoutingMember[]) => void;
}) {
  const { t } = useI18n();
  const [extra, setExtra] = useState<number[]>([]);
  const [newPriority, setNewPriority] = useState(1);
  const [active, setActive] = useState<string | null>(null);
  const priorities = [...new Set([...members.map(member => member.priority), ...extra])].sort((left, right) => right - left);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const change = (edited: RoutingMember) => onChange(members.map(member => member.key === edited.key ? edited : member));
  return <div className="routing-ladder">
    <div className="routing-add-tier"><label>{t('routing.priority')}<input type="number" min={-2147483648} max={2147483647} step={1} disabled={disabled} value={Number.isNaN(newPriority) ? '' : newPriority} onChange={event => setNewPriority(event.target.valueAsNumber)} /></label><button type="button" className="button secondary" disabled={disabled || !Number.isInteger(newPriority) || newPriority < -2147483648 || newPriority > 2147483647 || priorities.includes(newPriority)} onClick={() => setExtra(previous => [...previous, newPriority])}><Plus size={15} />{t('routing.addTier')}</button></div>
    <DndContext sensors={sensors} onDragStart={event => setActive(String(event.active.id))} onDragCancel={() => setActive(null)} onDragEnd={({ active: dragged, over }) => {
      setActive(null);
      if (!over || disabled) return;
      const member = members.find(item => item.key === dragged.id);
      const priority = Number(String(over.id).replace('tier:', ''));
      if (member && !member.runtimeOnly && priorities.includes(priority)) change({ ...member, priority });
    }}>
      {priorities.map(priority => <Tier priority={priority} key={priority}>{members.filter(member => member.priority === priority).map(member => <MemberCard key={member.key} member={member} priorities={priorities} disabled={disabled} weighted={weighted} onChange={change} />)}</Tier>)}
      <DragOverlay>{active && <div className="routing-drag-preview">{members.find(member => member.key === active)?.name}</div>}</DragOverlay>
    </DndContext>
    {!members.length && <p className="routing-empty">{t('routing.empty')}</p>}
  </div>;
}
