import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Bot,
  Check,
  ChevronUp,
  ExternalLink,
  FileKey,
  Gauge,
  GitFork,
  History,
  Languages,
  LogIn,
  MessageCircle,
  Monitor,
  Moon,
  Network,
  ServerCog,
  Settings,
  Sun,
} from 'lucide-react';
import appLogo from './assets/logo.jpg';
import { CoreRuntimeProvider, useCoreRuntime } from './coreRuntime';
import { useTheme, type ThemeMode } from './theme';
import { ConfigPanelPage } from './pages/ConfigPanel';
import { ApiAccessPage } from './pages/ApiAccessPage';
import { AuthFileManagementPage } from './pages/AuthFileManagementPage';
import { KernelPage } from './pages/Kernel';
import { OAuthLoginPage } from './pages/ManagementPages';
import { QuotaPage } from './pages/QuotaPage';
import { AgentsPage } from './pages/AgentsPage';
import { ThinkingAliasesPage } from './pages/ThinkingAliasesPage';
import { UsageRecordsPage } from './pages/UsageRecordsPage';
import { languageOptions, useI18n } from './i18n';

const CONTACT_URL = 'https://qm.qq.com/q/3queDaIG';

const pages = [
  {
    id: 'kernel',
    labelKey: 'app.nav.kernel',
    icon: ServerCog,
    component: KernelPage,
  },
  {
    id: 'config',
    labelKey: 'app.nav.config',
    icon: Settings,
    component: ConfigPanelPage,
  },
  {
    id: 'thinking-aliases',
    labelKey: 'app.nav.thinkingAliases',
    icon: GitFork,
    component: ThinkingAliasesPage,
  },
  {
    id: 'oauth',
    labelKey: 'app.nav.oauth',
    icon: LogIn,
    component: OAuthLoginPage,
  },
  {
    id: 'api',
    labelKey: 'app.nav.api',
    icon: Network,
    component: ApiAccessPage,
  },
  {
    id: 'auth-files',
    labelKey: 'app.nav.authFiles',
    icon: FileKey,
    component: AuthFileManagementPage,
  },
  {
    id: 'quota',
    labelKey: 'app.nav.quota',
    icon: Gauge,
    component: QuotaPage,
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

const themeOptions: ReadonlyArray<{
  value: ThemeMode;
  labelKey: 'app.theme.system' | 'app.theme.light' | 'app.theme.dark';
  icon: typeof Monitor;
}> = [
  { value: 'system', labelKey: 'app.theme.system', icon: Monitor },
  { value: 'light', labelKey: 'app.theme.light', icon: Sun },
  { value: 'dark', labelKey: 'app.theme.dark', icon: Moon },
];

type PageId = (typeof pages)[number]['id'];
type WindowsCloseAction = 'exit' | 'minimize-to-tray';

type WindowsClosePrompt = {
  resolvingAction: WindowsCloseAction | null;
  error: string | null;
};

function App() {
  return (
    <CoreRuntimeProvider>
      <AppContent />
    </CoreRuntimeProvider>
  );
}

function AppContent() {
  const { locale, setLocale, t } = useI18n();
  const { mode, setMode } = useTheme();
  const [active, setActive] = useState<PageId>('kernel');
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
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

  useEffect(() => {
    if (!coreRunning && active !== 'kernel') {
      setActive('kernel');
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

    void listen('windows-close-requested', () => {
      setWindowsClosePrompt((current) =>
        current ?? {
          resolvingAction: null,
          error: null,
        },
      );
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

  const select = (pageId: PageId) => {
    if (pageId !== 'kernel' && !coreRunning) {
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

  const resolveWindowsCloseRequest = async (action: WindowsCloseAction) => {
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
      await invoke('resolve_windows_close_request', { action });
      setWindowsClosePrompt(null);
    } catch (error) {
      setWindowsClosePrompt((current) =>
        current
          ? {
              ...current,
              resolvingAction: null,
              error: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  };

  return (
    <>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-brand" title="CLI Proxy API GUI">
            <img src={appLogo} alt="" className="brand-mark brand-logo" />
            <div>
              <strong>EasyCLIProxyAPI</strong>
              <span>{t('app.desktopConsole')}</span>
            </div>
          </div>

          <nav className="nav-section" aria-label={t('app.navigation')}>
            {pages.map((page) => {
              const Icon = page.icon;
              const locked = page.id !== 'kernel' && !coreRunning;
              return (
                <button
                  key={page.id}
                  type="button"
                  className={[page.id === active ? 'active' : '', locked ? 'locked' : '']
                    .filter(Boolean)
                    .join(' ')}
                  disabled={locked}
                  title={locked ? t('app.coreRequired.title') : undefined}
                  onClick={() => select(page.id)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>{t(page.labelKey)}</span>
                </button>
              );
            })}
          </nav>

          <div className="sidebar-bottom">
            <div className="sidebar-theme" aria-label={t('app.theme')}>
              <span className="sidebar-theme-label">{t('app.theme')}</span>
              <div className="sidebar-theme-options" role="group" aria-label={t('app.theme')}>
                {themeOptions.map((option) => {
                  const Icon = option.icon;
                  const selected = option.value === mode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={selected ? 'selected' : ''}
                      aria-pressed={selected}
                      aria-label={t(option.labelKey)}
                      title={t(option.labelKey)}
                      onClick={() => setMode(option.value)}
                    >
                      <Icon size={14} aria-hidden="true" />
                      <span>{t(option.labelKey)}</span>
                    </button>
                  );
                })}
              </div>
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

        <div className="workspace">
          <main className="content">
            {activePage.id === 'kernel' || coreRunning ? (
              <ActivePage />
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
            <div className="close-dialog-heading">
              <span>{t('app.close.eyebrow')}</span>
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
