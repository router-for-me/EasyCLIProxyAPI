import type { MessageKey } from '../i18n/resources';

export type SidebarHubId =
  | 'home'
  | 'access'
  | 'credentials'
  | 'account-switching'
  | 'agents'
  | 'usage'
  | 'plugins'
  | 'settings';

/**
 * A sidebar entry. Single-page hubs render as a plain row; multi-page hubs
 * render as one row that opens its first available page and reveals its
 * pages inline while one of them is active.
 */
export type SidebarHubDefinition = {
  id: SidebarHubId;
  /** Only multi-page hubs need their own label; single-page hubs use the page label. */
  labelKey?: MessageKey;
  pageIds: readonly string[];
  /** Pinned below a divider at the bottom of the list. */
  footer?: boolean;
};

export const SIDEBAR_HUBS: readonly SidebarHubDefinition[] = [
  { id: 'home', pageIds: ['home'] },
  { id: 'access', labelKey: 'app.nav.hub.access', pageIds: ['api', 'routing'] },
  { id: 'credentials', labelKey: 'app.nav.hub.credentials', pageIds: ['oauth', 'quota'] },
  { id: 'account-switching', pageIds: ['account-switching'] },
  { id: 'agents', labelKey: 'app.nav.hub.agents', pageIds: ['agents', 'mcp-skills'] },
  { id: 'usage', labelKey: 'app.nav.hub.usage', pageIds: ['usage-records', 'agent-usage'] },
  { id: 'plugins', pageIds: ['plugins'] },
  {
    id: 'settings',
    labelKey: 'app.nav.hub.settings',
    pageIds: ['config', 'config-management', 'versions'],
    footer: true,
  },
] as const;

export function findHubForPage(pageId: string): SidebarHubDefinition | undefined {
  if (pageId.startsWith('/plugin-pages/')) return SIDEBAR_HUBS.find((hub) => hub.id === 'plugins');
  return SIDEBAR_HUBS.find((hub) => hub.pageIds.includes(pageId));
}

const SIDEBAR_RAIL_KEY = 'cpa-gui.sidebar-rail.v1';

export function readSidebarRailCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_RAIL_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeSidebarRailCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_RAIL_KEY, String(collapsed));
  } catch {
    /* ignore storage failures */
  }
}
