import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Columns3Cog,
  Database,
  FilterX,
  Key,
  Layers,
  List,
  Pencil,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { getCurrentLocale, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatCacheReadRate, formatGenerationSpeed } from '../services/usageMetrics';
import { formatUsageNumber } from '../services/usageNumber';

type UsageTab = 'overview' | 'analysis' | 'events' | 'pricing';
type UsageRange = '4h' | '24h' | 'today' | '7d' | '30d' | 'all' | 'custom';

type CollectorStatus = {
  state: 'waiting-core' | 'collecting' | 'error';
  message: string;
  lastCollectedAt: string | null;
  totalRecords: number;
};

type TimelinePoint = {
  hour: string;
  requests: number;
  success: number;
  failure: number;
  canceled: number;
  tokens: number;
};

type UsageOverview = {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  canceledCount: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  rpm: number;
  tpm: number;
  tps: number;
  averageLatencyMs: number;
  cacheHitRate: number;
  estimatedCost: number;
  pricedRequests: number;
  timeline: TimelinePoint[];
};

type UsageCategory = {
  key: string;
  label: string;
  requests: number;
  failures: number;
  tokens: number;
};

type UsageAnalysis = {
  models: UsageCategory[];
  providers: UsageCategory[];
  sources: UsageCategory[];
  apiKeys: UsageCategory[];
};

type UsageRecord = {
  id: string;
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
  model: string;
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

type UsageEventPage = {
  items: UsageRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type ModelPrice = {
  model: string;
  prompt: number;
  completion: number;
  cache: number;
  cacheRead: number;
  cacheCreation: number;
  promptConfigured: boolean;
  completionConfigured: boolean;
  cacheReadConfigured: boolean;
  cacheCreationConfigured: boolean;
  source: string;
  sourceModelId: string;
  updatedAtMs: number;
};

type UsagePriceRow = {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  estimatedCost: number;
  price: ModelPrice | null;
};

type UsagePricing = {
  rows: UsagePriceRow[];
  totalCost: number;
  totalRequests: number;
  pricedRequests: number;
  savedPrices: number;
};

type ModelPriceSyncResult = {
  imported: number;
  skipped: number;
  unmatched: string[];
  usedBuiltin: boolean;
};

type UsageQuery = {
  start?: string;
  end?: string;
  model?: string;
  provider?: string;
  source?: string;
  api_key_hash?: string;
  failed?: boolean;
  canceled?: boolean;
  page?: number;
  page_size?: number;
};

const TAB_KEY = 'cpa-gui.usage-records-tab.v1';
const RANGE_KEY = 'cpa-gui.usage-records-range.v1';
const emptyAnalysis: UsageAnalysis = { models: [], providers: [], sources: [], apiKeys: [] };

const loadTab = (): UsageTab => {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return saved === 'analysis' || saved === 'events' || saved === 'pricing' ? saved : 'overview';
  } catch {
    return 'overview';
  }
};

const loadRange = (): UsageRange => {
  try {
    const saved = localStorage.getItem(RANGE_KEY) as UsageRange | null;
    return ['4h', '24h', 'today', '7d', '30d', 'all', 'custom'].includes(saved ?? '')
      ? (saved as UsageRange)
      : '24h';
  } catch {
    return '24h';
  }
};

const rangeQuery = (range: UsageRange, customStart: string, customEnd: string): Pick<UsageQuery, 'start' | 'end'> => {
  const now = new Date();
  if (range === 'all') return {};
  if (range === 'custom') {
    const start = customStart ? new Date(customStart) : null;
    const end = customEnd ? new Date(customEnd) : null;
    return {
      start: start && !Number.isNaN(start.getTime()) ? start.toISOString() : undefined,
      end: end && !Number.isNaN(end.getTime()) ? end.toISOString() : undefined,
    };
  }
  if (range === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start: start.toISOString(), end: now.toISOString() };
  }
  const hours = range === '4h' ? 4 : range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30;
  return {
    start: new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString(),
    end: now.toISOString(),
  };
};

const compactNumber = (value: number) => formatUsageNumber(value, getCurrentLocale());

const formatUsd = (amount: number) => {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  const maximumFractionDigits =
    amount >= 100
      ? 2
      : amount >= 1
      ? 3
      : amount >= 0.01
      ? 4
      : amount >= 0.0001
      ? 6
      : 8;
  return `$${new Intl.NumberFormat(getCurrentLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(amount)}`;
};

const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(getCurrentLocale(), {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date);
};

const filterOptions = (items: UsageCategory[]) => items.filter((item) => item.key && item.label);

