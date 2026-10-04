import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Brain, ChevronLeft, ChevronRight, Columns3Cog, Database, DatabaseZap, Download, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { getCurrentLocale, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatCacheReadRate, formatGenerationSpeed } from '../services/usageMetrics';
import { formatDuration, formatUsageNumber } from '../services/usageNumber';
import { useDialogFocusTrap } from '../components/useDialogFocusTrap';
import { usageProviderDetails } from '../services/usageProvider';
import { usageModelDetails } from '../services/usageModel';

const compactNumber = (value: number) => formatUsageNumber(value, getCurrentLocale());
const compactDuration = (value: number) => formatDuration(value, getCurrentLocale());
const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(getCurrentLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
};
const formatEventDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(getCurrentLocale(), { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
};
export type UsageRecord = {
  id: string;
  row_id: string;
  timestamp: string;
  latency_ms: number;
  ttft_ms: number | null;
  source: string;
  source_display: string;
  failed: boolean;
  canceled: boolean;
  failure_status: number;
  failure_body: string;
  provider: string;
  auth_type?: string;
  model: string;
  /** Model name reported by the upstream response, when available. */
  response_model?: string;
  cost?: { total: number; pricing_model: string } | null;
  alias: string;
  reasoning_effort: string;
  endpoint: string;
  api_key_hash: string;
  api_key_display: string;
  api_key_remark: string;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_tokens: number;
  };
};

