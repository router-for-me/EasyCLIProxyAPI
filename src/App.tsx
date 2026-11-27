import { Switch } from './components/Switch';
import { onWindowsCloseRequested } from './services/events';
import {
  openExternalUrl,
  getGuiSettings,
  resolveWindowsCloseRequest as resolveWindowsCloseRequestCommand,
} from './services/appSettings';
import type { WindowsCloseAction } from './services/appSettings';
import { closePluginWebview } from './services/pluginWebview';
import { WindowFrame } from './components/WindowFrame';
import { MessageNotice } from './appNotice';
import { ThemeSelector } from './components/ThemeSelector';
import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type SyntheticEvent } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Eye,
  EyeOff,
  FileSliders,
  Gauge,
  GitBranch,
  History,
  House,
  Languages,
  Lock,
  LogIn,
  MessageCircle,
  Network,
  PackageOpen,
  Blocks,
  Puzzle,
  ServerCog,
  Settings,
  Sprout,
  X,
} from 'lucide-react';
import appLogo from './assets/logo.jpg';
import { CoreRuntimeProvider, useCoreRuntime } from './coreRuntime';
import { CoreUpdateProvider, useCoreUpdate } from './coreUpdate';
import { ConfigPanelPage } from './pages/ConfigPanel';
import { ApiAccessPage } from './pages/ApiAccessPage';
import { KernelPage } from './pages/Kernel';
import { VersionManagementPage } from './pages/VersionManagementPage';
import { OAuthManagementPage } from './pages/ManagementPages';
import { QuotaPage } from './pages/QuotaPage';
import { AgentsPage } from './pages/AgentsPage';
import { AccountSwitchPage } from './pages/AccountSwitchPage';
import { AgentUsagePage } from './pages/AgentUsagePage';
import { EasyModePage } from './pages/EasyModePage';
import { UsageRecordsPage } from './pages/UsageRecordsPage';
import { RoutingPage } from './pages/routing/RoutingPage';
import { PluginsPage } from './pages/PluginsPage';
import { McpSkillsPage } from './pages/McpSkillsPage';
import { PluginResourcePage } from './pages/PluginResourcePage';
import { PluginNavChildren, PluginNavToggle } from './components/SidebarPluginNav';
import { SidebarNavGroup } from './components/SidebarNavGroup';
import {
  readSidebarRailCollapsed,
  SIDEBAR_NAV_GROUPS,
  writeSidebarRailCollapsed,
} from './components/SidebarNavConfig';
import { usePluginNavLayout } from './components/usePluginNavLayout';
import { usePluginNavEntries } from './usePluginNavEntries';
import { useCredentialSignInWatch, useSignInAlerts } from './components/useCredentialSignIn';
import {
  findPluginNavEntry,
  isPluginRoute,
  resolvePluginNavLayout,
  type PluginNavOverride,
} from './services/pluginNavigation';
import { languageOptions, useI18n } from './i18n';
import type { AppVersionSeries } from './services/appUpdates';
import { AppUpdateDialog, AppUpdateProvider, useAppUpdate } from './appUpdate';
import { appUpdateIndicatorState } from './appUpdateModel';
import { forgetUpdatedPlugins, pluginUpdateIndicatorState } from './pluginUpdateModel';
import {
  canOpenAppPage,
  requestAppNavigation,
} from './navigation';
import { useThemePreference } from './theme';
import { usePrivacyMode } from './privacy';
import { Dialog } from './components/Dialog';
import { WorkspaceScrollbars } from './components/WorkspaceScrollbars';
import { EmptyState } from './components/EmptyState';
import { CpaConnectionDialog, CpaWorkspaceTarget } from './pages/RemoteCpaPage';
import { getCpaConnection, type CpaConnection } from './services/remoteCpa';
import { hasBackend } from './services/platform';
import { WebAccountControls } from './components/WebLoginScreen';
import { ServerPathPickerHost } from './components/ServerPathPickerModal';

const QQ_CONTACT_URL = 'https://qm.qq.com/q/3queDaIG';
const DISCORD_SERVER_URL = 'https://discord.gg/PxvX4D9kgs';
const ConfigManagementPage = lazy(() => import('./pages/configManagement/ConfigManagementPage'));

