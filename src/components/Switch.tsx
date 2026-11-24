import { useId, type ChangeEventHandler, type InputHTMLAttributes, type ReactNode } from 'react';

export type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role' | 'size' | 'defaultChecked' | 'checked' | 'onChange'> & {
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  label?: ReactNode;
  size?: 'sm' | 'md';
  invalid?: boolean;
};

export function Switch({ checked, onChange, label, size = 'md', invalid, className, id, title, ...props }: SwitchProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const control = <span className={['switch-control', size === 'sm' ? 'switch-control-sm' : '', className].filter(Boolean).join(' ')} title={title}>
    <input {...props} id={inputId} type="checkbox" role="switch" aria-checked={checked} aria-label={props['aria-label'] ?? (label == null ? title : undefined)} checked={checked}
      aria-invalid={invalid || props['aria-invalid']} onChange={onChange} />
    <span className="switch-track" aria-hidden="true" />
  </span>;
  return label == null ? control : <label className="binary-control-label" htmlFor={inputId}>{control}<span>{label}</span></label>;
}