export type UsageEventPage = {
  items: UsageRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type EventColumnKey =
  | 'time'
  | 'model'
  | 'provider'
  | 'source'
  | 'key'
  | 'cache'
  | 'cost'
  | 'total'
  | 'result'
  | 'latency'
  | 'speed'
  | 'effort'
  | 'request';

type EventColumnDef = {
  key: EventColumnKey;
  labelKey: MessageKey;
  defaultWidth: number;
  minWidth: number;
  align: 'left' | 'center' | 'right';
};

const EVENT_COLUMNS: readonly EventColumnDef[] = [
  { key: 'time', labelKey: 'usage.column.time', defaultWidth: 84, minWidth: 76, align: 'left' },
  { key: 'provider', labelKey: 'usage.column.provider', defaultWidth: 108, minWidth: 88, align: 'left' },
  { key: 'key', labelKey: 'usage.column.key', defaultWidth: 120, minWidth: 96, align: 'left' },
  { key: 'source', labelKey: 'usage.column.source', defaultWidth: 180, minWidth: 120, align: 'left' },
  { key: 'model', labelKey: 'usage.column.model', defaultWidth: 132, minWidth: 104, align: 'left' },
  { key: 'effort', labelKey: 'usage.column.effort', defaultWidth: 76, minWidth: 64, align: 'left' },
  { key: 'result', labelKey: 'usage.column.result', defaultWidth: 80, minWidth: 68, align: 'left' },
  { key: 'request', labelKey: 'usage.column.request', defaultWidth: 112, minWidth: 88, align: 'left' },
  { key: 'latency', labelKey: 'usage.column.latency', defaultWidth: 112, minWidth: 96, align: 'left' },
  { key: 'speed', labelKey: 'usage.column.speed', defaultWidth: 88, minWidth: 72, align: 'left' },
  { key: 'total', labelKey: 'usage.column.tokens', defaultWidth: 120, minWidth: 112, align: 'left' },
  { key: 'cache', labelKey: 'usage.column.cache', defaultWidth: 104, minWidth: 88, align: 'left' },
  { key: 'cost', labelKey: 'usage.column.cost', defaultWidth: 112, minWidth: 96, align: 'left' },
] as const;

const DEFAULT_EVENT_VISIBLE_COLUMNS: readonly EventColumnKey[] = [
  'time', 'provider', 'key', 'source', 'model', 'effort', 'result', 'request', 'latency', 'speed', 'total', 'cache', 'cost',
];
const LEGACY_DEFAULT_EVENT_VISIBLE_COLUMNS: readonly string[] = [
  'time', 'model', 'input', 'output', 'cache', 'cacheRate', 'total', 'speed', 'ttft', 'latency', 'result', 'provider', 'source',
];

const EVENT_COL_WIDTHS_STORAGE_KEY = 'cpa-gui.usage-events-col-widths.v2';
const LEGACY_EVENT_COL_WIDTHS_STORAGE_KEY = 'cpa-gui.usage-events-col-widths.v1';
const PREVIOUS_EVENT_COLUMN_WIDTHS: Record<EventColumnKey, number> = {
  time: 105, key: 150, source: 205, model: 150, effort: 100, result: 95,
  request: 145, latency: 125, speed: 110, total: 145, cache: 135, provider: 135,
  cost: 112,
};
const EVENT_VISIBLE_COLS_STORAGE_KEY = 'cpa-gui.usage-events-visible-cols.v4';
const LEGACY_EVENT_VISIBLE_COLS_STORAGE_KEY = 'cpa-gui.usage-events-visible-cols.v3';

const getAllEventColumnKeys = () => EVENT_COLUMNS.map((column) => column.key);

const getInitialVisibleColumns = (): EventColumnKey[] => {
  try {
    const currentRaw = localStorage.getItem(EVENT_VISIBLE_COLS_STORAGE_KEY);
    const raw = currentRaw ?? localStorage.getItem(LEGACY_EVENT_VISIBLE_COLS_STORAGE_KEY)
      ?? localStorage.getItem('cpa-gui.usage-events-visible-cols.v2');
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const knownKeys = new Set<EventColumnKey>(getAllEventColumnKeys());
        const seen = new Set<EventColumnKey>();
        const savedKeys = parsed.filter((key): key is EventColumnKey => {
          if (typeof key !== 'string' || !knownKeys.has(key as EventColumnKey) || seen.has(key as EventColumnKey)) {
            return false;
          }
          seen.add(key as EventColumnKey);
          return true;
        });
        if (savedKeys.length > 0) {
          const wasLegacyDefault = currentRaw === null
            && parsed.length === LEGACY_DEFAULT_EVENT_VISIBLE_COLUMNS.length
            && LEGACY_DEFAULT_EVENT_VISIBLE_COLUMNS.every((key) => parsed.includes(key));
          if (wasLegacyDefault) return [...DEFAULT_EVENT_VISIBLE_COLUMNS];
          return currentRaw === null && !savedKeys.includes('cost') ? [...savedKeys, 'cost'] : savedKeys;
        }
      }
    }
  } catch {
  }
  return [...DEFAULT_EVENT_VISIBLE_COLUMNS];
};

const getInitialColumnWidths = (): Record<EventColumnKey, number> => {
  const initial: Record<EventColumnKey, number> = {} as any;
  for (const col of EVENT_COLUMNS) {
    initial[col.key] = col.defaultWidth;
  }
  try {
    const currentRaw = localStorage.getItem(EVENT_COL_WIDTHS_STORAGE_KEY);
    const raw = currentRaw ?? localStorage.getItem(LEGACY_EVENT_COL_WIDTHS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const col of EVENT_COLUMNS) {
          if (
            typeof parsed[col.key] === 'number' &&
            Number.isFinite(parsed[col.key]) &&
            parsed[col.key] >= col.minWidth
          ) {
            // Adopt tighter defaults while retaining columns the user resized.
            const wasDefault = currentRaw === null && parsed[col.key] === PREVIOUS_EVENT_COLUMN_WIDTHS[col.key];
            if (!wasDefault) initial[col.key] = Math.min(800, Math.round(parsed[col.key]));
          }
        }
      }
    }
  } catch {
  }
  return initial;
};

