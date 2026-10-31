import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Database, TriangleAlert } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { useI18n } from '../i18n';
import {
  AGENT_USAGE_REFRESH_INTERVALS,
  loadAgentUsageRefreshInterval,
  saveAgentUsageRefreshInterval,
  type AgentUsageRefreshInterval,
} from '../services/agentUsagePreferences';
import { formatUsageNumber } from '../services/usageNumber';
import { getUsagePricing, type UsagePricing } from '../services/usage';
import {
  buildAgentUsagePriceRows,
  estimateAgentUsageModelCost,
  getAgentUsage,
  type AgentUsageDaily,
  type AgentUsagePriceRow,
  type AgentUsageReport,
  type AgentUsageSource,
} from '../services/agentUsage';
import './AgentUsageView.css';

type AgentUsageViewProps = {
  refreshKey: number;
  onLoadingChange: (loading: boolean) => void;
};

const sourceLabels: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  omp: 'Oh My Pi',
  pi: 'Pi',
  amp: 'Amp',
  droid: 'Droid',
  codebuff: 'Codebuff',
  hermes: 'Hermes',
  goose: 'Goose',
  kilo: 'Kilo',
  copilot: 'GitHub Copilot CLI',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  qwen: 'Qwen',
  openclaw: 'OpenClaw',
  grok: 'Grok CLI',
  zcode: 'ZCode',
};

const sourceLabel = (source: string): string => sourceLabels[source] ?? source;
const money = (value: number): string => `$${value.toFixed(value >= 1 ? 2 : 4)}`;
const rate = (value: number): string => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

const emptyTotals = () => ({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0 });

function dailyCost(row: AgentUsageDaily, pricing: UsagePricing | null): number {
  const modelCosts = row.models
    .map((model) => estimateAgentUsageModelCost(model, pricing))
    .filter((cost): cost is number => cost !== null);
  return modelCosts.length ? modelCosts.reduce((sum, cost) => sum + cost, 0) : row.costUSD;
}

