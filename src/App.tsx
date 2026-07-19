import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
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

function App() {
  return (
    <CoreRuntimeProvider>
      <AppContent />
    </CoreRuntimeProvider>
  );
}

function AppContent() {
  const [active, setActive] = useState<PageId>('kernel');
  const { status } = useCoreRuntime();
  const coreRunning = Boolean(status?.running);
  const activePage = pages.find((page) => page.id === active) ?? pages[0];
  const ActivePage = activePage.component;

  useEffect(() => {
    if (!coreRunning && active !== 'kernel') {
      setActive('kernel');
    }
  }, [active, coreRunning]);

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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand" title="CLI Proxy API GUI">
          <img src={appLogo} alt="" className="brand-mark brand-logo" />
          <div>
            <strong>Easy CLIProxyAPI</strong>
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
