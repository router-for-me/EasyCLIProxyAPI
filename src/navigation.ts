const alwaysAvailablePages = new Set(['easy', 'home', 'versions', 'config', 'usage-records', 'agents']);

export function isAlwaysAvailablePage(pageId: string) {
  return alwaysAvailablePages.has(pageId);
}

export function canOpenAppPage(pageId: string, coreReady: boolean) {
  return coreReady || isAlwaysAvailablePage(pageId);
}

export const APP_NAVIGATION_REQUEST_EVENT = 'cpa-gui-navigation-request';

export type AppNavigationRequest = CustomEvent<() => void>;

export function requestAppNavigation(navigate: () => void) {
  const event: AppNavigationRequest = new CustomEvent(APP_NAVIGATION_REQUEST_EVENT, {
    cancelable: true,
    detail: navigate,
  });
  if (window.dispatchEvent(event)) navigate();
}

const SCROLL_CONTAINER_SELECTORS = [
  '.immersive-window',
  '.window-content',
  '.app-shell',
  '.workspace',
  '.content',
  '.agent-config-scroll-region',
] as const;

export function resetWorkspaceScroll(root: ParentNode | null = typeof document !== 'undefined' ? document : null) {
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
    try {
      window.scrollTo(0, 0);
    } catch {
      // Ignore non-scrolling window environments in tests.
    }
  }
  if (typeof document !== 'undefined') {
    if (document.documentElement) {
      document.documentElement.scrollTop = 0;
      document.documentElement.scrollLeft = 0;
    }
    if (document.body) {
      document.body.scrollTop = 0;
      document.body.scrollLeft = 0;
    }
  }
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const selector of SCROLL_CONTAINER_SELECTORS) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
  }
}
