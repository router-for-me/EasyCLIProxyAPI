import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Bot,
  Check,
  ChevronUp,
  ExternalLink,
  History,
  House,
  Languages,
  LogIn,
  MessageCircle,
  Network,
  PackageOpen,
  ServerCog,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import appLogo from './assets/logo.jpg';
import { CoreRuntimeProvider, useCoreRuntime } from './coreRuntime';
import { CoreUpdateProvider, useCoreUpdate } from './coreUpdate';
import { ConfigPanelPage } from './pages/ConfigPanel';
import { ApiAccessPage } from './pages/ApiAccessPage';
import { KernelPage } from './pages/Kernel';
import { VersionManagementPage } from './pages/VersionManagementPage';
import { OAuthManagementPage, type OAuthSubpageRequest } from './pages/ManagementPages';
import { LAUNCH_PAGE_EVENT, parseLaunchTarget, type LaunchTarget } from './launchNavigation';
import { AgentsPage } from './pages/AgentsPage';
import { EasyModePage } from './pages/EasyModePage';
import { UsageRecordsPage } from './pages/UsageRecordsPage';
import { languageOptions, useI18n } from './i18n';
import { AppUpdateDialog, AppUpdateProvider, useAppUpdate } from './appUpdate';
import { appUpdateIndicatorState } from './appUpdateModel';
import { canOpenAppPage, isAlwaysAvailablePage } from './navigation';
import { detectInitialTheme, saveTheme, type AppTheme } from './theme';

const CONTACT_URL = 'https://qm.qq.com/q/3queDaIG';

const pages = [
  {
    id: 'easy',
    labelKey: 'app.nav.easy',
    icon: Sparkles,
    component: HomePage,
  },
  {
    id: 'home',
    labelKey: 'app.nav.home',
    icon: House,
    component: HomePage,
  },
  {
    id: 'versions',
    labelKey: 'app.nav.versions',
    icon: PackageOpen,
    component: VersionManagementPageWrapper,
  },
  {
    id: 'config',
    labelKey: 'app.nav.config',
    icon: Settings,
    component: ConfigPanelPage,
  },
  {
    id: 'oauth',
    labelKey: 'app.nav.oauth',
    icon: LogIn,
    component: OAuthManagementPage,
  },
  {
    id: 'api',
    labelKey: 'app.nav.api',
    icon: Network,
    component: ApiAccessPage,
  },
  {
    id: 'usage-records',
    labelKey: 'app.nav.usageRecords',
    icon: History,
    component: UsageRecordsPage,
  },
  {
    id: 'agents',
    labelKey: 'app.nav.agents',
    icon: Bot,
    component: AgentsPage,
  },
] as const;

type PageId = (typeof pages)[number]['id'];
const pageIds = pages.map((page) => page.id);
type WindowsCloseAction = 'exit' | 'minimize-to-tray';
type WindowsCloseBehavior = 'ask' | WindowsCloseAction;

type WindowsClosePrompt = {
  resolvingAction: WindowsCloseAction | null;
  rememberChoice: boolean;
  error: string | null;
};

type GuiSettings = {
  closeBehavior: WindowsCloseBehavior;
};

function HomePage() {
  return <KernelPage view="home" />;
}

function VersionManagementPageWrapper() {
  return <VersionManagementPage />;
}

function App() {
  return (
    <AppUpdateProvider>
      <CoreRuntimeProvider>
        <CoreUpdateProvider>
          <AppContent />
        </CoreUpdateProvider>
      </CoreRuntimeProvider>
    </AppUpdateProvider>
  );
}

