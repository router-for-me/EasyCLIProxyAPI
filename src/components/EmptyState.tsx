import type { ReactNode } from 'react';

export type EmptyStateProps = {
  variant?: 'page' | 'box' | 'compact';
  tone?: 'error';
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'status' | 'alert';
  className?: string;
};

export function EmptyState({ variant = 'page', tone, icon, title, children, action, role, className }: EmptyStateProps) {
  const classes = ['empty-state', 'empty-state-' + variant, tone === 'error' ? 'empty-state-error' : '', className].filter(Boolean).join(' ');
  return <div className={classes} role={role}>
    {icon ? <span className="empty-state-icon" aria-hidden="true">{icon}</span> : null}
    {title ? <strong className="empty-state-title">{title}</strong> : null}
    {children != null && children !== false ? <span className="empty-state-description">{children}</span> : null}
    {action}
  </div>;
}
