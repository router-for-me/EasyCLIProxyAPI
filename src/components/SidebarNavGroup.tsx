import type { ReactNode } from 'react';
import { ChevronRight, Code2, Terminal } from 'lucide-react';
import { useI18n } from '../i18n';
import type { AccountSwitchCategoryFilter } from '../navigation';
import {
  ACCOUNT_SWITCH_SUBPAGES,
  type SidebarGroupDefinition,
} from './SidebarNavConfig';

export const ACCOUNT_SWITCH_CHILDREN_ID = 'nav-account-switch-children';

type SidebarNavGroupProps = {
  group: SidebarGroupDefinition;
  showDivider?: boolean;
  children: ReactNode;
};

export function SidebarNavGroup({
  group,
  showDivider = true,
  children,
}: SidebarNavGroupProps) {
  const { t } = useI18n();
  const groupLabel = t(group.labelKey);

  return (
    <div
      className={`nav-group nav-group-${group.tone}`}
      data-nav-group={group.id}
    >
      <div className="nav-group-label">{groupLabel}</div>
      {showDivider ? <div className="nav-group-divider" aria-hidden="true" /> : null}
      <div className="nav-group-items">{children}</div>
    </div>
  );
}

export function AccountSwitchSubToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="nav-plugin-toggle nav-sub-toggle"
      aria-expanded={expanded}
      aria-controls={ACCOUNT_SWITCH_CHILDREN_ID}
      aria-label={t('app.nav.accountSwitching.subpages')}
      onClick={onToggle}
    >
      <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

export function AccountSwitchNavChildren({
  expanded,
  activePage,
  activeCategory,
  onSelectCategory,
}: {
  expanded: boolean;
  activePage: boolean;
  activeCategory: AccountSwitchCategoryFilter;
  onSelectCategory: (category: Exclude<AccountSwitchCategoryFilter, 'all'>) => void;
}) {
  const { t } = useI18n();
  if (!expanded) return null;
  return (
    <div
      id={ACCOUNT_SWITCH_CHILDREN_ID}
      className="nav-sub-children"
      role="group"
      aria-label={t('app.nav.accountSwitching.subpages')}
    >
      {ACCOUNT_SWITCH_SUBPAGES.map((item) => {
        const isCurrent = activePage && activeCategory === item.category;
        const Icon = item.category === 'official-cli' ? Terminal : Code2;
        const label = t(item.labelKey);
        return (
          <button
            key={item.category}
            type="button"
            className={['nav-sub-entry', isCurrent ? 'sub-active' : ''].filter(Boolean).join(' ')}
            data-as-category={item.category}
            title={label}
            onClick={() => onSelectCategory(item.category)}
          >
            <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
