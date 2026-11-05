import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Grid3x3, LayoutDashboard, Rows3 } from 'lucide-react';
import { SegmentedControl } from './SegmentedControl';
import { useI18n } from '../i18n';
import { stackQuotaColumns } from '../services/quotaLayout';
import './CardLayout.css';

/**
 * Card layouts for pages that list cards of uneven height.
 * Even rows (the default) stretches cards to the row's tallest;
 * Stacked packs cards into columns with no row gaps; Compact packs narrower glance cards that expand for detail.
 */
export type CardLayout = 'even' | 'stacked' | 'compact';
export const cardLayouts: readonly CardLayout[] = ['even', 'stacked', 'compact'];
export type StackedColumns = Readonly<Record<'stacked' | 'compact', Readonly<{ minWidth: number; gap: number }>>>;

const icons: Record<CardLayout, ReactNode> = {
  even: <Rows3 size={16} aria-hidden="true" />,
  stacked: <LayoutDashboard size={16} aria-hidden="true" />,
  compact: <Grid3x3 size={16} aria-hidden="true" />,
};

/** The page's chosen layout, kept in localStorage under `storageKey` like other page preferences; `fallback` (Even rows unless given) when unset, unknown or unreadable. */
export function useCardLayout(storageKey: string, fallback: CardLayout = 'even'): [CardLayout, (layout: CardLayout) => void] {
  const [layout, setLayoutState] = useState<CardLayout>(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return cardLayouts.find((candidate) => candidate === stored) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const setLayout = useCallback((next: CardLayout) => {
    setLayoutState(next);
    try { window.localStorage.setItem(storageKey, next); } catch { /* Layout is a display preference. */ }
  }, [storageKey]);
  return [layout, setLayout];
}

/**
 * Keeps each card's height estimate from its last settled state while it reloads, so a refresh (which empties a card's
 * data while loading) does not move cards between Stacked or Compact columns and remount them.
 */
export function useSettledHeights(): (key: string, height: number, pending: boolean) => number {
  const settled = useRef(new Map<string, number>());
  return useCallback((key: string, height: number, pending: boolean) => {
    if (!pending) {
      settled.current.set(key, height);
      return height;
    }
    return settled.current.get(key) ?? height;
  }, []);
}

/** Keys of the cards a person expanded in Compact; not stored. */
export function useExpandedCards(): [ReadonlySet<string>, (key: string) => void] {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  return [expanded, toggle];
}

export function CardLayoutSwitch({ value, onChange, className = '' }: { value: CardLayout; onChange: (layout: CardLayout) => void; className?: string }) {
  const { t } = useI18n();
  return <SegmentedControl className={`routing-segmented card-layout-control ${className}`.trim()} aria-label={t('cardLayout.label')} value={value} onChange={onChange}
    items={cardLayouts.map((layout) => ({ value: layout, title: t(`cardLayout.${layout}`), 'aria-label': t(`cardLayout.${layout}`), label: icons[layout] }))} />;
}

/**
 * The card container for a layout. Even rows renders one element with `data-layout`, styled by the page's own grid rule;
 * Stacked and Compact render columns whose count follows the container width (`columns` gives each layout's minimum card width
 * and gap), placing each card in the column with the least estimated height (`heights`, one per child).
 */
export function CardLayoutGrid({ layout, className, columns, heights, children, ...list }: {
  layout: CardLayout;
  className: string;
  columns: StackedColumns;
  heights: readonly number[];
  children: readonly ReactNode[];
  role?: 'list';
  'aria-label'?: string;
}) {
  if (layout === 'stacked' || layout === 'compact') {
    return <StackedGrid layout={layout} className={className} columns={columns[layout]} heights={heights} list={list}>{children}</StackedGrid>;
  }
  return <div className={`${className} card-layout-grid`} data-layout={layout} {...list}>{children}</div>;
}

function StackedGrid({ layout, className, columns: { minWidth, gap }, heights, children, list }: {
  list: Readonly<{ role?: 'list'; 'aria-label'?: string }>;
  layout: 'stacked' | 'compact';
  className: string;
  columns: Readonly<{ minWidth: number; gap: number }>;
  heights: readonly number[];
  children: readonly ReactNode[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(1);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    // The exact (fractional) width: clientWidth rounds, which can admit a column narrower than minWidth.
    const measure = () => setColumnCount(Math.max(1, Math.floor((element.getBoundingClientRect().width + gap) / (minWidth + gap))));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [minWidth, gap]);
  return <div ref={container} className={`${className} card-layout-grid`} data-layout={layout} style={{ '--card-layout-gap': `${gap}px` } as React.CSSProperties} {...list}>
    {/* Columns are layout only: role none keeps list items direct children of the list for assistive tech. */}
    {stackQuotaColumns(heights, columnCount).map((items, column) => <div className="card-layout-column" role="none" key={column}>{items.map((index) => children[index])}</div>)}
  </div>;
}
