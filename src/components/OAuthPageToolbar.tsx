import type { ReactNode } from 'react';
import './OAuthPageToolbar.css';

type OAuthPageToolbarProps = {
  icon: ReactNode;
  summary: ReactNode;
  children: ReactNode;
};

export function OAuthPageToolbar({ icon, summary, children }: OAuthPageToolbarProps) {
  return (
    <header className="oauth-page-toolbar">
      <div className="oauth-page-toolbar-summary">
        <span className="oauth-page-toolbar-icon" aria-hidden="true">{icon}</span>
        <span>{summary}</span>
      </div>
      <div className="oauth-page-toolbar-actions">{children}</div>
    </header>
  );
}
