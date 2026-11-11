import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Link2, Monitor, Server, Undo2 } from 'lucide-react';
import { useI18n } from '../i18n';
import './CpaTargetSwitcher.css';

type Props = { disabled?: boolean; endpoints?: string[]; onPick?: (endpoint: string) => void } & (
  | { remote?: false; onConnect: () => void }
  | { remote: true; endpoint: string | null; onChangeServer: () => void; onReturnLocal: () => void }
);

export function CpaTargetSwitcher(props: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const startAtEnd = useRef(false);
  const menuId = useId();
  const mode = t(props.remote ? 'remote.remote' : 'remote.localLabel');
  const endpoint = props.remote ? props.endpoint : null;
  const host = endpoint ? new URL(endpoint).host : undefined;
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]') ?? []);

  useLayoutEffect(() => {
    if (!open) return;
    const list = items();
    list[startAtEnd.current ? list.length - 1 : 0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);

  function closeAndFocus() {
    setOpen(false);
    trigger.current?.focus();
  }

  function select(action: () => void) {
    closeAndFocus();
    action();
  }

  function handleKeys(event: KeyboardEvent) {
    if (!open) return;
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus();
    } else if (event.key === 'Tab') {
      closeAndFocus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    }
  }

  const Icon = props.remote ? Server : Monitor;
  return (
    <div className="cpa-target-switcher" ref={root} onKeyDown={handleKeys}>
      <button className="cpa-target-trigger" type="button" ref={trigger} title={endpoint ?? mode}
        aria-label={host ? `${mode}: ${host}` : mode} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} disabled={props.disabled}
        onClick={() => { startAtEnd.current = false; setOpen(value => !value); }}
        onKeyDown={event => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            event.stopPropagation();
            startAtEnd.current = event.key === 'ArrowUp';
            setOpen(true);
          }
        }}>
        <Icon size={15} aria-hidden="true" />
        <span className="cpa-target-trigger-text">{host ? <><strong>{host}</strong><small>{mode}</small></> : mode}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? <div className="cpa-target-menu" id={menuId} ref={menu} role="menu" aria-label={t('remote.targetMenu')}>
        <button type="button" role="menuitemradio" aria-checked={true} tabIndex={-1}
          title={endpoint ?? undefined} onClick={closeAndFocus}>
          <Icon size={15} aria-hidden="true" />
          <span className="cpa-target-option-text">{host ?? mode}</span>
          <Check className="cpa-target-check" size={15} aria-hidden="true" />
        </button>
        {props.endpoints?.filter(saved => saved !== endpoint).map(saved => (
          <button key={saved} type="button" role="menuitemradio" aria-checked={false} tabIndex={-1} title={saved} onClick={() => select(() => props.onPick?.(saved))}>
            <Server size={15} aria-hidden="true" /><span className="cpa-target-option-text">{saved.replace(/\/$/, '')}</span>
          </button>
        ))}
        {props.remote ? <>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => select(props.onChangeServer)}><Link2 size={15} aria-hidden="true" />{t('remote.connect')}</button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => select(props.onReturnLocal)}><Undo2 size={15} aria-hidden="true" />{t('remote.returnLocal')}</button>
        </> : <button type="button" role="menuitem" tabIndex={-1} onClick={() => select(props.onConnect)}><Link2 size={15} aria-hidden="true" />{t('remote.connect')}</button>}
      </div> : null}
    </div>
  );
}
