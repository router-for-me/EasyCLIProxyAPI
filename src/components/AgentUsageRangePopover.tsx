import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import {
  AGENT_USAGE_PRESETS,
  agentUsageDay,
  agentUsagePresetRange,
  type AgentUsageDateRange,
  type AgentUsagePreset,
} from '../services/agentUsage';

export type AgentUsageCustomRange = AgentUsageDateRange & { preset?: AgentUsagePreset };

type AgentUsageRangePopoverProps = {
  anchor: HTMLElement;
  initial: AgentUsageDateRange | null;
  onApply: (range: AgentUsageCustomRange) => void;
  onClose: () => void;
};

const EDGE = 12;
const GAP = 6;

export function AgentUsageRangePopover({ anchor, initial, onApply, onClose }: AgentUsageRangePopoverProps) {
  const { t } = useI18n();
  const presetsId = useId();
  const popoverRef = useRef<HTMLFormElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const now = new Date();
  const today = agentUsageDay(now);
  const fallback = agentUsagePresetRange('thisWeek', now);
  const [start, setStart] = useState(initial?.start ?? fallback.start);
  const [end, setEnd] = useState(initial?.end ?? fallback.end);
  const reversed = Boolean(start && end && start > end);
  const valid = Boolean(start && end) && !reversed;

  const place = useCallback(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const trigger = anchor.getBoundingClientRect();
    const { width, height } = popover.getBoundingClientRect();
    const left = Math.min(Math.max(EDGE, trigger.right - width), Math.max(EDGE, window.innerWidth - EDGE - width));
    const below = trigger.bottom + GAP;
    const above = trigger.top - GAP - height;
    const preferred = below + height <= window.innerHeight - EDGE || above < EDGE ? below : above;
    const top = Math.max(EDGE, Math.min(preferred, window.innerHeight - EDGE - height));
    setPosition({ top, left });
  }, [anchor]);

  useLayoutEffect(() => {
    place();
    const observer = new ResizeObserver(place);
    if (popoverRef.current) observer.observe(popoverRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [place]);

  const placed = position !== null;
  useEffect(() => {
    if (placed) popoverRef.current?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const close = (event: Event) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      anchor.focus();
      onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('focusin', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('focusin', close);
      document.removeEventListener('keydown', escape);
    };
  }, [anchor, onClose]);

  const apply = (range: AgentUsageCustomRange) => {
    anchor.focus();
    onApply(range);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) apply({ start, end });
  };

  return createPortal(
    <form
      ref={popoverRef}
      className="agent-usage-range-popover"
      role="dialog"
      aria-label={t('usage.agentUsage.customRange.title')}
      data-theme-surface="overlay"
      tabIndex={-1}
      style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
      onSubmit={submit}
    >
      <div className="agent-usage-range-presets" role="group" aria-labelledby={presetsId}>
        <span id={presetsId}>{t('usage.agentUsage.customRange.presets')}</span>
        {AGENT_USAGE_PRESETS.map((preset) => (
          <button key={preset} type="button" className="secondary-button small-button" data-preset={preset}
            onClick={() => apply({ ...agentUsagePresetRange(preset, new Date()), preset })}>
            {t(`usage.agentUsage.preset.${preset}`)}
          </button>
        ))}
      </div>
      <div className="agent-usage-range-fields">
        <label>
          <span>{t('usage.agentUsage.customRange.start')}</span>
          <input className="config-dialog-text-input" type="date" value={start} max={today} required
            aria-invalid={reversed} onChange={(event) => setStart(event.currentTarget.value)} />
        </label>
        <label>
          <span>{t('usage.agentUsage.customRange.end')}</span>
          <input className="config-dialog-text-input" type="date" value={end} max={today} required
            aria-invalid={reversed} onChange={(event) => setEnd(event.currentTarget.value)} />
        </label>
      </div>
      {reversed ? <p className="agent-usage-range-error">{t('usage.agentUsage.customRange.invalid')}</p> : null}
      <div className="agent-usage-range-actions">
        <button type="button" className="secondary-button small-button" onClick={() => {
          anchor.focus();
          onClose();
        }}>{t('common.cancel')}</button>
        <button type="submit" className="primary-button small-button" disabled={!valid}>{t('usage.agentUsage.customRange.apply')}</button>
      </div>
    </form>,
    document.body,
  );
}
