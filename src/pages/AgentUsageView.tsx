import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Bot, Check, Coins, Database, Layers, RefreshCw, TriangleAlert, Zap } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { Notice } from '../components/Notice';
import { Select } from '../components/Select';
import { SegmentedControl } from '../components/SegmentedControl';
import { useI18n } from '../i18n';
import {
  AGENT_USAGE_REFRESH_INTERVALS,
  loadAgentUsageRefreshInterval,
  saveAgentUsageRefreshInterval,
  type AgentUsageRefreshInterval,
} from '../services/agentUsagePreferences';
import { getUsagePricing, type UsagePricing } from '../services/usage';
import {
  buildAgentUsagePriceRows,
  estimateAgentUsageDailyCost,
  AGENT_USAGE_TIME_RANGES,
  filterAgentUsageReport,
  formatAgentUsageNumber as formatUsageNumber,
  getAgentUsage,
  type AgentUsageDaily,
  type AgentUsagePriceRow,
  type AgentUsageReport,
  type AgentUsageSource,
  type AgentUsageTimeRange,
} from '../services/agentUsage';
import './AgentUsageView.css';

type AgentUsageViewProps = {
  refreshKey: number;
  onLoadingChange: (loading: boolean) => void;
};

const sourceLabels: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  mcode: 'MCode',
  opencode: 'OpenCode',
  omp: 'Oh My Pi',
  pi: 'Pi',
  copilot: 'GitHub Copilot CLI',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  zcode: 'ZCode',
};

const sourceLabel = (source: string): string => sourceLabels[source] ?? source;
const money = (value: number): string => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: value >= 1 ? 2 : 4,
  maximumFractionDigits: value >= 1 ? 2 : 4,
}).format(value);
const rate = money;

const emptyTotals = () => ({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0 });

function addDaily(target: ReturnType<typeof emptyTotals>, row: AgentUsageDaily, pricing: UsagePricing | null) {
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.cacheCreationTokens += row.cacheCreationTokens;
  target.cacheReadTokens += row.cacheReadTokens;
  target.totalTokens += row.totalTokens;
  target.costUSD += estimateAgentUsageDailyCost(row, pricing);
}

function sourceTotals(source: AgentUsageSource, pricing: UsagePricing | null) {
  const totals = emptyTotals();
  source.daily.forEach((row) => addDaily(totals, row, pricing));
  return totals;
}

const statusLabelKey = (status: AgentUsageSource['status']) => {
  if (status === 'ok') return 'usage.agentUsage.status.ok' as const;
  if (status === 'empty') return 'usage.agentUsage.status.empty' as const;
  return 'usage.agentUsage.status.error' as const;
};

function totalsFor(report: AgentUsageReport, pricing: UsagePricing | null) {
  const totals = emptyTotals();
  report.sources.forEach((source) => source.daily.forEach((row) => addDaily(totals, row, pricing)));
  return totals;
}