function TableTopScrollbar({
  tableWrapRef,
}: {
  tableWrapRef: React.RefObject<HTMLDivElement | null>;
}) {
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scrollbar = scrollbarRef.current;
    const track = trackRef.current;
    const tableWrap = tableWrapRef.current;
    if (!scrollbar || !track || !tableWrap) return;

    // Remember the positions we applied, rather than locking a whole frame.
    // This ignores delayed programmatic/vertical scroll events without dropping
    // newer drag or trackpad input on either surface.
    let lastScrollbarLeft = scrollbar.scrollLeft;
    let lastTableLeft = tableWrap.scrollLeft;

    const syncTable = () => {
      const left = scrollbar.scrollLeft;
      if (left === lastScrollbarLeft) return;
      lastScrollbarLeft = left;
      tableWrap.scrollLeft = left;
      lastTableLeft = tableWrap.scrollLeft;
    };

    const syncScrollbar = () => {
      const left = tableWrap.scrollLeft;
      if (left === lastTableLeft) return;
      lastTableLeft = left;
      scrollbar.scrollLeft = left;
      lastScrollbarLeft = scrollbar.scrollLeft;
    };

    const updateLayout = () => {
      const clientWidth = tableWrap.clientWidth;
      const maxScroll = Math.max(0, tableWrap.scrollWidth - clientWidth);
      const left = Math.min(tableWrap.scrollLeft, maxScroll);

      // Commit the range before the position. A deferred React width update can
      // clamp the thumb to its old range and then rewind the table via scroll.
      scrollbar.classList.toggle('is-hidden', maxScroll <= 1);
      track.style.width = `${(scrollbar.clientWidth || clientWidth) + maxScroll}px`;
      tableWrap.scrollLeft = left;
      scrollbar.scrollLeft = left;
      lastTableLeft = tableWrap.scrollLeft;
      lastScrollbarLeft = scrollbar.scrollLeft;
    };

    updateLayout();
    scrollbar.addEventListener('scroll', syncTable, { passive: true });
    tableWrap.addEventListener('scroll', syncScrollbar, { passive: true });

    const resizeObserver = new ResizeObserver(updateLayout);
    resizeObserver.observe(tableWrap);
    resizeObserver.observe(scrollbar);
    // Column resizing changes the table's width without resizing its viewport.
    if (tableWrap.firstElementChild) resizeObserver.observe(tableWrap.firstElementChild);

    return () => {
      scrollbar.removeEventListener('scroll', syncTable);
      tableWrap.removeEventListener('scroll', syncScrollbar);
      resizeObserver.disconnect();
    };
  }, [tableWrapRef]);

  return (
    <div
      ref={scrollbarRef}
      className="usage-table-top-scrollbar"
      aria-hidden="true"
    >
      <div ref={trackRef} style={{ height: '1px' }} />
    </div>
  );
}

function UsageResultCell({ record }: { record: UsageRecord }) {
  const { t } = useI18n();
  const state = record.canceled ? 'canceled' : record.failed ? 'failed' : 'success';
  const detail = [
    record.failure_status > 0 ? `HTTP ${record.failure_status}` : '',
    record.failure_body.trim(),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <td className="usage-result-cell align-left" title={detail || t(`usage.result.${state}`)}>
      <span className={`usage-result ${state}`}>
        <span className="usage-result-dot" />
        {t(`usage.result.${state}`)}
      </span>
      {detail ? <small title={detail}>{detail}</small> : null}
    </td>
  );
}