const pages = [
  {
    id: 'easy',
    labelKey: 'app.nav.easy',
    icon: House,
    component: HomePage,
  },
  {
    id: 'home',
    labelKey: 'app.nav.home',
    icon: House,
    component: HomePage,
  },
  {
    id: 'api',
    labelKey: 'app.nav.api',
    icon: Network,
    component: ApiAccessPage,
  },
  {
    id: 'oauth',
    labelKey: 'app.nav.oauth',
    icon: LogIn,
    component: OAuthManagementPage,
  },
  {
    id: 'quota',
    labelKey: 'app.nav.quota',
    icon: Gauge,
    component: QuotaPage,
  },
  {
    id: 'routing',
    labelKey: 'app.nav.routing',
    icon: GitBranch,
    component: RoutingPage,
  },
  {
    id: 'agents',
    labelKey: 'app.nav.agents',
    icon: Bot,
    component: AgentsPage,
  },
  {
    id: 'account-switching',
    labelKey: 'app.nav.accountSwitching',
    icon: ArrowLeftRight,
    component: AccountSwitchPage,
  },
  {
    id: 'usage-records',
    labelKey: 'app.nav.usageRecords',
    icon: History,
    component: UsageRecordsPage,
  },
  {
    id: 'agent-usage',
    labelKey: 'app.nav.agentUsage',
    icon: Activity,
    component: AgentUsagePage,
  },
  {
    id: 'config',
    labelKey: 'app.nav.config',
    icon: Settings,
    component: ConfigPanelPage,
  },
  {
    id: 'config-management',
    labelKey: 'app.nav.configManagement',
    icon: FileSliders,
    component: null,
  },
  {
    id: 'versions',
    labelKey: 'app.nav.versions',
    icon: PackageOpen,
    component: VersionManagementPage,
  },
  {
    id: 'plugins',
    labelKey: 'app.nav.plugins',
    icon: Puzzle,
    component: PluginsPage,
  },
  {
    id: 'mcp-skills',
    labelKey: 'app.nav.mcpSkills',
    icon: Blocks,
    component: McpSkillsPage,
  },
] as const;

type PageId = (typeof pages)[number]['id'];
type AppPageId = PageId | `/plugin-pages/${string}`;

type WindowsClosePrompt = {
  resolvingAction: WindowsCloseAction | null;
  rememberChoice: boolean;
  error: string | null;
};

function HomePage() {
  return <KernelPage view="home" />;
}

