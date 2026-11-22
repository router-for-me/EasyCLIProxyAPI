import { useEffect, useState } from 'react';

const OVERLAY_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]';
const MODAL_SELECTOR = 'dialog:modal, [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';
const OBSERVED_ATTRIBUTES = ['open', 'hidden', 'class', 'style', 'role', 'aria-hidden', 'aria-modal'];

const isVisible = (element: Element): boolean => {
  if (element.getClientRects().length === 0) return false;
  const style = window.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
};

const isOverlayOpen = (selector: string): boolean =>
  Array.from(document.querySelectorAll(selector)).some(isVisible);

export function useOverlayOpen(kind: 'all' | 'modal' = 'all'): boolean {
  const selector = kind === 'modal' ? MODAL_SELECTOR : OVERLAY_SELECTOR;
  const [open, setOpen] = useState(() => isOverlayOpen(selector));

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setOpen(isOverlayOpen(selector));
    };
    const observer = new MutationObserver((records) => {
      if (kind === 'modal' && records.every(({ target, attributeName }) =>
        attributeName === 'style' && target instanceof Element && !target.matches(selector) && !target.querySelector(selector))) return;
      if (!frame) frame = window.requestAnimationFrame(update);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: OBSERVED_ATTRIBUTES });
    update();
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [kind, selector]);

  return open;
}