function UsageEventCell({
  record,
  columnKey,
  noRemarkLabel,
}: {
  record: UsageRecord;
  columnKey: EventColumnKey;
  noRemarkLabel: string;
}) {
  const { t, formatDate } = useI18n();

  switch (columnKey) {
    case 'time':
      return (
        <td className="usage-td-time usage-stacked-cell align-left" title={formatDate(record.timestamp)}>
          <strong>{formatTime(record.timestamp)}</strong>
          <small>{formatEventDate(record.timestamp)}</small>
        </td>
      );
    case 'model': {
      const model = usageModelDetails(record.model, record.alias, record.response_model);
      const modelTitle = [
        `${t('usage.model.request')}: ${model.requested}`,
        model.showResolved ? `${t('usage.model.upstream')}: ${model.resolved}` : '',
        model.showResponseInTooltip ? `${t('usage.model.response')}: ${model.response}` : '',
        model.mismatch ? t('usage.model.mismatch') : '',
        model.showResponseInTooltip ? t('usage.model.responseHint') : '',
      ].filter(Boolean).join('\n');
      return (
        <td className="usage-stacked-cell usage-td-model align-left" title={modelTitle}>
          <strong title={modelTitle}>{model.requested}</strong>
          {model.showResolved ? <small title={modelTitle}>{model.resolved}</small> : null}
          {model.mismatch ? (
            <small className="usage-response-model" title={modelTitle}>
              {t('usage.model.response')}: {model.response}
            </small>
          ) : null}
          {model.mismatch ? <span className="usage-model-mismatch">{t('usage.model.mismatch')}</span> : null}
        </td>
      );
    }
    case 'cost': {
      const cost = record.cost;
      const amount = cost ? new Intl.NumberFormat(getCurrentLocale(), {
        style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 6,
      }).format(cost.total) : '—';
      return <td className="usage-td-cost usage-stacked-cell align-left" title={cost ? t('usage.cost.hint', { model: cost.pricing_model }) : t('usage.cost.unpriced')}>
        <strong>{amount}</strong>
        {!cost ? <small>{t('usage.cost.unpriced')}</small> : null}
      </td>;
    }
    case 'effort':
      return <td className="usage-stacked-cell align-left" title={record.reasoning_effort || 'auto'}><strong>{record.reasoning_effort || 'auto'}</strong></td>;
    case 'request':
      return <td className="usage-stacked-cell align-left" title={record.endpoint || undefined}><strong>{record.endpoint || '—'}</strong></td>;
    case 'provider': {
      const provider = usageProviderDetails(record.provider, record.auth_type);
      return (
        <td className="usage-td-provider usage-stacked-cell align-left" title={`${t('usage.provider.hint')}\nprovider: ${provider.rawProvider || '—'}\nauth_type: ${provider.rawAuthType || '—'}`}>
          <strong>{provider.name}</strong>
          <small className="usage-access-type">{provider.access || t('usage.provider.unknownAccess')}</small>
        </td>
      );
    }
    case 'source':
      return (
        <td className="usage-td-source align-left" title={record.source_display || record.source || undefined}>
          <span className="usage-event-source">{record.source_display || record.source || '—'}</span>
        </td>
      );
    case 'key':
      return (
        <td className="usage-stacked-cell usage-td-key align-left">
          <strong title={record.api_key_display || undefined}>{record.api_key_display || '—'}</strong>
          <small title={record.api_key_remark}>{record.api_key_remark || noRemarkLabel}</small>
        </td>
      );
    case 'cache':
      return (
        <td
          className="usage-td-token usage-td-cache align-left"
          title={`${t('usage.token.cacheRead')}: ${record.tokens.cache_read_tokens.toLocaleString()} tokens${
            record.tokens.cache_creation_tokens > 0
              ? ` / ${t('usage.token.cacheCreation')}: ${record.tokens.cache_creation_tokens.toLocaleString()} tokens`
              : ''
          }`}
        >
          <strong>{formatCacheReadRate({ inputTokens: record.tokens.input_tokens, cacheReadTokens: record.tokens.cache_read_tokens })}</strong>
          <div className="usage-event-metrics"><span className="tone-cache-read" title={`${t('usage.token.cacheRead')}: ${record.tokens.cache_read_tokens.toLocaleString()}`} aria-label={`${t('usage.token.cacheRead')}: ${record.tokens.cache_read_tokens}`}><Database size={11} aria-hidden="true" />{compactNumber(record.tokens.cache_read_tokens)}</span></div>
          <div className="usage-event-metrics"><span className="tone-cache-write" title={`${t('usage.token.cacheCreation')}: ${record.tokens.cache_creation_tokens.toLocaleString()}`} aria-label={`${t('usage.token.cacheCreation')}: ${record.tokens.cache_creation_tokens}`}><DatabaseZap size={11} aria-hidden="true" />{compactNumber(record.tokens.cache_creation_tokens)}</span></div>
        </td>
      );
    case 'total':
      return (
        <td className="usage-td-token usage-td-total align-left" title={`${record.tokens.total_tokens.toLocaleString()} tokens`}>
          <strong>{compactNumber(record.tokens.total_tokens)}</strong>
          <div className="usage-event-metrics"><span className="tone-input" title={`${t('usage.column.input')}: ${record.tokens.input_tokens.toLocaleString()}`} aria-label={`${t('usage.column.input')}: ${record.tokens.input_tokens}`}><ArrowUp size={11} aria-hidden="true" />{compactNumber(record.tokens.input_tokens)}</span></div>
          <div className="usage-event-metrics">
            <span className="tone-output" title={`${t('usage.column.output')}: ${record.tokens.output_tokens.toLocaleString()}`} aria-label={`${t('usage.column.output')}: ${record.tokens.output_tokens}`}><ArrowDown size={11} aria-hidden="true" />{compactNumber(record.tokens.output_tokens)}</span>
            <span className="tone-reasoning" title={`${t('usage.column.reasoning')}: ${record.tokens.reasoning_tokens.toLocaleString()}`} aria-label={`${t('usage.column.reasoning')}: ${record.tokens.reasoning_tokens}`}><Brain size={11} aria-hidden="true" />{compactNumber(record.tokens.reasoning_tokens)}</span>
          </div>
        </td>
      );
    case 'result':
      return <UsageResultCell record={record} />;
    case 'latency':
      return (
        <td className="usage-td-latency usage-stacked-cell align-left" title={`${record.latency_ms} ms`}>
          <strong>{compactDuration(record.latency_ms)}</strong>
          <small title={record.ttft_ms == null ? undefined : `${record.ttft_ms} ms`}>{t('usage.column.ttft')} {record.ttft_ms == null ? '—' : compactDuration(record.ttft_ms)}</small>
        </td>
      );
    case 'speed': {
      const value = formatGenerationSpeed({
        outputTokens: record.tokens.output_tokens,
        latencyMs: record.latency_ms,
      });
      return <td className="usage-td-speed align-left" title={value === '—' ? undefined : value}>{value}</td>;
    }
  }
}

