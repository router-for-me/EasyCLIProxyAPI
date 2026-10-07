import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';
import { useI18n } from '../i18n';

export function SettingsHelp({ label, children }: { label: string; children: ReactNode }) {
  const { locale } = useI18n();
  const helpLabel = locale === 'zh-CN' ? '说明' : locale === 'ja' ? '説明' : 'Help';
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !popover.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      // Close help when its setting is hidden by a category or search change.
      if (!anchor.width || !anchor.height) { setOpen(false); return; }
      const bounds = popover.current.getBoundingClientRect();
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12));
      const below = anchor.bottom + 8;
      const top = Math.max(12, below + bounds.height <= window.innerHeight - 12 ? below : anchor.top - bounds.height - 8);
      setPosition({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  return <span className="settings-help">
    <button ref={trigger} type="button" className="settings-help-trigger" aria-label={`${label} · ${helpLabel}`} aria-expanded={open} aria-controls={id} aria-describedby={open ? id : undefined} onClick={() => { setPosition(null); setOpen(previous => !previous); }}>
      <CircleHelp size={14} aria-hidden="true" />
    </button>
    {open ? createPortal(<span ref={popover} id={id} role="tooltip" className="settings-help-popover" style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}>{children}</span>, document.body) : null}
  </span>;
}
