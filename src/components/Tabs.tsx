import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { useEffect, useRef } from 'react';
import { useChoiceNavigation } from './useChoiceNavigation';

export type TabItem<T extends string> = {
  value: T;
  id: string;
  panelId: string;
  label: ReactNode;
  title?: string;
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

export function Tabs<T extends string>({ items, value, onChange, disabled, activation = 'automatic', orientation = 'horizontal', variant = 'underline', className, ref, ...props }: TabsProps<T>) {
  const available = items.filter(item => !disabled && !item.disabled).map(item => item.value);
  const stop = available.includes(value) ? value : available[0];
  const navigation = useChoiceNavigation(value, available, onChange, orientation === 'vertical', activation);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Expose overflow state so horizontally scrolling tab bars can fade the right edge.
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = () => {
      const overflowing = element.scrollWidth - element.clientWidth > 1;
      const atEnd = !overflowing || element.scrollWidth - element.clientWidth - element.scrollLeft <= 1;
      element.dataset.overflowing = overflowing ? 'true' : 'false';
      element.dataset.atEnd = atEnd ? 'true' : 'false';
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    element.addEventListener('scroll', update, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener('scroll', update); };
  }, [items]);

  const assignRef = (element: HTMLDivElement | null) => {
    rootRef.current = element;
    if (typeof ref === 'function') ref(element);
    else if (ref) ref.current = element;
  };

  return <div {...props} ref={assignRef} className={['tabs-control', className].filter(Boolean).join(' ')} data-variant={variant} role="tablist" aria-orientation={orientation}>
    {items.map(item => <button key={item.value} type="button" id={item.id} role="tab" aria-selected={value === item.value}
      aria-label={item.title} title={item.title}
      aria-controls={item.panelId} tabIndex={stop === item.value ? 0 : -1} className={value === item.value ? 'active' : ''}
      disabled={disabled || item.disabled} ref={element => { if (element) navigation.buttons.current.set(item.value, element); else navigation.buttons.current.delete(item.value); }}
      onClick={() => navigation.choose(item.value)} onKeyDown={event => navigation.onKeyDown(event, item.value)}>{item.label}</button>)}
  </div>;
}
