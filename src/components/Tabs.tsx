import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { useChoiceNavigation } from './useChoiceNavigation';

export type TabItem<T extends string> = {
  value: T;
  id: string;
  panelId: string;
  label: ReactNode;
  disabled?: boolean;
};

type TabsProps<T extends string> = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> & {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  activation?: 'automatic' | 'manual';
  orientation?: 'horizontal' | 'vertical';
  variant?: 'underline' | 'segmented' | 'sidebar';
  ref?: Ref<HTMLDivElement>;
};

export function Tabs<T extends string>({ items, value, onChange, disabled, activation = 'automatic', orientation = 'horizontal', variant = 'underline', className, ...props }: TabsProps<T>) {
  const available = items.filter(item => !disabled && !item.disabled).map(item => item.value);
  const stop = available.includes(value) ? value : available[0];
  const navigation = useChoiceNavigation(value, available, onChange, orientation === 'vertical', activation);
  return <div {...props} className={['tabs-control', className].filter(Boolean).join(' ')} data-variant={variant} role="tablist" aria-orientation={orientation}>
    {items.map(item => <button key={item.value} type="button" id={item.id} role="tab" aria-selected={value === item.value}
      aria-controls={item.panelId} tabIndex={stop === item.value ? 0 : -1} className={value === item.value ? 'active' : ''}
      disabled={disabled || item.disabled} ref={element => { if (element) navigation.buttons.current.set(item.value, element); else navigation.buttons.current.delete(item.value); }}
      onClick={() => navigation.choose(item.value)} onKeyDown={event => navigation.onKeyDown(event, item.value)}>{item.label}</button>)}
  </div>;
}
