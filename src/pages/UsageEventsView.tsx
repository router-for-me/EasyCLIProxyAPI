import { EmptyState } from '../components/EmptyState';
import { Checkbox } from '../components/Checkbox';
import { Switch } from '../components/Switch';
import { getUsageEvents, saveUsageEventsExport } from '../services/usage';
import type { UsageEventPage, UsageRecord, UsageEventQuery } from '../services/usage';
import { managementApi } from '../services/managementApi';
import { openCoreLogsDirectory } from '../services/coreSettings';
import { usagePreferences } from '../services/usagePreferences';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { save } from '../services/platform';
import { ArrowDown, ArrowUp, Brain, Check, ChevronLeft, ChevronRight, Columns3, Copy, Database, DatabaseZap, Download, FileText, FolderOpen, Loader2, RefreshCw, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { FloatingNotice, useAppNotice } from '../appNotice';
import { getCurrentLocale, useI18n } from '../i18n';
import { usePrivacyMask } from '../privacy';
import type { MessageKey } from '../i18n/resources';
import { formatCacheReadRate, formatGenerationSpeed, getSpeedMode, setSpeedMode, type GenerationSpeedMode } from '../services/usageMetrics';
import { Select } from '../components/Select';
import { formatDuration, formatUsageNumber } from '../services/usageNumber';
import { Dialog } from '../components/Dialog';
import { usageProviderDetails } from '../services/usageProvider';
import { usageModelDetails } from '../services/usageModel';

const compactNumber = (value: number) => formatUsageNumber(value, getCurrentLocale());
const compactDuration = (value: number) => formatDuration(value, getCurrentLocale());

const durationTone = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined;
  if (value >= 30_000) return 'tone-bad';
  if (value >= 15_000) return 'tone-warn';
  return 'tone-good';
};

const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(getCurrentLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
};
const formatEventDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(getCurrentLocale(), { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
};
export type { UsageRecord } from '../services/usage';

export type { UsageEventPage } from '../services/usage';

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
  | 'request';

type EventColumnDef = {
  key: EventColumnKey;
  labelKey: MessageKey;
  defaultWidth: number;
  minWidth: number;
  align: 'left' | 'center' | 'right';
};

const EVENT_COLUMNS: readonly EventColumnDef[] = [
  { key: 'time', labelKey: 'usage.column.time', defaultWidth: 82, minWidth: 76, align: 'left' },
  { key: 'model', labelKey: 'usage.column.model', defaultWidth: 150, minWidth: 112, align: 'left' },
  { key: 'source', labelKey: 'usage.column.source', defaultWidth: 128, minWidth: 104, align: 'left' },
  { key: 'key', labelKey: 'usage.column.key', defaultWidth: 112, minWidth: 96, align: 'left' },
  { key: 'provider', labelKey: 'usage.column.provider', defaultWidth: 92, minWidth: 84, align: 'left' },
  { key: 'result', labelKey: 'usage.column.result', defaultWidth: 78, minWidth: 68, align: 'left' },
  { key: 'total', labelKey: 'usage.column.tokens', defaultWidth: 112, minWidth: 100, align: 'left' },
  { key: 'cache', labelKey: 'usage.column.cache', defaultWidth: 94, minWidth: 84, align: 'left' },
  { key: 'latency', labelKey: 'usage.column.latency', defaultWidth: 112, minWidth: 100, align: 'center' },
  { key: 'speed', labelKey: 'usage.column.speed', defaultWidth: 82, minWidth: 72, align: 'left' },
  { key: 'cost', labelKey: 'usage.column.cost', defaultWidth: 96, minWidth: 86, align: 'left' },
  { key: 'request', labelKey: 'usage.column.request', defaultWidth: 128, minWidth: 88, align: 'left' },
] as const;

const DEFAULT_EVENT_VISIBLE_COLUMNS: readonly EventColumnKey[] = [
  'time', 'model', 'source', 'key', 'result', 'total', 'cache', 'latency', 'speed', 'cost',
];

const EVENT_COL_WIDTHS_STORAGE_KEY = 'cpa-gui.usage-events-col-widths.v4';
const LEGACY_EVENT_COL_WIDTHS_STORAGE_KEY = 'cpa-gui.usage-events-col-widths.v3';
const EVENT_VISIBLE_COLS_STORAGE_KEY = 'cpa-gui.usage-events-visible-cols.v6';
const LEGACY_EVENT_VISIBLE_COLS_STORAGE_KEY = 'cpa-gui.usage-events-visible-cols.v5';
const EVENT_COLLAPSE_ERRORS_KEY = 'cpa-gui.usage-events-collapse-errors.v1';
const getAllEventColumnKeys = () => EVENT_COLUMNS.map((column) => column.key);

export const getInitialVisibleColumns = (): EventColumnKey[] => {
  try {
    const currentRaw = usagePreferences.getItem(EVENT_VISIBLE_COLS_STORAGE_KEY);
    const previousRaw = usagePreferences.getItem(LEGACY_EVENT_VISIBLE_COLS_STORAGE_KEY);
    const raw = currentRaw ?? previousRaw
      ?? usagePreferences.getItem('cpa-gui.usage-events-visible-cols.v4')
      ?? usagePreferences.getItem('cpa-gui.usage-events-visible-cols.v3')
      ?? usagePreferences.getItem('cpa-gui.usage-events-visible-cols.v2');
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
          return savedKeys;
        }
      }
    }
  } catch {
  }
  return [...DEFAULT_EVENT_VISIBLE_COLUMNS];
};

export const getInitialCollapseErrors = (): boolean => {
  try {
    const raw = usagePreferences.getItem(EVENT_COLLAPSE_ERRORS_KEY);
    if (raw === '0' || raw === 'false') return false;
  } catch {
  }
  return true;
};

export const getInitialColumnWidths = (): Record<EventColumnKey, number> => {
  const initial: Record<EventColumnKey, number> = {} as any;
  for (const col of EVENT_COLUMNS) {
    initial[col.key] = col.defaultWidth;
  }
  try {
    const currentRaw = usagePreferences.getItem(EVENT_COL_WIDTHS_STORAGE_KEY);
    const previousRaw = usagePreferences.getItem(LEGACY_EVENT_COL_WIDTHS_STORAGE_KEY);
    const raw = currentRaw ?? previousRaw
      ?? usagePreferences.getItem('cpa-gui.usage-events-col-widths.v2')
      ?? usagePreferences.getItem('cpa-gui.usage-events-col-widths.v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const col of EVENT_COLUMNS) {
          if (
            typeof parsed[col.key] === 'number' &&
            Number.isFinite(parsed[col.key]) &&
            parsed[col.key] >= col.minWidth
          ) {
            initial[col.key] = Math.min(800, Math.round(parsed[col.key]));
          }
        }
      }
    }
  } catch {
  }
  return initial;
};

function usageEventsExportName(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `usage-events-${date.getFullYear()}-${month}-${day}.csv`;
}

