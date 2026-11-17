import './scrollEdges.css';

/**
 * Marks a horizontally scrolling element with `data-scroll-start` / `data-scroll-end` while columns are hidden past that edge, so
 * scrollEdges.css can draw an edge shadow over it: a cue that more columns exist when the scrollbar is hidden (overlay scrollbars,
 * or tables that hide their own). Also sizes the shadow overlay to the visible area, so it stays clear of the scrollbars, and starts
 * the left shadow at the right edge of a frozen (sticky) first column.
 * Use as a React 19 callback ref: `ref={scrollEdges}`; it returns its own cleanup.
 */
export function scrollEdges(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return undefined;
  element.classList.add('scroll-edges');
  const update = () => {
    const style = getComputedStyle(element);
    const gutter = Math.max(0, element.offsetWidth - element.clientWidth - parseFloat(style.borderLeftWidth || '0') - parseFloat(style.borderRightWidth || '0'));
    // A reserved scrollbar gutter without a vertical scrollbar shows content and makes Chrome stop scrolling the gutter's width short
    // of the end: the overlay then covers the gutter too.
    const slack = element.scrollHeight > element.clientHeight ? 0 : gutter;
    const end = element.scrollWidth - element.clientWidth - element.scrollLeft - slack;
    element.toggleAttribute('data-scroll-start', element.scrollLeft > 1);
    element.toggleAttribute('data-scroll-end', end > 1);
    const box = element.getBoundingClientRect();
    const left = box.left + parseFloat(style.borderLeftWidth || '0');
    const top = box.top + parseFloat(style.borderTopWidth || '0');
    // The left shadow starts where a frozen (sticky) first column ends, as scrolled columns pass under that column.
    const frozen = [...element.querySelectorAll<HTMLElement>('thead th')].filter(cell => {
      const cellStyle = getComputedStyle(cell);
      return cellStyle.position === 'sticky' && cellStyle.left !== 'auto';
    });
    const inset = frozen.length ? Math.max(...frozen.map(cell => cell.getBoundingClientRect().right)) - left : 0;
    // The overlay covers the visible part of the table: never wider than the content (it must not widen the scrolled area) and
    // never taller, so a short table's shadow ends with its last row.
    const children = [...element.children].map(child => child.getBoundingClientRect());
    const contentRight = Math.max(0, ...children.map(rect => rect.right - left + element.scrollLeft));
    const contentBottom = Math.max(0, ...children.map(rect => rect.bottom - top + element.scrollTop));
    element.style.setProperty('--scroll-edge-width', `${Math.min(element.clientWidth + slack, contentRight)}px`);
    element.style.setProperty('--scroll-edge-height', `${Math.min(element.clientHeight, contentBottom)}px`);
    element.style.setProperty('--scroll-edge-start-inset', `${Math.max(0, inset)}px`);
  };
  update();
  element.addEventListener('scroll', update, { passive: true });
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
  observer?.observe(element);
  // Content width changes (columns shown, rows loaded) do not resize the scroller itself.
  if (observer) for (const child of element.children) observer.observe(child);
  return () => {
    element.removeEventListener('scroll', update);
    observer?.disconnect();
  };
}
