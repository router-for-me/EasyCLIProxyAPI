import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, RefreshCw, TriangleAlert } from 'lucide-react';
import {
  AgentUsageActivity,
  AgentUsageChart,
  AGENT_USAGE_VIEWS,
  agentSourceColor,
  agentUsageMoney as money,
  STRUCTURE_COLORS,
  type AgentUsageView as AgentUsageViewMode,
} from '../components/AgentUsageCharts';
import { AgentUsageRangePopover, type AgentUsageCustomRange } from '../components/AgentUsageRangePopover';
import { BrandIcon } from '../components/BrandIcon';
import { EmptyState } from '../components/EmptyState';
import { Notice } from '../components/Notice';
import { SegmentedControl } from '../components/SegmentedControl';
import { useI18n } from '../i18n';
import {
  AGENT_USAGE_GRANULARITIES,
  AGENT_USAGE_GROUP_BY,
  AGENT_USAGE_TIME_RANGES,
  agentUsageHourAvailable,
  formatAgentUsageBucket,
  formatAgentUsageCompact,
  formatAgentUsageNumber,
  getAgentUsage,
  rangeGranularity,
  syncAgentUsage,
  type AgentUsageGranularity,
  type AgentUsageGroupBy,
  type AgentUsageMetric,
  type AgentUsageReport,
  type AgentUsageSource,
  type AgentUsageSyncProgress,
  type AgentUsageTimeRange,
} from '../services/agentUsage';
import { buildModelRanking, cacheHitRate, periodChange, shareOf, sparklinePoints } from '../services/agentUsageCharts';
import { loadAgentUsageRefreshInterval, shouldSyncAgentUsageOnOpen } from '../services/agentUsagePreferences';
import { onAgentUsageSynced, onAgentUsageSyncProgress } from '../services/events';
import './AgentUsageView.css';

type AgentUsageViewProps = {
  refreshKey: number;
  onLoadingChange: (loading: boolean) => void;
};

type RankingTab = 'models' | 'sources' | 'details';

const sourceLabels: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  mcode: 'MCode',
  opencode: 'OpenCode',
  omp: 'Oh My Pi',
  pi: 'Pi',
  copilot: 'Copilot CLI',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  zcode: 'ZCode',
};

const MODEL_PREVIEW_COUNT = 8;
const PROGRESS_RELOAD_MS = 1200;
const TOKEN_KINDS = ['cacheRead', 'cacheCreation', 'input', 'output'] as const;

const sourceLabel = (source: string): string => sourceLabels[source] ?? source;

function Sparkline({ values, tone }: { values: number[]; tone: 'tokens' | 'cost' }) {
  const points = sparklinePoints(values, 100, 26);
  if (!points || values.every((value) => value <= 0)) return <span className="agent-usage-sparkline empty" aria-hidden="true" />;
  return (
    <svg className={`agent-usage-sparkline ${tone}`} viewBox="0 -2 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,28 ${points} 100,28`} />
      <polyline points={points} />
    </svg>
  );
}

