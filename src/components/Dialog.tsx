import { useId, type FormEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import { useDialogFocusTrap } from './useDialogFocusTrap';

export type DialogSize = 'sm';

type DialogProps = {
  children?: ReactNode;
  id?: string;
  className?: string;
  backdropClassName?: string;
  size?: DialogSize;
  tone?: 'danger';
  alert?: boolean;
  as?: 'section' | 'form' | 'div';
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  actionsClassName?: string;
  labelledBy?: string;
  describedBy?: string;
  label?: string;
  busy?: boolean;
  tabIndex?: number;
  onClose?: () => void;
  onBackdropClose?: () => void;
  closeDisabled?: boolean;
  dismissOnBackdrop?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onSubmit?: (event: FormEvent<HTMLElement>) => void;
};

export function Dialog({
  children,
  id,
  className = 'config-dialog',
  backdropClassName,
  size,
  tone,
  alert = false,
  as: Element = 'section',
  title,
  icon,
  actions,
  actionsClassName,
  labelledBy,
  describedBy,
  label,
  busy,
  tabIndex,
  onClose,
  onBackdropClose = onClose,
  closeDisabled = false,
  dismissOnBackdrop = false,
  initialFocusRef,
  onSubmit,
}: DialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useDialogFocusTrap<HTMLElement>({
    onEscape: closeDisabled ? undefined : onClose,
    preventEscape: closeDisabled,
    initialFocusRef,
  });
  const classes = ['app-dialog', className, size ? `config-dialog-${size}` : ''].filter(Boolean).join(' ');
  const content = (
    <div className={['config-dialog-backdrop', backdropClassName].filter(Boolean).join(' ')} onMouseDown={(event) => {
      if (event.currentTarget !== event.target || !dismissOnBackdrop || closeDisabled || !onBackdropClose) return;
      event.preventDefault();
      onBackdropClose();
    }}>
      <Element
        ref={dialogRef as RefObject<never>}
        id={id}
        className={classes}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={title ? titleId : labelledBy}
        aria-describedby={describedBy}
        aria-label={label}
        aria-busy={busy}
        data-tone={tone}
        tabIndex={tabIndex}
        onSubmit={onSubmit}
      >
        {title ? (
          <div className="config-dialog-heading">
            <div>{icon}<h2 id={titleId}>{title}</h2></div>
            {onClose ? <button type="button" className="icon-button quiet" onClick={onClose} disabled={closeDisabled} title={t('common.close')} aria-label={t('common.close')}><X size={18} aria-hidden="true" /></button> : null}
          </div>
        ) : null}
        {children}
        {actions ? <div className={['config-dialog-actions', actionsClassName].filter(Boolean).join(' ')}>{actions}</div> : null}
      </Element>
    </div>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
