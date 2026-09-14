import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type NoticeHost = { element: HTMLDivElement; users: number; dispose: () => void };
const hosts = new WeakMap<Document, NoticeHost>();

function acquireHost(doc: Document) {
  let host = hosts.get(doc);
  if (!host) {
    const element = doc.createElement('div');
    element.className = 'app-notice-stack';
    let observedDialog: Element | undefined;
    const resizeObserver = new ResizeObserver(() => placeHost());
    const placeHost = () => {
      const nativeDialogs = doc.querySelectorAll('dialog:modal');
      const nativeDialog = nativeDialogs[nativeDialogs.length - 1];
      const dialogs = Array.from((nativeDialog ?? doc).querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'))
        .filter(dialog => dialog.getBoundingClientRect().height > 0);
      const dialog = dialogs[dialogs.length - 1] ?? nativeDialog;
      const parent = dialog ?? doc.body;
      if (element.parentElement !== parent) parent.appendChild(element);
      if (dialog !== observedDialog) {
        if (observedDialog) resizeObserver.unobserve(observedDialog);
        if (dialog) resizeObserver.observe(dialog);
        observedDialog = dialog;
      }
      let bottom = 24;
      const viewportHeight = doc.documentElement.clientHeight;
      const bounds = element.getBoundingClientRect();
      const idealTop = viewportHeight - 24 - Math.min(element.scrollHeight, viewportHeight - 48);
      const buttons = dialog ? Array.from(dialog.querySelectorAll('button'))
        .filter(button => !element.contains(button))
        .map(button => button.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0) : [];
      const lastBottom = Math.max(0, ...buttons.map(rect => rect.bottom));
      const footer = buttons.filter(rect => rect.bottom >= lastBottom - 8);
      if (footer.some(rect => rect.right > bounds.left && rect.left < bounds.right
        && rect.bottom > idealTop && rect.top < viewportHeight - 24)) {
        bottom = Math.max(24, viewportHeight - Math.min(...footer.map(rect => rect.top)) + 12);
      }
      const value = bottom + 'px';
      if (element.style.getPropertyValue('--notice-bottom') !== value) {
        element.style.setProperty('--notice-bottom', value);
      }
    };
    const observer = new MutationObserver(placeHost);
    placeHost();
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'class', 'hidden'] });
    resizeObserver.observe(element);
    doc.defaultView?.addEventListener('resize', placeHost);
    host = { element, users: 0, dispose() {
      observer.disconnect();
      resizeObserver.disconnect();
      doc.defaultView?.removeEventListener('resize', placeHost);
      element.remove();
    } };
    hosts.set(doc, host);
  }
  host.users += 1;
  const acquired = host;
  return {
    element: acquired.element,
    release() {
      acquired.users -= 1;
      if (acquired.users === 0) {
        acquired.dispose();
        hosts.delete(doc);
      }
    },
  };
}

export function NoticePortal({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const acquired = acquireHost(document);
    setHost(acquired.element);
    return acquired.release;
  }, []);
  useLayoutEffect(() => {
    if (host) host.scrollTop = host.scrollHeight;
  }, [host]);
  return host ? createPortal(children, host) : null;
}
