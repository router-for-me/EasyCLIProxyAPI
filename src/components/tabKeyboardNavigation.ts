import type { KeyboardEvent } from 'react';

const horizontalKeys = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

export function handleHorizontalTabKey<T extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  tabs: readonly T[],
  current: T,
  activate: (tab: T) => void,
  focusTab: (tab: T) => HTMLElement | null,
) {
  if (!horizontalKeys.has(event.key) || tabs.length === 0) return;
  const index = Math.max(0, tabs.indexOf(current));
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : (index - 1 + tabs.length) % tabs.length;
  const next = tabs[nextIndex];
  event.preventDefault();
  activate(next);
  window.requestAnimationFrame(() => focusTab(next)?.focus());
}
