import { listen } from '@tauri-apps/api/event';
import { createRefreshScheduler } from './refreshScheduler';

/** Coalesce bursts, keep a bounded poll for missed events, and ignore queued work after unmount. */
export function subscribeActivity(refresh: () => Promise<void>) {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const scheduler = createRefreshScheduler(1500);
  const request = () => {
    if (!disposed) void scheduler.schedule(async () => { if (!disposed) await refresh(); }).catch(() => {});
  };
  void listen('usage-records-updated', request).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
  const timer = window.setInterval(request, 15_000);
  window.addEventListener('focus', request);
  request();
  return { request, dispose: () => {
    disposed = true; unlisten?.(); scheduler.cancelPending();
    window.clearInterval(timer); window.removeEventListener('focus', request);
  } };
}