export function UsageRecordsPage() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<UsageTab>(loadTab);
  const [range, setRange] = useState<UsageRange>(loadRange);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [source, setSource] = useState('');
  const [apiKeyHash, setApiKeyHash] = useState('');
  const [result, setResult] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [analysis, setAnalysis] = useState<UsageAnalysis>(emptyAnalysis);
  const [optionsAnalysis, setOptionsAnalysis] = useState<UsageAnalysis>(emptyAnalysis);
  const [events, setEvents] = useState<UsageEventPage | null>(null);
  const [pricing, setPricing] = useState<UsagePricing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, activeTab);
    } catch {
      /* Keep in-memory */
    }
  }, [activeTab]);

  useEffect(() => {
    try {
      localStorage.setItem(RANGE_KEY, range);
    } catch {
      /* Keep in-memory */
    }
  }, [range]);

  const buildQueries = useCallback(() => {
    const nextTimeQuery = rangeQuery(range, customStart, customEnd);
    return {
      timeQuery: nextTimeQuery,
      query: {
        ...nextTimeQuery,
        model: model || undefined,
        provider: provider || undefined,
        source: source || undefined,
        api_key_hash: apiKeyHash || undefined,
        failed: result === 'failed' ? true : result === 'success' ? false : undefined,
        canceled: result === 'canceled' ? true : result === 'failed' ? false : undefined,
      } satisfies UsageQuery,
    };
  }, [apiKeyHash, customEnd, customStart, model, provider, range, result, source]);

  const loadData = useCallback(
    async (quiet = false) => {
      const requestId = ++requestIdRef.current;
      const { timeQuery, query } = buildQueries();
      if (!quiet) setLoading(true);
      try {
        const statusRequest = invoke<CollectorStatus>('get_usage_collector_status');
        const optionsRequest = invoke<UsageAnalysis>('get_usage_analysis', { query: timeQuery });
        if (activeTab === 'overview') {
          const [nextStatus, nextOptions, nextOverview] = await Promise.all([
            statusRequest,
            optionsRequest,
            invoke<UsageOverview>('get_usage_overview', { query }),
          ]);
          if (requestId !== requestIdRef.current) return;
          setStatus(nextStatus);
          setOptionsAnalysis(nextOptions);
          setOverview(nextOverview);
        } else if (activeTab === 'analysis') {
          const [nextStatus, nextOptions, nextOverview, nextAnalysis] = await Promise.all([
            statusRequest,
            optionsRequest,
            invoke<UsageOverview>('get_usage_overview', { query }),
            invoke<UsageAnalysis>('get_usage_analysis', { query }),
          ]);
          if (requestId !== requestIdRef.current) return;
          setStatus(nextStatus);
          setOptionsAnalysis(nextOptions);
          setOverview(nextOverview);
          setAnalysis(nextAnalysis);
        } else if (activeTab === 'events') {
          const [nextStatus, nextOptions, nextEvents] = await Promise.all([
            statusRequest,
            optionsRequest,
            invoke<UsageEventPage>('get_usage_events', {
              query: { ...query, page, page_size: pageSize },
            }),
          ]);
          if (requestId !== requestIdRef.current) return;
          setStatus(nextStatus);
          setOptionsAnalysis(nextOptions);
          setEvents(nextEvents);
        } else {
          const [nextStatus, nextOptions, nextPricing] = await Promise.all([
            statusRequest,
            optionsRequest,
            invoke<UsagePricing>('get_usage_pricing', { query }),
          ]);
          if (requestId !== requestIdRef.current) return;
          setStatus(nextStatus);
          setOptionsAnalysis(nextOptions);
          setPricing(nextPricing);
        }
        setError('');
      } catch (requestError) {
        if (requestId === requestIdRef.current) setError(String(requestError));
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [activeTab, buildQueries, page, pageSize]
  );

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const refresh = () => {
      if (!disposed && !document.hidden) void loadData(true);
    };
    listen('usage-records-updated', refresh)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    const timer = window.setInterval(refresh, 5_000);
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadData]);

  const changeFilter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };

  const hasActiveFilters = Boolean(
    model || provider || source || apiKeyHash || (result && result !== 'all') || range === 'custom'
  );

  const resetFilters = () => {
    setModel('');
    setProvider('');
    setSource('');
    setApiKeyHash('');
    setResult('all');
    if (range === 'custom') setRange('24h');
    setCustomStart('');
    setCustomEnd('');
    setPage(1);
  };

  const collectorTone = status?.state === 'error' ? 'error' : status?.state === 'collecting' ? 'success' : '';
  const showInitialLoading =
    loading &&
    ((activeTab === 'overview' && !overview) ||
      (activeTab === 'analysis' && !overview) ||
      (activeTab === 'events' && !events) ||
      (activeTab === 'pricing' && !pricing));

  return (
    <section className="page management-page usage-records-page">
      {error ? <div className="management-alert error">{error}</div> : null}

      <div className="usage-topbar">
        <div className="usage-tabs" role="tablist" aria-label={t('usage.pageLabel')}>
          <button
            type="button"
            className={activeTab === 'overview' ? 'active' : ''}
            onClick={() => setActiveTab('overview')}
          >
            <BarChart3 size={15} />
            <span>{t('usage.tab.overview')}</span>
          </button>
          <button
            type="button"
            className={activeTab === 'analysis' ? 'active' : ''}
            onClick={() => setActiveTab('analysis')}
          >
            <Activity size={15} />
            <span>{t('usage.tab.analysis')}</span>
          </button>
          <button
            type="button"
            className={activeTab === 'events' ? 'active' : ''}
            onClick={() => setActiveTab('events')}
          >
            <List size={15} />
            <span>{t('usage.tab.events')}</span>
          </button>
          <button
            type="button"
            className={activeTab === 'pricing' ? 'active' : ''}
            onClick={() => setActiveTab('pricing')}
          >
            <CircleDollarSign size={15} />
            <span>{t('usage.tab.pricing')}</span>
          </button>
        </div>

        <div className="usage-topbar-actions">
          <div className={`usage-collector-state ${collectorTone}`} title={status?.message}>
            <span className="status-dot" />
            <strong>
              {status?.state === 'collecting'
                ? t('usage.collector.collecting')
                : status?.state === 'error'
                ? t('usage.collector.error')
                : t('usage.collector.waiting')}
            </strong>
            <span>{t('usage.longTermRecords', { count: compactNumber(status?.totalRecords ?? 0) })}</span>
          </div>
          <button
            type="button"
            className="icon-button usage-refresh-btn"
            onClick={() => void loadData(false)}
            disabled={loading}
            title={t('usage.refresh')}
            aria-label={t('usage.refresh')}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <section className="panel usage-filter-panel">
        <div className="usage-filter-row">
          <div className="usage-filter-group">
            <label className="usage-filter-item">
              <span className="usage-filter-label">
                <Clock3 size={13} />
                {t('usage.filter.timeRange')}
              </span>
              <select
                value={range}
                onChange={(event) => {
                  setRange(event.currentTarget.value as UsageRange);
                  setPage(1);
                }}
                aria-label={t('usage.filter.timeRange')}
              >
                <option value="4h">{t('usage.range.4h')}</option>
                <option value="24h">{t('usage.range.24h')}</option>
                <option value="today">{t('usage.range.today')}</option>
                <option value="7d">{t('usage.range.7d')}</option>
                <option value="30d">{t('usage.range.30d')}</option>
                <option value="all">{t('usage.range.all')}</option>
                <option value="custom">{t('usage.range.custom')}</option>
              </select>
            </label>

            <label className="usage-filter-item">
              <span className="usage-filter-label">
                <Sparkles size={13} />
                {t('usage.filter.model')}
              </span>
              <select
                value={model}
                onChange={(event) => changeFilter(setModel, event.currentTarget.value)}
                aria-label={t('usage.filter.model')}
              >
                <option value="">{t('usage.filter.allModels')}</option>
                {filterOptions(optionsAnalysis.models).map((item) => (
                  <option value={item.key} key={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="usage-filter-item">
              <span className="usage-filter-label">
                <Layers size={13} />
                Provider
              </span>
              <select
                value={provider}
                onChange={(event) => changeFilter(setProvider, event.currentTarget.value)}
                aria-label="Provider"
              >
                <option value="">{t('usage.filter.allProviders')}</option>
                {filterOptions(optionsAnalysis.providers).map((item) => (
                  <option value={item.key} key={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="usage-filter-item">
              <span className="usage-filter-label">
                <Terminal size={13} />
                {t('usage.filter.source')}
              </span>
              <select
                value={source}
                onChange={(event) => changeFilter(setSource, event.currentTarget.value)}
                aria-label={t('usage.filter.source')}
              >
                <option value="">{t('usage.filter.allSources')}</option>
                {filterOptions(optionsAnalysis.sources).map((item) => (
                  <option value={item.key} key={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="usage-filter-item">
              <span className="usage-filter-label">
                <Key size={13} />
                API Key
              </span>
              <select
                value={apiKeyHash}
                onChange={(event) => changeFilter(setApiKeyHash, event.currentTarget.value)}
                aria-label="API Key"
              >
                <option value="">{t('usage.filter.allKeys')}</option>
                {filterOptions(optionsAnalysis.apiKeys).map((item) => (
                  <option value={item.key} key={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="usage-filter-item">
              <span className="usage-filter-label">
                <ShieldCheck size={13} />
                {t('usage.filter.result')}
              </span>
              <select
                value={result}
                onChange={(event) => changeFilter(setResult, event.currentTarget.value)}
                aria-label={t('usage.filter.result')}
              >
                <option value="all">{t('usage.filter.allResults')}</option>
                <option value="success">{t('usage.result.success')}</option>
                <option value="failed">{t('usage.result.failed')}</option>
                <option value="canceled">{t('usage.result.canceled')}</option>
              </select>
            </label>
          </div>

          {hasActiveFilters ? (
            <button
              type="button"
              className="usage-filter-reset-btn"
              onClick={resetFilters}
              title={t('usage.filter.reset')}
            >
              <FilterX size={14} />
              <span>{t('usage.filter.reset')}</span>
            </button>
          ) : null}
        </div>

        {range === 'custom' ? (
          <div className="usage-custom-range">
            <input
              type="datetime-local"
              value={customStart}
              onChange={(event) => setCustomStart(event.currentTarget.value)}
              aria-label={t('usage.filter.startTime')}
            />
            <span>{t('usage.filter.to')}</span>
            <input
              type="datetime-local"
              value={customEnd}
              onChange={(event) => setCustomEnd(event.currentTarget.value)}
              aria-label={t('usage.filter.endTime')}
            />
          </div>
        ) : null}
      </section>

      {showInitialLoading ? (
        <div className="usage-initial-loading">
          <Database size={22} />
          <span>{t('usage.loading')}</span>
        </div>
      ) : null}

      {activeTab === 'overview' && overview ? <OverviewView overview={overview} /> : null}
      {activeTab === 'analysis' ? <AnalysisView analysis={analysis} overview={overview} /> : null}
      {activeTab === 'events' && events ? (
        <EventsView
          events={events}
          pageSize={pageSize}
          onPage={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      ) : null}
      {activeTab === 'pricing' && pricing ? (
        <PricingView pricing={pricing} query={buildQueries().query} onChanged={() => loadData(true)} />
      ) : null}
    </section>
  );
}

function OverviewView({ overview }: { overview: UsageOverview }) {
  const { t } = useI18n();
  const cards = [
    {
      label: t('usage.stat.requests'),
      value: compactNumber(overview.totalRequests),
      meta: t('usage.stat.requestMeta', {
        success: compactNumber(overview.successCount),
        failed: compactNumber(overview.failureCount),
        canceled: compactNumber(overview.canceledCount),
      }),
      metaTitle: t('usage.stat.requestMetaTitle', {
        total: compactNumber(overview.totalRequests),
        success: compactNumber(overview.successCount),
        failed: compactNumber(overview.failureCount),
        canceled: compactNumber(overview.canceledCount),
      }),
    },
    {
      label: t('usage.stat.tokens'),
      value: compactNumber(overview.totalTokens),
      meta: t('usage.stat.tokenMeta', {
        input: compactNumber(overview.inputTokens),
        output: compactNumber(overview.outputTokens),
      }),
      metaTitle: t('usage.stat.tokenMetaTitle', {
        input: compactNumber(overview.inputTokens),
        output: compactNumber(overview.outputTokens),
        reasoning: compactNumber(overview.reasoningTokens),
        cache: compactNumber(overview.cacheReadTokens),
      }),
    },
    {
      label: t('usage.stat.successRate'),
      value: `${overview.successRate.toFixed(1)}%`,
      meta: t('usage.stat.successMeta', {
        success: compactNumber(overview.successCount),
        failed: compactNumber(overview.failureCount),
      }),
      metaTitle: t('usage.stat.successMetaTitle', {
        success: compactNumber(overview.successCount),
        failed: compactNumber(overview.failureCount),
        canceled: compactNumber(overview.canceledCount),
      }),
    },
    {
      label: t('usage.stat.tps'),
      value: `${overview.tps.toFixed(1)} TPS`,
      meta: t('usage.stat.performanceMeta', {
        rpm: overview.rpm.toFixed(2),
        latency: Math.round(overview.averageLatencyMs),
      }),
      metaTitle: t('usage.stat.performanceMetaTitle', {
        tps: overview.tps.toFixed(1),
        rpm: overview.rpm.toFixed(2),
        latency: Math.round(overview.averageLatencyMs),
      }),
    },
    {
      label: t('usage.stat.cacheHitRate'),
      value: `${(overview.cacheHitRate * 100).toFixed(1)}%`,
      meta: t('usage.stat.cacheHitMeta', {
        hit: compactNumber(overview.cacheReadTokens),
        input: compactNumber(overview.inputTokens),
      }),
      metaTitle: t('usage.stat.cacheHitMetaTitle', {
        rate: (overview.cacheHitRate * 100).toFixed(1),
        hit: compactNumber(overview.cacheReadTokens),
        input: compactNumber(overview.inputTokens),
      }),
    },
    {
      label: t('usage.stat.estimatedCost'),
      value: formatUsd(overview.estimatedCost),
      meta: t('usage.stat.costMeta', {
        priced: compactNumber(overview.pricedRequests),
        total: compactNumber(overview.totalRequests),
      }),
      metaTitle: t('usage.stat.costMetaTitle', {
        priced: compactNumber(overview.pricedRequests),
        total: compactNumber(overview.totalRequests),
        unpriced: compactNumber(Math.max(overview.totalRequests - overview.pricedRequests, 0)),
      }),
    },
  ];

  return (
    <div className="usage-overview-layout">
      <div className="usage-stat-grid">
        {cards.map(({ label, value, meta, metaTitle }) => (
          <article className="panel usage-stat-card" key={label}>
            <span className="usage-stat-card-label">{label}</span>
            <strong className="usage-stat-card-value">{value}</strong>
            <small className="usage-stat-card-meta" title={metaTitle ?? meta}>
              {meta}
            </small>
          </article>
        ))}
      </div>
      <section className="panel usage-trend-panel">
        <div className="usage-section-heading">
          <div>
            <strong>{t('usage.trend.title')}</strong>
            <span>{t('usage.trend.description')}</span>
          </div>
        </div>
        {overview.timeline.length ? <UsageTrend points={overview.timeline} /> : <UsageEmpty />}
      </section>
      <section className="panel usage-health-panel">
        <div className="usage-section-heading">
          <div>
            <strong>{t('usage.token.title')}</strong>
            <span>{t('usage.token.description')}</span>
          </div>
        </div>
        <div className="usage-token-breakdown">
          <TokenMetric
            label={t('usage.token.input')}
            value={overview.inputTokens}
            total={overview.totalTokens}
            tone="input"
          />
          <TokenMetric
            label={t('usage.token.output')}
            value={overview.outputTokens}
            total={overview.totalTokens}
            tone="output"
          />
          <TokenMetric
            label={t('usage.token.reasoning')}
            value={overview.reasoningTokens}
            total={overview.totalTokens}
            tone="reasoning"
          />
          <TokenMetric
            label={t('usage.token.cacheRead')}
            value={overview.cacheReadTokens}
            total={overview.totalTokens}
            tone="cache-read"
          />
          <TokenMetric
            label={t('usage.token.cacheCreation')}
            value={overview.cacheCreationTokens}
            total={overview.totalTokens}
            tone="cache-creation"
          />
        </div>
      </section>
    </div>
  );
}

function UsageTrend({ points }: { points: TimelinePoint[] }) {
  const { t } = useI18n();
  const recent = points.slice(-48);
  const max = Math.max(...recent.map((point) => point.requests), 1);
  const totalTokens = recent.reduce((sum, point) => sum + point.tokens, 0);
  const totalReqs = recent.reduce((sum, point) => sum + point.requests, 0);

  const pointsCoords = recent.map((point, index) => {
    const x = recent.length <= 1 ? 50 : (index * 100) / (recent.length - 1);
    const y = 28 - (point.requests * 24) / max;
    return { x, y, point };
  });

  const polyline = pointsCoords.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath =
    pointsCoords.length > 0
      ? `M 0,32 L ${pointsCoords[0].x.toFixed(1)},${pointsCoords[0].y.toFixed(1)} ` +
        pointsCoords.map((p) => `L ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') +
        ` L 100,32 Z`
      : '';

  return (
    <div className="usage-trend-wrapper">
      <div className="usage-trend-header-meta">
        <span className="usage-trend-chip">
          <strong>{compactNumber(totalReqs)}</strong> requests
        </span>
        <span className="usage-trend-chip">
          <strong>{compactNumber(totalTokens)}</strong> tokens
        </span>
      </div>
      <div className="usage-trend">
        <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-label={t('usage.trend.aria')}>
          <defs>
            <linearGradient id="usageTrendGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--theme-3f6f98)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--theme-3f6f98)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <line x1="0" y1="8" x2="100" y2="8" stroke="var(--theme-eeeae2)" strokeDasharray="2,2" vectorEffect="non-scaling-stroke" />
          <line x1="0" y1="18" x2="100" y2="18" stroke="var(--theme-eeeae2)" strokeDasharray="2,2" vectorEffect="non-scaling-stroke" />
          <line x1="0" y1="28" x2="100" y2="28" stroke="var(--theme-eeeae2)" strokeDasharray="2,2" vectorEffect="non-scaling-stroke" />
          {areaPath ? <path d={areaPath} fill="url(#usageTrendGrad)" /> : null}
          <polyline points={polyline} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="usage-trend-labels">
          <span>{recent[0]?.hour ?? ''}</span>
          {recent.length > 2 ? <span>{recent[Math.floor(recent.length / 2)]?.hour ?? ''}</span> : null}
          <span>{recent[recent.length - 1]?.hour ?? ''}</span>
        </div>
      </div>
    </div>
  );
}

function TokenMetric({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: 'input' | 'output' | 'reasoning' | 'cache-read' | 'cache-creation';
}) {
  const percent = total ? Math.min((value * 100) / total, 100) : 0;
  return (
    <div className={`usage-token-row tone-${tone}`}>
      <div className="usage-token-info">
        <strong className="usage-token-name">{label}</strong>
        <div className="usage-token-vals">
          <span className="usage-token-count">{compactNumber(value)}</span>
          <span className="usage-token-pct">{percent.toFixed(1)}%</span>
        </div>
      </div>
      <div className="usage-token-bar-track">
        <div className="usage-token-bar-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function AnalysisView({ analysis, overview }: { analysis: UsageAnalysis; overview: UsageOverview | null }) {
  const { t } = useI18n();
  const hours = (overview?.timeline ?? [])
    .map((point) => ({
      key: point.hour,
      label: point.hour,
      requests: point.requests,
      failures: point.failure,
      tokens: point.tokens,
    }))
    .sort((left, right) => right.tokens - left.tokens);
  return (
    <div className="usage-analysis-grid">
      <CategoryPanel title={t('usage.analysis.models')} items={analysis.models} />
      <CategoryPanel title="Provider" items={analysis.providers} />
      <CategoryPanel title={t('usage.analysis.sources')} items={analysis.sources} compactLabels />
      <CategoryPanel title={t('usage.analysis.keys')} items={analysis.apiKeys} />
      <CategoryPanel title={t('usage.analysis.hours')} items={hours} />
    </div>
  );
}

function CategoryPanel({
  title,
  items,
  compactLabels = false,
}: {
  title: string;
  items: UsageCategory[];
  compactLabels?: boolean;
}) {
  const { t } = useI18n();
  const max = Math.max(...items.map((item) => item.tokens), 1);
  const total = items.reduce((sum, item) => sum + item.tokens, 0);
  return (
    <section className={`panel usage-category-panel${compactLabels ? ' compact-labels' : ''}`}>
      <div className="usage-section-heading">
        <div>
          <strong>{title}</strong>
          <span>{t('usage.analysis.sortedByTokens')}</span>
        </div>
      </div>
      {items.length ? (
        <div className="usage-category-list">
          {items.slice(0, 10).map((item, idx) => {
            const percent = total ? ((item.tokens * 100) / total).toFixed(1) : '0.0';
            return (
              <div key={item.key} className="usage-category-row">
                <div className="usage-category-header">
                  <div className="usage-category-label-wrap">
                    <span className={`usage-rank-badge${idx < 3 ? ' top' : ''}`}>{idx + 1}</span>
                    <strong className="usage-category-name" title={item.label}>
                      {item.label}
                    </strong>
                  </div>
                  <small className="usage-category-meta">
                    <span>{compactNumber(item.requests)} requests</span>
                    <span className="usage-category-pct">{percent}%</span>
                    <strong>{compactNumber(item.tokens)} Token</strong>
                  </small>
                </div>
                <div className="usage-category-track">
                  <div className="usage-category-fill" style={{ width: `${(item.tokens * 100) / max}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <UsageEmpty />
      )}
    </section>
  );
}

type EventColumnKey =
  | 'time'
  | 'model'
  | 'provider'
  | 'source'
  | 'key'
  | 'input'
  | 'output'
  | 'reasoning'
  | 'cache'
  | 'total'
  | 'result'
  | 'latency'
  | 'ttft'
  | 'speed'
  | 'cacheRate';

type EventColumnDef = {
  key: EventColumnKey;
  labelKey: MessageKey;
  defaultWidth: number;
  minWidth: number;
  align: 'left' | 'center' | 'right';
};

const EVENT_COLUMNS: readonly EventColumnDef[] = [
  { key: 'time', labelKey: 'usage.column.time', defaultWidth: 150, minWidth: 110, align: 'center' },
  { key: 'model', labelKey: 'usage.column.model', defaultWidth: 190, minWidth: 120, align: 'center' },
  { key: 'input', labelKey: 'usage.column.input', defaultWidth: 84, minWidth: 60, align: 'center' },
  { key: 'output', labelKey: 'usage.column.output', defaultWidth: 84, minWidth: 60, align: 'center' },
  { key: 'cache', labelKey: 'usage.column.cache', defaultWidth: 84, minWidth: 60, align: 'center' },
  { key: 'cacheRate', labelKey: 'usage.column.cacheRate', defaultWidth: 92, minWidth: 70, align: 'center' },
  { key: 'total', labelKey: 'usage.column.total', defaultWidth: 90, minWidth: 65, align: 'center' },
  { key: 'speed', labelKey: 'usage.column.speed', defaultWidth: 104, minWidth: 80, align: 'center' },
  { key: 'ttft', labelKey: 'usage.column.ttft', defaultWidth: 100, minWidth: 75, align: 'center' },
  { key: 'latency', labelKey: 'usage.column.latency', defaultWidth: 100, minWidth: 75, align: 'center' },
  { key: 'result', labelKey: 'usage.column.result', defaultWidth: 150, minWidth: 100, align: 'center' },
  { key: 'provider', labelKey: 'usage.column.provider', defaultWidth: 120, minWidth: 80, align: 'center' },
  { key: 'source', labelKey: 'usage.column.source', defaultWidth: 120, minWidth: 80, align: 'center' },
  { key: 'key', labelKey: 'usage.column.key', defaultWidth: 145, minWidth: 95, align: 'center' },
  { key: 'reasoning', labelKey: 'usage.column.reasoning', defaultWidth: 84, minWidth: 60, align: 'center' },
] as const;

const DEFAULT_EVENT_VISIBLE_COLUMNS: readonly EventColumnKey[] = [
  'time',
  'model',
  'input',
  'output',
  'cache',
  'cacheRate',
  'total',
  'speed',
  'ttft',
  'latency',
  'result',
  'provider',
  'source',
];

const EVENT_COL_WIDTHS_STORAGE_KEY = 'cpa-gui.usage-events-col-widths.v1';
const EVENT_VISIBLE_COLS_STORAGE_KEY = 'cpa-gui.usage-events-visible-cols.v2';

const getAllEventColumnKeys = () => EVENT_COLUMNS.map((column) => column.key);

const getInitialVisibleColumns = (): EventColumnKey[] => {
  try {
    const raw = localStorage.getItem(EVENT_VISIBLE_COLS_STORAGE_KEY);
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
        if (savedKeys.length > 0) return savedKeys;
      }
    }
  } catch {
    // fallback to defaults
  }
  return [...DEFAULT_EVENT_VISIBLE_COLUMNS];
};

const getInitialColumnWidths = (): Record<EventColumnKey, number> => {
  const initial: Record<EventColumnKey, number> = {} as any;
  for (const col of EVENT_COLUMNS) {
    initial[col.key] = col.defaultWidth;
  }
  try {
    const raw = localStorage.getItem(EVENT_COL_WIDTHS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const col of EVENT_COLUMNS) {
          if (
            typeof parsed[col.key] === 'number' &&
            Number.isFinite(parsed[col.key]) &&
            parsed[col.key] >= col.minWidth
          ) {
            initial[col.key] = Math.round(parsed[col.key]);
          }
        }
      }
    }
  } catch {
    // fallback to defaults
  }
  return initial;
};

function TableTopScrollbar({
  tableWrapRef,
  totalWidth,
  visibleColumnKeys,
}: {
  tableWrapRef: React.RefObject<HTMLDivElement | null>;
  totalWidth: number;
  visibleColumnKeys: EventColumnKey[];
}) {
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [scrollWidth, setScrollWidth] = useState(totalWidth);

  useEffect(() => {
    const scrollbar = scrollbarRef.current;
    const tableWrap = tableWrapRef.current;
    if (!scrollbar || !tableWrap) return;

    let syncing = false;

    const syncTable = () => {
      if (syncing) return;
      syncing = true;
      tableWrap.scrollLeft = scrollbar.scrollLeft;
      window.requestAnimationFrame(() => {
        syncing = false;
      });
    };

    const syncScrollbar = () => {
      if (syncing) return;
      syncing = true;
      scrollbar.scrollLeft = tableWrap.scrollLeft;
      window.requestAnimationFrame(() => {
        syncing = false;
      });
    };

    const updateLayout = () => {
      const clientWidth = tableWrap.clientWidth;
      const wrapScrollWidth = tableWrap.scrollWidth;
      const maxScroll = Math.max(0, wrapScrollWidth - clientWidth);
      const isOverflowing = maxScroll > 1;

      setHasOverflow(isOverflowing);

      if (isOverflowing) {
        const scrollbarClientWidth = scrollbar.clientWidth || clientWidth;
        const targetInnerWidth = scrollbarClientWidth + maxScroll;
        setScrollWidth(targetInnerWidth);

        if (tableWrap.scrollLeft > maxScroll) {
          tableWrap.scrollLeft = maxScroll;
        }
        scrollbar.scrollLeft = tableWrap.scrollLeft;
      } else {
        tableWrap.scrollLeft = 0;
        scrollbar.scrollLeft = 0;
        setScrollWidth(clientWidth);
      }
    };

    updateLayout();
    const frameId = window.requestAnimationFrame(updateLayout);

    scrollbar.addEventListener('scroll', syncTable, { passive: true });
    tableWrap.addEventListener('scroll', syncScrollbar, { passive: true });

    const resizeObserver = new ResizeObserver(() => {
      updateLayout();
    });
    resizeObserver.observe(tableWrap);
    resizeObserver.observe(scrollbar);

    return () => {
      window.cancelAnimationFrame(frameId);
      scrollbar.removeEventListener('scroll', syncTable);
      tableWrap.removeEventListener('scroll', syncScrollbar);
      resizeObserver.disconnect();
    };
  }, [tableWrapRef, totalWidth, visibleColumnKeys]);

  return (
    <div
      ref={scrollbarRef}
      className={`usage-table-top-scrollbar ${hasOverflow ? '' : 'is-hidden'}`}
      aria-hidden="true"
    >
      <div style={{ width: `${scrollWidth}px`, height: '1px' }} />
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
    <td className="usage-result-cell align-center" title={detail || t(`usage.result.${state}`)}>
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
  switch (columnKey) {
    case 'time':
      return (
        <td className="usage-td-time align-center" title={new Date(record.timestamp).toLocaleString()}>
          {formatTime(record.timestamp)}
        </td>
      );
    case 'model':
      return (
        <td className="usage-stacked-cell align-center">
          <strong title={record.alias || record.model}>{record.alias || record.model}</strong>
          <small title={record.reasoning_effort || 'auto'}>{record.reasoning_effort || 'auto'}</small>
        </td>
      );
    case 'provider':
      return (
        <td className="usage-td-provider align-center" title={record.provider || undefined}>
          <span className="usage-tag-pill">{record.provider || '—'}</span>
        </td>
      );
    case 'source':
      return (
        <td className="usage-td-source align-center" title={record.source_display || record.source || undefined}>
          <span className="usage-tag-pill">{record.source_display || record.source || '—'}</span>
        </td>
      );
    case 'key':
      return (
        <td className="usage-stacked-cell align-center">
          <strong title={record.api_key_remark}>{record.api_key_remark || noRemarkLabel}</strong>
          <small title={record.api_key_display || undefined}>{record.api_key_display || '—'}</small>
        </td>
      );
    case 'input':
      return (
        <td className="usage-td-token align-center" title={`${record.tokens.input_tokens.toLocaleString()} tokens`}>
          {compactNumber(record.tokens.input_tokens)}
        </td>
      );
    case 'output':
      return (
        <td className="usage-td-token align-center" title={`${record.tokens.output_tokens.toLocaleString()} tokens`}>
          {compactNumber(record.tokens.output_tokens)}
        </td>
      );
    case 'reasoning':
      return (
        <td className="usage-td-token align-center" title={`${record.tokens.reasoning_tokens.toLocaleString()} tokens`}>
          {compactNumber(record.tokens.reasoning_tokens)}
        </td>
      );
    case 'cache':
      return (
        <td
          className="usage-td-token align-center"
          title={`Read: ${record.tokens.cache_read_tokens.toLocaleString()} tokens${
            record.tokens.cache_creation_tokens > 0
              ? ` / Creation: ${record.tokens.cache_creation_tokens.toLocaleString()} tokens`
              : ''
          }`}
        >
          {compactNumber(record.tokens.cache_read_tokens)}
        </td>
      );
    case 'cacheRate': {
      const value = formatCacheReadRate({
        inputTokens: record.tokens.input_tokens,
        cacheReadTokens: record.tokens.cache_read_tokens,
      });
      return <td className="usage-td-cache-rate align-center" title={value === '—' ? undefined : value}>{value}</td>;
    }
    case 'total':
      return (
        <td className="usage-td-token align-center" title={`${record.tokens.total_tokens.toLocaleString()} tokens`}>
          <strong>{compactNumber(record.tokens.total_tokens)}</strong>
        </td>
      );
    case 'result':
      return <UsageResultCell record={record} />;
    case 'latency':
      return (
        <td className="usage-td-latency align-center" title={`${record.latency_ms} ms`}>
          {compactNumber(record.latency_ms)} ms
        </td>
      );
    case 'ttft':
      return (
        <td className="usage-td-ttft align-center" title={record.ttft_ms == null ? undefined : `${record.ttft_ms} ms`}>
          {record.ttft_ms == null ? '—' : `${compactNumber(record.ttft_ms)} ms`}
        </td>
      );
    case 'speed': {
      const value = formatGenerationSpeed({
        outputTokens: record.tokens.output_tokens,
        latencyMs: record.latency_ms,
        ttftMs: record.ttft_ms,
      });
      return <td className="usage-td-speed align-center" title={value === '—' ? undefined : value}>{value}</td>;
    }
  }
}

function EventsView({
  events,
  pageSize,
  onPage,
  onPageSizeChange,
}: {
  events: UsageEventPage;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const { t } = useI18n();
  const [widths, setWidths] = useState<Record<EventColumnKey, number>>(getInitialColumnWidths);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<EventColumnKey[]>(getInitialVisibleColumns);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [draftVisibleColumnKeys, setDraftVisibleColumnKeys] = useState<EventColumnKey[]>(visibleColumnKeys);
  const [resizingCol, setResizingCol] = useState<EventColumnKey | null>(null);

  const columnDialogRef = useRef<HTMLElement | null>(null);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);

  const visibleColumnKeySet = new Set(visibleColumnKeys);
  const visibleColumns = EVENT_COLUMNS.filter((column) => visibleColumnKeySet.has(column.key));
  const isCustomized = EVENT_COLUMNS.some((col) => widths[col.key] !== col.defaultWidth);
  const noRemarkLabel = t('usage.key.noRemark');

  useEffect(() => {
    if (columnSettingsOpen) columnDialogRef.current?.focus();
  }, [columnSettingsOpen]);

  const resetAllWidths = () => {
    const defaults: Record<EventColumnKey, number> = {} as any;
    for (const col of EVENT_COLUMNS) {
      defaults[col.key] = col.defaultWidth;
    }
    setWidths(defaults);
    try {
      localStorage.removeItem(EVENT_COL_WIDTHS_STORAGE_KEY);
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

  const handleResizeStart = (key: EventColumnKey, e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

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
      const nextWidth = Math.max(minWidth, Math.round(startWidth + delta));
      currentWidth = nextWidth;
      setWidths((prev) => ({ ...prev, [key]: nextWidth }));
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      document.body.classList.remove('table-col-resizing');
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
  };

  const totalTableWidth = visibleColumns.reduce(
    (sum, col) => sum + (widths[col.key] ?? col.defaultWidth),
    0
  );

  const startRecordNum = events.total > 0 ? (events.page - 1) * pageSize + 1 : 0;
  const endRecordNum = Math.min(events.page * pageSize, events.total);

  return (
    <section className="panel usage-events-panel">
      <div className="usage-events-summary">
        <div className="usage-events-summary-left">
          <span className="usage-events-count-badge">
            {t('usage.events.total', { count: compactNumber(events.total) })}
          </span>
          <span className="usage-pagination-summary">
            {t('usage.events.rangeSummary', {
              start: startRecordNum,
              end: endRecordNum,
              total: compactNumber(events.total),
            })}
          </span>
        </div>

        <div className="usage-events-summary-right">
          <select
            className="usage-page-size-select"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.currentTarget.value))}
            aria-label={t('usage.events.pageSize', { size: pageSize })}
          >
            <option value="20">{t('usage.events.pageSize', { size: 20 })}</option>
            <option value="50">{t('usage.events.pageSize', { size: 50 })}</option>
            <option value="100">{t('usage.events.pageSize', { size: 100 })}</option>
            <option value="200">{t('usage.events.pageSize', { size: 200 })}</option>
          </select>

          <div className="usage-pagination-right usage-pagination-top">
            <button
              type="button"
              className="usage-page-nav-btn"
              disabled={events.page <= 1}
              onClick={() => onPage(events.page - 1)}
            >
              <ChevronLeft size={14} />
              <span>{t('usage.previous')}</span>
            </button>
            <span className="usage-pagination-info">
              {events.page} / {events.totalPages}
            </span>
            <button
              type="button"
              className="usage-page-nav-btn"
              disabled={events.page >= events.totalPages}
              onClick={() => onPage(events.page + 1)}
            >
              <span>{t('usage.next')}</span>
              <ChevronRight size={14} />
            </button>
          </div>

          <button
            type="button"
            className="usage-col-settings-btn"
            onClick={openColumnSettings}
            title={t('usage.events.columnSettings')}
          >
            <Columns3Cog size={14} />
            <span>{t('usage.events.columnSettings')}</span>
          </button>
          {isCustomized ? (
            <button
              type="button"
              className="usage-col-reset-btn icon-only"
              onClick={resetAllWidths}
              title={t('usage.events.resetColumns')}
              aria-label={t('usage.events.resetColumns')}
            >
              <RotateCcw size={13} />
            </button>
          ) : null}
        </div>
      </div>

      {events.items.length > 0 ? (
        <TableTopScrollbar
          tableWrapRef={tableWrapRef}
          totalWidth={totalTableWidth}
          visibleColumnKeys={visibleColumnKeys}
        />
      ) : null}

      {events.items.length ? (
        <div ref={tableWrapRef} className="usage-table-wrap">
          <table
            className="usage-events-table"
            style={{ width: `max(100%, ${totalTableWidth}px)` }}
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
                        onPointerDown={(e) => handleResizeStart(col.key, e)}
                        onDoubleClick={(e) => resetSingleColumn(col.key, e)}
                        title={t('usage.events.resizeHint')}
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {events.items.map((record) => (
                <tr key={record.id}>
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

type PriceDraft = {
  model: string;
  prompt: string;
  completion: string;
  cache: string;
  cacheRead: string;
  cacheCreation: string;
};

const emptyPriceDraft = (): PriceDraft => ({
  model: '',
  prompt: '',
  completion: '',
  cache: '',
  cacheRead: '',
  cacheCreation: '',
});
const priceDraftFor = (model = '', price?: ModelPrice | null): PriceDraft => ({
  model,
  prompt: price ? String(price.prompt) : '',
  completion: price ? String(price.completion) : '',
  cache: price ? String(price.cache) : '',
  cacheRead: price && (price.cacheReadConfigured || price.cacheRead > 0) ? String(price.cacheRead) : '',
  cacheCreation: price && (price.cacheCreationConfigured || price.cacheCreation > 0) ? String(price.cacheCreation) : '',
});

const parsePrice = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const priceUnit = (value: number | undefined) => (Number.isFinite(value) ? `$${Number(value).toFixed(4)}` : '—');

function PricingView({
  pricing,
  query,
  onChanged,
}: {
  pricing: UsagePricing;
  query: UsageQuery;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<PriceDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState('');
  const visibleRows = pricing.rows.filter((row) => {
    const keyword = search.trim().toLowerCase();
    return !keyword || row.model.toLowerCase().includes(keyword);
  });

  const savePrice = async () => {
    if (!draft?.model.trim()) {
      setLocalError(t('usage.pricing.modelRequired'));
      return;
    }
    setSaving(true);
    setLocalError('');
    try {
      await invoke('save_usage_model_price', {
        price: {
          model: draft.model.trim(),
          prompt: parsePrice(draft.prompt),
          completion: parsePrice(draft.completion),
          cache: draft.cache.trim() ? parsePrice(draft.cache) : parsePrice(draft.prompt),
          cacheRead: parsePrice(draft.cacheRead),
          cacheCreation: parsePrice(draft.cacheCreation),
          promptConfigured: draft.prompt.trim() !== '',
          completionConfigured: draft.completion.trim() !== '',
          cacheReadConfigured: draft.cacheRead.trim() !== '',
          cacheCreationConfigured: draft.cacheCreation.trim() !== '',
          source: 'manual',
          sourceModelId: '',
          updatedAtMs: 0,
        } satisfies ModelPrice,
      });
      setDraft(null);
      setMessage(t('usage.pricing.saved'));
      await onChanged();
    } catch (saveError) {
      setLocalError(String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const deletePrice = async (model: string) => {
    if (!window.confirm(t('usage.pricing.deleteConfirm', { model }))) return;
    try {
      await invoke('delete_usage_model_price', { model });
      setMessage(t('usage.pricing.deleted'));
      await onChanged();
    } catch (deleteError) {
      setLocalError(String(deleteError));
    }
  };

  const syncPrices = async () => {
    setSyncing(true);
    setLocalError('');
    try {
      const result = await invoke<ModelPriceSyncResult>('sync_usage_model_prices', { query });
      setMessage(
        t('usage.pricing.syncResult', {
          imported: result.imported,
          skipped: result.skipped,
          unmatched: result.unmatched.length,
        })
      );
      await onChanged();
    } catch (syncError) {
      setLocalError(String(syncError));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="panel usage-pricing-panel">
      <div className="usage-pricing-toolbar">
        <div className="usage-pricing-summary">
          <strong>{formatUsd(pricing.totalCost)}</strong>
          <span>
            {t('usage.pricing.coverage', {
              priced: compactNumber(pricing.pricedRequests),
              total: compactNumber(pricing.totalRequests),
              saved: compactNumber(pricing.savedPrices),
            })}
          </span>
        </div>
        <div className="usage-pricing-actions">
          <input
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={t('usage.pricing.search')}
            aria-label={t('usage.pricing.search')}
          />
          <button type="button" className="secondary-button" onClick={() => setDraft(emptyPriceDraft())}>
            {t('usage.pricing.add')}
          </button>
          <button type="button" className="primary-button" disabled={syncing} onClick={() => void syncPrices()}>
            <RefreshCw size={14} className={syncing ? 'spin' : ''} />
            {syncing ? t('usage.pricing.syncing') : t('usage.pricing.sync')}
          </button>
        </div>
      </div>

      {localError ? <div className="management-alert error">{localError}</div> : null}
      {message ? <div className="management-alert success">{message}</div> : null}

      {draft ? (
        <div className="usage-price-editor">
          <label>
            <span>{t('usage.pricing.model')}</span>
            <input
              value={draft.model}
              onChange={(event) => setDraft({ ...draft, model: event.currentTarget.value })}
              placeholder="gpt-5.6-terra"
            />
          </label>
          <label>
            <span>{t('usage.pricing.prompt')}</span>
            <input
              type="number"
              min="0"
              step="0.0001"
              value={draft.prompt}
              onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>{t('usage.pricing.completion')}</span>
            <input
              type="number"
              min="0"
              step="0.0001"
              value={draft.completion}
              onChange={(event) => setDraft({ ...draft, completion: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>{t('usage.pricing.cache')}</span>
            <input
              type="number"
              min="0"
              step="0.0001"
              value={draft.cache}
              onChange={(event) => setDraft({ ...draft, cache: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>{t('usage.pricing.cacheRead')}</span>
            <input
              type="number"
              min="0"
              step="0.0001"
              value={draft.cacheRead}
              onChange={(event) => setDraft({ ...draft, cacheRead: event.currentTarget.value })}
              placeholder={t('usage.pricing.optional')}
            />
          </label>
          <label>
            <span>{t('usage.pricing.cacheCreation')}</span>
            <input
              type="number"
              min="0"
              step="0.0001"
              value={draft.cacheCreation}
              onChange={(event) => setDraft({ ...draft, cacheCreation: event.currentTarget.value })}
              placeholder={t('usage.pricing.optional')}
            />
          </label>
          <div className="usage-price-editor-actions">
            <button type="button" className="secondary-button" onClick={() => setDraft(null)}>
              <X size={14} />
              {t('common.cancel')}
            </button>
            <button type="button" className="primary-button" disabled={saving} onClick={() => void savePrice()}>
              {saving ? t('usage.pricing.saving') : t('common.save')}
            </button>
          </div>
        </div>
      ) : null}

      {visibleRows.length ? (
        <div className="usage-table-wrap usage-pricing-table-wrap">
          <table className="usage-pricing-table">
            <thead>
              <tr>
                <th>{t('usage.pricing.model')}</th>
                <th>{t('usage.pricing.calls')}</th>
                <th>Token</th>
                <th>{t('usage.pricing.cost')}</th>
                <th>{t('usage.pricing.prompt')}</th>
                <th>{t('usage.pricing.completion')}</th>
                <th>{t('usage.pricing.cacheRead')}</th>
                <th>{t('usage.pricing.cacheCreation')}</th>
                <th>{t('usage.pricing.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.model}>
                  <td>
                    <strong>{row.model}</strong>
                  </td>
                  <td>{compactNumber(row.requests)}</td>
                  <td>{compactNumber(row.totalTokens)}</td>
                  <td>
                    <strong>{row.price ? formatUsd(row.estimatedCost) : '—'}</strong>
                  </td>
                  <td>{row.price ? priceUnit(row.price.prompt) : '—'}</td>
                  <td>{row.price ? priceUnit(row.price.completion) : '—'}</td>
                  <td>
                    {row.price
                      ? priceUnit(
                          row.price.cacheReadConfigured || row.price.cacheRead > 0
                            ? row.price.cacheRead
                            : row.price.cache
                        )
                      : '—'}
                  </td>
                  <td>
                    {row.price
                      ? priceUnit(
                          row.price.cacheCreationConfigured || row.price.cacheCreation > 0
                            ? row.price.cacheCreation
                            : row.price.prompt
                        )
                      : '—'}
                  </td>
                  <td>
                    <div className="usage-price-row-actions">
                      <button
                        type="button"
                        className="icon-button"
                        title={t('common.edit')}
                        onClick={() => setDraft(priceDraftFor(row.model, row.price))}
                      >
                        <Pencil size={14} />
                      </button>
                      {row.price?.source === 'manual' ? (
                        <button
                          type="button"
                          className="icon-button danger"
                          title={t('common.delete')}
                          onClick={() => void deletePrice(row.model)}
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <UsageEmpty />
      )}
    </section>
  );
}

function UsageEmpty() {
  const { t } = useI18n();
  return (
    <div className="usage-empty">
      <TriangleAlert size={18} />
      <span>{t('usage.empty')}</span>
    </div>
  );
}
