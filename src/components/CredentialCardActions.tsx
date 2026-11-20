import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, Ellipsis, List, RefreshCw, Settings2, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { Switch } from './Switch';

export type CredentialCardActionsProps = {
  identity: string; disabled: boolean; busy: boolean; resettingCooldown: boolean;
  oauth: boolean; runtimeOnly: boolean; hasProvider: boolean; canRefresh: boolean;
  refreshing: boolean; copied: boolean; expanded: boolean; detailsId: string;
  onRefresh: () => void; onSettings: () => void; onExclusions: () => void; onModels: () => void;
  onCopy: () => void; onDelete: () => void; onToggle: () => void; onDetails: () => void;
};

// Uses the same anchored, keyboard-operated menu pattern as account management.
export function CredentialCardActions(props: CredentialCardActionsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [upward, setUpward] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const show = (last = false) => {
    if (props.busy) return;
    focusLast.current = last;
    const rect = trigger.current?.getBoundingClientRect();
    setUpward(Boolean(rect && window.innerHeight - rect.bottom < 210 && rect.top > 210));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const items = menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      (focusLast.current ? items?.[items.length - 1] : items?.[0])?.focus();
    });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  useEffect(() => { if (props.busy) setOpen(false); }, [props.busy]);
  const settingsDisabled = props.busy || props.resettingCooldown || !props.oauth;
  const toggleTitle = t(props.oauth ? props.disabled ? 'common.enable' : 'common.disable' : 'authFiles.fileOnly');
  const actions = [
    { key: 'models', label: t('authFiles.action.models'), icon: List, disabled: props.busy || !props.hasProvider, run: props.onModels },
    { key: 'exclusions', label: t('authFiles.models.excludeButton'), icon: SlidersHorizontal, disabled: settingsDisabled, run: props.onExclusions },
    { key: 'copy', label: t('authFiles.copyName'), icon: props.copied ? Check : Copy, disabled: props.busy, run: props.onCopy },
    { key: 'delete', label: t('common.delete'), icon: Trash2, disabled: props.busy || props.resettingCooldown || props.runtimeOnly, run: props.onDelete },
  ];
  return <footer className="auth-card-actions auth-list-cell" data-label={t('authFiles.list.actions')}>
    <div className="auth-list-icon-actions">
      <button type="button" className="secondary-button small-button auth-action-refresh" onClick={props.onRefresh}
        disabled={props.busy || props.disabled || !props.canRefresh || props.refreshing} aria-label={t('authFiles.quota.refresh')} title={t('authFiles.quota.refresh')}>
        <RefreshCw size={14} className={props.refreshing ? 'spin' : ''} aria-hidden="true" />
      </button>
      <button type="button" className="secondary-button small-button auth-action-settings" aria-label={t('authFiles.action.settings')} onClick={props.onSettings} disabled={settingsDisabled}
        title={t(props.oauth ? 'authFiles.settings.title' : 'authFiles.fileOnly')}><Settings2 size={14} aria-hidden="true" /><span>{t('authFiles.action.settings')}</span></button>
      <button type="button" className="secondary-button small-button auth-list-details-button" onClick={props.onDetails}
        aria-expanded={props.expanded} aria-controls={props.detailsId}>{t(props.expanded ? 'authFiles.list.collapse' : 'authFiles.list.details')}</button>
      <div className="auth-card-more" ref={wrap} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}>
        <button ref={trigger} type="button" className="secondary-button small-button auth-card-more-trigger" disabled={props.busy}
          aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => open ? close() : show()}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp'); }
          }}><Ellipsis size={14} aria-hidden="true" />{t('authFiles.action.more')}</button>
        {open ? <div ref={menu} id={id} role="menu" aria-label={t('authFiles.action.more')} className="auth-card-action-menu surface-panel" data-upward={upward}
          onKeyDown={event => {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : event.key === 'ArrowDown' ? (index + 1) % items.length
              : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : -1;
            if (next >= 0 && items[next]) { event.preventDefault(); items[next].focus(); }
            // Restore the trigger before native Tab navigation; it leaves the menu normally.
            if (event.key === 'Tab') close(true);
          }}>
          {actions.map(action => <button type="button" role="menuitem" key={action.key} className={`auth-card-menu-item ${action.key === 'delete' ? 'auth-card-menu-delete' : ''}`}
            disabled={action.disabled} onClick={() => { close(true); action.run(); }}><action.icon size={14} aria-hidden="true" />{action.label}</button>)}
        </div> : null}
      </div>
    </div>
    <div className="auth-list-main-actions">
      <Switch size="sm" checked={!props.disabled} onChange={props.onToggle} disabled={settingsDisabled}
        aria-label={`${toggleTitle} ${props.identity}`} title={toggleTitle} />
    </div>
  </footer>;
}