export function AgentUsageView({ refreshKey, onLoadingChange }: AgentUsageViewProps) {
  const { t, locale } = useI18n();
  const [report, setReport] = useState<AgentUsageReport | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<AgentUsageSyncProgress | null>(null);
  const [error, setError] = useState('');
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [timeRange, setTimeRange] = useState<AgentUsageTimeRange>('7d');
  const [customRange, setCustomRange] = useState<AgentUsageCustomRange | null>(null);
  const [rangeAnchor, setRangeAnchor] = useState<HTMLElement | null>(null);
  const [granularity, setGranularity] = useState<AgentUsageGranularity | ''>('');
  const [groupBy, setGroupBy] = useState<AgentUsageGroupBy>('source');
  const [metric, setMetric] = useState<AgentUsageMetric>('totalTokens');
  const [view, setView] = useState<AgentUsageViewMode>('trend');
  const [ranking, setRanking] = useState<RankingTab>('models');
  const [showAllModels, setShowAllModels] = useState(false);
  const mountedRef = useRef(false);
  const openedRef = useRef(false);
  const currentFilters = () => ({
    range: timeRange, sources: selectedSources, groupBy, granularity,
    ...(timeRange === 'custom' && customRange ? { start: customRange.start, end: customRange.end } : {}),
  });
  const filtersRef = useRef(currentFilters());
  const reloadAtRef = useRef(0);
  const requestRef = useRef(0);
  const localSyncRef = useRef(false);
  filtersRef.current = currentFilters();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onLoadingChange(false);
    };
  }, [onLoadingChange]);

  const loadReport = useCallback(async (): Promise<AgentUsageReport | null> => {
    const request = ++requestRef.current;
    try {
      const next = await getAgentUsage(filtersRef.current);
      if (!mountedRef.current || request !== requestRef.current) return null;
      setReport(next);
      setError('');
      const busy = next.syncing || localSyncRef.current;
      setSyncing(busy);
      if (!busy) setProgress(null);
      return next;
    } catch (reason) {
      if (mountedRef.current && request === requestRef.current) setError(String(reason) || t('usage.agentUsage.readFailed'));
      return null;
    }
  }, [t]);

  const finishSync = useCallback(() => {
    if (!mountedRef.current) return;
    setSyncing(false);
    setProgress(null);
  }, []);

  const runSync = useCallback(async () => {
    if (mountedRef.current) setSyncing(true);
    localSyncRef.current = true;
    try {
      const result = await syncAgentUsage();
      localSyncRef.current = false;
      if (result.skipped) return;
      await loadReport();
      finishSync();
    } catch (reason) {
      localSyncRef.current = false;
      if (mountedRef.current) setError(String(reason) || t('usage.agentUsage.readFailed'));
      finishSync();
    }
  }, [finishSync, loadReport, t]);

  useEffect(() => {
    onLoadingChange(syncing);
  }, [onLoadingChange, syncing]);

  useEffect(() => {
    const disposers: (() => void)[] = [];
    let disposed = false;
    const keep = (promise: Promise<() => void>) => promise.then((unlisten) => {
      if (disposed) unlisten();
      else disposers.push(unlisten);
    }).catch(() => {});
    keep(onAgentUsageSyncProgress((event) => {
      if (!mountedRef.current) return;
      setSyncing(true);
      setProgress(event.payload);
      const now = Date.now();
      if (event.payload.finished || now - reloadAtRef.current >= PROGRESS_RELOAD_MS) {
        reloadAtRef.current = now;
        void loadReport();
      }
    }));
    keep(onAgentUsageSynced(() => {
      void loadReport().then(finishSync);
    }));
    return () => {
      disposed = true;
      disposers.forEach((dispose) => dispose());
    };
  }, [finishSync, loadReport]);

  useEffect(() => {
    void loadReport().then((next) => {
      const opening = !openedRef.current;
      openedRef.current = true;
      if (!opening || shouldSyncAgentUsageOnOpen(loadAgentUsageRefreshInterval(), next?.lastSyncAt)) void runSync();
    });
  }, [refreshKey, loadReport, runSync]);

  useEffect(() => {
    if (report) void loadReport();
  }, [timeRange, customRange, selectedSources, groupBy, granularity]);

  const changeRange = (next: AgentUsageTimeRange, dates: AgentUsageCustomRange | null = null) => {
    setTimeRange(next);
    setCustomRange(dates);
    setGranularity(rangeGranularity(granularity || report?.bucket || '', agentUsageHourAvailable(next, dates?.start ?? '', new Date())));
  };

  const chooseRange = (next: AgentUsageTimeRange) => {
    if (next !== 'custom') {
      changeRange(next);
      return;
    }
    const anchor = document.querySelector<HTMLButtonElement>('.agent-usage-range [data-value="custom"]');
    anchor?.focus();
    setRangeAnchor((current) => current ? null : anchor);
  };

  const closeRange = useCallback(() => setRangeAnchor(null), []);

  const toggleSource = (source: string) => {
    setSelectedSources((current) => current.includes(source)
      ? current.filter((entry) => entry !== source)
      : [...current, source]);
  };

  const sources = report?.sources ?? [];
  const sourceOrder = useMemo(() => sources.map((source) => source.source), [sources]);
  const usedSources = useMemo(() => sources
    .filter((source) => source.totals.totalTokens > 0 || selectedSources.includes(source.source))
    .sort((left, right) => right.totals.totalTokens - left.totals.totalTokens), [selectedSources, sources]);
  const allSourceTokens = usedSources.reduce((sum, source) => sum + source.totals.totalTokens, 0);
  const models = useMemo(() => buildModelRanking(sources), [sources]);

  if (!report) {
    if (error) {
      return (
        <EmptyState
          className="agent-usage-loading"
          tone="error"
          icon={<TriangleAlert size={20} />}
          title={t('usage.agentUsage.title')}
          action={<button type="button" className="secondary-button" onClick={() => void loadReport().then(() => runSync())}>{t('usage.agentUsage.syncNow')}</button>}
        >
          {error}
        </EmptyState>
      );
    }
    return (
      <EmptyState className="agent-usage-loading" icon={<Database size={22} />}>
        {t('usage.agentUsage.loading')}
      </EmptyState>
    );
  }

  const totals = report.totals;
  const percent = (value: number, digits = 1) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(value);
  const changeText = (current: number, previous: number | undefined) => {
    if (previous === undefined) return '';
    const change = periodChange(current, previous);
    if (change === null) return t('usage.agentUsage.changeNoBaseline');
    if (Math.abs(change) < 0.005) return t('usage.agentUsage.changeFlat');
    return t(change > 0 ? 'usage.agentUsage.changeUp' : 'usage.agentUsage.changeDown', { percent: percent(Math.abs(change), 0) });
  };
  const changeTone = (current: number, previous: number | undefined) => {
    const change = previous === undefined ? null : periodChange(current, previous);
    return change === null || Math.abs(change) < 0.005 ? '' : change > 0 ? 'up' : 'down';
  };
  const lastSyncAt = report.lastSyncAt ? new Date(report.lastSyncAt) : null;
  const visibleModels = showAllModels ? models : models.slice(0, MODEL_PREVIEW_COUNT);
  const modelTotal = models.reduce((sum, model) => sum + model.totalTokens, 0);
  const detailRows = report.timeline.filter((row) => row.totalTokens > 0).reverse();
  const archivedLabel = (source: AgentUsageSource): string => {
    const date = source.archivedAt ? new Date(source.archivedAt) : null;
    if (!date || Number.isNaN(date.getTime())) return t('usage.agentUsage.archivedUnknown');
    return t('usage.agentUsage.archived', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date) });
  };
  const emptyText = syncing ? t('usage.agentUsage.building') : t('usage.agentUsage.empty');
  const hitRate = cacheHitRate(totals);
  const tokenParts = TOKEN_KINDS.map((kind, index) => ({
    kind,
    color: STRUCTURE_COLORS[index],
    value: kind === 'cacheRead' ? totals.cacheReadTokens : kind === 'cacheCreation' ? totals.cacheCreationTokens : kind === 'input' ? totals.inputTokens : totals.outputTokens,
  }));
  const tokenPartsTotal = tokenParts.reduce((sum, part) => sum + part.value, 0);
  const full = (value: number) => formatAgentUsageNumber(value, locale);
  const hourAvailable = agentUsageHourAvailable(timeRange, customRange?.start ?? '', new Date());

  return (
    <section className="agent-usage-view" aria-label={t('usage.agentUsage.title')} aria-busy={syncing}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {rangeAnchor ? (
        <AgentUsageRangePopover anchor={rangeAnchor} initial={customRange} onClose={closeRange}
          onApply={(dates) => {
            setRangeAnchor(null);
            changeRange('custom', dates);
          }} />
      ) : null}
      <div className="agent-usage-toolbar">
        <div className="agent-usage-title-row">
          <h2>{t('usage.agentUsage.title')}</h2>
          <div aria-live="polite" className={`agent-usage-sync-status${syncing ? ' syncing' : ''}`}>
            <span className="agent-usage-sync-dot" aria-hidden="true" />
            {syncing
              ? progress
                ? t('usage.agentUsage.syncProgress', { source: sourceLabel(progress.source), scanned: progress.scanned, total: progress.total })
                : t('usage.agentUsage.syncing')
              : lastSyncAt && !Number.isNaN(lastSyncAt.getTime())
                ? <>{t('usage.agentUsage.lastSynced')} <time dateTime={report.lastSyncAt}>{new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(lastSyncAt)}</time></>
                : t('usage.agentUsage.neverSynced')}
          </div>
        </div>
        <div className="agent-usage-toolbar-actions">
          <SegmentedControl className="usage-analysis-metric agent-usage-range" aria-label={t('usage.agentUsage.timeRange')}
            value={timeRange} onChange={chooseRange}
            items={AGENT_USAGE_TIME_RANGES.map((range) => range === 'custom' && timeRange === 'custom' && customRange
              ? { value: range, label: customRange.preset ? t(`usage.agentUsage.preset.${customRange.preset}`) : `${customRange.start} ~ ${customRange.end}`, title: `${customRange.start} ~ ${customRange.end}` }
              : { value: range, label: t(`usage.agentUsage.range.${range}`) })} />
          <SegmentedControl className="usage-analysis-metric agent-usage-granularity" aria-label={t('usage.agentUsage.granularity')}
            value={report.bucket} onChange={(next) => setGranularity(next as AgentUsageGranularity)}
            items={AGENT_USAGE_GRANULARITIES.map((item) => ({
              value: item,
              label: t(`usage.agentUsage.granularity.${item}`),
              disabled: item === 'hour' && !hourAvailable,
              title: item === 'hour' && !hourAvailable ? t('usage.agentUsage.hourUnavailable') : undefined,
            }))} />
          <button type="button" className="secondary-button compact-button agent-usage-sync" disabled={syncing} onClick={() => void runSync()}>
            <RefreshCw size={14} className={syncing ? 'agent-usage-spin' : ''} aria-hidden="true" />{t('usage.agentUsage.syncNow')}
          </button>
        </div>
      </div>

      {usedSources.length ? (
        <div className="agent-usage-chips" role="group" aria-label={t('usage.agentUsage.sourceFilter')}>
          <button type="button" className={`agent-usage-chip${selectedSources.length ? '' : ' selected'}`}
            aria-pressed={!selectedSources.length} onClick={() => setSelectedSources([])}>
            {t('usage.agentUsage.allSources')}
          </button>
          {usedSources.map((source) => {
            const selected = selectedSources.includes(source.source);
            return (
              <button
                type="button"
                key={source.source}
                className={`agent-usage-chip${selected ? ' selected' : ''}`}
                data-source={source.source}
                data-status={source.status}
                aria-pressed={selected}
                title={source.status === 'archived' ? archivedLabel(source) : undefined}
                onClick={() => toggleSource(source.source)}
              >
                <span className="agent-usage-chip-dot" style={{ background: agentSourceColor(source.source, sourceOrder) }} aria-hidden="true" />
                <BrandIcon name={source.source} size={14} />
                <span>{sourceLabel(source.source)}</span>
                <small>{formatAgentUsageCompact(source.totals.totalTokens)}</small>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="agent-usage-kpis">
        <div className="surface-card agent-usage-kpi" data-kpi="tokens">
          <span>{t('usage.agentUsage.totalTokens')}</span>
          <strong title={full(totals.totalTokens)}>{formatAgentUsageCompact(totals.totalTokens)}</strong>
          <div className="agent-usage-kpi-trend">
            <small className={changeTone(totals.totalTokens, report.previous?.totalTokens)}>
              {changeText(totals.totalTokens, report.previous?.totalTokens) || t('usage.agentUsage.activeDays', { count: totals.days })}
            </small>
            <Sparkline values={report.timeline.map((row) => row.totalTokens)} tone="tokens" />
          </div>
          <div className="agent-usage-kpi-split">
            <span className="agent-usage-stack" aria-hidden="true">
              {tokenParts.map((part) => (
                <span key={part.kind} style={{ width: `${shareOf(part.value, tokenPartsTotal) * 100}%`, background: part.color }} />
              ))}
            </span>
            <span className="agent-usage-stack-legend">
              {tokenParts.filter((part) => part.value > 0).map((part) => (
                <span key={part.kind} title={full(part.value)}>
                  <i style={{ background: part.color }} aria-hidden="true" />
                  {t(`usage.agentUsage.token.${part.kind}`)} {percent(shareOf(part.value, tokenPartsTotal), 0)}
                </span>
              ))}
            </span>
          </div>
        </div>
        <div className="surface-card agent-usage-kpi cost" data-kpi="cost">
          <span title={t('usage.agentUsage.costHint')}>{t('usage.agentUsage.estimatedCost')}</span>
          <strong>{money(totals.costUSD)}</strong>
          <div className="agent-usage-kpi-trend">
            <small className={changeTone(totals.costUSD, report.previous?.costUSD)}>
              {changeText(totals.costUSD, report.previous?.costUSD)}
            </small>
            <Sparkline values={report.timeline.map((row) => row.costUSD)} tone="cost" />
          </div>
          <small className="agent-usage-kpi-foot">
            {[t('usage.agentUsage.activeDays', { count: totals.days }),
              totals.days > 0 ? t('usage.agentUsage.dailyAverage', { value: money(totals.costUSD / totals.days) }) : ''].filter(Boolean).join(' · ')}
          </small>
        </div>
        <div className="surface-card agent-usage-kpi" data-kpi="cache">
          <span>{t('usage.agentUsage.cacheHitRate')}</span>
          <strong>{percent(hitRate)}</strong>
          <span className="agent-usage-meter" aria-hidden="true"><span style={{ width: `${hitRate * 100}%` }} /></span>
          <small className="agent-usage-kpi-foot">
            {t('usage.agentUsage.cacheHitDetail', { read: formatAgentUsageCompact(totals.cacheReadTokens), write: formatAgentUsageCompact(totals.cacheCreationTokens) })}
          </small>
        </div>
      </div>

      <section className="panel surface-card agent-usage-charts-panel">
        <div className="agent-usage-section-heading agent-usage-chart-heading">
          <SegmentedControl className="usage-analysis-metric agent-usage-view-tabs" aria-label={t('usage.agentUsage.viewLabel')}
            value={view} onChange={(next) => setView(next as AgentUsageViewMode)}
            items={AGENT_USAGE_VIEWS.map((item) => ({ value: item, label: t(`usage.agentUsage.view.${item}`) }))} />
          {view === 'trend' ? (
            <div className="agent-usage-chart-controls">
              <SegmentedControl className="usage-analysis-metric agent-usage-group-tabs" aria-label={t('usage.agentUsage.groupBy')}
                value={groupBy} onChange={(next) => setGroupBy(next as AgentUsageGroupBy)}
                items={AGENT_USAGE_GROUP_BY.map((item) => ({ value: item, label: t(`usage.agentUsage.groupBy.${item}`) }))} />
              <SegmentedControl className="usage-analysis-metric agent-usage-metric-tabs" aria-label={t('usage.agentUsage.metricLabel')}
                value={metric} onChange={(next) => setMetric(next as AgentUsageMetric)}
                items={[
                  { value: 'totalTokens', label: t('usage.agentUsage.metric.tokens') },
                  { value: 'costUSD', label: t('usage.agentUsage.metric.cost') },
                ]} />
            </div>
          ) : null}
        </div>
        <AgentUsageChart view={view} metric={metric} report={report} groupBy={groupBy} locale={locale}
          seriesLabel={groupBy === 'source' || view !== 'trend' ? sourceLabel : (key) => key || t('usage.agentUsage.unknownModel')} />
      </section>

      <section className="panel surface-card agent-usage-activity">
        <div className="agent-usage-section-heading">
          <h3>{t('usage.agentUsage.activityTitle')}</h3>
          <span>{t('usage.agentUsage.activityHint')}</span>
        </div>
        <AgentUsageActivity report={report} locale={locale} />
      </section>

      <section className="panel surface-card agent-usage-ranking">
        <SegmentedControl className="usage-analysis-metric agent-usage-ranking-tabs" aria-label={t('usage.agentUsage.rankingLabel')}
          value={ranking} onChange={(next) => setRanking(next as RankingTab)}
          items={[
            { value: 'models', label: `${t('usage.agentUsage.models')} ${models.length}` },
            { value: 'sources', label: `${t('usage.agentUsage.sources')} ${usedSources.length}` },
            { value: 'details', label: t('usage.agentUsage.details') },
          ]} />
        {ranking === 'models' ? (
          models.length ? (
            <>
              <div className="agent-usage-table-wrap">
                <table className="agent-usage-table" data-table="models">
                  <thead><tr>
                    <th>{t('usage.agentUsage.models')}</th>
                    <th className="share">{t('usage.agentUsage.column.share')}</th>
                    <th>{t('usage.agentUsage.totalTokens')}</th>
                    <th>{t('usage.agentUsage.estimatedCost')}</th>
                  </tr></thead>
                  <tbody>
                    {visibleModels.map((model) => {
                      const share = shareOf(model.totalTokens, modelTotal);
                      return (
                        <tr key={model.model} data-model={model.model}>
                          <td className="name" title={model.model || t('usage.agentUsage.unknownModel')}>{model.model || t('usage.agentUsage.unknownModel')}</td>
                          <td className="share"><ShareBar share={share} label={percent(share)} /></td>
                          <td title={full(model.totalTokens)}>{formatAgentUsageCompact(model.totalTokens)}</td>
                          <td className={model.priced ? undefined : 'unpriced'} title={model.priced ? undefined : t('usage.agentUsage.unpriced')}>{money(model.costUSD)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {models.length > MODEL_PREVIEW_COUNT ? (
                <button type="button" className="link-button" onClick={() => setShowAllModels((current) => !current)}>
                  {showAllModels ? t('usage.agentUsage.showFewerModels') : t('usage.agentUsage.showAllModels', { count: models.length })}
                </button>
              ) : null}
            </>
          ) : <EmptyState variant="compact">{emptyText}</EmptyState>
        ) : null}
        {ranking === 'sources' ? (
          usedSources.length ? (
            <div className="agent-usage-table-wrap">
              <table className="agent-usage-table" data-table="sources">
                <thead><tr>
                  <th>{t('usage.agentUsage.sources')}</th>
                  <th className="share">{t('usage.agentUsage.column.share')}</th>
                  <th>{t('usage.agentUsage.totalTokens')}</th>
                  <th>{t('usage.agentUsage.column.days')}</th>
                  <th>{t('usage.agentUsage.estimatedCost')}</th>
                </tr></thead>
                <tbody>
                  {usedSources.map((source) => {
                    const share = shareOf(source.totals.totalTokens, allSourceTokens);
                    const dimmed = selectedSources.length > 0 && !selectedSources.includes(source.source);
                    return (
                      <tr key={source.source} data-source={source.source} className={dimmed ? 'dimmed' : undefined}>
                        <td className="name">
                          <span className="agent-usage-source-name">
                            <span className="agent-usage-chip-dot" style={{ background: agentSourceColor(source.source, sourceOrder) }} aria-hidden="true" />
                            <BrandIcon name={source.source} size={14} />
                            {sourceLabel(source.source)}
                            {source.status === 'archived' ? <small>{archivedLabel(source)}</small> : null}
                          </span>
                        </td>
                        <td className="share"><ShareBar share={share} label={percent(share)} color={agentSourceColor(source.source, sourceOrder)} /></td>
                        <td title={full(source.totals.totalTokens)}>{formatAgentUsageCompact(source.totals.totalTokens)}</td>
                        <td>{source.totals.days}</td>
                        <td>{money(source.totals.costUSD)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <EmptyState variant="compact">{emptyText}</EmptyState>
        ) : null}
        {ranking === 'details' ? (
          detailRows.length ? (
            <div className="agent-usage-table-wrap scroll" tabIndex={0} role="region" aria-label={t('usage.agentUsage.details')}>
              <table className="agent-usage-table" data-table="details">
                <thead><tr>
                  <th>{t(`usage.agentUsage.bucketColumn.${report.bucket}`)}</th>
                  <th>{t('usage.agentUsage.inputTokens')}</th>
                  <th>{t('usage.agentUsage.outputTokens')}</th>
                  <th>{t('usage.agentUsage.cacheReadTokens')}</th>
                  <th>{t('usage.agentUsage.cacheCreationTokens')}</th>
                  <th>{t('usage.agentUsage.totalTokens')}</th>
                  <th>{t('usage.agentUsage.estimatedCost')}</th>
                </tr></thead>
                <tbody>
                  {detailRows.map((row) => (
                    <tr key={row.bucket}>
                      <td className="name">{formatAgentUsageBucket(row.bucket, report.bucket)}</td>
                      <td title={full(row.inputTokens)}>{formatAgentUsageCompact(row.inputTokens)}</td>
                      <td title={full(row.outputTokens)}>{formatAgentUsageCompact(row.outputTokens)}</td>
                      <td title={full(row.cacheReadTokens)}>{formatAgentUsageCompact(row.cacheReadTokens)}</td>
                      <td title={full(row.cacheCreationTokens)}>{formatAgentUsageCompact(row.cacheCreationTokens)}</td>
                      <td title={full(row.totalTokens)}><strong>{formatAgentUsageCompact(row.totalTokens)}</strong></td>
                      <td>{money(row.costUSD)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState variant="compact">{emptyText}</EmptyState>
        ) : null}
      </section>
    </section>
  );
}

function ShareBar({ share, label, color }: { share: number; label: string; color?: string }) {
  return (
    <span className="agent-usage-share">
      <span className="agent-usage-share-track" aria-hidden="true">
        <span style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%`, background: color }} />
      </span>
      <span className="agent-usage-share-value">{label}</span>
    </span>
  );
}
