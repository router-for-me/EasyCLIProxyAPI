import type { AccountSwitchCategoryFilter } from '../navigation';
import type { MessageKey } from '../i18n/resources';

export type SidebarGroupId = 'proxy' | 'direct' | 'extensions' | 'system';

export type SidebarGroupDefinition = {
  id: SidebarGroupId;
  labelKey: MessageKey;
  tone: 'proxy' | 'direct' | 'neutral';
  pageIds: readonly string[];
};

export const SIDEBAR_NAV_GROUPS: readonly SidebarGroupDefinition[] = [
  {
    id: 'proxy',
    labelKey: 'app.nav.group.proxy',
    tone: 'proxy',
    pageIds: ['api', 'oauth', 'quota', 'routing', 'agents', 'config', 'config-management'],
  },
  {
    id: 'direct',
    labelKey: 'app.nav.group.direct',
    tone: 'direct',
    pageIds: ['account-switching'],
  },
  {
    id: 'extensions',
    labelKey: 'app.nav.group.extensions',
    tone: 'neutral',
    pageIds: ['usage-records', 'agent-usage', 'plugins', 'mcp-skills'],
  },
  {
    id: 'system',
    labelKey: 'app.nav.group.system',
    tone: 'neutral',
    pageIds: ['versions'],
  },
] as const;

export type AccountSwitchSubpageItem = {
  category: Exclude<AccountSwitchCategoryFilter, 'all'>;
  labelKey: MessageKey;
};

export const ACCOUNT_SWITCH_SUBPAGES: readonly AccountSwitchSubpageItem[] = [
  {
    category: 'official-cli',
    labelKey: 'app.nav.accountSwitching.officialCli',
  },
  {
    category: 'ai-ide',
    labelKey: 'app.nav.accountSwitching.aiIde',
  },
] as const;

const COLLAPSED_GROUPS_KEY = 'cpa-gui.sidebar-nav-groups.v1';
const SUBPAGES_EXPANDED_KEY = 'cpa-gui.sidebar-as-subpages.v1';
const SIDEBAR_RAIL_KEY = 'cpa-gui.sidebar-rail.v1';

export type CollapsedGroupsMap = Partial<Record<SidebarGroupId, boolean>>;

export function findGroupForPage(pageId: string): SidebarGroupId | null {
  if (pageId.startsWith('/plugin-pages/')) return 'extensions';
  const match = SIDEBAR_NAV_GROUPS.find((group) => group.pageIds.includes(pageId));
  return match?.id ?? null;
}

export function readCollapsedGroups(): CollapsedGroupsMap {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: CollapsedGroupsMap = {};
    for (const group of SIDEBAR_NAV_GROUPS) {
      if ((parsed as Record<string, unknown>)[group.id] === true) {
        result[group.id] = true;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function writeCollapsedGroups(map: CollapsedGroupsMap): void {
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(map));
  } catch {
    /* ignore storage failures */
  }
}

export function readAccountSwitchSubpagesExpanded(): boolean {
  try {
    const raw = window.localStorage.getItem(SUBPAGES_EXPANDED_KEY);
    if (raw === 'false') return false;
    return true;
  } catch {
    return true;
  }
}

export function writeAccountSwitchSubpagesExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(SUBPAGES_EXPANDED_KEY, String(expanded));
  } catch {
    /* ignore storage failures */
  }
}

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
