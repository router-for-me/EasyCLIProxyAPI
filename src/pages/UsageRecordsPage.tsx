import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Activity, BarChart3, Clock3, Database, List, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { getCurrentLocale, useI18n } from '../i18n';

type UsageTab = 'overview' | 'analysis' | 'events';
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
  tokens: number;
};

type UsageOverview = {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  rpm: number;
  tpm: number;
  averageLatencyMs: number;
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
  failed: boolean;
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

type UsageQuery = {
  start?: string;
  end?: string;
  model?: string;
  provider?: string;
  source?: string;
  api_key_hash?: string;
  failed?: boolean;
  page?: number;
  page_size?: number;
};

const TAB_KEY = 'cpa-gui.usage-records-tab.v1';
const RANGE_KEY = 'cpa-gui.usage-records-range.v1';
const emptyAnalysis: UsageAnalysis = { models: [], providers: [], sources: [], apiKeys: [] };

const loadTab = (): UsageTab => {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return saved === 'analysis' || saved === 'events' ? saved : 'overview';
  } catch {
    return 'overview';
  }
};

const loadRange = (): UsageRange => {
  try {
    const saved = localStorage.getItem(RANGE_KEY) as UsageRange | null;
    return ['4h', '24h', 'today', '7d', '30d', 'all', 'custom'].includes(saved ?? '')
      ? saved as UsageRange
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
  return { start: new Date(now.getTime() - hours * 3_600_000).toISOString(), end: now.toISOString() };
};

const compactNumber = (value: number) => new Intl.NumberFormat(getCurrentLocale(), {
  notation: value >= 10_000 ? 'compact' : 'standard',
  maximumFractionDigits: 1,
}).format(Number.isFinite(value) ? value : 0);

const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(getCurrentLocale(), {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
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
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [analysis, setAnalysis] = useState<UsageAnalysis>(emptyAnalysis);
  const [optionsAnalysis, setOptionsAnalysis] = useState<UsageAnalysis>(emptyAnalysis);
  const [events, setEvents] = useState<UsageEventPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);

  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, activeTab); } catch { /* Keep the in-memory tab. */ }
  }, [activeTab]);

  useEffect(() => {
    try { localStorage.setItem(RANGE_KEY, range); } catch { /* Keep the in-memory range. */ }
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
      } satisfies UsageQuery,
    };
  }, [apiKeyHash, customEnd, customStart, model, provider, range, result, source]);

  const loadData = useCallback(async (quiet = false) => {
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
      } else {
        const [nextStatus, nextOptions, nextEvents] = await Promise.all([
          statusRequest,
          optionsRequest,
          invoke<UsageEventPage>('get_usage_events', {
            query: { ...query, page, page_size: 50 },
          }),
        ]);
        if (requestId !== requestIdRef.current) return;
        setStatus(nextStatus);
        setOptionsAnalysis(nextOptions);
        setEvents(nextEvents);
      }
      setError('');
    } catch (requestError) {
      if (requestId === requestIdRef.current) setError(String(requestError));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [activeTab, buildQueries, page]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const refresh = () => {
      if (!disposed && !document.hidden) void loadData(true);
    };
    listen('usage-records-updated', refresh).then((stop) => {
      if (disposed) stop(); else unlisten = stop;
    }).catch(() => {});
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

  const collectorTone = status?.state === 'error' ? 'error' : status?.state === 'collecting' ? 'success' : '';
  const showInitialLoading = loading && (
    (activeTab === 'overview' && !overview)
    || (activeTab === 'analysis' && !overview)
    || (activeTab === 'events' && !events)
  );

  return (
    <section className="page management-page usage-records-page">
      <header className="management-header usage-records-header">
        <div>
          <span>Local Usage</span>
          <h1>{t('usage.title')}</h1>
        </div>
        <div className={`usage-collector-state ${collectorTone}`} title={status?.message}>
          <span className="status-dot" />
          <div>
            <strong>{status?.state === 'collecting' ? t('usage.collector.collecting') : status?.state === 'error' ? t('usage.collector.error') : t('usage.collector.waiting')}</strong>
            <span>{t('usage.longTermRecords', { count: compactNumber(status?.totalRecords ?? 0) })}</span>
          </div>
        </div>
      </header>

      {error ? <div className="management-alert error">{error}</div> : null}

      <div className="usage-tabs" role="tablist" aria-label={t('usage.pageLabel')}>
        <button type="button" className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}><Activity size={15} />{t('usage.tab.overview')}</button>
        <button type="button" className={activeTab === 'analysis' ? 'active' : ''} onClick={() => setActiveTab('analysis')}><BarChart3 size={15} />{t('usage.tab.analysis')}</button>
        <button type="button" className={activeTab === 'events' ? 'active' : ''} onClick={() => setActiveTab('events')}><List size={15} />{t('usage.tab.events')}</button>
      </div>

      <section className="panel usage-filter-panel">
        <select value={range} onChange={(event) => { setRange(event.currentTarget.value as UsageRange); setPage(1); }} aria-label={t('usage.filter.timeRange')}>
          <option value="4h">{t('usage.range.4h')}</option><option value="24h">{t('usage.range.24h')}</option><option value="today">{t('usage.range.today')}</option><option value="7d">{t('usage.range.7d')}</option><option value="30d">{t('usage.range.30d')}</option><option value="all">{t('usage.range.all')}</option><option value="custom">{t('usage.range.custom')}</option>
        </select>
        <select value={model} onChange={(event) => changeFilter(setModel, event.currentTarget.value)} aria-label={t('usage.filter.model')}><option value="">{t('usage.filter.allModels')}</option>{filterOptions(optionsAnalysis.models).map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select>
        <select value={provider} onChange={(event) => changeFilter(setProvider, event.currentTarget.value)} aria-label="Provider"><option value="">{t('usage.filter.allProviders')}</option>{filterOptions(optionsAnalysis.providers).map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select>
        <select value={source} onChange={(event) => changeFilter(setSource, event.currentTarget.value)} aria-label={t('usage.filter.source')}><option value="">{t('usage.filter.allSources')}</option>{filterOptions(optionsAnalysis.sources).map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select>
        <select value={apiKeyHash} onChange={(event) => changeFilter(setApiKeyHash, event.currentTarget.value)} aria-label="API Key"><option value="">{t('usage.filter.allKeys')}</option>{filterOptions(optionsAnalysis.apiKeys).map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select>
        <select value={result} onChange={(event) => changeFilter(setResult, event.currentTarget.value)} aria-label={t('usage.filter.result')}><option value="all">{t('usage.filter.allResults')}</option><option value="success">{t('usage.result.success')}</option><option value="failed">{t('usage.result.failed')}</option></select>
        {range === 'custom' ? <div className="usage-custom-range"><input type="datetime-local" value={customStart} onChange={(event) => setCustomStart(event.currentTarget.value)} aria-label={t('usage.filter.startTime')} /><span>{t('usage.filter.to')}</span><input type="datetime-local" value={customEnd} onChange={(event) => setCustomEnd(event.currentTarget.value)} aria-label={t('usage.filter.endTime')} /></div> : null}
      </section>

      {showInitialLoading ? <div className="usage-initial-loading"><Database size={22} /><span>{t('usage.loading')}</span></div> : null}

      {activeTab === 'overview' && overview ? <OverviewView overview={overview} /> : null}
      {activeTab === 'analysis' ? <AnalysisView analysis={analysis} overview={overview} /> : null}
      {activeTab === 'events' && events ? <EventsView events={events} onPage={setPage} /> : null}
    </section>
  );
}

function OverviewView({ overview }: { overview: UsageOverview }) {
  const { t } = useI18n();
  const cards = [
    { icon: Activity, label: t('usage.stat.requests'), value: compactNumber(overview.totalRequests), meta: t('usage.stat.requestMeta', { success: overview.successCount, failed: overview.failureCount }) },
    { icon: Sparkles, label: t('usage.stat.tokens'), value: compactNumber(overview.totalTokens), meta: t('usage.stat.tokenMeta', { input: compactNumber(overview.inputTokens), output: compactNumber(overview.outputTokens) }) },
    { icon: ShieldCheck, label: t('usage.stat.successRate'), value: `${overview.successRate.toFixed(1)}%`, meta: t('usage.stat.reasoningMeta', { tokens: compactNumber(overview.reasoningTokens) }) },
    { icon: Clock3, label: t('usage.stat.averageLatency'), value: `${Math.round(overview.averageLatencyMs)} ms`, meta: `${overview.rpm.toFixed(2)} RPM · ${compactNumber(overview.tpm)} TPM` },
  ];
  return <div className="usage-overview-layout">
    <div className="usage-stat-grid">{cards.map(({ icon: Icon, label, value, meta }) => <article className="panel usage-stat-card" key={label}><span><Icon size={16} />{label}</span><strong>{value}</strong><small>{meta}</small></article>)}</div>
    <section className="panel usage-trend-panel"><div className="usage-section-heading"><div><strong>{t('usage.trend.title')}</strong><span>{t('usage.trend.description')}</span></div></div>{overview.timeline.length ? <UsageTrend points={overview.timeline} /> : <UsageEmpty />}</section>
    <section className="panel usage-health-panel"><div className="usage-section-heading"><div><strong>{t('usage.token.title')}</strong><span>{t('usage.token.description')}</span></div></div><div className="usage-token-breakdown"><TokenMetric label={t('usage.token.input')} value={overview.inputTokens} total={overview.totalTokens} /><TokenMetric label={t('usage.token.output')} value={overview.outputTokens} total={overview.totalTokens} /><TokenMetric label={t('usage.token.reasoning')} value={overview.reasoningTokens} total={overview.totalTokens} /><TokenMetric label={t('usage.token.cacheRead')} value={overview.cacheReadTokens} total={overview.totalTokens} /><TokenMetric label={t('usage.token.cacheCreation')} value={overview.cacheCreationTokens} total={overview.totalTokens} /></div></section>
  </div>;
}

function UsageTrend({ points }: { points: TimelinePoint[] }) {
  const { t } = useI18n();
  const recent = points.slice(-48);
  const max = Math.max(...recent.map((point) => point.requests), 1);
  const polyline = recent.map((point, index) => `${recent.length === 1 ? 50 : index * 100 / (recent.length - 1)},${28 - point.requests * 24 / max}`).join(' ');
  return <div className="usage-trend"><svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-label={t('usage.trend.aria')}><polyline points={polyline} fill="none" vectorEffect="non-scaling-stroke" /></svg><div className="usage-trend-labels"><span>{recent[0]?.hour ?? ''}</span><strong>{compactNumber(recent.reduce((sum, point) => sum + point.tokens, 0))} Token</strong><span>{recent[recent.length - 1]?.hour ?? ''}</span></div></div>;
}

function TokenMetric({ label, value, total }: { label: string; value: number; total: number }) {
  const percent = total ? Math.min(value * 100 / total, 100) : 0;
  return <div><span><strong>{label}</strong><small>{compactNumber(value)}</small></span><i><b style={{ width: `${percent}%` }} /></i></div>;
}

function AnalysisView({ analysis, overview }: { analysis: UsageAnalysis; overview: UsageOverview | null }) {
  const { t } = useI18n();
  const hours = (overview?.timeline ?? []).map((point) => ({
    key: point.hour,
    label: point.hour,
    requests: point.requests,
    failures: point.failure,
    tokens: point.tokens,
  })).sort((left, right) => right.tokens - left.tokens);
  return <div className="usage-analysis-grid"><CategoryPanel title={t('usage.analysis.models')} items={analysis.models} /><CategoryPanel title="Provider" items={analysis.providers} /><CategoryPanel title={t('usage.analysis.sources')} items={analysis.sources} /><CategoryPanel title={t('usage.analysis.keys')} items={analysis.apiKeys} /><CategoryPanel title={t('usage.analysis.hours')} items={hours} /></div>;
}

function CategoryPanel({ title, items }: { title: string; items: UsageCategory[] }) {
  const { t } = useI18n();
  const max = Math.max(...items.map((item) => item.tokens), 1);
  const total = items.reduce((sum, item) => sum + item.tokens, 0);
  return <section className="panel usage-category-panel"><div className="usage-section-heading"><div><strong>{title}</strong><span>{t('usage.analysis.sortedByTokens')}</span></div></div>{items.length ? <div className="usage-category-list">{items.slice(0, 10).map((item) => <div key={item.key}><span><strong title={item.label}>{item.label}</strong><small>{t('usage.analysis.itemMeta', { requests: compactNumber(item.requests), percent: total ? (item.tokens * 100 / total).toFixed(1) : '0.0', tokens: compactNumber(item.tokens) })}</small></span><i><b style={{ width: `${item.tokens * 100 / max}%` }} /></i></div>)}</div> : <UsageEmpty />}</section>;
}

function EventsView({ events, onPage }: { events: UsageEventPage; onPage: (page: number) => void }) {
  const { t } = useI18n();
  return <section className="panel usage-events-panel"><div className="usage-events-summary"><span>{t('usage.events.total', { count: compactNumber(events.total) })}</span><span>{t('usage.events.page', { page: events.page, total: events.totalPages })}</span></div>{events.items.length ? <div className="usage-table-wrap"><table className="usage-events-table"><thead><tr><th>{t('usage.column.time')}</th><th>{t('usage.column.model')}</th><th>Provider</th><th>{t('usage.column.source')}</th><th>API Key</th><th>{t('usage.column.result')}</th><th>{t('usage.column.latency')}</th><th>TTFT</th><th>{t('usage.column.input')}</th><th>{t('usage.column.output')}</th><th>{t('usage.column.reasoning')}</th><th>{t('usage.column.cache')}</th><th>{t('usage.column.total')}</th></tr></thead><tbody>{events.items.map((record) => <tr key={record.id}><td>{formatTime(record.timestamp)}</td><td className="usage-stacked-cell"><strong title={record.alias || record.model}>{record.alias || record.model}</strong>{record.alias || record.reasoning_effort ? <small title={record.model}>{record.alias ? record.model : ''}{record.alias && record.reasoning_effort ? ' · ' : ''}{record.reasoning_effort}</small> : null}</td><td title={record.provider}>{record.provider || '—'}</td><td title={record.source}>{record.source || '—'}</td><td className="usage-stacked-cell"><strong title={record.api_key_remark}>{record.api_key_remark || t('usage.key.noRemark')}</strong><small>{record.api_key_display || '—'}</small></td><td><span className={`usage-result ${record.failed ? 'failed' : 'success'}`}>{record.failed ? t('usage.result.failed') : t('usage.result.success')}</span></td><td>{record.latency_ms} ms</td><td>{record.ttft_ms == null ? '—' : `${record.ttft_ms} ms`}</td><td>{compactNumber(record.tokens.input_tokens)}</td><td>{compactNumber(record.tokens.output_tokens)}</td><td>{compactNumber(record.tokens.reasoning_tokens)}</td><td>{compactNumber(record.tokens.cache_read_tokens)}</td><td><strong>{compactNumber(record.tokens.total_tokens)}</strong></td></tr>)}</tbody></table></div> : <UsageEmpty />}<div className="usage-pagination"><button type="button" className="secondary-button" disabled={events.page <= 1} onClick={() => onPage(events.page - 1)}>{t('usage.previous')}</button><button type="button" className="secondary-button" disabled={events.page >= events.totalPages} onClick={() => onPage(events.page + 1)}>{t('usage.next')}</button></div></section>;
}

function UsageEmpty() {
  const { t } = useI18n();
  return <div className="usage-empty"><TriangleAlert size={18} /><span>{t('usage.empty')}</span></div>;
}
