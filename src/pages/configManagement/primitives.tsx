import { useId, useMemo, type AriaAttributes, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SyntheticEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { SelectMenu, type SelectMenuOption } from '../../components/SelectMenu';
import { SettingsHelp } from '../../components/SettingsHelp';
import { Switch, type SwitchProps } from '../../components/Switch';

export function Button({ className, variant = 'primary', size, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm';
}) {
  return <button {...props} type={type} className={['btn', variant === 'primary' ? 'primary-button' : 'secondary-button', size === 'sm' && 'mock-config-small-button', className].filter(Boolean).join(' ')} />;
}

export function InfoTip({ label = '', content, descriptionId }: { label?: string; content: ReactNode; descriptionId?: string }) {
  return <><SettingsHelp label={label}>{content}</SettingsHelp>{descriptionId && <span className="visually-hidden-focusable" id={descriptionId}>{content}</span>}</>;
}

export function FieldLabel({ id, htmlFor, label, hint, hintId, className }: { id?: string; htmlFor?: string; label: ReactNode; hint?: ReactNode; hintId?: string; className?: string }) {
  return <div className={['config-field-label', className].filter(Boolean).join(' ')}>
    {htmlFor ? <label id={id} htmlFor={htmlFor}>{label}</label> : <span id={id}>{label}</span>}
    {hint && <><InfoTip label={typeof label === 'string' ? label : undefined} content={hint} /><span className="visually-hidden-focusable" id={hintId}>{hint}</span></>}
  </div>;
}

export function Input({ label, hint, error, rightElement, className, id, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  label?: string; hint?: ReactNode; error?: string; rightElement?: ReactNode;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return <div className="form-group">
    {label && <FieldLabel htmlFor={inputId} label={label} hint={hint} hintId={`${inputId}-hint`} />}
    <div className="mock-config-input-wrap">
      <input {...props} id={inputId} className={['input', className].filter(Boolean).join(' ')} aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={[props['aria-describedby'], hint && `${inputId}-hint`, error && `${inputId}-error`].filter(Boolean).join(' ') || undefined} />
      {rightElement && <span className="mock-config-input-addon">{rightElement}</span>}
    </div>
    {error && <p id={`${inputId}-error`} className="mock-config-error">{error}</p>}
  </div>;
}

export type SelectOption = { value: string; label: string };

export function Select({ id, value, options, onChange, disabled, placeholder, ariaLabel, ariaLabelledBy, ariaDescribedBy, ariaInvalid, className, fullWidth, size }: {
  id?: string; value: string; options: readonly SelectOption[]; onChange: (value: string) => void; disabled?: boolean;
  placeholder?: string; ariaLabel?: string; ariaLabelledBy?: string; ariaDescribedBy?: string;
  ariaInvalid?: AriaAttributes['aria-invalid']; className?: string; fullWidth?: boolean; size?: 'sm' | 'md';
}) {
  const menuOptions = useMemo((): readonly SelectMenuOption[] => {
    if (options.some((option) => option.value === value)) return options;
    return [{ value, label: (value || placeholder) ?? '', disabled: !value }, ...options];
  }, [options, placeholder, value]);
  return <div className={['mock-config-select', fullWidth && 'mock-config-select-wide', size === 'sm' && 'mock-config-select-small', className].filter(Boolean).join(' ')}>
    <SelectMenu id={id} value={value} options={menuOptions} onChange={onChange} disabled={disabled} className="mock-config-menu"
      ariaLabel={ariaLabel} ariaLabelledBy={ariaLabelledBy} ariaDescribedBy={ariaDescribedBy} ariaInvalid={ariaInvalid} />
  </div>;
}

export function ToggleSwitch({ onChange, ariaDescribedBy, ...props }: Omit<SwitchProps, 'onChange'> & {
  onChange: (checked: boolean) => void; ariaDescribedBy?: string;
}) {
  return <Switch {...props} aria-describedby={ariaDescribedBy} onChange={(event) => onChange(event.target.checked)} />;
}

export function Collapsible({ label, defaultOpen, open, onToggle, children }: {
  label: ReactNode; defaultOpen?: boolean; open?: boolean; onToggle?: (event: SyntheticEvent<HTMLDetailsElement>) => void; children: ReactNode;
}) {
  return <details className="mock-config-collapsible" open={open ?? defaultOpen ?? undefined} onToggle={onToggle}>
    <summary><span>{label}</span><ChevronDown size={15} aria-hidden="true" /></summary><div>{children}</div>
  </details>;
}

export function Modal({ open, onClose, title, footer, children }: { open: boolean; onClose: () => void; title: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return open ? <Dialog className="config-dialog mock-config-form-dialog" title={title} actions={footer} onClose={onClose}>
    <div className="mock-config-form-body">{children}</div>
  </Dialog> : null;
}