function App({ initialConnection, browserMockEnabled = false }: { initialConnection?: CpaConnection; browserMockEnabled?: boolean }) {
  const { t } = useI18n();
  const [connection, setConnection] = useState(initialConnection);
  const [connectionDraft, setConnectionDraft] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (initialConnection) return;
    let cancelled = false;
    void getCpaConnection().then(next => { if (!cancelled) setConnection(next); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [attempt, initialConnection]);
  const openConnection = (endpoint = '') => setConnectionDraft(endpoint);
  const closeConnection = () => setConnectionDraft(null);

  return (
    <WindowFrame>
      {!connection ? (
        <main className="cpa-remote-workspace">
          <p role={failed ? 'alert' : 'status'}>{t(failed ? 'remote.error.unknown' : 'remote.loading')}</p>
          {failed ? <button type="button" className="secondary-button" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>{t('remote.retry')}</button> : null}
        </main>
      ) : (
        <AppUpdateProvider enabled={!connection.remoteActive}>
          <CoreRuntimeProvider targetRevision={connection.remoteActive ? connection.revision : undefined}>
            <CoreUpdateProvider enabled={!connection.remoteActive}>
              <CpaWorkspaceTarget connection={connection} openConnection={openConnection} onChange={setConnection}>
                {switcher => <AppContent connection={connection} switcher={switcher} browserMockEnabled={browserMockEnabled} openConnection={openConnection} />}
              </CpaWorkspaceTarget>
            </CoreUpdateProvider>
          </CoreRuntimeProvider>
        </AppUpdateProvider>
      )}
      {connection && !connection.remoteActive ? <LocalWindowClose /> : null}
      {connection && connectionDraft !== null ? (
        <CpaConnectionDialog initialEndpoint={connectionDraft} connection={connection} close={closeConnection} onChange={setConnection} />
      ) : null}
    </WindowFrame>
  );
}

function AppContent({ connection, switcher, browserMockEnabled, openConnection }: { connection: CpaConnection; switcher: React.ReactNode; browserMockEnabled: boolean; openConnection: (endpoint?: string) => void }) {
  const remote = connection.remoteActive;
  const { locale, setLocale, t } = useI18n();
  const { info: appUpdateInfo, hasUpdate, processing: appUpdateProcessing } = useAppUpdate();
  const [appVersionDisplay, setAppVersionDisplay] = useState<AppVersionSeries>('stable');
  const logoLabel = t(appVersionDisplay === 'stable' ? 'appUpdate.logoShowPreview' : 'appUpdate.logoShowStable');
  const { latest: coreLatest, hasUpdate: coreHasUpdate } = useCoreUpdate();
  const [active, setActive] = useState<AppPageId>('home');
  const [sidebarRailCollapsed, setSidebarRailCollapsed] = useState<boolean>(
    readSidebarRailCollapsed,
  );
  const [railTooltip, setRailTooltip] = useState<{
    targetId: string;
    label: string;
    meta?: string;
    top: number;
  } | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const isMac = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    return /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || navigator.userAgent || '');
  }, []);
  const sidebarShortcutLabel = isMac ? '⌘B' : 'Ctrl+B';

  const hideRailTooltip = useCallback(() => setRailTooltip(null), []);
  const showRailTooltip = useCallback(
    (event: SyntheticEvent<HTMLElement>, targetId: string, label: string, meta?: string) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setRailTooltip({
        targetId,
        label,
        meta,
        top: Math.max(24, Math.min(window.innerHeight - 24, rect.top + rect.height / 2)),
      });
    },
    [],
  );

  const toggleSidebarRail = useCallback(() => {
    setRailTooltip(null);
    setSidebarRailCollapsed((current) => {
      const next = !current;
      writeSidebarRailCollapsed(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 'b') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      toggleSidebarRail();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebarRail]);
  useLayoutEffect(() => {
    // Reset only committed page changes, before the destination is painted.
    workspaceRef.current?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [active]);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [theme, setTheme] = useThemePreference();
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [privacyMode, setPrivacyMode] = usePrivacyMode();
  const languageMenuRef = useRef<HTMLDivElement>(null);
  const languageButtonRef = useRef<HTMLButtonElement>(null);
  const { status } = useCoreRuntime();
  const coreReady = remote || Boolean(status?.ready);
  useCredentialSignInWatch(coreReady, remote ? connection.revision : undefined);
  const signInAlerts = useSignInAlerts();
  const [navElement, setNavElement] = useState<HTMLElement | null>(null);
  const { entries: pluginEntries, plugins: installedPluginList, fetched: pluginEntriesFetched, pluginUpdates } = usePluginNavEntries(coreReady, remote ? connection.revision : undefined);
  const pluginEntry = findPluginNavEntry(pluginEntries, active);
  const configManagementAvailable = hasBackend() || browserMockEnabled;
  const navPages = pages.filter((page) => page.id !== 'easy' && (page.id !== 'config-management' || configManagementAvailable));
  const { layout: autoPluginLayout, compact: navCompact } = usePluginNavLayout(navElement, navPages.length, pluginEntries.length);
  const [pluginReload, setPluginReload] = useState(0);
  const [pluginNavOverride, setPluginNavOverride] = useState<PluginNavOverride | null>(null);
  useEffect(() => setPluginNavOverride(null), [autoPluginLayout, pluginEntries.length]);
  const pluginNavLayout = navCompact
    ? 'expanded'
    : resolvePluginNavLayout(autoPluginLayout, pluginEntries.length, pluginNavOverride);
  const pluginNavExpanded = pluginNavLayout === 'expanded';
  const pluginChildActive = pluginEntries.some((entry) => entry.route === active);
  // The top bar's nav row scrolls sideways on phones: keep the active item inside it.
  useLayoutEffect(() => {
    const row = navElement?.querySelector<HTMLElement>('button.active');
    if (!navElement || !row) return;
    const box = navElement.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    // Line the item up with the row's start, where the row's scroll snapping puts it anyway.
    if (rect.left < box.left || rect.right > box.right) navElement.scrollLeft += rect.left - box.left;
    if (rect.top < box.top) navElement.scrollTop += rect.top - box.top;
    else if (rect.bottom > box.bottom) navElement.scrollTop += rect.bottom - box.bottom;
  }, [navElement, active, pluginEntries.length, pluginNavExpanded]);
  const activePage = pages.find((page) => page.id === active);
  const ActivePage = activePage?.component;
  const selectedLanguage = languageOptions.find((option) => option.value === locale)
    ?? languageOptions[0];
  const availableUpdateLabel = [
    hasUpdate
      ? t('appUpdate.badgeAvailable', { version: appUpdateInfo?.latestVersion ?? '' })
      : '',
    coreHasUpdate
      ? `${t('kernel.versions.coreCardTitle')}: ${t('kernel.update.available')} ${coreLatest?.version ?? ''}`.trim()
      : '',
  ].filter(Boolean).join(' · ');
  useEffect(() => {
    if (!canOpenAppPage(active, coreReady)) {
      setActive('home');
    }
  }, [active, coreReady, remote]);

  useEffect(() => {
    if (status !== null && !status.ready) void closePluginWebview().catch(() => undefined);
  }, [status]);

  useEffect(() => {
    if (pluginEntriesFetched && isPluginRoute(active) && !pluginEntry) {
      setActive('plugins');
    }
  }, [active, pluginEntry, pluginEntriesFetched]);

  useEffect(() => {
    if (!languageMenuOpen) return undefined;
    const closeFromOutside = (event: PointerEvent) => {
      if (!languageMenuRef.current?.contains(event.target as Node)) {
        setLanguageMenuOpen(false);
      }
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setLanguageMenuOpen(false);
      languageButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeFromOutside);
    document.addEventListener('keydown', closeFromKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside);
      document.removeEventListener('keydown', closeFromKeyboard);
    };
  }, [languageMenuOpen]);

  const handleLanguageListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    if (!options.length) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown'
          ? (Math.max(current, -1) + 1) % options.length
          : (current <= 0 ? options.length : current) - 1;
    event.preventDefault();
    options[next]?.focus();
  };

  const select = useCallback((pageId: AppPageId) => {
    if ((pageId === 'config-management' && !configManagementAvailable) || !canOpenAppPage(pageId, coreReady)) {
      return;
    }
    if (pageId !== active) requestAppNavigation(() => setActive(pageId));
    else if (isPluginRoute(pageId)) setPluginReload((value) => value + 1);
  }, [active, coreReady, configManagementAvailable]);

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const customEvent = event as CustomEvent<AppPageId>;
      if (customEvent.detail) {
        select(customEvent.detail);
      }
    };
    window.addEventListener('app:navigate', handleNavigate);
    return () => window.removeEventListener('app:navigate', handleNavigate);
  }, [select]);

  const openContact = async () => {
    try {
      await openExternalUrl({
        url: locale === 'zh-CN' ? QQ_CONTACT_URL : DISCORD_SERVER_URL,
      });
    } catch (error) {
      console.error('Failed to open the contact link', error);
    }
  };

  const renderNavPageRow = (page: (typeof navPages)[number]) => {
    const Icon = page.icon;
    const hasPluginChildren = page.id === 'plugins' && pluginEntries.length > 0;
    const isActive =
      page.id === active || (hasPluginChildren && !pluginNavExpanded && pluginChildActive);
    const locked = !canOpenAppPage(page.id, coreReady);
    const updateIndicator =
      page.id === 'versions'
        ? appUpdateIndicatorState(hasUpdate, coreHasUpdate, appUpdateProcessing)
        : page.id === 'plugins'
          ? pluginUpdateIndicatorState(pluginUpdates)
          : page.id === 'oauth' && signInAlerts.length > 0
            ? 'attention'
            : null;
    const updateIndicatorLabel =
      page.id === 'oauth'
        ? t('authFiles.signIn.badge', { count: signInAlerts.length })
        : page.id === 'plugins'
          ? Object.keys(pluginUpdates).length > 0
            ? `${t('plugins.updateAvailable')} (${Object.keys(pluginUpdates).length})`
            : ''
          : availableUpdateLabel;
    const labelText = t(page.labelKey);
    const lockedHint = locked ? t('app.nav.lockedHint') : undefined;
    const row = (
      <button
        key={page.id}
        type="button"
        className={[isActive ? 'active' : '', locked ? 'locked' : ''].filter(Boolean).join(' ')}
        aria-current={page.id === active ? 'page' : undefined}
        disabled={locked}
        title={sidebarRailCollapsed ? undefined : locked ? `${labelText} — ${lockedHint}` : labelText}
        onClick={() => {
          hideRailTooltip();
          select(page.id);
        }}
        onMouseEnter={
          sidebarRailCollapsed
            ? (event) => showRailTooltip(event, `nav-${page.id}`, labelText, lockedHint)
            : undefined
        }
        onMouseLeave={sidebarRailCollapsed ? hideRailTooltip : undefined}
        onFocus={
          sidebarRailCollapsed
            ? (event) => showRailTooltip(event, `nav-${page.id}`, labelText, lockedHint)
            : undefined
        }
        onBlur={sidebarRailCollapsed ? hideRailTooltip : undefined}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{labelText}</span>
        {locked ? (
          <Lock size={12} strokeWidth={1.75} className="nav-lock-icon" aria-hidden="true" />
        ) : updateIndicator ? (
          <i
            className={`nav-update-indicator ${updateIndicator}`}
            title={
              updateIndicator === 'processing'
                ? t('appUpdate.progressTitle')
                : updateIndicatorLabel
            }
            aria-label={
              updateIndicator === 'processing'
                ? t('appUpdate.progressTitle')
                : updateIndicatorLabel
            }
          />
        ) : null}
      </button>
    );
    if (!hasPluginChildren) return row;
    return (
      <Fragment key={page.id}>
        <div className="nav-plugin-parent">
          {row}
          <PluginNavToggle
            expanded={pluginNavExpanded}
            onToggle={() =>
              setPluginNavOverride({
                layout: pluginNavExpanded ? 'collapsed' : 'expanded',
                auto: autoPluginLayout,
                count: pluginEntries.length,
              })
            }
          />
        </div>
        {pluginNavExpanded ? (
          <PluginNavChildren
            entries={pluginEntries}
            active={active}
            locked={!coreReady}
            onSelect={(route) => select(route as AppPageId)}
          />
        ) : null}
      </Fragment>
    );
  };

  const homePageEntry = navPages.find((page) => page.id === 'home');
  const versionsPageEntry = navPages.find((page) => page.id === 'versions');
  const sidebarToggleLabel = t(sidebarRailCollapsed ? 'app.nav.sidebarExpand' : 'app.nav.sidebarCollapse');

  return (
    <>
      <div
        className={[
          'app-shell',
          active === 'easy' ? 'app-shell-easy-mode' : '',
          sidebarRailCollapsed ? 'app-shell-sidebar-collapsed' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {active !== 'easy' ? (
          <>
          <aside className="sidebar">
            <div className="sidebar-header">
              <div className="sidebar-brand" title="EasyCLIProxyAPI">
                <button
                  type="button"
                  className="brand-logo-button"
                  aria-label={logoLabel}
                  title={logoLabel}
                  onClick={() => setAppVersionDisplay(current => current === 'stable' ? 'preview' : 'stable')}
                >
                  <img src={appLogo} alt="" className="brand-mark brand-logo" />
                </button>
                <div className="sidebar-brand-text">
                  <strong>EasyCLIProxyAPI</strong>
                </div>
              </div>
            </div>

            {switcher}

            <nav
              ref={setNavElement}
              className="nav-section"
              aria-label={t('app.navigation')}
              data-plugin-layout={pluginEntries.length ? pluginNavLayout : undefined}
            >
              {homePageEntry ? renderNavPageRow(homePageEntry) : null}
              {SIDEBAR_NAV_GROUPS.map((group) => {
                const groupPages = group.pageIds
                  .map((id) => navPages.find((page) => page.id === id))
                  .filter((page): page is (typeof navPages)[number] => Boolean(page));
                if (groupPages.length === 0) return null;

                return (
                  <SidebarNavGroup key={group.id} group={group}>
                    {groupPages.map((page) => renderNavPageRow(page))}
                  </SidebarNavGroup>
                );
              })}
              {versionsPageEntry ? (
                <>
                  <div className="nav-section-divider" aria-hidden="true" />
                  {renderNavPageRow(versionsPageEntry)}
                </>
              ) : null}
            </nav>

            <div className="sidebar-bottom">
              <div className="sidebar-links">
                <button
                  type="button"
                  className="sidebar-link sidebar-easy-entry"
                  title={sidebarRailCollapsed ? undefined : t('app.nav.easy')}
                  onClick={() => {
                    hideRailTooltip();
                    select('easy');
                  }}
                  onMouseEnter={
                    sidebarRailCollapsed
                      ? (event) => showRailTooltip(event, 'footer-easy', t('app.nav.easy'))
                      : undefined
                  }
                  onMouseLeave={sidebarRailCollapsed ? hideRailTooltip : undefined}
                  onFocus={
                    sidebarRailCollapsed
                      ? (event) => showRailTooltip(event, 'footer-easy', t('app.nav.easy'))
                      : undefined
                  }
                  onBlur={sidebarRailCollapsed ? hideRailTooltip : undefined}
                >
                  <Sprout size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t('app.nav.easy')}</span>
                </button>
                <button
                  type="button"
                  className="sidebar-link sidebar-contact"
                  title={sidebarRailCollapsed ? undefined : t('app.contact.title')}
                  onClick={() => void openContact()}
                  onMouseEnter={
                    sidebarRailCollapsed
                      ? (event) => showRailTooltip(event, 'footer-contact', t('app.contact.label'))
                      : undefined
                  }
                  onMouseLeave={sidebarRailCollapsed ? hideRailTooltip : undefined}
                  onFocus={
                    sidebarRailCollapsed
                      ? (event) => showRailTooltip(event, 'footer-contact', t('app.contact.label'))
                      : undefined
                  }
                  onBlur={sidebarRailCollapsed ? hideRailTooltip : undefined}
                >
                  <MessageCircle size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t('app.contact.label')}</span>
                </button>
                <WebAccountControls />
              </div>

              <div className="sidebar-utility">
                <div ref={languageMenuRef} className="sidebar-language">
                  <button
                    ref={languageButtonRef}
                    type="button"
                    className="sidebar-language-trigger"
                    aria-label={t('app.language')}
                    title={t('app.language')}
                    aria-haspopup="listbox"
                    aria-expanded={languageMenuOpen}
                    aria-controls="sidebar-language-list"
                    onClick={() => { setThemeMenuOpen(false); setLanguageMenuOpen((open) => !open); }}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                      event.preventDefault();
                      setThemeMenuOpen(false);
                      setLanguageMenuOpen(true);
                      window.requestAnimationFrame(() => {
                        const options = languageMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
                        options?.[event.key === 'ArrowUp' ? options.length - 1 : 0]?.focus();
                      });
                    }}
                  >
                    <Languages size={15} strokeWidth={1.75} aria-hidden="true" />
                    <span lang={selectedLanguage.value}>{selectedLanguage.nativeLabel}</span>
                    <ChevronsUpDown size={12} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  {languageMenuOpen ? (
                    <div
                      id="sidebar-language-list"
                      className="sidebar-language-list"
                      data-theme-surface="overlay"
                      role="listbox"
                      aria-label={t('app.language')}
                      onKeyDown={handleLanguageListKeyDown}
                    >
                      {languageOptions.map((option) => {
                        const selected = option.value === locale;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className={selected ? 'selected' : ''}
                            role="option"
                            aria-selected={selected}
                            onClick={() => {
                              setLocale(option.value);
                              setLanguageMenuOpen(false);
                              window.requestAnimationFrame(() => languageButtonRef.current?.focus());
                            }}
                          >
                            <span lang={option.value}>{option.nativeLabel}</span>
                            {selected ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>

                <div className="sidebar-utility-actions">
                <button
                  type="button"
                  className={`sidebar-privacy-toggle${privacyMode ? ' active' : ''}`}
                  aria-pressed={privacyMode}
                  aria-label={t('app.privacy.label')}
                  title={t(privacyMode ? 'app.privacy.disable' : 'app.privacy.enable')}
                  onClick={() => setPrivacyMode(!privacyMode)}
                >
                  {privacyMode
                    ? <EyeOff size={14} strokeWidth={1.75} aria-hidden="true" />
                    : <Eye size={14} strokeWidth={1.75} aria-hidden="true" />}
                </button>
                <ThemeSelector value={theme} onChange={setTheme} open={themeMenuOpen}
                  onOpenChange={(open) => { setThemeMenuOpen(open); if (open) setLanguageMenuOpen(false); }} />
                </div>
              </div>
            </div>
          </aside>
          <button
            type="button"
            className="sidebar-rail-toggle sidebar-toggle-floating"
            aria-label={`${sidebarToggleLabel} (${sidebarShortcutLabel})`}
            aria-pressed={sidebarRailCollapsed}
            onClick={toggleSidebarRail}
            onMouseEnter={(event) => showRailTooltip(event, 'sidebar-toggle', sidebarToggleLabel, sidebarShortcutLabel)}
            onMouseLeave={hideRailTooltip}
            onFocus={(event) => showRailTooltip(event, 'sidebar-toggle', sidebarToggleLabel, sidebarShortcutLabel)}
            onBlur={hideRailTooltip}
          >
            {sidebarRailCollapsed
              ? <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
              : <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />}
          </button>
          {railTooltip ? (
            <div
              className="nav-tooltip"
              role="tooltip"
              style={{ top: railTooltip.top }}
            >
              <span className="nav-tooltip-label">{railTooltip.label}</span>
              {railTooltip.meta ? <span className="nav-tooltip-meta">{railTooltip.meta}</span> : null}
            </div>
          ) : null}
          </>
        ) : null}

        <div id="app-workspace" className="workspace" ref={workspaceRef} data-overlay-scrollbars>
          <main className="content" key={`${connection.remoteActive}:${connection.revision}`}>
            {active === 'config-management' && configManagementAvailable ? (
              <Suspense fallback={<p role="status">{t('common.loading')}</p>}>
                <ConfigManagementPage revision={connection.revision} remote={remote || connection.remoteSelected || connection.needsRepair} preview={browserMockEnabled}
                  reconnect={() => openConnection(connection.endpoint ?? '')} />
              </Suspense>
            ) : connection.needsRepair ? <p role="alert">{t('remote.error.profileInvalid')}</p> : !canOpenAppPage(active, coreReady) ? (
              <CoreLockedPage />
            ) : pluginEntry ? (
              <PluginResourcePage key={pluginEntry.route} entry={pluginEntry} reloadToken={pluginReload} />
            ) : ActivePage ? (
              active === 'easy' ? (
                <EasyModePage
                  onExit={() => select('home')}
                  theme={theme}
                  setTheme={setTheme}
                  locale={locale}
                  setLocale={setLocale}
                />
              ) : active === 'account-switching' ? (
                <AccountSwitchPage remoteCpaActive={remote} />
              ) : active === 'versions' ? (
                <VersionManagementPage displaySeries={appVersionDisplay} />
              ) : ActivePage === PluginsPage ? (
                <PluginsPage
                  discoveredPlugins={installedPluginList}
                  discoveredUpdates={pluginUpdates}
                  onPluginUpdatesResolved={forgetUpdatedPlugins}
                />
              ) : (
                <ActivePage />
              )
            ) : null}
          </main>
        </div>
      </div>

      <WorkspaceScrollbars viewportRef={workspaceRef} viewportId="app-workspace" />
      <AppUpdateDialog />
      <ServerPathPickerHost />
    </>
  );
}

function LocalWindowClose() {
  const { t } = useI18n();
  const [windowsClosePrompt, setWindowsClosePrompt] = useState<WindowsClosePrompt | null>(null);
  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;

    const handleWindowsCloseRequest = async () => {
      try {
        const settings = await getGuiSettings();
        if (settings.closeBehavior !== 'ask') {
          await resolveWindowsCloseRequest(settings.closeBehavior, false);
          return;
        }
      } catch (error) {
        console.error('Failed to read close behavior settings', error);
      }

      setWindowsClosePrompt((current) =>
        current ?? {
          resolvingAction: null,
          rememberChoice: false,
          error: null,
        },
      );
    };

    void onWindowsCloseRequested(() => {
      void handleWindowsCloseRequest();
    })
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          stopListening = stop;
        }
      })
      .catch((error) => {
        console.error('Failed to listen for Windows close confirmation events', error);
      });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  const resolveWindowsCloseRequest = async (
    action: WindowsCloseAction,
    remember = windowsClosePrompt?.rememberChoice ?? false,
  ) => {
    setWindowsClosePrompt((current) =>
      current
        ? {
            ...current,
            resolvingAction: action,
            error: null,
          }
        : current,
    );

    try {
      await resolveWindowsCloseRequestCommand({ action, remember });
      setWindowsClosePrompt(null);
    } catch (error) {
      setWindowsClosePrompt((current) =>
        current
          ? {
              ...current,
              resolvingAction: null,
              error: error instanceof Error ? error.message : String(error),
            }
          : {
              resolvingAction: null,
              rememberChoice: false,
              error: error instanceof Error ? error.message : String(error),
            },
      );
    }
  };

  return (
    <>
      {windowsClosePrompt ? (
        <Dialog
          alert
          className="close-dialog"
          backdropClassName="close-dialog-backdrop"
          tabIndex={-1}
          labelledBy="close-dialog-title"
          describedBy="close-dialog-description"
          onClose={() => setWindowsClosePrompt(null)}
          closeDisabled={Boolean(windowsClosePrompt.resolvingAction)}
        >
          <button
            type="button"
            className="icon-button quiet ghost small-button close-dialog-dismiss"
            aria-label={t('common.cancel')}
            title={t('common.cancel')}
            disabled={windowsClosePrompt.resolvingAction !== null}
            onClick={() => setWindowsClosePrompt(null)}
          >
            <X size={17} aria-hidden="true" />
          </button>
          <div className="close-dialog-heading">
            <h2 id="close-dialog-title">{t('app.close.title')}</h2>
          </div>
          <p id="close-dialog-description">
            {t('app.close.description')}
          </p>
          {windowsClosePrompt.error ? (
            <MessageNotice message={windowsClosePrompt.error} onDismiss={() => setWindowsClosePrompt(current => current ? { ...current, error: null } : current)} />
          ) : null}
          <label className="close-dialog-remember">
            <Switch checked={windowsClosePrompt.rememberChoice} disabled={windowsClosePrompt.resolvingAction !== null} onChange={(event) => {
                const rememberChoice = event.currentTarget.checked;
                setWindowsClosePrompt((current) =>
                  current ? { ...current, rememberChoice } : current,
                );
              }} />
            <span>{t('app.close.remember')}</span>
          </label>
          <div className="close-dialog-actions">
            <button
              type="button"
              className="close-choice-button primary-button"
              disabled={windowsClosePrompt.resolvingAction !== null}
              onClick={() => void resolveWindowsCloseRequest('minimize-to-tray')}
            >
              <span>
                {windowsClosePrompt.resolvingAction === 'minimize-to-tray'
                  ? t('app.close.minimizing')
                  : t('app.close.minimize')}
              </span>
            </button>
            <button
              type="button"
              className="close-choice-button danger-button"
              disabled={windowsClosePrompt.resolvingAction !== null}
              onClick={() => void resolveWindowsCloseRequest('exit')}
            >
              <span>
                {windowsClosePrompt.resolvingAction === 'exit'
                  ? t('app.close.exiting')
                  : t('app.close.exit')}
              </span>
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function CoreLockedPage() {
  const { t } = useI18n();
  return (
    <section className="page core-locked-page">
      <EmptyState variant="box" icon={<ServerCog size={26} />} title={t('app.coreRequired.title')}>
        {t('app.coreRequired.description')}
      </EmptyState>
    </section>
  );
}

export default App;
