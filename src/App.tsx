import { useState } from 'react';
import { ConfigPanelPage } from './pages/ConfigPanel';
import { KernelPage } from './pages/Kernel';

const pages = [
  { id: 'kernel', label: '内核管理', component: KernelPage },
  { id: 'config', label: '配置面板', component: ConfigPanelPage },
] as const;

type PageId = (typeof pages)[number]['id'];

function App() {
  const [active, setActive] = useState<PageId>('kernel');
  const activePage = pages.find((page) => page.id === active) ?? pages[0];
  const ActivePage = activePage.component;

  const select = (pageId: PageId) => {
    setActive(pageId);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand" title="CLI Proxy API GUI">
          <strong>Easy CLIProxyAPI</strong>
        </div>

        <nav className="nav-section">
          {pages.map((page) => (
            <button
              key={page.id}
              type="button"
              className={page.id === active ? 'active' : ''}
              onClick={() => select(page.id)}
            >
              {page.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="content">
        <ActivePage />
      </main>
    </div>
  );
}

export default App;
