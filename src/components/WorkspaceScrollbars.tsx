import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { useOverlayOpen } from './useOverlayOpen';
import './WorkspaceScrollbars.css';

type Axis = 'vertical' | 'horizontal';

type ScrollMetrics = {
  top: number;
  left: number;
  width: number;
  height: number;
  scrollTop: number;
  scrollLeft: number;
  maxTop: number;
  maxLeft: number;
};

const edgeSize = 12;
const minThumbSize = 24;
const lineStep = 40;
const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

function readMetrics(viewport: HTMLElement): ScrollMetrics {
  const bounds = viewport.getBoundingClientRect();
  const style = getComputedStyle(viewport);
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const maxTop = /^(auto|scroll)$/.test(style.overflowY) ? Math.max(0, viewport.scrollHeight - height) : 0;
  const maxLeft = /^(auto|scroll)$/.test(style.overflowX) ? Math.max(0, viewport.scrollWidth - width) : 0;
  return {
    top: bounds.top + viewport.clientTop,
    left: bounds.left + viewport.clientLeft,
    width,
    height,
    scrollTop: clamp(viewport.scrollTop, maxTop),
    scrollLeft: clamp(viewport.scrollLeft, maxLeft),
    maxTop,
    maxLeft,
  };
}

function useScrollMetrics(viewportRef: RefObject<HTMLDivElement | null>) {
  const [metrics, setMetrics] = useState<ScrollMetrics | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    let content: Element | null = null;
    const measure = () => {
      frame = 0;
      const next = readMetrics(viewport);
      setMetrics(previous => previous && (Object.keys(next) as (keyof ScrollMetrics)[])
        .every(key => previous[key] === next[key]) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    const observeContent = () => {
      const next = viewport.firstElementChild;
      if (content === next) return;
      if (content) resize.unobserve(content);
      content = next;
      if (content) resize.observe(content);
    };
    const changes = new MutationObserver(() => { observeContent(); schedule(); });
    changes.observe(viewport, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'open', 'hidden'] });
    resize.observe(viewport);
    observeContent();
    viewport.addEventListener('scroll', schedule, { passive: true });
    viewport.addEventListener('load', schedule, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true });
    measure();
    return () => {
      changes.disconnect();
      resize.disconnect();
      viewport.removeEventListener('scroll', schedule);
      viewport.removeEventListener('load', schedule, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [viewportRef]);
  return metrics;
}

function ScrollTrack({ axis, label, viewportRef, viewportId, viewportSize, trackSize, position, range }: {
  axis: Axis;
  label: string;
  viewportRef: RefObject<HTMLDivElement | null>;
  viewportId: string;
  viewportSize: number;
  trackSize: number;
  position: number;
  range: number;
}) {
  const vertical = axis === 'vertical';
  const thumbSize = Math.min(trackSize, Math.max(minThumbSize, trackSize * viewportSize / (viewportSize + range)));
  const travel = trackSize - thumbSize;
  const offset = position / range * travel;
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointerPosition = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return vertical ? event.clientY - bounds.top : event.clientX - bounds.left;
  };
  const currentPosition = () => (vertical ? viewportRef.current?.scrollTop : viewportRef.current?.scrollLeft) ?? 0;
  const scrollTo = (value: number) => {
    const next = clamp(value, range);
    viewportRef.current?.scrollTo(vertical ? { top: next, behavior: 'instant' } : { left: next, behavior: 'instant' });
  };
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const pointer = pointerPosition(event);
    if (pointer < offset || pointer > offset + thumbSize) {
      scrollTo(currentPosition() + (pointer < offset ? -viewportSize : viewportSize));
      return;
    }
    if (!travel) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, offset: pointer - offset };
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId || !travel) return;
    scrollTo((pointerPosition(event) - drag.current.offset) / travel * range);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyScroll = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = currentPosition();
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? range
        : event.key === 'PageUp' ? current - viewportSize
          : event.key === 'PageDown' ? current + viewportSize
            : event.key === (vertical ? 'ArrowUp' : 'ArrowLeft') ? current - lineStep
              : event.key === (vertical ? 'ArrowDown' : 'ArrowRight') ? current + lineStep : null;
    if (next === null) return;
    event.preventDefault();
    scrollTo(next);
  };

  return <div className={`workspace-scrollbar workspace-scrollbar-${axis}`} role="scrollbar" tabIndex={0}
    aria-controls={viewportId} aria-label={label} aria-orientation={axis} aria-valuemin={0} aria-valuemax={range} aria-valuenow={Math.round(position)}
    data-dragging={dragging || undefined} style={vertical ? { height: trackSize, width: edgeSize } : { width: trackSize, height: edgeSize }}
    onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
    onLostPointerCapture={endDrag} onKeyDown={keyScroll}>
    <div className="workspace-scrollbar-thumb" style={vertical
      ? { height: thumbSize, transform: `translateY(${offset}px)` }
      : { width: thumbSize, transform: `translateX(${offset}px)` }} />
  </div>;
}

export function WorkspaceScrollbars({ viewportRef, viewportId }: { viewportRef: RefObject<HTMLDivElement | null>; viewportId: string }) {
  const { t } = useI18n();
  const modalOpen = useOverlayOpen('modal');
  const metrics = useScrollMetrics(viewportRef);
  const layerRef = useRef<HTMLDivElement>(null);
  const vertical = Boolean(metrics && metrics.width && metrics.height && metrics.maxTop);
  const horizontal = Boolean(metrics && metrics.width && metrics.height && metrics.maxLeft);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const wheel = (event: WheelEvent) => {
      const viewport = viewportRef.current;
      if (!viewport || event.ctrlKey) return;
      const line = event.deltaMode === WheelEvent.DOM_DELTA_LINE;
      const page = event.deltaMode === WheelEvent.DOM_DELTA_PAGE;
      const deltaX = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      event.preventDefault();
      viewport.scrollBy({
        left: deltaX * (line ? lineStep : page ? viewport.clientWidth : 1),
        top: (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * (line ? lineStep : page ? viewport.clientHeight : 1),
        behavior: 'instant',
      });
    };
    layer.addEventListener('wheel', wheel, { passive: false });
    return () => layer.removeEventListener('wheel', wheel);
  }, [viewportRef]);

  return createPortal(<div ref={layerRef} className="workspace-scrollbar-layer" hidden={modalOpen || (!vertical && !horizontal)}
    style={metrics ? { top: metrics.top, left: metrics.left, width: metrics.width, height: metrics.height } : undefined}>
    {!modalOpen && metrics && <>
      {vertical && <ScrollTrack axis="vertical" label={t('app.workspace.scrollVertical')} viewportId={viewportId} viewportRef={viewportRef}
        viewportSize={metrics.height} trackSize={Math.max(0, metrics.height - (horizontal ? edgeSize : 0))} position={metrics.scrollTop} range={metrics.maxTop} />}
      {horizontal && <ScrollTrack axis="horizontal" label={t('app.workspace.scrollHorizontal')} viewportId={viewportId} viewportRef={viewportRef}
        viewportSize={metrics.width} trackSize={Math.max(0, metrics.width - (vertical ? edgeSize : 0))} position={metrics.scrollLeft} range={metrics.maxLeft} />}
    </>}
  </div>, document.body);
}
