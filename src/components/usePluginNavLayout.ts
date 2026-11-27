import { useLayoutEffect, useState } from 'react';
import { pluginNavLayout, type PluginNavLayout } from '../services/pluginNavigation';

const COMPACT_QUERY = '(max-width: 900px)';

const px = (value: string) => Number.parseFloat(value) || 0;

export function usePluginNavLayout(
  nav: HTMLElement | null,
  staticCount: number,
  pluginCount: number,
): { layout: PluginNavLayout; compact: boolean } {
  const [state, setState] = useState<{ layout: PluginNavLayout; compact: boolean }>({ layout: 'expanded', compact: false });

  useLayoutEffect(() => {
    const sidebar = nav?.closest<HTMLElement>('.sidebar');
    if (!nav || !sidebar || pluginCount === 0) {
      setState((current) => (current.layout === 'expanded' && !current.compact ? current : { layout: 'expanded', compact: false }));
      return undefined;
    }
    const brand = sidebar.querySelector<HTMLElement>('.sidebar-header, .sidebar-brand');
    const switcher = sidebar.querySelector<HTMLElement>('.cpa-target-switcher');
    const bottom = sidebar.querySelector<HTMLElement>('.sidebar-bottom');
    const media = window.matchMedia(COMPACT_QUERY);
    const measure = () => {
      const row = nav.querySelector<HTMLElement>(
        'button:not(.nav-plugin-entry, .nav-plugin-toggle, .nav-group-toggle, .nav-sub-entry)',
      );
      const groups = Array.from(nav.querySelectorAll<HTMLElement>('.nav-group'));
      const groupOverhead = groups.reduce((total, group) => {
        const header = group.querySelector<HTMLElement>('.nav-group-label, .nav-group-toggle');
        const groupStyle = getComputedStyle(group);
        const headerStyle = header ? getComputedStyle(header) : null;
        return total
          + (header ? header.offsetHeight : 0)
          + (headerStyle ? px(headerStyle.marginTop) + px(headerStyle.marginBottom) : 0)
          + px(groupStyle.marginTop)
          + px(groupStyle.paddingTop)
          + px(groupStyle.marginBottom);
      }, 0);
      const dividers = Array.from(nav.querySelectorAll<HTMLElement>('.nav-section-divider'));
      const dividerOverhead = dividers.reduce((total, divider) => {
        const dividerStyle = getComputedStyle(divider);
        return total + divider.offsetHeight + px(dividerStyle.marginTop) + px(dividerStyle.marginBottom);
      }, 0);
      const sidebarStyle = getComputedStyle(sidebar);
      const navStyle = getComputedStyle(nav);
      const switcherHeight = switcher
        ? switcher.offsetHeight + px(getComputedStyle(switcher).marginBottom)
        : 0;
      const available = sidebar.clientHeight
        - px(sidebarStyle.paddingTop) - px(sidebarStyle.paddingBottom)
        - (brand ? brand.offsetHeight + px(getComputedStyle(brand).marginBottom) : 0)
        - switcherHeight
        - (bottom?.offsetHeight ?? 0)
        - groupOverhead
        - dividerOverhead
        - 8;
      const layout = pluginNavLayout({
        available,
        rowHeight: row?.offsetHeight ?? 0,
        gap: px(navStyle.rowGap),
        padding: px(navStyle.paddingTop) + px(navStyle.paddingBottom),
        staticCount,
        pluginCount,
        compact: media.matches,
      });
      setState((current) => (
        current.layout === layout && current.compact === media.matches
          ? current
          : { layout, compact: media.matches }
      ));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sidebar);
    if (brand) observer.observe(brand);
    if (bottom) observer.observe(bottom);
    window.addEventListener('resize', measure);
    media.addEventListener('change', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      media.removeEventListener('change', measure);
    };
  }, [nav, staticCount, pluginCount]);

  return state;
}
