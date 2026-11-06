import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { EmptyState } from './EmptyState';
import { useI18n } from '../i18n';
import {
  formatAgentUsageAxisLabel,
  formatAgentUsageBucket,
  formatAgentUsageCompact,
  type AgentUsageBucketRow,
  type AgentUsageMetric,
  type AgentUsageReport,
} from '../services/agentUsage';
import {
  axisGutter,
  axisScale,
  buildCalendarGrid,
  calendarMinColumns,
  calendarMonthStarts,
  calendarSpanDays,
  buildHourGrid,
  buildStackedSeries,
  buildTokenStructure,
  heatLevel,
  heatThresholds,
  labelStep,
  peakValue,
  slotIndexAt,
} from '../services/agentUsageCharts';
import './AgentUsageCharts.css';

export const AGENT_USAGE_VIEWS = ['trend', 'structure'] as const;
export type AgentUsageView = (typeof AGENT_USAGE_VIEWS)[number];

const SERIES_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#94a3b8'];
const SOURCE_COLORS = ['#3b82f6', '#10b981', '#8b5cf6', '#0ea5e9', '#ec4899', '#f59e0b', '#14b8a6', '#6366f1', '#ef4444', '#84cc16', '#a855f7'];
export const STRUCTURE_COLORS = ['#10b981', '#a7f3d0', '#3b82f6', '#f59e0b'];
const OTHER_COLOR = '#94a3b8';
const BAR_TOP = 16;
const BAR_LEFT = 44;
const AXIS_LABEL_GAP = 8;
const TOOLTIP_WIDTH = 220;
const SPARSE_BARS = 16;
const HEAT_CELL = 13;
const HEAT_GAP = 3;
const HEAT_LEFT = 30;
const HEAT_TOP = 18;
const CALENDAR_TAIL = 24;
const YEAR_LABEL_WIDTH = 72;

export function agentSourceColor(source: string, sources: string[]): string {
  const index = sources.indexOf(source);
  return index >= 0 ? SOURCE_COLORS[index % SOURCE_COLORS.length] : OTHER_COLOR;
}

export const agentUsageMoney = (value: number): string => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: value >= 1 || value === 0 ? 2 : 4,
  maximumFractionDigits: value >= 1 || value === 0 ? 2 : 4,
}).format(value);

const valueText = (value: number, metric: AgentUsageMetric): string => (
  metric === 'costUSD' ? agentUsageMoney(value) : formatAgentUsageCompact(value)
);

type AgentUsageChartProps = {
  view: AgentUsageView;
  metric: AgentUsageMetric;
  report: AgentUsageReport;
  groupBy: 'source' | 'model';
  locale: string;
  seriesLabel: (key: string) => string;
};

type Segment = { key: string; value: number; color: string; label: string };
type Bar = { bucket: string; segments: Segment[] };
type TooltipRow = { label: string; value: string; color?: string };
type Tip = { x: number; y: number; title: string; total: string; rows: TooltipRow[]; extra?: string; above?: boolean };

function useWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(720);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(240, Math.round(node.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function AgentUsageChart({ view, metric, report, groupBy, locale, seriesLabel }: AgentUsageChartProps) {
  const { t } = useI18n();
  const plotRef = useRef<HTMLDivElement>(null);
  const width = useWidth(plotRef);
  const label = (key: string): string => (key === '__other__' ? t('usage.agentUsage.chart.other') : seriesLabel(key));
  const buckets = useMemo(() => report.timeline.map((row) => row.bucket), [report.timeline]);
  const sourceOrder = useMemo(() => report.sources.map((source) => source.source), [report.sources]);

  const stack = useMemo(() => {
    if (groupBy === 'source') {
      return buildStackedSeries(
        report.sources
          .filter((source) => source.series.length > 0)
          .map((source) => ({ key: source.source, label: source.source, rows: source.series })),
        metric,
        buckets,
      );
    }
    const byModel = new Map<string, AgentUsageBucketRow[]>();
    report.sources.forEach((source) => source.series.forEach((row) => {
      const separator = row.bucket.lastIndexOf('|');
      const bucket = separator >= 0 ? row.bucket.slice(0, separator) : row.bucket;
      const model = separator >= 0 ? row.bucket.slice(separator + 1) : source.source;
      const rows = byModel.get(model) ?? [];
      rows.push({ ...row, bucket });
      byModel.set(model, rows);
    }));
    return buildStackedSeries(
      [...byModel].map(([model, rows]) => ({ key: model, label: model, rows })),
      metric,
      buckets,
    );
  }, [buckets, groupBy, metric, report.sources]);

  let content;
  if (report.totals.totalTokens <= 0) {
    content = <EmptyState variant="compact">{t('usage.agentUsage.chart.empty')}</EmptyState>;
  } else if (view === 'trend') {
    const seriesColor = (key: string) => groupBy === 'source'
      ? agentSourceColor(key, sourceOrder)
      : key === '__other__' ? OTHER_COLOR : SERIES_COLORS[stack.keys.indexOf(key) % SERIES_COLORS.length];
    const bars: Bar[] = stack.points.map((point) => ({
      bucket: point.bucket,
      segments: point.segments.map((segment) => ({
        key: segment.key,
        value: segment.value,
        color: seriesColor(segment.key),
        label: label(segment.key),
      })),
    }));
    content = (
      <>
        <BarChart bars={bars} max={stack.max} metric={metric} kind={report.bucket} width={width} label={t('usage.agentUsage.view.trend')} />
        <ChartLegend keys={stack.keys} label={label} color={seriesColor} />
      </>
    );
  } else {
    const kinds = ['cacheRead', 'cacheCreation', 'input', 'output'] as const;
    const rows = buildTokenStructure(report.timeline);
    const bars: Bar[] = rows.map((row) => ({
      bucket: row.bucket,
      segments: kinds.map((kind, index) => ({
        key: kind,
        value: row[kind],
        color: STRUCTURE_COLORS[index],
        label: t(`usage.agentUsage.token.${kind}`),
      })),
    }));
    const max = peakValue(rows.map((row) => row.input + row.output + row.cacheRead + row.cacheCreation));
    content = (
      <>
        <BarChart bars={bars} max={max} metric="totalTokens" kind={report.bucket} width={width} label={t('usage.agentUsage.view.structure')} />
        <ChartLegend keys={[...kinds]} label={(key) => t(`usage.agentUsage.token.${key as (typeof kinds)[number]}`)}
          color={(key) => STRUCTURE_COLORS[kinds.indexOf(key as (typeof kinds)[number])]} />
      </>
    );
  }

  return <div className="agent-usage-chart" ref={plotRef} data-view={view}>{content}</div>;
}

function BarChart({ bars, max, metric, kind, width, label }: {
  bars: Bar[];
  max: number;
  metric: AgentUsageMetric;
  kind: AgentUsageReport['bucket'];
  width: number;
  label: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const height = Math.round(Math.max(220, Math.min(320, width * 0.2)));
  const baseline = height - 24;
  const sparse = bars.length <= SPARSE_BARS;
  const { ceiling, step } = axisScale(max);
  const right = width - 4;
  const ticks = Array.from({ length: Math.round(ceiling / step) + 1 }, (_, index) => index * step);
  const left = axisGutter(ticks.map((tick) => valueText(tick, metric)), BAR_LEFT, AXIS_LABEL_GAP);
  const plotWidth = right - left;
  const slot = plotWidth / Math.max(1, bars.length);
  const barWidth = Math.max(1, Math.min(sparse ? 64 : 32, slot * (slot > 6 ? 0.62 : 0.9)));
  const every = labelStep(bars.length, plotWidth, kind === 'hour' ? 96 : 64);
  const scale = (value: number) => (ceiling > 0 ? (value / ceiling) * (baseline - BAR_TOP) : 0);
  const activeBar = active === null ? null : bars[active];
  const tip: Tip | null = activeBar && active !== null ? {
    x: left + (active + 0.5) * slot,
    y: 0,
    title: formatAgentUsageBucket(activeBar.bucket, kind),
    total: valueText(activeBar.segments.reduce((sum, segment) => sum + segment.value, 0), metric),
    rows: activeBar.segments.filter((segment) => segment.value > 0).reverse()
      .map((segment) => ({ label: segment.label, value: valueText(segment.value, metric), color: segment.color })),
  } : null;
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setActive(slotIndexAt(((event.clientX - bounds.left) / bounds.width) * width, left, plotWidth, bars.length));
  };
  const keyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const last = bars.length - 1;
    const next = event.key === 'ArrowRight' ? Math.min(last, active === null ? 0 : active + 1)
      : event.key === 'ArrowLeft' ? Math.max(0, active === null ? last : active - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
    if (event.key === 'Escape') setActive(null);
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  };
  return (
    <div className="agent-usage-plot" style={{ height: height }}>
      <svg
        className="agent-usage-svg"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={label}
        tabIndex={bars.length ? 0 : undefined}
        onPointerMove={move}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={keyDown}
      >
        {ticks.map((tick) => {
          const y = baseline - scale(tick);
          return (
            <g key={tick} className={`agent-usage-axis${tick === 0 ? ' baseline' : ''}`}>
              <line x1={left} x2={right} y1={y} y2={y} />
              <text x={left - AXIS_LABEL_GAP} y={y + 3} textAnchor="end">{valueText(tick, metric)}</text>
            </g>
          );
        })}
        {active !== null ? (
          <rect className="agent-usage-highlight" x={left + active * slot} y={BAR_TOP - 4} width={slot} height={baseline - BAR_TOP + 4} rx="3" />
        ) : null}
        {bars.map((bar, index) => {
          let cursor = 0;
          const x = left + index * slot + (slot - barWidth) / 2;
          const visible = bar.segments.filter((segment) => segment.value > 0);
          return (
            <g key={bar.bucket} className="agent-usage-bar" data-bucket={bar.bucket}>
              {visible.map((segment, segmentIndex) => {
                const height = scale(segment.value);
                const y = baseline - cursor - height;
                cursor += height;
                const top = segmentIndex === visible.length - 1;
                return (
                  <rect key={segment.key} x={x} y={y} width={barWidth} height={Math.max(0.5, height)} fill={segment.color}
                    rx={top && barWidth > 4 ? Math.min(3, barWidth / 3) : 0} />
                );
              })}
              {sparse && cursor > 0 ? (
                <text className="agent-usage-bar-value" x={x + barWidth / 2} y={baseline - cursor - 6} textAnchor="middle">
                  {valueText(bar.segments.reduce((sum, segment) => sum + segment.value, 0), metric)}
                </text>
              ) : null}
              {index % every === 0 ? (
                <text className="agent-usage-axis-label" x={left + (index + 0.5) * slot} y={height - 6} textAnchor="middle">
                  {formatAgentUsageAxisLabel(bar.bucket, kind, bars[index - every]?.bucket)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {tip ? <ChartTooltip tip={tip} width={width} /> : null}
    </div>
  );
}

const localDay = (date: Date): string => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-');

export function AgentUsageActivity({ report, locale }: { report: AgentUsageReport; locale: string }) {
  const { t } = useI18n();
  const weekdays = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    const monday = Date.UTC(2024, 0, 1);
    return Array.from({ length: 7 }, (_, index) => format.format(new Date(monday + index * 86_400_000)));
  }, [locale]);
  const today = localDay(new Date());
  const calendarMinWidth = HEAT_LEFT + calendarMinColumns(report.calendar[0]?.date ?? today, today) * (HEAT_CELL + HEAT_GAP) + CALENDAR_TAIL;
  return (
    <div className="agent-usage-activity-grid">
      <div className="agent-usage-activity-block" data-view="calendar" style={{ flexBasis: calendarMinWidth }}>
        <div className="agent-usage-activity-heading">
          <h4>{t('usage.agentUsage.view.calendar')}</h4>
          <span>{t('usage.agentUsage.calendarHint')}</span>
        </div>
        <CalendarHeatmap report={report} weekdays={weekdays} locale={locale} label={t('usage.agentUsage.view.calendar')} />
      </div>
      <div className="agent-usage-activity-block" data-view="hours">
        <div className="agent-usage-activity-heading">
          <h4>{t('usage.agentUsage.view.hours')}</h4>
          <span>{t('usage.agentUsage.hoursWindow')}</span>
        </div>
        <HoursHeatmap report={report} weekdays={weekdays} label={t('usage.agentUsage.view.hours')} />
      </div>
      <div className="agent-usage-heat-legend" aria-hidden="true">
        <span>{t('usage.agentUsage.heatLess')}</span>
        {[0, 1, 2, 3, 4].map((level) => <i key={level} className={`agent-usage-heat level-${level}`} />)}
        <span>{t('usage.agentUsage.heatMore')}</span>
      </div>
    </div>
  );
}

function CalendarHeatmap({ report, weekdays, locale, label }: {
  report: AgentUsageReport;
  weekdays: string[];
  locale: string;
  label: string;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const available = useWidth(scrollRef);
  const end = localDay(new Date());
  const first = report.calendar[0]?.date ?? end;
  const pitch = HEAT_CELL + HEAT_GAP;
  const grid = buildCalendarGrid(report.calendar, end, calendarSpanDays(first, end, Math.floor((available - CALENDAR_TAIL) / pitch)));
  const thresholds = heatThresholds(report.calendar.map((row) => row.totalTokens));
  const costs = new Map(report.calendar.map((row) => [row.date, row.costUSD]));
  const width = grid.length * pitch + CALENDAR_TAIL;
  const height = HEAT_TOP + 7 * pitch;
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const yearMonthFormat = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', timeZone: 'UTC' });
  const monthStarts = calendarMonthStarts(grid, end);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const pin = () => { node.scrollLeft = node.scrollWidth; };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(node);
    return () => observer.disconnect();
  }, [grid.length]);
  return (
    <div className="agent-usage-calendar">
      <svg className="agent-usage-svg" viewBox={`0 0 ${HEAT_LEFT} ${height}`} width={HEAT_LEFT} height={height} aria-hidden="true">
        {[0, 2, 4, 6].map((index) => (
          <text key={index} className="agent-usage-axis-label" x={HEAT_LEFT - 6} y={HEAT_TOP + index * pitch + HEAT_CELL - 3} textAnchor="end">
            {weekdays[index]}
          </text>
        ))}
      </svg>
      <div className="agent-usage-plot agent-usage-scroll" ref={scrollRef} onPointerLeave={() => setTip(null)}>
      <svg className="agent-usage-svg" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={label}>
        {grid.map((week, weekIndex) => {
          const x = weekIndex * pitch;
          const monthStart = monthStarts[weekIndex];
          const yearLabel = monthStart?.slice(5, 7) === '01';
          return (
            <g key={week[0].date}>
              {monthStart ? (
                <text className="agent-usage-axis-label" x={yearLabel && x + YEAR_LABEL_WIDTH > width ? width : x} y={11}
                  textAnchor={yearLabel && x + YEAR_LABEL_WIDTH > width ? 'end' : undefined}>
                  {(yearLabel ? yearMonthFormat : monthFormat).format(new Date(`${monthStart}T00:00:00Z`))}
                </text>
              ) : null}
              {week.map((day, dayIndex) => {
                const y = HEAT_TOP + dayIndex * pitch;
                if (day.date > end) return null;
                return (
                  <rect
                    key={day.date}
                    className={`agent-usage-heat level-${heatLevel(day.value, thresholds)}`}
                    data-date={day.date}
                    x={x}
                    y={y}
                    width={HEAT_CELL}
                    height={HEAT_CELL}
                    rx="3"
                    onPointerEnter={() => setTip({
                      x: x + HEAT_CELL / 2,
                      y: dayIndex > 2 ? y - 6 : y + HEAT_CELL + 6,
                      above: dayIndex > 2,
                      title: day.date,
                      total: formatAgentUsageCompact(day.value),
                      rows: [],
                      extra: day.value > 0 ? agentUsageMoney(costs.get(day.date) ?? 0) : undefined,
                    })}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      {tip ? <ChartTooltip tip={tip} width={width} compact /> : null}
      </div>
    </div>
  );
}

function HoursHeatmap({ report, weekdays, label }: {
  report: AgentUsageReport;
  weekdays: string[];
  label: string;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const grid = buildHourGrid(report.hourly);
  const thresholds = heatThresholds(grid.flat());
  const pitch = HEAT_CELL + HEAT_GAP;
  const width = HEAT_LEFT + 24 * pitch;
  const height = HEAT_TOP + 7 * pitch;
  return (
    <div className="agent-usage-plot" onPointerLeave={() => setTip(null)}>
      <svg className="agent-usage-svg" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={label}>
        {[0, 6, 12, 18].map((hour) => (
          <text key={hour} className="agent-usage-axis-label" x={HEAT_LEFT + hour * pitch} y={11}>{hour}</text>
        ))}
        {grid.map((row, weekday) => row.map((value, hour) => {
          const x = HEAT_LEFT + hour * pitch;
          const y = HEAT_TOP + weekday * pitch;
          return (
            <rect
              key={`${weekday}-${hour}`}
              className={`agent-usage-heat level-${heatLevel(value, thresholds)}`}
              x={x}
              y={y}
              width={HEAT_CELL}
              height={HEAT_CELL}
              rx="3"
              onPointerEnter={() => setTip({
                x: x + HEAT_CELL / 2,
                y: weekday > 2 ? y - 6 : y + HEAT_CELL + 6,
                above: weekday > 2,
                title: `${weekdays[weekday]} ${String(hour).padStart(2, '0')}:00`,
                total: formatAgentUsageCompact(value),
                rows: [],
              })}
            />
          );
        }))}
        {[0, 2, 4, 6].map((index) => (
          <text key={index} className="agent-usage-axis-label" x={HEAT_LEFT - 6} y={HEAT_TOP + index * pitch + HEAT_CELL - 3} textAnchor="end">
            {weekdays[index]}
          </text>
        ))}
      </svg>
      {tip ? <ChartTooltip tip={tip} width={width} compact /> : null}
    </div>
  );
}

function ChartTooltip({ tip, width, compact = false }: { tip: Tip; width: number; compact?: boolean }) {
  const boxWidth = Math.min(compact ? 160 : TOOLTIP_WIDTH, width);
  return (
    <div
      className={`agent-usage-tooltip${compact ? ' compact' : ''}${tip.above ? ' above' : ''}`}
      data-theme-surface="overlay"
      aria-hidden="true"
      style={{ left: Math.max(0, Math.min(width - boxWidth, tip.x - boxWidth / 2)), top: tip.y, width: boxWidth }}
    >
      <div className="agent-usage-tooltip-head">
        <strong>{tip.title}</strong>
        <b>{tip.total}</b>
      </div>
      {tip.extra ? <div className="agent-usage-tooltip-row"><span /><b>{tip.extra}</b></div> : null}
      {tip.rows.map((row) => (
        <div key={row.label} className="agent-usage-tooltip-row">
          <span>{row.color ? <i style={{ background: row.color }} /> : null}{row.label}</span>
          <b>{row.value}</b>
        </div>
      ))}
    </div>
  );
}

function ChartLegend({ keys, label, color }: { keys: string[]; label: (key: string) => string; color: (key: string) => string }) {
  return (
    <ul className="agent-usage-chart-legend">
      {keys.map((key) => (
        <li key={key}>
          <span className="agent-usage-chart-swatch" style={{ background: color(key) }} aria-hidden="true" />
          <span className="agent-usage-chart-legend-label">{label(key)}</span>
        </li>
      ))}
    </ul>
  );
}