export function AgentUsageView({ refreshKey, onLoadingChange }: AgentUsageViewProps) {
  const { t, locale } = useI18n();
  const [report, setReport] = useState<AgentUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pricing, setPricing] = useState<UsagePricing | null>(null);
  const [pricingLoading, setPricingLoading] = useState(true);
  const [selectedSource, setSelectedSource] = useState('');
  const [timeRange, setTimeRange] = useState<AgentUsageTimeRange>('7d');
  const [refreshInterval, setRefreshInterval] = useState<AgentUsageRefreshInterval>(loadAgentUsageRefreshInterval);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onLoadingChange(false);
    };
  }, [onLoadingChange]);

  const loadReport = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setPricingLoading(true);
    onLoadingChange(true);
    Promise.all([
      getAgentUsage(),
      getUsagePricing({ query: {} }).catch(() => null),
    ])
      .then(([next, nextPricing]) => {
        if (mountedRef.current) {
          setReport(next);
          setPricing(nextPricing);
          setError('');
        }
      })
      .catch((reason) => {
        if (mountedRef.current) {
          const message = String(reason);
          setError(message || t('usage.agentUsage.readFailed'));
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setLoading(false);
          setPricingLoading(false);
          onLoadingChange(false);
        }
        inFlightRef.current = false;
      });
  }, [onLoadingChange, t]);

  useEffect(() => loadReport(), [loadReport, refreshKey]);

  useEffect(() => {
    if (refreshInterval === 0) return undefined;
    const timer = window.setInterval(loadReport, refreshInterval);
    return () => window.clearInterval(timer);
  }, [loadReport, refreshInterval]);

  const handleRefreshIntervalChange = (value: string) => {
    const next = Number(value);
    if (!AGENT_USAGE_REFRESH_INTERVALS.includes(next as AgentUsageRefreshInterval)) return;
    const interval = next as AgentUsageRefreshInterval;
    setRefreshInterval(interval);
    saveAgentUsageRefreshInterval(interval);
  };

  const rangeReport = useMemo(
    () => report ? filterAgentUsageReport(report, timeRange) : null,
    [report, timeRange],
  );
  const filteredReport = useMemo(() => rangeReport ? {
    ...rangeReport, sources: rangeReport.sources.filter((source) => !selectedSource || source.source === selectedSource),
  } : null, [rangeReport, selectedSource]);
  const filteredSources = filteredReport?.sources ?? [];
  const rangeTotals = useMemo(() => rangeReport ? totalsFor(rangeReport, pricing) : emptyTotals(), [rangeReport, pricing]);
  const totals = useMemo(() => filteredReport ? totalsFor(filteredReport, pricing) : emptyTotals(), [filteredReport, pricing]);
  const daily = useMemo(() => {
    const rows = new Map<string, ReturnType<typeof emptyTotals>>();
    filteredSources.forEach((source) => source.daily.forEach((row) => {
      const total = rows.get(row.date) ?? emptyTotals();
      addDaily(total, row, pricing);
      rows.set(row.date, total);
    }));
    return [...rows.entries()].sort(([left], [right]) => right.localeCompare(left));
  }, [filteredSources, pricing]);
  const priceRows = useMemo(
    () => filteredReport ? buildAgentUsagePriceRows(filteredReport, pricing) : [],
    [filteredReport, pricing],
  );

  if (loading && !report) {
    return <EmptyState className="agent-usage-loading" icon={<Database size={22} />}>{t('usage.agentUsage.loading')}</EmptyState>;
  }
  if (error && !report) {
    return <EmptyState className="agent-usage-loading" tone="error" icon={<TriangleAlert size={20} />} title={t('usage.agentUsage.title')} action={<button type="button" className="secondary-button" onClick={loadReport}>{t('usage.agentUsage.syncNow')}</button>}>{error}</EmptyState>;
  }
  if (!report) return null;

  const availableSources = rangeReport?.sources.filter((source) => source.status === 'ok' && source.daily.length > 0) ?? [];
  const visibleSources = rangeReport?.sources ?? [];
  const generatedAt = new Date(report.generatedAt);
  return (
    <section className="agent-usage-view" aria-label={t('usage.agentUsage.title')} aria-busy={loading}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="agent-usage-summary surface-card">
        <div className="agent-usage-summary-heading">
          <div>
            <h2>{t('usage.agentUsage.title')}</h2>
            <div role="status" className={`agent-usage-sync-status${error ? ' error' : ''}`}>
              <span className="agent-usage-sync-dot" aria-hidden="true" />
              {loading ? t('usage.agentUsage.syncing') : error ? t('usage.agentUsage.status.error') : t('usage.agentUsage.lastSynced')}
              {!Number.isNaN(generatedAt.getTime()) ? <time dateTime={report.generatedAt}>{new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(generatedAt)}</time> : null}
            </div>
          </div>
          <div className="agent-usage-summary-actions">
            <SegmentedControl className="agent-usage-range" aria-label={t('usage.agentUsage.timeRange')}
              value={timeRange} onChange={setTimeRange}
              items={AGENT_USAGE_TIME_RANGES.map((range) => ({ value: range, label: t(`usage.agentUsage.range.${range}`) }))} />
            <button type="button" className="secondary-button compact-button agent-usage-sync" disabled={loading} onClick={loadReport}><RefreshCw size={14} className={loading ? 'agent-usage-spin' : ''} aria-hidden="true" />{t('usage.agentUsage.syncNow')}</button>
            <label className="agent-usage-refresh-setting">
              <span>{t('usage.agentUsage.refreshFrequency')}</span>
              <Select value={refreshInterval} onChange={(event) => handleRefreshIntervalChange(event.currentTarget.value)}>
                <option value={0}>{t('usage.agentUsage.refreshFrequency.manual')}</option>
                <option value={60_000}>{t('usage.agentUsage.refreshFrequency.1m')}</option>
                <option value={300_000}>{t('usage.agentUsage.refreshFrequency.5m')}</option>
                <option value={900_000}>{t('usage.agentUsage.refreshFrequency.15m')}</option>
                <option value={1_800_000}>{t('usage.agentUsage.refreshFrequency.30m')}</option>
              </Select>
            </label>
          </div>
        </div>
        <div className="agent-usage-stat-grid">
          <div className="agent-usage-stat primary tokens"><span><Layers size={17} aria-hidden="true" />{t('usage.agentUsage.totalTokens')}</span><strong>{formatUsageNumber(totals.totalTokens, locale)}</strong><small>{t('usage.agentUsage.tokens')}</small></div>
          <div className="agent-usage-stat primary cost"><span><Coins size={17} aria-hidden="true" />{t('usage.agentUsage.estimatedTotalCost')}</span><strong>{money(totals.costUSD)}</strong><small>USD</small></div>
          <div className="agent-usage-stat input"><span><ArrowDownLeft size={16} aria-hidden="true" />{t('usage.agentUsage.inputTokens')}</span><strong>{formatUsageNumber(totals.inputTokens, locale)}</strong><small>{t('usage.agentUsage.tokens')}</small></div>
          <div className="agent-usage-stat output"><span><ArrowUpRight size={16} aria-hidden="true" />{t('usage.agentUsage.outputTokens')}</span><strong>{formatUsageNumber(totals.outputTokens, locale)}</strong><small>{t('usage.agentUsage.tokens')}</small></div>
          <div className="agent-usage-stat cache-read"><span><Zap size={16} aria-hidden="true" />{t('usage.agentUsage.cacheReadTokens')}</span><strong>{formatUsageNumber(totals.cacheReadTokens, locale)}</strong><small>{t('usage.agentUsage.tokens')}</small></div>
          <div className="agent-usage-stat cache-write"><span><Database size={16} aria-hidden="true" />{t('usage.agentUsage.cacheCreationTokens')}</span><strong>{formatUsageNumber(totals.cacheCreationTokens, locale)}</strong><small>{t('usage.agentUsage.tokens')}</small></div>
        </div>
      </div>

        <section className="panel surface-card agent-usage-sources">
          <div className="agent-usage-section-heading">
            <h3>{t('usage.agentUsage.sources')}</h3>
            <div className="agent-usage-source-filter">
              <span>{t('usage.agentUsage.sourceCount', { count: availableSources.length })}</span>
            </div>
          </div>
          <div className="agent-usage-source-list" role="group" aria-label={t('usage.agentUsage.sourceFilter')}>
            <button type="button" className={`agent-usage-source-row ${!selectedSource ? 'selected' : ''}`} aria-pressed={!selectedSource} onClick={() => setSelectedSource('')}>
              <div className="agent-usage-source-name"><span className="agent-usage-source-icon"><Layers size={17} aria-hidden="true" /></span><strong>{t('usage.agentUsage.sourceAll')}</strong>{!selectedSource && <Check size={14} aria-hidden="true" />}</div>
              <div className="agent-usage-source-volume"><strong>{formatUsageNumber(rangeTotals.totalTokens, locale)}</strong><span>{t('usage.agentUsage.tokens')}</span></div>
              <div className="agent-usage-source-track" aria-hidden="true"><span style={{ width: rangeTotals.totalTokens > 0 ? '100%' : '0%' }} /></div>
              <div className="agent-usage-source-metrics"><span>{money(rangeTotals.costUSD)}</span></div>
            </button>
            {visibleSources.map((source) => {
              const sourceTotal = sourceTotals(source, pricing);
              const hasData = source.daily.length > 0;
              const status = !hasData && source.status === 'ok' ? 'empty' : source.status;
              const contribution = rangeTotals.totalTokens > 0 ? sourceTotal.totalTokens / rangeTotals.totalTokens : 0;
              return <button
                type="button"
                className={`agent-usage-source-row ${hasData ? 'has-data' : 'is-empty'} ${selectedSource === source.source ? 'selected' : ''}`}
                key={source.source}
                data-source={source.source}
                aria-pressed={selectedSource === source.source}
                onClick={() => setSelectedSource((current) => current === source.source ? '' : source.source)}
              >
                <div className="agent-usage-source-name"><span className="agent-usage-source-icon"><Bot size={17} aria-hidden="true" /></span><strong title={sourceLabel(source.source)}>{sourceLabel(source.source)}</strong><span className={`agent-usage-status ${status}`}>{t(statusLabelKey(status))}</span>{selectedSource === source.source && <Check size={14} aria-hidden="true" />}</div>
                {hasData && <>
                  <div className="agent-usage-source-volume"><strong>{formatUsageNumber(sourceTotal.totalTokens, locale)}</strong><span>{t('usage.agentUsage.tokens')}</span><span className="agent-usage-source-share">{new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(contribution)}</span></div>
                  <div className="agent-usage-source-track" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, contribution * 100))}%` }} /></div>
                  <div className="agent-usage-source-metrics"><span>{new Set(source.daily.map((row) => row.date)).size} {t('usage.agentUsage.days')}</span><span>{money(sourceTotal.costUSD)}</span></div>
                </>}
                {source.status === 'error' && source.error ? <small title={source.error}>{source.error}</small> : null}
              </button>;
            })}
            {!visibleSources.length && <EmptyState variant="compact">{t('usage.agentUsage.empty')}</EmptyState>}
          </div>
        </section>

      <div className="agent-usage-columns">
        <section className="panel surface-card agent-usage-daily">
          <div className="agent-usage-section-heading"><h3>{t('usage.agentUsage.daily')}</h3><span>{t('usage.agentUsage.dayCount', { count: daily.length })}</span></div>
          {daily.length ? <div className="agent-usage-table-wrap" tabIndex={0} role="region" aria-label={t('usage.agentUsage.daily')}><table>
            <thead><tr>
              <th>{t('usage.agentUsage.date')}</th>
              <th>{t('usage.agentUsage.inputTokens')}</th>
              <th>{t('usage.agentUsage.outputTokens')}</th>
              <th>{t('usage.agentUsage.cacheReadTokens')}</th>
              <th>{t('usage.agentUsage.cacheCreationTokens')}</th>
              <th>{t('usage.agentUsage.totalTokens')}</th>
              <th>{t('usage.agentUsage.estimatedCost')}</th>
            </tr></thead>
            <tbody>{daily.map(([date, row]) => <tr key={date}>
              <td>{date}</td>
              <td>{formatUsageNumber(row.inputTokens, locale)}</td>
              <td>{formatUsageNumber(row.outputTokens, locale)}</td>
              <td>{formatUsageNumber(row.cacheReadTokens, locale)}</td>
              <td>{formatUsageNumber(row.cacheCreationTokens, locale)}</td>
              <td><strong>{formatUsageNumber(row.totalTokens, locale)}</strong></td>
              <td>{money(row.costUSD)}</td>
            </tr>)}</tbody>
          </table></div> : <EmptyState variant="compact">{t('usage.agentUsage.empty')}</EmptyState>}
        </section>
      <AgentUsagePricingView rows={priceRows} loading={pricingLoading} locale={locale} />
      </div>
    </section>
  );
}

function AgentUsagePricingView({
  rows,
  loading,
  locale,
}: {
  rows: AgentUsagePriceRow[];
  loading: boolean;
  locale: string;
}) {
  const { t } = useI18n();
  return (
    <section className="panel surface-card agent-usage-pricing">
      <div className="agent-usage-section-heading">
        <div>
          <h3>{t('usage.agentUsage.pricingTitle')}</h3>
          <span>{t('usage.agentUsage.pricingDescription')}</span>
        </div>
        <span>{t('usage.agentUsage.modelCount', { count: rows.length })}</span>
      </div>
      {loading ? (
        <EmptyState variant="compact">{t('usage.agentUsage.pricingLoading')}</EmptyState>
      ) : rows.length ? (
        <div className="agent-usage-table-wrap" tabIndex={0} role="region" aria-label={t('usage.agentUsage.pricingTitle')}>
          <table>
            <thead>
              <tr>
                <th>{t('usage.pricing.model')}</th>
                <th>{t('usage.agentUsage.days')}</th>
                <th>{t('usage.agentUsage.totalTokens')}</th>
                <th>{t('usage.pricing.prompt')}</th>
                <th>{t('usage.pricing.completion')}</th>
                <th>{t('usage.pricing.cacheRead')}</th>
                <th>{t('usage.pricing.cacheCreation')}</th>
                <th>{t('usage.pricing.cost')}</th>
                <th>{t('usage.agentUsage.recordedCost')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.model}>
                  <td title={row.model}>{row.model}</td>
                  <td>{formatUsageNumber(row.days, locale)} {t('usage.agentUsage.days')}</td>
                  <td>{formatUsageNumber(row.totalTokens, locale)}</td>
                  <td>{row.price ? rate(row.price.prompt) : '—'}</td>
                  <td>{row.price ? rate(row.price.completion) : '—'}</td>
                  <td>{row.price ? rate(row.price.cacheRead) : '—'}</td>
                  <td>{row.price ? rate(row.price.cacheCreation) : '—'}</td>
                  <td>{row.estimatedCostUSD === null ? '—' : money(row.estimatedCostUSD)}</td>
                  <td>{row.recordedCostUSD === null ? '—' : money(row.recordedCostUSD)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState variant="compact">{t('usage.agentUsage.pricingEmpty')}</EmptyState>
      )}
    </section>
  );
}
