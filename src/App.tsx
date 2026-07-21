import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Bot,
  ExternalLink,
  FileKey,
  Gauge,
  GitFork,
  History,
  LogIn,
  MessageCircle,
  Network,
  ServerCog,
  Settings,
} from 'lucide-react';
import appLogo from './assets/logo.jpg';
import { CoreRuntimeProvider, useCoreRuntime } from './coreRuntime';
import { ConfigPanelPage } from './pages/ConfigPanel';
import { ApiAccessPage } from './pages/ApiAccessPage';
import { AuthFileManagementPage } from './pages/AuthFileManagementPage';
import { KernelPage } from './pages/Kernel';
import { OAuthLoginPage } from './pages/ManagementPages';
import { QuotaPage } from './pages/QuotaPage';
import { AgentsPage } from './pages/AgentsPage';
import { ThinkingAliasesPage } from './pages/ThinkingAliasesPage';
import { UsageRecordsPage } from './pages/UsageRecordsPage';

const CONTACT_URL = 'https://qm.qq.com/q/3queDaIG';

const pages = [
  {
    id: 'kernel',
    label: '内核',
    icon: ServerCog,
    component: KernelPage,
  },
  {
    id: 'config',
    label: '配置',
    icon: Settings,
    component: ConfigPanelPage,
  },
  {
    id: 'thinking-aliases',
    label: '模型别名',
    icon: GitFork,
    component: ThinkingAliasesPage,
  },
  {
    id: 'oauth',
    label: 'OAuth',
    icon: LogIn,
    component: OAuthLoginPage,
  },
  {
    id: 'api',
    label: 'API 接入',
    icon: Network,
    component: ApiAccessPage,
  },
  {
    id: 'auth-files',
    label: '认证文件',
    icon: FileKey,
    component: AuthFileManagementPage,
  },
  {
    id: 'quota',
    label: '配额',
    icon: Gauge,
    component: QuotaPage,
  },
  {
    id: 'usage-records',
    label: '使用记录',
    icon: History,
    component: UsageRecordsPage,
  },
  {
    id: 'agents',
    label: '智能体',
    icon: Bot,
    component: AgentsPage,
  },
] as const;

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
  const [active, setActive] = useState<PageId>('kernel');
  const [windowsClosePrompt, setWindowsClosePrompt] = useState<WindowsClosePrompt | null>(null);
  const closeDialogRef = useRef<HTMLElement>(null);
  const { status } = useCoreRuntime();
  const coreRunning = Boolean(status?.running);
  const activePage = pages.find((page) => page.id === active) ?? pages[0];
  const ActivePage = activePage.component;

  useEffect(() => {
    if (!coreRunning && active !== 'kernel') {
      setActive('kernel');
    }
  }, [active, coreRunning]);

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
              <span>Desktop Console</span>
            </div>
          </div>

          <nav className="nav-section" aria-label="主导航">
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
                  title={locked ? '请先启动内核' : undefined}
                  onClick={() => select(page.id)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>{page.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="sidebar-bottom">
            <button
              type="button"
              className="sidebar-contact"
              title="通过 QQ 联系我们"
              onClick={() => void openContact()}
            >
              <MessageCircle size={16} aria-hidden="true" />
              <span>联系我们</span>
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
              <span>关闭窗口</span>
              <h2 id="close-dialog-title">请选择后续操作</h2>
            </div>
            <p id="close-dialog-description">
              你可以退出程序，或让 EasyCLIProxyAPI 继续在系统托盘中运行。
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
                    ? '正在最小化...'
                    : '最小化到托盘'}
                </span>
              </button>
              <button
                type="button"
                className="close-choice-button danger-button"
                disabled={windowsClosePrompt.resolvingAction !== null}
                onClick={() => void resolveWindowsCloseRequest('exit')}
              >
                <span>
                  {windowsClosePrompt.resolvingAction === 'exit' ? '正在退出...' : '退出程序'}
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
  return (
    <section className="page core-locked-page">
      <div className="empty-state core-locked-panel">
        <ServerCog size={26} aria-hidden="true" />
        <strong>请先启动内核</strong>
        <span>启动 CPA 内核后，才能使用配置、OAuth、API 接入等功能。</span>
      </div>
    </section>
  );
}

export default App;