function AppContent() {
  const { locale, setLocale, t } = useI18n();
  const { info: appUpdateInfo, hasUpdate, processing: appUpdateProcessing } = useAppUpdate();
  const { latest: coreLatest, hasUpdate: coreHasUpdate } = useCoreUpdate();
  const [active, setActive] = useState<PageId>('home');
  const [requestedOAuthSubpage, setRequestedOAuthSubpage] = useState<OAuthSubpageRequest | null>(null);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(detectInitialTheme);
  const [windowsClosePrompt, setWindowsClosePrompt] = useState<WindowsClosePrompt | null>(null);
  const closeDialogRef = useRef<HTMLElement>(null);
  const languageMenuRef = useRef<HTMLDivElement>(null);
  const languageButtonRef = useRef<HTMLButtonElement>(null);
  const { status } = useCoreRuntime();
  const coreRunning = Boolean(status?.running);
  const activePage = pages.find((page) => page.id === active) ?? pages[0];
  const ActivePage = activePage.component;
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
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!canOpenAppPage(active, coreRunning)) {
      setActive('home');
    }
  }, [active, coreRunning]);

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

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;

    const handleWindowsCloseRequest = async () => {
      try {
        const settings = await invoke<GuiSettings>('get_gui_settings');
        if (settings.closeBehavior !== 'ask') {
          await resolveWindowsCloseRequest(settings.closeBehavior, false);
          return;
        }
      } catch (error) {
        console.error('读取关闭行为设置失败', error);
      }

      setWindowsClosePrompt((current) =>
        current ?? {
          resolvingAction: null,
          rememberChoice: false,
          error: null,
        },
      );
    };

    void listen('windows-close-requested', () => {
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
        console.error('监听 Windows 关闭确认事件失败', error);
      });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    if (!windowsClosePrompt || windowsClosePrompt.resolvingAction) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      closeDialogRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [windowsClosePrompt]);

  // A launch target (from `--page`) waits until its page is allowed, since pages other than
  // Home unlock only once the core is running; otherwise the reset-to-home effect would win.
  const [pendingLaunchTarget, setPendingLaunchTarget] = useState<LaunchTarget<PageId> | null>(null);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | null = null;
    const requestLaunchTarget = (value: unknown) => {
      const target = parseLaunchTarget(typeof value === 'string' ? value : null, pageIds);
      if (target) setPendingLaunchTarget(target);
    };
    void invoke<string | null>('take_launch_page')
      .then((value) => {
        if (!disposed) requestLaunchTarget(value);
      })
      .catch((error) => {
        console.error('读取启动页面参数失败', error);
      });
    void listen<string>(LAUNCH_PAGE_EVENT, (event) => requestLaunchTarget(event.payload))
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          stopListening = stop;
        }
      })
      .catch((error) => {
        console.error('监听页面导航事件失败', error);
      });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    if (!pendingLaunchTarget || !canOpenAppPage(pendingLaunchTarget.page, coreRunning)) return;
    setActive(pendingLaunchTarget.page);
    if (pendingLaunchTarget.oauthSubpage) {
      setRequestedOAuthSubpage({ subpage: pendingLaunchTarget.oauthSubpage, nonce: Date.now() });
    }
    setPendingLaunchTarget(null);
  }, [pendingLaunchTarget, coreRunning]);

  const select = (pageId: PageId) => {
    if (!canOpenAppPage(pageId, coreRunning)) {
      return;
    }
    setActive(pageId);
  };

  const openContact = async () => {
    try {
      await invoke('open_external_url', { url: CONTACT_URL });
    } catch (error) {
      console.error('打开联系我们链接失败', error);
    }
  };

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
      await invoke('resolve_windows_close_request', { action, remember });
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
      <div className={`app-shell${active === "easy" ? " app-shell-easy-mode" : ""}`}>
        {active !== "easy" ? (
          <aside className="sidebar">
          <div className="sidebar-brand" title="CLI Proxy API GUI">
            <img src={appLogo} alt="" className="brand-mark brand-logo" />
            <div>
              <strong>EasyCLIProxyAPI</strong>
              <span>{t('app.desktopConsole')}</span>
            </div>
          </div>

          <nav className="nav-section" aria-label={t('app.navigation')}>
            {pages.filter((page) => page.id !== 'easy').map((page) => {
              const Icon = page.icon;
              const locked = !canOpenAppPage(page.id, coreRunning);
              const updateIndicator = page.id === 'versions'
                ? appUpdateIndicatorState(hasUpdate, coreHasUpdate, appUpdateProcessing)
                : null;
              return (
                <button
                  key={page.id}
                  type="button"
                  className={[
                    page.id === active ? 'active' : '',
                    locked ? 'locked' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={locked}
                  title={locked ? t('app.coreRequired.title') : undefined}
                  onClick={() => select(page.id)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>{t(page.labelKey)}</span>
                  {updateIndicator ? (
                    <i
                      className={`nav-update-indicator ${updateIndicator}`}
                      title={updateIndicator === 'processing'
                        ? t('appUpdate.progressTitle')
                        : availableUpdateLabel}
                      aria-label={updateIndicator === 'processing'
                        ? t('appUpdate.progressTitle')
                        : availableUpdateLabel}
                    />
                  ) : null}
                </button>
              );
            })}
          </nav>

          <div className="sidebar-bottom">
            <button
              type="button"
              className="sidebar-easy-entry"
              onClick={() => select('easy')}
            >
              <span>{t('app.nav.easy')}</span>
            </button>
            <div
              className="sidebar-theme-selector"
              role="group"
              aria-label={`${t('app.theme.light')} / ${t('app.theme.dark')}`}
            >
              <button
                type="button"
                className={theme === 'light' ? 'active' : ''}
                aria-pressed={theme === 'light'}
                title={t('app.theme.switchToLight')}
                onClick={() => setTheme('light')}
              >
                {t('app.theme.light')}
              </button>
              <button
                type="button"
                className={theme === 'dark' ? 'active' : ''}
                aria-pressed={theme === 'dark'}
                title={t('app.theme.switchToDark')}
                onClick={() => setTheme('dark')}
              >
                {t('app.theme.dark')}
              </button>
            </div>
            <div ref={languageMenuRef} className="sidebar-language">
              <button
                ref={languageButtonRef}
                type="button"
                className="sidebar-language-trigger"
                aria-label={t('app.language')}
                aria-haspopup="listbox"
                aria-expanded={languageMenuOpen}
                aria-controls="sidebar-language-list"
                onClick={() => setLanguageMenuOpen((open) => !open)}
              >
                <Languages size={16} aria-hidden="true" />
                <span lang={selectedLanguage.value}>{selectedLanguage.nativeLabel}</span>
                <ChevronUp
                  size={14}
                  aria-hidden="true"
                  className={languageMenuOpen ? 'expanded' : ''}
                />
              </button>
              {languageMenuOpen ? (
                <div
                  id="sidebar-language-list"
                  className="sidebar-language-list"
                  role="listbox"
                  aria-label={t('app.language')}
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
                        }}
                      >
                        <span lang={option.value}>{option.nativeLabel}</span>
                        {selected ? <Check size={14} aria-hidden="true" /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="sidebar-contact"
              title={t('app.contact.title')}
              onClick={() => void openContact()}
            >
              <MessageCircle size={16} aria-hidden="true" />
              <span>{t('app.contact.label')}</span>
              <ExternalLink size={13} aria-hidden="true" />
            </button>
          </div>
          </aside>
        ) : null}

        <div className="workspace">
          <main className="content">
            {isAlwaysAvailablePage(activePage.id) || coreRunning ? (
              activePage.id === 'easy' ? (
                <EasyModePage
                  onExit={() => select('home')}
                  theme={theme}
                  setTheme={setTheme}
                  locale={locale}
                  setLocale={setLocale}
                />
              ) : activePage.id === 'oauth' ? (
                <OAuthManagementPage requestedSubpage={requestedOAuthSubpage} />
              ) : (
                <ActivePage />
              )
            ) : (
              <CoreLockedPage />
            )}
          </main>
        </div>
      </div>

      {windowsClosePrompt ? (
        <div className="close-dialog-backdrop">
          <section
            ref={closeDialogRef}
            className="close-dialog"
            role="alertdialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="close-dialog-title"
            aria-describedby="close-dialog-description"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
              }
            }}
          >
            <button
              type="button"
              className="close-dialog-dismiss"
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
              <div className="close-dialog-error" role="alert">
                {windowsClosePrompt.error}
              </div>
            ) : null}
            <label className="close-dialog-remember">
              <input
                type="checkbox"
                checked={windowsClosePrompt.rememberChoice}
                disabled={windowsClosePrompt.resolvingAction !== null}
                onChange={(event) => {
                  const rememberChoice = event.currentTarget.checked;
                  setWindowsClosePrompt((current) =>
                    current ? { ...current, rememberChoice } : current,
                  );
                }}
              />
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
          </section>
        </div>
      ) : null}

      <AppUpdateDialog />
    </>
  );
}

function CoreLockedPage() {
  const { t } = useI18n();
  return (
    <section className="page core-locked-page">
      <div className="empty-state core-locked-panel">
        <ServerCog size={26} aria-hidden="true" />
        <strong>{t('app.coreRequired.title')}</strong>
        <span>{t('app.coreRequired.description')}</span>
      </div>
    </section>
  );
}

export default App;
