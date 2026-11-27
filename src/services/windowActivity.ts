import { invoke, isDesktopApp, listen } from './platform';
import { startActivePolling } from './activePolling';

let active = false;
const listeners = new Set<() => void>();
const publish = (value: boolean) => {
  if (active === value) return;
  active = value;
  listeners.forEach(listener => listener());
};
export const windowActivity = {
  active: () => active,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export const pollWhileActive = (refresh: () => void, interval: number, pause?: () => void) =>
  startActivePolling(windowActivity, refresh, interval, pause);

// One application-lifetime subscription. Native visibility avoids treating an
// unfocused/occluded window on a second monitor as hidden (#493).
export async function initializeWindowActivity() {
  if (!isDesktopApp()) {
    const update = () => publish(!document.hidden);
    document.addEventListener('visibilitychange', update);
    update();
    return;
  }
  let revision = 0;
  try {
    await listen<boolean>('main-window-activity', ({ payload }) => { ++revision; publish(payload); });
    const before = revision;
    const initial = await invoke<boolean>('main_window_active');
    if (revision === before) publish(initial);
  } catch (error) {
    // A visibility-query failure must not prevent the application from starting.
    console.error('Failed to initialize window activity', error);
    if (revision === 0) publish(true);
  }
}