function usageEventsCsv(records: UsageRecord[]) {
  const headers = ['id', 'row_id', 'timestamp', 'api_key_display', 'api_key_remark', 'api_key_hash', 'source', 'source_display', 'provider', 'model', 'alias', 'response_model', 'reasoning_effort', 'endpoint', 'failed', 'canceled', 'failure_status', 'failure_body', 'latency_ms', 'ttft_ms', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'estimated_cost_usd', 'pricing_model'];
  const csvCell = (value: string | number | boolean | null) => {
    const text = value == null ? '' : String(value);
    const safe = typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = records.map((record) => [record.id, record.row_id, record.timestamp, record.api_key_display, record.api_key_remark, record.api_key_hash, record.source, record.source_display, record.provider, record.model, record.alias, record.response_model ?? '', record.reasoning_effort, record.endpoint, record.failed, record.canceled, record.failure_status, record.failure_body, record.latency_ms, record.ttft_ms, record.tokens.input_tokens, record.tokens.output_tokens, record.tokens.reasoning_tokens, record.tokens.cache_read_tokens, record.tokens.cache_creation_tokens, record.tokens.total_tokens, record.cost?.total ?? null, record.cost?.pricing_model ?? '']);
  return '\uFEFF' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function TableTopScrollbar({
  tableWrapRef,
}: {
  tableWrapRef: React.RefObject<HTMLDivElement | null>;
}) {
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLTableElement | null>(null);

  useEffect(() => {
    const scrollbar = scrollbarRef.current;
    const track = trackRef.current;
    const tableWrap = tableWrapRef.current;
    if (!scrollbar || !track || !tableWrap) return;

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

    // The track is a real table whose width is viewport + horizontal overflow,
    // so the native scroller reports no scrollbar once the content fits.
    const updateLayout = () => {
      const clientWidth = scrollbar.clientWidth;
      const maxScroll = Math.max(0, tableWrap.scrollWidth - tableWrap.clientWidth);
      const left = Math.min(tableWrap.scrollLeft, maxScroll);
      track.style.width = `${clientWidth + maxScroll}px`;
      scrollbar.classList.toggle('is-hidden', maxScroll <= 0);
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
      <table ref={trackRef} style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
        <tbody><tr><td style={{ padding: 0, height: '1px' }} /></tr></tbody>
      </table>
    </div>
  );
}

function usageResultDetail(record: UsageRecord) {
  const state = record.canceled ? 'canceled' : record.failed ? 'failed' : 'success';
  return [
    record.failure_status > 0 && (state !== 'success' || record.failure_status >= 400) ? `HTTP ${record.failure_status}` : '',
    record.failure_body.trim(),
  ]
    .filter(Boolean)
    .join(' · ');
}

function CopyErrorButton({ detail, onCopy }: { detail: string; onCopy: (detail: string) => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="icon-button quiet tiny-button usage-error-copy"
      title={t('usage.events.copyError')}
      aria-label={t('usage.events.copyError')}
      onClick={(event) => {
        event.stopPropagation();
        onCopy(detail);
      }}
    >
      <Copy size={13} aria-hidden="true" />
    </button>
  );
}

function UsageResultCell({ record, onCopyError }: { record: UsageRecord; onCopyError: (detail: string) => void }) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const state = record.canceled ? 'canceled' : record.failed ? 'failed' : 'success';
  const detail = usageResultDetail(record);
  const shownDetail = privacy.text(detail);
  return (
    <td className="usage-result-cell align-left" title={shownDetail || t(`usage.result.${state}`)}>
      <span className={`usage-result ${state}`}>
        <span className="usage-result-dot" />
        {t(`usage.result.${state}`)}
      </span>
      {detail ? (
        <div className={`usage-result-detail-line${state === 'success' ? '' : ' usage-result-detail'}`}>
          <small title={shownDetail}>{shownDetail}</small>
          <CopyErrorButton detail={detail} onCopy={onCopyError} />
        </div>
      ) : null}
    </td>
  );
}

function UsageEventCell({
  record,
  columnKey,
  noRemarkLabel,
  showDate,
  compact,
  speedMode = "total",
  onCopyError,
}: {
  record: UsageRecord;
  columnKey: EventColumnKey;
  noRemarkLabel: string;
  showDate?: boolean;
  compact?: boolean;
  speedMode?: GenerationSpeedMode;
  onCopyError: (detail: string) => void;
}) {
  const { t, formatDate } = useI18n();
  const privacy = usePrivacyMask();

  switch (columnKey) {
    case 'time':
      return (
        <td className="usage-td-time usage-stacked-cell align-left" title={formatDate(record.timestamp)}>
          <strong>{formatTime(record.timestamp)}</strong>
          {showDate !== false ? <small>{formatEventDate(record.timestamp)}</small> : null}
        </td>
      );
    case 'model': {
      const model = usageModelDetails(record.model, record.alias, record.response_model, record.reasoning_effort);
      const effort = model.effort || 'auto';
      const tier = record.service_tier?.trim().toLowerCase() ?? '';
      const fast = ['priority', 'fast', 'ultrafast'].includes(tier);
      const modelTitle = [
        `${t('usage.model.request')}: ${model.requested}`,
        model.showResolved ? `${t('usage.model.upstream')}: ${model.resolved}` : '',
        model.showResponseInTooltip ? `${t('usage.model.response')}: ${model.response}` : '',
        model.mismatch ? t('usage.model.mismatch') : '',
        model.showResponseInTooltip ? t('usage.model.responseHint') : '',
        `${t('usage.column.effort')}: ${effort}`,
      ].filter(Boolean).join('\n');
      return (
        <td className="usage-stacked-cell usage-td-model align-left" title={modelTitle}>
          <strong title={modelTitle}>{model.requested}</strong>
          <span className="usage-model-badges">
            <small className="usage-model-effort" title={effort}>{effort}</small>
            {fast ? <small className="usage-model-fast" title={record.service_tier}>{t(tier === 'ultrafast' ? 'aliases.ultrafast.title' : 'usage.speedMode.fast')}</small> : null}
          </span>
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
    case 'request': {
      const path = record.endpoint.trim().replace(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s+/i, '');
      return <td className="usage-stacked-cell usage-td-request align-left" title={path || undefined}><strong>{path || '—'}</strong></td>;
    }
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
      {
        const credentialLabel = privacy.text(record.source_display || record.provider || '—');
      return (
        <td className="usage-td-source align-left" title={credentialLabel}>
          <span className="usage-event-source" title={credentialLabel}>
            {credentialLabel}
          </span>
        </td>
      );
      }
    case 'key':
      return (
        <td className="usage-stacked-cell usage-td-key align-left">
          <strong title={record.api_key_display || undefined}>{record.api_key_display || '—'}</strong>
          <small title={privacy.text(record.api_key_remark)}>{privacy.text(record.api_key_remark) || noRemarkLabel}</small>
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
          <div className="usage-event-metrics usage-cache-write"><span className="tone-cache-write" title={`${t('usage.token.cacheCreation')}: ${record.tokens.cache_creation_tokens.toLocaleString()}`} aria-label={`${t('usage.token.cacheCreation')}: ${record.tokens.cache_creation_tokens}`}><DatabaseZap size={11} aria-hidden="true" />{compactNumber(record.tokens.cache_creation_tokens)}</span></div>
        </td>
      );
    case 'total':
      return (
        <td
          className="usage-td-token usage-td-total align-left"
          title={compact
            ? `${record.tokens.total_tokens.toLocaleString()} tokens · ${t('usage.column.input')}: ${record.tokens.input_tokens.toLocaleString()} · ${t('usage.column.output')}: ${record.tokens.output_tokens.toLocaleString()} · ${t('usage.column.reasoning')}: ${record.tokens.reasoning_tokens.toLocaleString()}`
            : `${record.tokens.total_tokens.toLocaleString()} tokens`}
        >
          <strong>{compactNumber(record.tokens.total_tokens)}</strong>
          <div className="usage-event-metrics"><span className="tone-input" title={`${t('usage.column.input')}: ${record.tokens.input_tokens.toLocaleString()}`} aria-label={`${t('usage.column.input')}: ${record.tokens.input_tokens}`}><ArrowUp size={11} aria-hidden="true" />{compactNumber(record.tokens.input_tokens)}</span></div>
          <div className="usage-event-metrics">
            <span className="tone-output" title={`${t('usage.column.output')}: ${record.tokens.output_tokens.toLocaleString()}`} aria-label={`${t('usage.column.output')}: ${record.tokens.output_tokens}`}><ArrowDown size={11} aria-hidden="true" />{compactNumber(record.tokens.output_tokens)}</span>
            <span className="tone-reasoning" title={`${t('usage.column.reasoning')}: ${record.tokens.reasoning_tokens.toLocaleString()}`} aria-label={`${t('usage.column.reasoning')}: ${record.tokens.reasoning_tokens}`}><Brain size={11} aria-hidden="true" />{compactNumber(record.tokens.reasoning_tokens)}</span>
          </div>
        </td>
      );
    case 'result':
      return <UsageResultCell record={record} onCopyError={onCopyError} />;
    case 'latency': {
      const latencyTone = durationTone(record.latency_ms);
      const ttftTone = durationTone(record.ttft_ms);
      const latencyTitle = [
        `${t('usage.latency.ttft')}: ${record.ttft_ms == null ? '—' : `${record.ttft_ms} ms`}`,
        `${t('usage.latency.elapsed')}: ${record.latency_ms} ms`,
      ].join('\n');
      return (
        <td className="usage-td-latency align-center" title={latencyTitle}>
          <span className="usage-latency-cell">
          <span className="usage-latency-line">
            <span className="usage-latency-label">{t('usage.latency.ttft')}</span>
            <span className={ttftTone ? `usage-latency-value ${ttftTone}` : 'usage-latency-value'}>{record.ttft_ms == null ? '—' : compactDuration(record.ttft_ms)}</span>
          </span>
          <span className="usage-latency-line">
            <span className="usage-latency-label">{t('usage.latency.elapsed')}</span>
            <span className={`usage-latency-value ${latencyTone}`}>{compactDuration(record.latency_ms)}</span>
          </span>
          </span>
        </td>
      );
    }
    case 'speed': {
        const value =
          record.failed || record.canceled
            ? '—'
            : formatGenerationSpeed({
                outputTokens: record.tokens.output_tokens,
                latencyMs: record.latency_ms,
                ttftMs: record.ttft_ms,
                mode: speedMode,
              });
      return <td className="usage-td-speed align-left" title={value === '—' ? undefined : value}>{value}</td>;
    }
  }
}

type ShowNoticeFn = ReturnType<typeof useAppNotice>['showNotice'];

interface RequestLogData {
  content: string;
  filename: string;
  size: number;
  updatedAt: string;
}

interface SseTextPreview {
  reasoning: string;
  content: string;
}

interface ParsedLogSection {
  index: number;
  title: string;
  raw: string;
  formatted: string;
  ssePreview: SseTextPreview | null;
}

function tryPrettyJsonBlock(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

function collectSseRecordParts(record: Record<string, unknown>, reasoningOut: string[], contentOut: string[]): void {
  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const item = choice as Record<string, unknown>;
    const payload = (item.delta && typeof item.delta === 'object' ? item.delta : item.message) as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') continue;
    if (typeof payload.reasoning_content === 'string') reasoningOut.push(payload.reasoning_content);
    else if (typeof payload.reasoning === 'string') reasoningOut.push(payload.reasoning);
    if (typeof payload.content === 'string') contentOut.push(payload.content);
  }

  const eventType = typeof record.type === 'string' ? record.type : '';
  if (typeof record.delta === 'string') {
    if (eventType.includes('reasoning')) reasoningOut.push(record.delta);
    else if (eventType.includes('output_text') || eventType.includes('text')) contentOut.push(record.delta);
  } else if (record.delta && typeof record.delta === 'object') {
    const delta = record.delta as Record<string, unknown>;
    if (typeof delta.thinking === 'string') reasoningOut.push(delta.thinking);
    if (typeof delta.text === 'string') contentOut.push(delta.text);
  }

  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const content = (candidate as Record<string, unknown>).content as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (typeof p.text !== 'string' || !p.text) continue;
      if (p.thought) reasoningOut.push(p.text);
      else contentOut.push(p.text);
    }
  }
}

function extractSseTextPreview(raw: string): SseTextPreview | null {
  const reasoningParts: string[] = [];
  const contentParts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.*)$/);
    if (!match) continue;
    const payload = match[1].trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object') {
        collectSseRecordParts(parsed as Record<string, unknown>, reasoningParts, contentParts);
      }
    } catch {
      // Skip non-JSON SSE control or chunk lines
    }
  }
  const reasoning = reasoningParts.join('');
  const content = contentParts.join('');
  return reasoning || content ? { reasoning, content } : null;
}