export function EventsView({
  events,
  pageSize,
  onPage,
  onPageSizeChange,
  loading = false,
}: {
  events: UsageEventPage;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  loading?: boolean;
}) {
  const { t } = useI18n();
  const [widths, setWidths] = useState<Record<EventColumnKey, number>>(getInitialColumnWidths);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<EventColumnKey[]>(getInitialVisibleColumns);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [draftVisibleColumnKeys, setDraftVisibleColumnKeys] = useState<EventColumnKey[]>(visibleColumnKeys);
  const [resizingCol, setResizingCol] = useState<EventColumnKey | null>(null);

  const columnDialogRef = useDialogFocusTrap<HTMLElement>({
    active: columnSettingsOpen,
    onEscape: () => setColumnSettingsOpen(false),
  });
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const visibleColumnKeySet = new Set(visibleColumnKeys);
  const visibleColumns = EVENT_COLUMNS.filter((column) => visibleColumnKeySet.has(column.key));
  const isCustomized = EVENT_COLUMNS.some((col) => widths[col.key] !== col.defaultWidth);
  const noRemarkLabel = t('usage.key.noRemark');

  const resetAllWidths = () => {
    const defaults: Record<EventColumnKey, number> = {} as any;
    for (const col of EVENT_COLUMNS) {
      defaults[col.key] = col.defaultWidth;
    }
    setWidths(defaults);
    try {
      localStorage.setItem(EVENT_COL_WIDTHS_STORAGE_KEY, JSON.stringify(defaults));
    } catch {}
  };

  const openColumnSettings = () => {
    setDraftVisibleColumnKeys(visibleColumnKeys);
    setColumnSettingsOpen(true);
  };

  const toggleDraftColumn = (key: EventColumnKey) => {
    setDraftVisibleColumnKeys((current) => {
      if (current.includes(key)) {
        return current.length > 1 ? current.filter((columnKey) => columnKey !== key) : current;
      }
      return EVENT_COLUMNS.filter(
        (column) => current.includes(column.key) || column.key === key
      ).map((column) => column.key);
    });
  };

  const applyColumnSettings = () => {
    const next =
      draftVisibleColumnKeys.length > 0 ? draftVisibleColumnKeys : getAllEventColumnKeys();
    setVisibleColumnKeys(next);
    try {
      localStorage.setItem(EVENT_VISIBLE_COLS_STORAGE_KEY, JSON.stringify(next));
    } catch {}
    setColumnSettingsOpen(false);
  };

  const resetVisibleColumns = () => {
    setDraftVisibleColumnKeys(getAllEventColumnKeys());
  };

  const resetSingleColumn = (key: EventColumnKey, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const colDef = EVENT_COLUMNS.find((c) => c.key === key);
    if (!colDef) return;
    setWidths((prev) => {
      const next = { ...prev, [key]: colDef.defaultWidth };
      try {
        localStorage.setItem(EVENT_COL_WIDTHS_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const persistColumnWidth = (key: EventColumnKey, width: number) => {
    setWidths((current) => {
      const next = { ...current, [key]: width };
      try {
        localStorage.setItem(EVENT_COL_WIDTHS_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const handleResizeKeyDown = (key: EventColumnKey, event: KeyboardEvent<HTMLDivElement>) => {
    const column = EVENT_COLUMNS.find((item) => item.key === key);
    if (!column) return;
    const current = widths[key] ?? column.defaultWidth;
    const step = event.shiftKey ? 25 : 10;
    const next = event.key === 'Home'
      ? column.defaultWidth
      : event.key === 'ArrowLeft'
        ? Math.max(column.minWidth, current - step)
        : event.key === 'ArrowRight'
          ? Math.min(800, current + step)
          : null;
    if (next === null) return;
    event.preventDefault();
    persistColumnWidth(key, next);
  };

  const handleResizeStart = (key: EventColumnKey, e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    resizeCleanupRef.current?.();
    const startX = e.clientX;
    const startWidth =
      widths[key] ?? EVENT_COLUMNS.find((c) => c.key === key)?.defaultWidth ?? 100;
    const colDef = EVENT_COLUMNS.find((c) => c.key === key);
    const minWidth = colDef?.minWidth ?? 50;

    setResizingCol(key);
    document.body.classList.add('table-col-resizing');

    let currentWidth = startWidth;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = Math.min(800, Math.max(minWidth, Math.round(startWidth + delta)));
      currentWidth = nextWidth;
      setWidths((prev) => ({ ...prev, [key]: nextWidth }));
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      document.body.classList.remove('table-col-resizing');
      resizeCleanupRef.current = null;
    };

    const onPointerUp = () => {
      cleanup();
      setResizingCol(null);

      setWidths((prev) => {
        const next = { ...prev, [key]: currentWidth };
        try {
          localStorage.setItem(EVENT_COL_WIDTHS_STORAGE_KEY, JSON.stringify(next));
        } catch {}
        return next;
      });
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    resizeCleanupRef.current = cleanup;
  };

  const totalTableWidth = visibleColumns.reduce(
    (sum, col) => sum + (widths[col.key] ?? col.defaultWidth),
    0
  );

  const startRecordNum = events.total > 0 ? (events.page - 1) * pageSize + 1 : 0;
  const endRecordNum = Math.min(events.page * pageSize, events.total);

  const exportCurrentPage = () => {
    const headers = ['id', 'row_id', 'timestamp', 'api_key_display', 'api_key_remark', 'api_key_hash', 'source', 'source_display', 'provider', 'model', 'alias', 'response_model', 'reasoning_effort', 'endpoint', 'failed', 'canceled', 'failure_status', 'failure_body', 'latency_ms', 'ttft_ms', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'estimated_cost_usd', 'pricing_model'];
    const csvCell = (value: string | number | boolean | null) => {
      const text = value == null ? '' : String(value);
      const safe = typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const rows = events.items.map((record) => [record.id, record.row_id, record.timestamp, record.api_key_display, record.api_key_remark, record.api_key_hash, record.source, record.source_display, record.provider, record.model, record.alias, record.response_model ?? '', record.reasoning_effort, record.endpoint, record.failed, record.canceled, record.failure_status, record.failure_body, record.latency_ms, record.ttft_ms, record.tokens.input_tokens, record.tokens.output_tokens, record.tokens.reasoning_tokens, record.tokens.cache_read_tokens, record.tokens.cache_creation_tokens, record.tokens.total_tokens, record.cost?.total ?? null, record.cost?.pricing_model ?? '']);
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `usage-events-page-${events.page}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="panel usage-events-panel usage-request-log" aria-label={t('usage.events.title')} aria-busy={loading}>
      {loading ? <div className="usage-empty" role="status"><Database size={20} aria-hidden="true" /><span>{t('usage.loading')}</span></div> : events.items.length ? (
        <div ref={tableWrapRef} className="usage-table-wrap" tabIndex={0} role="region" aria-label={t('usage.events.title')}>
          <table
            className="usage-events-table"
            style={{ width: `${totalTableWidth}px` }}
          >
            <colgroup>
              {visibleColumns.map((col) => (
                <col key={col.key} style={{ width: `${widths[col.key]}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {visibleColumns.map((col) => {
                  const label = t(col.labelKey);
                  return (
                    <th
                      key={col.key}
                      className={`usage-th-${col.key} align-${col.align}`}
                      style={{ width: `${widths[col.key]}px` }}
                    >
                      <div className="usage-th-content" title={label}>
                        <span>{label}</span>
                      </div>
                      <div
                        className={`usage-col-resizer ${resizingCol === col.key ? 'active' : ''}`}
                        role="separator"
                        tabIndex={0}
                        aria-label={`${label}: ${t('usage.events.resizeHint')}`}
                        aria-orientation="vertical"
                        aria-valuemin={col.minWidth}
                        aria-valuemax={800}
                        aria-valuenow={widths[col.key]}
                        onPointerDown={(e) => handleResizeStart(col.key, e)}
                        onDoubleClick={(e) => resetSingleColumn(col.key, e)}
                        onKeyDown={(event) => handleResizeKeyDown(col.key, event)}
                        title={t('usage.events.resizeHint')}
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {events.items.map((record) => (
                <tr key={record.row_id}>
                  {visibleColumns.map((column) => (
                    <UsageEventCell
                      key={column.key}
                      record={record}
                      columnKey={column.key}
                      noRemarkLabel={noRemarkLabel}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <UsageEmpty />
      )}

      {!loading && events.items.length > 0 ? <TableTopScrollbar tableWrapRef={tableWrapRef} /> : null}

      <div className="usage-events-footer">
        <span className="usage-pagination-summary">{t('usage.events.rangeSummary', { start: startRecordNum, end: endRecordNum, total: compactNumber(events.total) })}</span>
        <div className="usage-events-actions">
          <button
            type="button"
            className="usage-col-settings-btn"
            onClick={openColumnSettings}
            title={t('usage.events.columnSettings')}
            aria-label={t('usage.events.columnSettings')}
          >
            <Columns3Cog size={14} aria-hidden="true" />
            <span>{t('usage.events.columns')}</span>
          </button>
          {isCustomized ? (
            <button
              type="button"
              className="usage-col-reset-btn icon-only"
              onClick={resetAllWidths}
              title={t('usage.events.resetColumns')}
              aria-label={t('usage.events.resetColumns')}
            >
              <RotateCcw size={13} aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" className="usage-events-export-btn" disabled={loading || events.items.length === 0} onClick={exportCurrentPage} title={t('usage.events.exportDescription')}>
            <Download size={14} aria-hidden="true" /><span>{t('usage.events.exportPage')}</span>
          </button>
        </div>
        <div className="usage-pagination-controls">
          <select className="usage-page-size-select" value={pageSize} disabled={loading} onChange={(event) => onPageSizeChange(Number(event.currentTarget.value))} aria-label={t('usage.events.pageSize', { size: pageSize })}>
            {[20, 50, 100, 200].map((size) => <option key={size} value={size}>{t('usage.events.pageSize', { size })}</option>)}
          </select>
          <div className="usage-pagination-right">
            <button type="button" className="usage-page-nav-btn" disabled={loading || events.page <= 1} onClick={() => onPage(events.page - 1)}><ChevronLeft size={14} aria-hidden="true" /><span>{t('usage.previous')}</span></button>
            <span className="usage-pagination-info">{events.page} / {Math.max(1, events.totalPages)}</span>
            <button type="button" className="usage-page-nav-btn" disabled={loading || events.page >= events.totalPages} onClick={() => onPage(events.page + 1)}><span>{t('usage.next')}</span><ChevronRight size={14} aria-hidden="true" /></button>
          </div>
        </div>
      </div>

      {columnSettingsOpen ? (
        <div
          className="config-dialog-backdrop"
          onMouseDown={(event) =>
            event.currentTarget === event.target && setColumnSettingsOpen(false)
          }
        >
          <section
            ref={columnDialogRef}
            className="config-dialog usage-column-dialog"
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="usage-column-dialog-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setColumnSettingsOpen(false);
            }}
          >
            <div className="usage-column-dialog-heading">
              <div>
                <Columns3Cog size={19} aria-hidden="true" />
                <h2 id="usage-column-dialog-title">{t('usage.events.columnSettings')}</h2>
              </div>
              <button
                type="button"
                className="icon-button quiet"
                onClick={() => setColumnSettingsOpen(false)}
                title={t('common.close')}
                aria-label={t('common.close')}
              >
                <X size={17} />
              </button>
            </div>
            <p className="usage-column-dialog-description">
              {t('usage.events.columnSettingsDescription')}
            </p>
            <div className="usage-column-options">
              {EVENT_COLUMNS.map((column) => {
                const checked = draftVisibleColumnKeys.includes(column.key);
                return (
                  <label key={column.key} className="usage-column-option">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={checked && draftVisibleColumnKeys.length === 1}
                      onChange={() => toggleDraftColumn(column.key)}
                    />
                    <span>{t(column.labelKey)}</span>
                  </label>
                );
              })}
            </div>
            <div className="usage-column-dialog-footer">
              <div className="usage-column-dialog-meta">
                <span>
                  {t('usage.events.columnsSelected', {
                    selected: draftVisibleColumnKeys.length,
                    total: EVENT_COLUMNS.length,
                  })}
                </span>
                <button
                  type="button"
                  className="usage-column-select-all"
                  onClick={resetVisibleColumns}
                >
                  {t('usage.events.selectAllColumns')}
                </button>
              </div>
              <div className="usage-column-dialog-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setColumnSettingsOpen(false)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={applyColumnSettings}
                >
                  {t('usage.events.applyColumns')}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function UsageEmpty() {
  const { t } = useI18n();
  return <div className="usage-empty"><TriangleAlert size={18} /><span>{t('usage.empty')}</span></div>;
}
