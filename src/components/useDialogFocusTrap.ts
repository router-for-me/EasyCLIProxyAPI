import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let bodyLockCount = 0;
let bodyOverflowBeforeLock = '';

function lockBodyScroll() {
  if (bodyLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  bodyLockCount += 1;
  return () => {
    bodyLockCount = Math.max(0, bodyLockCount - 1);
    if (bodyLockCount === 0) document.body.style.overflow = bodyOverflowBeforeLock;
  };
}

function visible(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(visible);
}

function topModal() {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>(
    'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
  )).filter(visible);
  return dialogs[dialogs.length - 1] ?? null;
}

type DialogFocusOptions = {
  active?: boolean;
  onEscape?: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  preventEscape?: boolean;
};

export function useDialogFocusTrap<T extends HTMLElement>({
  active = true,
  onEscape,
  initialFocusRef,
  preventEscape = false,
}: DialogFocusOptions = {}) {
  const dialogRef = useRef<T>(null);
  const escapeRef = useRef(onEscape);
  const initialFocus = useRef(initialFocusRef);
  const preventEscapeRef = useRef(preventEscape);
  const wasActiveRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  if (active && !wasActiveRef.current && typeof document !== 'undefined') {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }
  wasActiveRef.current = active;
  escapeRef.current = onEscape;
  initialFocus.current = initialFocusRef;
  preventEscapeRef.current = preventEscape;

  useEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const previousFocus = previousFocusRef.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const unlockBodyScroll = lockBodyScroll();
    const frame = window.requestAnimationFrame(() => {
      const requested = initialFocus.current?.current;
      const autoFocus = dialog.querySelector<HTMLElement>('[autofocus]');
      const first = focusableElements(dialog)[0];
      const target = requested && visible(requested) ? requested : autoFocus ?? first ?? dialog;
      if (!dialog.hasAttribute('tabindex') && target === dialog) dialog.tabIndex = -1;
      target.focus();
    });

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (topModal() !== dialog) return;
      if (event.key === 'Escape') {
        if (!escapeRef.current && !preventEscapeRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;

      const controls = focusableElements(dialog);
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      const focusInside = dialog.contains(document.activeElement);
      if (event.shiftKey && (!focusInside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!focusInside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown, true);
      unlockBodyScroll();
      if (previousFocus?.isConnected) previousFocus.focus();
      previousFocusRef.current = null;
    };
  }, [active]);

  return dialogRef;
}