function formatLogSectionBody(raw: string): { formatted: string; ssePreview: SseTextPreview | null } {
  const trimmed = raw.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, '');
  if (!trimmed) return { formatted: '', ssePreview: null };
  const prettyJson = tryPrettyJsonBlock(trimmed);
  if (prettyJson !== null) return { formatted: prettyJson, ssePreview: null };
  const hasSseData = /^data:\s*/m.test(trimmed);
  return {
    formatted: trimmed,
    ssePreview: hasSseData ? extractSseTextPreview(trimmed) : null,
  };
}

function parseRequestLogSections(rawText: string, defaultTitle: string): ParsedLogSection[] {
  const sections: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const line of rawText.split(/\r?\n/)) {
    const headerMatch = line.match(/^===\s+(.+?)\s+===\s*$/);
    if (headerMatch) {
      current = { title: headerMatch[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { title: defaultTitle, lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }

  return sections
    .map((sec, index) => {
      const raw = sec.lines.join('\n').trim();
      const { formatted, ssePreview } = formatLogSectionBody(raw);
      return { index, title: sec.title, raw, formatted, ssePreview };
    })
    .filter((sec, _idx, all) => all.length === 1 || sec.raw.length > 0 || sec.title !== defaultTitle);
}

function normalizeRequestLogPayload(payload: unknown, fallbackId: string): RequestLogData | null {
  if (typeof payload === 'string') {
    return { content: payload, filename: `${fallbackId}.log`, size: payload.length, updatedAt: '' };
  }
  if (!payload || typeof payload !== 'object') return null;
  const rec = payload as Record<string, unknown>;
  if (rec.exists === false) return null;
  const content =
    typeof rec.content === 'string'
      ? rec.content
      : typeof rec.raw === 'string'
        ? rec.raw
        : typeof rec.log === 'string'
          ? rec.log
          : typeof rec.body === 'string'
            ? rec.body
            : '';
  const filename =
    typeof rec.filename === 'string'
      ? rec.filename
      : typeof rec.file === 'string'
        ? rec.file
        : typeof rec.name === 'string'
          ? rec.name
          : `${fallbackId}.log`;
  if (!content && !rec.filename && !rec.file) return null;
  const size = typeof rec.size === 'number' && Number.isFinite(rec.size) ? rec.size : content.length;
  const updatedAt =
    typeof rec.updated_at === 'string'
      ? rec.updated_at
      : typeof rec.modified_at === 'string'
        ? rec.modified_at
        : typeof rec.updatedAt === 'string'
          ? rec.updatedAt
          : '';
  return { content, filename, size, updatedAt };
}

function isLogMissingError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error && (error as { status?: unknown }).status === 404) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /\b404\b|not[\s_-]*found/i.test(message);
}

function formatRecordCost(record: UsageRecord, locale: string, unpricedLabel: string): string {
  if (!record.cost) return unpricedLabel;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(record.cost.total);
}

interface DetailMetadataSection {
  key: string;
  title: string;
  rows: { label: string; value: string; mono?: boolean }[];
}

function LogSectionCard({
  title,
  rawBody,
  displayBody,
  copyKey,
  copiedKey,
  copyLabel,
  onCopy,
  ssePreview,
  ssePreviewTitle,
  maskText,
}: {
  title: string;
  rawBody: string;
  displayBody: string;
  copyKey: string;
  copiedKey: string;
  copyLabel: string;
  onCopy: (text: string, key: string) => void;
  ssePreview?: SseTextPreview | null;
  ssePreviewTitle?: string;
  maskText: (text: string) => string;
}) {
  return (
    <section className="usage-log-section">
      <header className="usage-log-section-header">
        <strong>{title}</strong>
        <button
          type="button"
          className="icon-button quiet tiny-button"
          title={copyLabel}
          aria-label={copyLabel}
          onClick={() => onCopy(rawBody, copyKey)}
        >
          {copiedKey === copyKey ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        </button>
      </header>
      {ssePreview ? (
        <div className="usage-log-sse-preview">
          {ssePreviewTitle ? <div className="usage-log-sse-preview-title">{ssePreviewTitle}</div> : null}
          {ssePreview.reasoning ? (
            <pre className="usage-log-code usage-log-code-reasoning">{maskText(ssePreview.reasoning)}</pre>
          ) : null}
          {ssePreview.content ? (
            <pre className="usage-log-code usage-log-code-content">{maskText(ssePreview.content)}</pre>
          ) : null}
        </div>
      ) : null}
      {displayBody ? <pre className="usage-log-code">{maskText(displayBody)}</pre> : null}
    </section>
  );
}

function UsageLogDetailModal({
  record,
  speedMode,
  onClose,
  onNotice,
}: {
  record: UsageRecord;
  speedMode: GenerationSpeedMode;
  onClose: () => void;
  onNotice: ShowNoticeFn;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const locale = getCurrentLocale();
  const privacy = usePrivacyMask();

  const [tab, setTab] = useState<'log' | 'meta'>('log');
  const [viewMode, setViewMode] = useState<'structured' | 'raw'>('structured');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [logData, setLogData] = useState<RequestLogData | null>(null);
  const [copiedKey, setCopiedKey] = useState('');
  const copyTimerRef = useRef<number | null>(null);
  const fetchSeqRef = useRef(0);

  const candidates = useMemo(
    () => Array.from(new Set([record.request_id, record.id].map((value) => String(value ?? '').trim()).filter(Boolean))),
    [record.request_id, record.id],
  );

  const markCopied = useCallback((key: string) => {
    setCopiedKey(key);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? '' : prev));
      copyTimerRef.current = null;
    }, 1500);
  }, []);

  useEffect(() => {
    return () => {
      fetchSeqRef.current += 1;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const loadLog = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setMissing(false);
    setFetchError('');
    setLogData(null);

    if (candidates.length === 0) {
      setMissing(true);
      setLoading(false);
      return;
    }

    try {
      for (const candidate of candidates) {
        try {
          const payload = await managementApi.get<unknown>(`/observability/logs/requests/${encodeURIComponent(candidate)}`);
          if (seq !== fetchSeqRef.current) return;
          const normalized = normalizeRequestLogPayload(payload, candidate);
          if (normalized) {
            setLogData(normalized);
            setLoading(false);
            return;
          }
        } catch (err) {
          if (seq !== fetchSeqRef.current) return;
          if (!isLogMissingError(err)) throw err;
        }
      }
      if (seq === fetchSeqRef.current) setMissing(true);
    } catch (err) {
      if (seq === fetchSeqRef.current) {
        setFetchError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [candidates]);

  useEffect(() => {
    setSearch('');
    setCopiedKey('');
    void loadLog();
  }, [record.row_id, loadLog]);

  const sections = useMemo(() => {
    if (!logData?.content) return [];
    return parseRequestLogSections(logData.content, t('usage.events.detail.tabLog'));
  }, [logData?.content, t]);

  const normalizedQuery = search.trim().toLowerCase();

  const filteredSections = useMemo(() => {
    if (!normalizedQuery) return sections;
    return sections.filter((section) =>
      section.title.toLowerCase().includes(normalizedQuery)
      || section.formatted.toLowerCase().includes(normalizedQuery)
      || section.raw.toLowerCase().includes(normalizedQuery)
      || (section.ssePreview?.content.toLowerCase().includes(normalizedQuery) ?? false)
      || (section.ssePreview?.reasoning.toLowerCase().includes(normalizedQuery) ?? false),
    );
  }, [sections, normalizedQuery]);

  const rawVisibleText = useMemo(() => {
    const content = logData?.content ?? '';
    if (!content) return '';
    if (!normalizedQuery) return content;
    return content
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().includes(normalizedQuery))
      .join('\n');
  }, [logData?.content, normalizedQuery]);

  const copyText = useCallback(async (text: string, key = 'all') => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      markCopied(key);
      onNotice({ key: 'usage.events.detail.copied' });
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [markCopied, onNotice]);

  const saveLogFile = useCallback(async () => {
    const content = logData?.content ?? '';
    if (!content) return;
    try {
      const defaultPath = logData?.filename || `${record.request_id || record.id || record.row_id}.log`;
      const path = await save({
        title: t('usage.events.detail.saveTitle'),
        defaultPath,
        filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
      });
      if (!path) return;
      await saveUsageEventsExport({ path, contents: content });
      onNotice({ key: 'usage.events.detail.saved' });
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [logData?.content, logData?.filename, onNotice, record.id, record.request_id, record.row_id, t]);

  const openLogsDir = useCallback(async () => {
    try {
      await openCoreLogsDirectory();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [onNotice]);

  const baseStatusLabel = record.canceled
    ? t('usage.result.canceled')
    : record.failed
      ? t('usage.result.failed')
      : t('usage.result.success');
  const statusBadgeText = record.failure_status ? `${baseStatusLabel} (${record.failure_status})` : baseStatusLabel;
  const recordedErrorDetail = record.failure_body || usageResultDetail(record);

  const statsSummary = useMemo(() => {
    if (!logData?.content) return '';
    const lineCount = logData.content.split(/\r?\n/).length;
    return `${logData.filename} · ${formatNumber(lineCount)} ${t('usage.events.detail.lines')} · ${formatNumber(logData.size)} ${t('usage.events.detail.bytes')}`;
  }, [logData, formatNumber, t]);

  const visibleLogCopyPayload = useMemo(() => {
    if (viewMode === 'raw') return rawVisibleText;
    if (!normalizedQuery) return logData?.content ?? '';
    return filteredSections.map((sec) => `=== ${sec.title} ===\n${sec.formatted}`).join('\n\n');
  }, [viewMode, rawVisibleText, normalizedQuery, logData?.content, filteredSections]);

  const metadataSections = useMemo<DetailMetadataSection[]>(() => {
    const modelInfo = usageModelDetails(record.model, record.alias, record.response_model, record.reasoning_effort);
    const providerInfo = usageProviderDetails(record.provider, record.auth_type);
    const speedLabel = formatGenerationSpeed({
      outputTokens: record.tokens.output_tokens,
      latencyMs: record.latency_ms,
      ttftMs: record.ttft_ms,
      mode: speedMode,
    });
    const cacheRateLabel = formatCacheReadRate({
      inputTokens: record.tokens.input_tokens,
      cacheReadTokens: record.tokens.cache_read_tokens,
    });
    const speedBaseline = t(speedMode === 'ttft' ? 'usage.events.speedModeTtft' : 'usage.events.speedModeTotal');

    return [
      {
        key: 'basic',
        title: t('usage.events.detail.secBasic'),
        rows: [
          { label: t('usage.column.time'), value: formatDate(record.timestamp), mono: true },
          { label: t('usage.column.result'), value: statusBadgeText },
          { label: t('usage.events.detail.eventId'), value: record.id || '—', mono: true },
          { label: t('usage.events.detail.requestId'), value: record.request_id || '—', mono: true },
          { label: t('usage.events.detail.rowId'), value: String(record.row_id), mono: true },
        ],
      },
      {
        key: 'model',
        title: t('usage.events.detail.secModel'),
        rows: [
          { label: t('usage.model.request'), value: modelInfo.requested || record.model || '—', mono: true },
          { label: t('usage.events.detail.alias'), value: record.alias || '—', mono: true },
          { label: t('usage.model.upstream'), value: modelInfo.resolved || '—', mono: true },
          { label: t('usage.model.response'), value: modelInfo.response || record.response_model || '—', mono: true },
          { label: t('usage.column.provider'), value: providerInfo.name || record.provider || '—' },
          { label: t('usage.events.detail.authType'), value: record.auth_type || providerInfo.rawAuthType || '—', mono: true },
          { label: t('usage.events.detail.authIndex'), value: record.auth_index || '—', mono: true },
          { label: t('usage.events.detail.executor'), value: record.executor_type || '—', mono: true },
          { label: t('usage.column.effort'), value: modelInfo.effort || t('usage.effort.unrecorded') },
          { label: t('usage.events.detail.serviceTier'), value: record.service_tier || '—', mono: true },
          { label: t('usage.events.detail.responseServiceTier'), value: record.response_service_tier || '—', mono: true },
        ],
      },
      {
        key: 'latency',
        title: t('usage.events.detail.secLatency'),
        rows: [
          { label: t('usage.column.latency'), value: formatDuration(record.latency_ms, locale), mono: true },
          { label: t('usage.column.ttft'), value: record.ttft_ms != null ? formatDuration(record.ttft_ms, locale) : '—', mono: true },
          { label: t('usage.column.speed'), value: `${speedLabel} (${speedBaseline})`, mono: true },
        ],
      },
      {
        key: 'tokens',
        title: t('usage.events.detail.secTokens'),
        rows: [
          { label: t('usage.column.total'), value: formatUsageNumber(record.tokens.total_tokens, locale), mono: true },
          { label: t('usage.column.input'), value: formatUsageNumber(record.tokens.input_tokens, locale), mono: true },
          { label: t('usage.column.output'), value: formatUsageNumber(record.tokens.output_tokens, locale), mono: true },
          { label: t('usage.column.reasoning'), value: formatUsageNumber(record.tokens.reasoning_tokens, locale), mono: true },
          { label: t('usage.token.cacheRead'), value: formatUsageNumber(record.tokens.cache_read_tokens, locale), mono: true },
          { label: t('usage.token.cacheCreation'), value: formatUsageNumber(record.tokens.cache_creation_tokens, locale), mono: true },
          { label: t('usage.column.cacheRate'), value: cacheRateLabel, mono: true },
        ],
      },
      {
        key: 'cost',
        title: t('usage.events.detail.secCost'),
        rows: [
          { label: t('usage.column.cost'), value: formatRecordCost(record, locale, t('usage.cost.unpriced')), mono: true },
          { label: t('usage.events.detail.pricingModel'), value: record.cost?.pricing_model || '—', mono: true },
        ],
      },
      {
        key: 'client',
        title: t('usage.events.detail.secClient'),
        rows: [
          { label: t('usage.column.source'), value: privacy.text(record.source_display || record.source || '—') },
          { label: t('usage.column.key'), value: privacy.text(record.api_key_display || '—'), mono: true },
          { label: t('usage.events.detail.apiKeyRemark'), value: privacy.text(record.api_key_remark || t('usage.key.noRemark')) },
          { label: t('usage.events.detail.apiKeyHash'), value: privacy.text(record.api_key_hash || '—'), mono: true },
        ],
      },
    ];
  }, [record, speedMode, locale, t, formatDate, statusBadgeText, privacy]);

  const rawJsonText = useMemo(() => JSON.stringify(record, null, 2), [record]);

  return (
    <Dialog
      className="config-dialog usage-log-detail-dialog"
      tabIndex={-1}
      labelledBy="usage-log-detail-title"
      onClose={onClose}
      dismissOnBackdrop
      actions={
        <button type="button" className="secondary-button" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <div className="config-dialog-heading usage-log-detail-heading">
        <div className="usage-log-detail-title-group">
          <div className="usage-log-detail-title-row">
            <FileText size={16} aria-hidden="true" />
            <h2 id="usage-log-detail-title">{t('usage.events.detail.title')}</h2>
            <span className={`usage-status-pill ${record.canceled ? 'is-canceled' : record.failed ? 'is-failed' : 'is-success'}`}>
              {statusBadgeText}
            </span>
          </div>
          <p className="usage-log-detail-subtitle">
            <span>{record.model || '—'}</span>
            <span>·</span>
            <span>{formatDate(record.timestamp)}</span>
            {statsSummary ? (
              <>
                <span>·</span>
                <span>{statsSummary}</span>
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          className="icon-button quiet"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="usage-log-detail-tabs">
        <div className="usage-log-detail-tab-buttons">
          <button
            type="button"
            className={tab === 'log' ? 'primary-button small-button' : 'secondary-button small-button'}
            onClick={() => setTab('log')}
          >
            {t('usage.events.detail.tabLog')}
          </button>
          <button
            type="button"
            className={tab === 'meta' ? 'primary-button small-button' : 'secondary-button small-button'}
            onClick={() => setTab('meta')}
          >
            {t('usage.events.detail.tabMeta')}
          </button>
        </div>
        <div className="usage-log-detail-actions">
          <button
            type="button"
            className="secondary-button small-button"
            onClick={() => void loadLog()}
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? 'spin' : undefined} aria-hidden="true" />
            <span>{t('usage.events.detail.refresh')}</span>
          </button>
          <button
            type="button"
            className="secondary-button small-button"
            onClick={() => void copyText(tab === 'meta' ? rawJsonText : visibleLogCopyPayload, 'toolbar')}
            disabled={tab === 'log' ? !visibleLogCopyPayload : !rawJsonText}
          >
            {copiedKey === 'toolbar' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            <span>{t('usage.events.detail.copy')}</span>
          </button>
          <button
            type="button"
            className="secondary-button small-button"
            onClick={() => void saveLogFile()}
            disabled={!logData?.content}
          >
            <Download size={13} aria-hidden="true" />
            <span>{t('usage.events.detail.saveLog')}</span>
          </button>
          <button
            type="button"
            className="secondary-button small-button"
            onClick={() => void openLogsDir()}
          >
            <FolderOpen size={13} aria-hidden="true" />
            <span>{t('usage.events.detail.logsDir')}</span>
          </button>
        </div>
      </div>

      {tab === 'log' ? (
        <div className="usage-log-detail-panel">
          <div className="usage-log-detail-toolbar">
            <div className="usage-log-mode-toggle">
              <button
                type="button"
                className={viewMode === 'structured' ? 'primary-button small-button' : 'secondary-button small-button'}
                onClick={() => setViewMode('structured')}
              >
                {t('usage.events.detail.modeStructured')}
              </button>
              <button
                type="button"
                className={viewMode === 'raw' ? 'primary-button small-button' : 'secondary-button small-button'}
                onClick={() => setViewMode('raw')}
              >
                {t('usage.events.detail.modeRaw')}
              </button>
            </div>
            <input
              type="search"
              className="config-dialog-text-input usage-log-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('usage.events.detail.searchPlaceholder')}
              aria-label={t('usage.events.detail.searchPlaceholder')}
            />
          </div>

          <div className="usage-log-detail-scroll">
            {loading ? (
              <div className="usage-log-loading">
                <Loader2 size={16} className="spin" aria-hidden="true" />
                <span>{t('usage.events.detail.loading')}</span>
              </div>
            ) : fetchError ? (
              <div className="usage-log-error-box">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>{privacy.text(fetchError)}</span>
              </div>
            ) : missing ? (
              <div className="usage-log-empty-stack">
                <EmptyState variant="compact">{t('usage.events.detail.missingLog')}</EmptyState>
                {recordedErrorDetail ? (
                  <LogSectionCard
                    title={t('usage.events.detail.recordedError')}
                    rawBody={recordedErrorDetail}
                    displayBody={recordedErrorDetail}
                    copyKey="missing-err"
                    copiedKey={copiedKey}
                    copyLabel={t('usage.events.detail.copy')}
                    onCopy={(text, key) => void copyText(text, key)}
                    maskText={privacy.text}
                  />
                ) : null}
              </div>
            ) : viewMode === 'raw' ? (
              rawVisibleText ? (
                <pre className="usage-log-code usage-log-code-raw">{privacy.text(rawVisibleText)}</pre>
              ) : (
                <EmptyState variant="compact">{t('usage.events.detail.noMatch')}</EmptyState>
              )
            ) : filteredSections.length === 0 ? (
              <EmptyState variant="compact">{t('usage.events.detail.noMatch')}</EmptyState>
            ) : (
              <div className="usage-log-sections">
                {filteredSections.map((section) => (
                  <LogSectionCard
                    key={section.index}
                    title={section.title}
                    rawBody={section.formatted || section.raw}
                    displayBody={section.formatted}
                    copyKey={`sec-${section.index}`}
                    copiedKey={copiedKey}
                    copyLabel={t('usage.events.detail.copy')}
                    onCopy={(text, key) => void copyText(text, key)}
                    ssePreview={section.ssePreview}
                    ssePreviewTitle={t('usage.events.detail.ssePreview')}
                    maskText={privacy.text}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="usage-log-detail-panel">
          <div className="usage-log-detail-scroll">
            <div className="usage-detail-grid">
              {metadataSections.map((section) => (
                <section key={section.key} className="usage-detail-card">
                  <h3>{section.title}</h3>
                  <dl className="usage-detail-dl">
                    {section.rows.map((row) => (
                      <div key={row.label} className="usage-detail-kv">
                        <dt>{row.label}</dt>
                        <dd className={row.mono ? 'is-mono' : undefined}>{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>

            {recordedErrorDetail ? (
              <LogSectionCard
                title={t('usage.events.detail.recordedError')}
                rawBody={recordedErrorDetail}
                displayBody={recordedErrorDetail}
                copyKey="meta-err"
                copiedKey={copiedKey}
                copyLabel={t('usage.events.detail.copy')}
                onCopy={(text, key) => void copyText(text, key)}
                maskText={privacy.text}
              />
            ) : null}

            <LogSectionCard
              title={t('usage.events.detail.secRawJson')}
              rawBody={rawJsonText}
              displayBody={rawJsonText}
              copyKey="meta-json"
              copiedKey={copiedKey}
              copyLabel={t('usage.events.detail.copy')}
              onCopy={(text, key) => void copyText(text, key)}
              maskText={privacy.text}
            />
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function EventsView({
  events,
  pageSize,
  query,
  onPage,
  onPageSizeChange,
  loading = false,
}: {
  events: UsageEventPage;
  pageSize: number;
  query: UsageEventQuery;
  onPage: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  loading?: boolean;
}) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const [widths, setWidths] = useState<Record<EventColumnKey, number>>(getInitialColumnWidths);
  const widthsRef = useRef(widths);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<EventColumnKey[]>(getInitialVisibleColumns);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [collapseErrors, setCollapseErrors] = useState(getInitialCollapseErrors);
  const [draftCollapseErrors, setDraftCollapseErrors] = useState(collapseErrors);
  const [speedMode, setCurrentSpeedMode] = useState<GenerationSpeedMode>(getSpeedMode);
  const [draftSpeedMode, setDraftSpeedMode] = useState<GenerationSpeedMode>(getSpeedMode);
  const [draftVisibleColumnKeys, setDraftVisibleColumnKeys] = useState<EventColumnKey[]>(visibleColumnKeys);
  const [resizingCol, setResizingCol] = useState<EventColumnKey | null>(null);
  const [exporting, setExporting] = useState(false);
  const [detailRecord, setDetailRecord] = useState<UsageRecord | null>(null);
  const feedback = useAppNotice();

  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>, record: UsageRecord) => {
    const target = event.target;
    if (target instanceof Element && target.closest('button, a, input, select, textarea, [role="button"]')) {
      return;
    }
    if (typeof window !== 'undefined' && window.getSelection()?.toString().trim()) {
      return;
    }
    setDetailRecord(record);
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, record: UsageRecord) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setDetailRecord(record);
    }
  };
  const copyError = async (detail: string) => {
    try {
      await navigator.clipboard.writeText(detail);
      feedback.showNotice({ key: 'usage.events.errorCopied' });
    } catch {
      feedback.showNotice({ key: 'common.copyFailed' }, 'error');
    }
  };

  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const visibleColumnKeySet = new Set(visibleColumnKeys);
  const visibleColumns = EVENT_COLUMNS.filter((column) => visibleColumnKeySet.has(column.key));
  const isCompactDefault = visibleColumns.length === DEFAULT_EVENT_VISIBLE_COLUMNS.length
    && DEFAULT_EVENT_VISIBLE_COLUMNS.every((key) => visibleColumnKeySet.has(key));
  const isCustomized = EVENT_COLUMNS.some((col) => widths[col.key] !== col.defaultWidth);
  const noRemarkLabel = t('usage.key.noRemark');

  const commitWidths = (next: Record<EventColumnKey, number>) => {
    widthsRef.current = next;
    setWidths(next);
  };

  const resetAllWidths = () => {
    const defaults: Record<EventColumnKey, number> = {} as any;
    for (const col of EVENT_COLUMNS) {
      defaults[col.key] = col.defaultWidth;
    }
    commitWidths(defaults);
    try {
      usagePreferences.setItem(EVENT_COL_WIDTHS_STORAGE_KEY, JSON.stringify(defaults));
    } catch {}
  };

  const openColumnSettings = () => {
    setDraftVisibleColumnKeys(visibleColumnKeys);
    setDraftCollapseErrors(collapseErrors);
    setDraftSpeedMode(speedMode);
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
      usagePreferences.setItem(EVENT_VISIBLE_COLS_STORAGE_KEY, JSON.stringify(next));
      usagePreferences.setItem(EVENT_COLLAPSE_ERRORS_KEY, draftCollapseErrors ? '1' : '0');
    } catch {}
    setCollapseErrors(draftCollapseErrors);
    setSpeedMode(draftSpeedMode);
    setCurrentSpeedMode(draftSpeedMode);
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
    const next = { ...widthsRef.current, [key]: colDef.defaultWidth };
    commitWidths(next);
    try {
      usagePreferences.setItem(EVENT_COL_WIDTHS_STORAGE_KEY, JSON.stringify(next));
    } catch {}
  };

  const persistColumnWidth = (key: EventColumnKey, width: number) => {
    const next = { ...widthsRef.current, [key]: width };
    commitWidths(next);
    try {
      usagePreferences.setItem(EVENT_COL_WIDTHS_STORAGE_KEY, JSON.stringify(next));
    } catch {}
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
      widthsRef.current[key] ?? EVENT_COLUMNS.find((c) => c.key === key)?.defaultWidth ?? 100;
    const colDef = EVENT_COLUMNS.find((c) => c.key === key);
    const minWidth = colDef?.minWidth ?? 50;
    const table = e.currentTarget.closest('table');
    const column = table?.querySelector<HTMLElement>(`col[data-column="${key}"]`) ?? null;
    const header = e.currentTarget.closest('th');

    setResizingCol(key);
    document.body.classList.add('table-col-resizing');

    let currentWidth = startWidth;
    let frame = 0;

    const paintWidth = (nextWidth: number) => {
      widthsRef.current = { ...widthsRef.current, [key]: nextWidth };
      if (column) column.style.width = `${nextWidth}px`;
      if (header) header.style.width = `${nextWidth}px`;
      if (table) {
        const total = visibleColumns.reduce(
          (sum, item) => sum + (widthsRef.current[item.key] ?? item.defaultWidth),
          0,
        );
        table.style.width = `${total}px`;
      }
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      currentWidth = Math.min(800, Math.max(minWidth, Math.round(startWidth + delta)));
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        paintWidth(currentWidth);
      });
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      if (frame) window.cancelAnimationFrame(frame);
      document.body.classList.remove('table-col-resizing');
      resizeCleanupRef.current = null;
    };

    const onPointerUp = () => {
      paintWidth(currentWidth);
      cleanup();
      setResizingCol(null);
      const next = widthsRef.current;
      setWidths(next);
      try {
        usagePreferences.setItem(EVENT_COL_WIDTHS_STORAGE_KEY, JSON.stringify(next));
      } catch {}
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    resizeCleanupRef.current = cleanup;
  };

  const totalTableWidth = visibleColumns.reduce(
    (sum, col) => sum + (widthsRef.current[col.key] ?? widths[col.key] ?? col.defaultWidth),
    0
  );

  const startRecordNum = events.total > 0 ? (events.page - 1) * pageSize + 1 : 0;
  const endRecordNum = Math.min(events.page * pageSize, events.total);

  const exportFilteredEvents = async () => {
    if (exporting || events.total === 0) return;
    setExporting(true);
    try {
      const path = await save({
        title: t('usage.events.exportDialogTitle'),
        defaultPath: usageEventsExportName(),
        filters: [{ name: t('usage.events.exportFileType'), extensions: ['csv'] }],
      });
      if (!path) return;
      const items: UsageRecord[] = [];
      const pageSize = 5000;
      for (let page = 1; ; page += 1) {
        const exported = await getUsageEvents({
          query: { ...query, page, page_size: pageSize },
        });
        if (exported.page !== page || exported.items.length === 0) break;
        items.push(...exported.items);
        if (items.length >= exported.total || page >= exported.totalPages) break;
      }
      await saveUsageEventsExport({ path, contents: usageEventsCsv(items) });
    } catch (error) {
      feedback.showNotice(String(error), 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className={`panel usage-events-panel usage-request-log${isCompactDefault ? ' usage-events-compact' : ''}${collapseErrors ? '' : ' usage-events-errors-expanded'}`} aria-label={t('usage.events.title')} aria-busy={loading}>
      <FloatingNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
      {loading && events.items.length === 0 ? <EmptyState className="usage-empty" role="status" icon={<Database size={20} />}>{t('usage.loading')}</EmptyState> : events.items.length ? (
        <div ref={tableWrapRef} className="usage-table-wrap" tabIndex={0} role="region" aria-label={t('usage.events.title')}>
          <table
            className="usage-events-table"
            style={{ width: `${totalTableWidth}px` }}
          >
            <colgroup>
              {visibleColumns.map((col) => (
                <col key={col.key} data-column={col.key} style={{ width: `${widthsRef.current[col.key] ?? widths[col.key]}px` }} />
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
                      style={{ width: `${widthsRef.current[col.key] ?? widths[col.key]}px` }}
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
                        aria-valuenow={widthsRef.current[col.key] ?? widths[col.key]}
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
              {events.items.map((record, index) => {
                const previousRecord = events.items[index - 1];
                const showDate = index === 0
                  || !previousRecord
                  || formatEventDate(previousRecord.timestamp) !== formatEventDate(record.timestamp);
                const detail = usageResultDetail(record);
                const selected = detailRecord?.row_id === record.row_id;
                return (
                  <Fragment key={record.row_id}>
                    <tr
                      className={`usage-event-row${selected ? ' is-selected' : ''}`}
                      tabIndex={0}
                      aria-haspopup="dialog"
                      aria-expanded={selected}
                      title={t('usage.events.detail.rowHint')}
                      onClick={(event) => handleRowClick(event, record)}
                      onKeyDown={(event) => handleRowKeyDown(event, record)}
                    >
                      {visibleColumns.map((column) => (
                        <UsageEventCell
                          key={column.key}
                          record={record}
                          columnKey={column.key}
                          noRemarkLabel={noRemarkLabel}
                          showDate={showDate}
                          compact={isCompactDefault}
                            speedMode={speedMode}
                          onCopyError={(detail) => void copyError(detail)}
                        />
                      ))}
                    </tr>
                    {!collapseErrors && detail ? (
                      <tr className="usage-event-error-row">
                        <td colSpan={visibleColumns.length}>
                          <div className="usage-event-error-message">{privacy.text(detail)}<CopyErrorButton detail={detail} onCopy={(value) => void copyError(value)} /></div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <UsageEmpty />
      )}

      {events.items.length > 0 ? <TableTopScrollbar tableWrapRef={tableWrapRef} /> : null}

      <div className="usage-events-footer">
        <div className="usage-events-footer-left">
          <span className="usage-pagination-summary">{t('usage.events.rangeSummary', { start: startRecordNum, end: endRecordNum, total: compactNumber(events.total) })}</span>
          <div className="usage-events-actions">
          <button
            type="button"
            className="secondary-button small-button usage-col-settings-btn"
            onClick={openColumnSettings}
            title={t('usage.events.columnSettings')}
            aria-label={t('usage.events.columnSettings')}
            aria-haspopup="dialog"
            aria-expanded={columnSettingsOpen}
          >
            <Columns3 size={16} aria-hidden="true" />
            <span>{t('usage.events.columns')}</span>
          </button>
          {isCustomized ? (
            <button
              type="button"
              className="secondary-button small-button usage-col-reset-btn"
              onClick={resetAllWidths}
              title={t('usage.events.resetColumns')}
              aria-label={t('usage.events.resetColumns')}
            >
              <RotateCcw size={14} aria-hidden="true" />
              <span>{t('usage.events.resetColumns')}</span>
            </button>
          ) : null}
          <button type="button" className="secondary-button small-button" disabled={loading || exporting || events.total === 0} onClick={() => void exportFilteredEvents()} title={t('usage.events.exportDescription')}>
            <Download size={14} aria-hidden="true" /><span>{exporting ? t('usage.events.exporting') : t('usage.events.exportPage')}</span>
          </button>
          </div>
        </div>
        <div className="usage-pagination-controls">
          <Select className="usage-page-size-select" value={pageSize} disabled={loading} onChange={(event) => onPageSizeChange(Number(event.currentTarget.value))} aria-label={t('usage.events.pageSize', { size: pageSize })}>
            {[20, 50, 100, 200].map((size) => <option key={size} value={size}>{t('usage.events.pageSize', { size })}</option>)}
          </Select>
          <div className="usage-pagination-right">
            <button type="button" className="secondary-button small-button" disabled={loading || events.page <= 1} onClick={() => onPage(events.page - 1)}><ChevronLeft size={14} aria-hidden="true" /><span>{t('usage.previous')}</span></button>
            <span className="usage-pagination-info">{events.page} / {Math.max(1, events.totalPages)}</span>
            <button type="button" className="secondary-button small-button" disabled={loading || events.page >= events.totalPages} onClick={() => onPage(events.page + 1)}><span>{t('usage.next')}</span><ChevronRight size={14} aria-hidden="true" /></button>
          </div>
        </div>
      </div>

      {columnSettingsOpen ? (
        <Dialog
          className="config-dialog usage-column-dialog"
          tabIndex={-1}
          labelledBy="usage-column-dialog-title"
          onClose={() => setColumnSettingsOpen(false)}
          dismissOnBackdrop
        >
          <div className="usage-column-dialog-heading">
            <div>
              <Columns3 size={19} aria-hidden="true" />
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
          <div className="usage-column-dialog-controls">
          <label className="usage-error-collapse-setting">
            <span>
              <strong>{t('usage.events.collapseErrors')}</strong>
              <small>{t('usage.events.collapseErrorsHint')}</small>
            </span>
            <Switch checked={draftCollapseErrors} aria-label={t('usage.events.collapseErrors')} onChange={(event) => setDraftCollapseErrors(event.currentTarget.checked)} />
          </label>
            <div className="usage-error-collapse-setting">
              <span>
                <strong>{t('usage.events.speedMode')}</strong>
                <small>{t('usage.events.speedModeHint')}</small>
              </span>
              <Select
                value={draftSpeedMode}
                onChange={(event) => setDraftSpeedMode(event.currentTarget.value as GenerationSpeedMode)}
                aria-label={t('usage.events.speedMode')}
              >
                <option value="total">{t('usage.events.speedModeTotal')}</option>
                <option value="ttft">{t('usage.events.speedModeTtft')}</option>
              </Select>
            </div>
          </div>
          <div className="usage-column-options">
            {EVENT_COLUMNS.map((column) => {
              const checked = draftVisibleColumnKeys.includes(column.key);
              return (
                <label key={column.key} className="usage-column-option">
                  <Checkbox checked={checked} disabled={checked && draftVisibleColumnKeys.length === 1} onChange={() => toggleDraftColumn(column.key)} />
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
                className="link-button muted usage-column-select-all"
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
        </Dialog>
      ) : null}

      {detailRecord ? (
        <UsageLogDetailModal
          record={detailRecord}
          speedMode={speedMode}
          onClose={() => setDetailRecord(null)}
          onNotice={feedback.showNotice}
        />
      ) : null}
    </section>
  );
}

function UsageEmpty() {
  const { t } = useI18n();
  return <EmptyState className="usage-empty" icon={<TriangleAlert size={18} />}>{t('usage.empty')}</EmptyState>;
}
