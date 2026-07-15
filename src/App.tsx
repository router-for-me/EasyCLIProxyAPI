import { useState } from 'react';
import { ConfigPanelPage } from './pages/ConfigPanel';
import { KernelPage } from './pages/Kernel';

const pages = [
  {
    id: 'kernel',
    label: '内核',
    component: KernelPage,
  },
  {
    id: 'config',
    label: '配置',
    component: ConfigPanelPage,
  },
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
          <span className="brand-mark">CP</span>
          <div>
            <strong>Easy CLIProxyAPI</strong>
            <span>Desktop Console</span>
          </div>
        </div>

        <nav className="nav-section" aria-label="主导航">
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

        <div className="sidebar-footer">
          <span>CPA GUI</span>
          <strong>0.1</strong>
        </div>
      </aside>

      <div className="workspace">
        <main className="content">
          <ActivePage />
        </main>
      </div>
    </div>
  );
}

export default App;