function addDaily(target: ReturnType<typeof emptyTotals>, row: AgentUsageDaily, pricing: UsagePricing | null) {
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.cacheCreationTokens += row.cacheCreationTokens;
  target.cacheReadTokens += row.cacheReadTokens;
  target.totalTokens += row.totalTokens;
  target.costUSD += dailyCost(row, pricing);
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
  const [refreshInterval, setRefreshInterval] = useState<AgentUsageRefreshInterval>(loadAgentUsageRefreshInterval);
  const inFlightRef = useRef(false);

  const loadReport = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    let disposed = false;
    setLoading(true);
    setPricingLoading(true);
    onLoadingChange(true);
    Promise.all([
      getAgentUsage(),
      getUsagePricing({ query: {} }).catch(() => null),
    ])
      .then(([next, nextPricing]) => {
        if (!disposed) {
          setReport(next);
          setPricing(nextPricing);
          setError('');
        }
      })
      .catch((reason) => {
        if (!disposed) {
          const message = String(reason);
          setError(message || t('usage.agentUsage.readFailed'));
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
          setPricingLoading(false);
          onLoadingChange(false);
        }
        inFlightRef.current = false;
      });
    return () => {
      disposed = true;
      inFlightRef.current = false;
    };
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

  const filteredSources = useMemo(
    () => report?.sources.filter((source) => !selectedSource || source.source === selectedSource) ?? [],
    [report, selectedSource],
  );
  const filteredReport = report ? { ...report, sources: filteredSources } : null;
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
    return <EmptyState className="agent-usage-empty" tone="error" icon={<TriangleAlert size={20} />} title={t('usage.agentUsage.title')}>{error}</EmptyState>;
  }
  if (!report) return null;

  const availableSources = report.sources.filter((source) => source.status === 'ok' && source.daily.length > 0);
  const visibleSources = report.sources.filter((source) => source.status !== 'empty' || source.daily.length > 0);
  return (
    <section className="agent-usage-view" aria-label={t('usage.agentUsage.title')}>
      {error ? <div className="agent-usage-inline-error" role="status">{error}</div> : null}
      <div className="agent-usage-summary surface-card">
        <div className="agent-usage-summary-heading">
          <div>
            <h2>{t('usage.agentUsage.title')}</h2>
          </div>
          <div className="agent-usage-summary-actions">
            <label className="agent-usage-refresh-setting">
              <span>{t('usage.agentUsage.refreshFrequency')}</span>
              <select value={refreshInterval} onChange={(event) => handleRefreshIntervalChange(event.currentTarget.value)}>
                <option value={0}>{t('usage.agentUsage.refreshFrequency.manual')}</option>
                <option value={60_000}>{t('usage.agentUsage.refreshFrequency.1m')}</option>
                <option value={300_000}>{t('usage.agentUsage.refreshFrequency.5m')}</option>
                <option value={900_000}>{t('usage.agentUsage.refreshFrequency.15m')}</option>
                <option value={1_800_000}>{t('usage.agentUsage.refreshFrequency.30m')}</option>
              </select>
            </label>
            <span className="agent-usage-generated">{report.generatedAt ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.generatedAt)) : '—'}</span>
          </div>
        </div>
        <div className="agent-usage-stat-grid">
          <div><span>{t('usage.agentUsage.totalTokens')}</span><strong>{formatUsageNumber(totals.totalTokens, locale)}</strong></div>
          <div><span>{t('usage.agentUsage.inputTokens')}</span><strong>{formatUsageNumber(totals.inputTokens, locale)}</strong></div>
          <div><span>{t('usage.agentUsage.outputTokens')}</span><strong>{formatUsageNumber(totals.outputTokens, locale)}</strong></div>
          <div><span>{t('usage.agentUsage.estimatedCost')}</span><strong>{money(totals.costUSD)}</strong></div>
        </div>
      </div>

      <div className="agent-usage-columns">
        <section className="panel surface-card agent-usage-sources">
          <div className="agent-usage-section-heading">
            <h3>{t('usage.agentUsage.sources')}</h3>
            <div className="agent-usage-source-filter">
              <select
                value={selectedSource}
                aria-label={t('usage.agentUsage.sourceFilter')}
                onChange={(event) => setSelectedSource(event.currentTarget.value)}
              >
                <option value="">{t('usage.agentUsage.sourceAll')}</option>
                {report.sources
                  .filter((source) => source.status !== 'empty' || source.daily.length > 0)
                  .map((source) => <option key={source.source} value={source.source}>{sourceLabel(source.source)}</option>)}
              </select>
              <span>{t('usage.agentUsage.sourceCount', { count: availableSources.length })}</span>
            </div>
          </div>
          <div className="agent-usage-source-list">
            {visibleSources.length ? visibleSources.map((source) => {
              const sourceTotal = sourceTotals(source, pricing);
              return <button
                type="button"
                className={`agent-usage-source-row ${selectedSource === source.source ? 'selected' : ''}`}
                key={source.source}
                aria-pressed={selectedSource === source.source}
                onClick={() => setSelectedSource((current) => current === source.source ? '' : source.source)}
              >
                <div className="agent-usage-source-name"><Bot size={16} aria-hidden="true" /><strong>{sourceLabel(source.source)}</strong><span className={`agent-usage-status ${source.status}`}>{t(statusLabelKey(source.status))}</span></div>
                <div className="agent-usage-source-metrics"><span>{formatUsageNumber(sourceTotal.totalTokens, locale)} {t('usage.agentUsage.tokens')}</span><span>{source.daily.length} {t('usage.agentUsage.days')}</span><span>{money(sourceTotal.costUSD)}</span></div>
                {source.status === 'error' && source.error ? <small>{source.error}</small> : null}
              </button>;
            }) : <EmptyState variant="compact">{t('usage.agentUsage.empty')}</EmptyState>}
          </div>
        </section>

        <section className="panel surface-card agent-usage-daily">
          <div className="agent-usage-section-heading"><h3>{t('usage.agentUsage.daily')}</h3><span>{t('usage.agentUsage.dayCount', { count: daily.length })}</span></div>
          {daily.length ? <div className="agent-usage-table-wrap"><table><thead><tr><th>{t('usage.agentUsage.date')}</th><th>{t('usage.agentUsage.inputTokens')}</th><th>{t('usage.agentUsage.outputTokens')}</th><th>{t('usage.agentUsage.totalTokens')}</th><th>{t('usage.agentUsage.estimatedCost')}</th></tr></thead><tbody>{daily.map(([date, row]) => <tr key={date}><td>{date}</td><td>{formatUsageNumber(row.inputTokens, locale)}</td><td>{formatUsageNumber(row.outputTokens, locale)}</td><td><strong>{formatUsageNumber(row.totalTokens, locale)}</strong></td><td>{money(row.costUSD)}</td></tr>)}</tbody></table></div> : <EmptyState variant="compact">{t('usage.agentUsage.empty')}</EmptyState>}
        </section>
      </div>

      <AgentUsagePricingView rows={priceRows} loading={pricingLoading} locale={locale} />
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
        <div className="agent-usage-table-wrap">
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
