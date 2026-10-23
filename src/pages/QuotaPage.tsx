import { requestRateColor } from '../services/authFileRequests';
import { Notice } from '../components/Notice';
import { EmptyState } from '../components/EmptyState';
import { SegmentedControl } from '../components/SegmentedControl';
import { commitFetchedQuota } from '../services/quotaEnrichment';
import { ResetCreditExpiries } from '../components/ResetCreditExpiries';
import { MessageNotice } from '../appNotice';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Gauge, ListRestart, LoaderCircle, RefreshCw } from 'lucide-react';
import { useConfirmation } from '../components/ConfirmationDialog';
import { OAuthPageToolbar } from '../components/OAuthPageToolbar';
import { QuotaActionFeedback } from '../components/QuotaActionFeedback';
import { canResetQuota, hasPendingClaudeReset } from '../services/quotaActions';
import { useQuotaReset } from '../components/useQuotaReset';
import antigravityIcon from '../assets/icons/antigravity.svg';
import claudeIcon from '../assets/icons/claude.svg';
import codexIcon from '../assets/icons/codex.svg';
import grokIcon from '../assets/icons/grok.svg';
import devinIcon from '../assets/icons/devin.svg';
import geminiIcon from '../assets/icons/gemini.svg';
import kimiIcon from '../assets/icons/kimi-light.svg';
import { managementApi, readBoolean, responseList } from '../services/managementApi';
import { formatQuotaReset, useQuotaClock } from '../services/quotaTime';
import {
  formatQuotaTimestamp,
  idleQuota,
  loadQuota,
  quotaProviderForFile,
  quotaKey,
  type AuthFile,
  type QuotaDisplayProvider,
  type QuotaState,
} from '../services/quotaService';
import {
  captureQuotaCacheGeneration,
  getQuotaCacheSnapshot,
  pruneQuotaCache,
  updateQuotaCache,
  useQuotaCache,
} from '../services/quotaCache';
import { dedupeAuthFiles, sortAuthFilesByPriority } from '../services/authFiles';
import { useI18n } from '../i18n';
import { usePrivacyMask } from '../privacy';
import './QuotaPage.css';

const providerMeta: Record<QuotaDisplayProvider, { label: string; icon: string }> = {
  plugin: { label: 'Plugin', icon: '' },
  claude: { label: 'Claude', icon: claudeIcon },
  codex: { label: 'Codex', icon: codexIcon },
  kimi: { label: 'Kimi', icon: kimiIcon },
  xai: { label: 'xAI', icon: grokIcon },
  devin: { label: 'Devin', icon: devinIcon },
  antigravity: { label: 'Antigravity', icon: antigravityIcon },
};

const providerOrder: QuotaDisplayProvider[] = ['claude', 'antigravity', 'codex', 'xai', 'kimi', 'devin', 'plugin'];
const REFRESH_CONCURRENCY = 4;

export function QuotaPage() {
  const { t } = useI18n();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [files, setFiles] = useState<AuthFile[]>([]);
  const quotas = useQuotaCache();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [category, setCategory] = useState<'all' | QuotaDisplayProvider>('all');
  const querying = Object.values(quotas).some((quota) => quota.status === 'loading');

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await managementApi.get('/credentials');
      const allFiles = sortAuthFilesByPriority(dedupeAuthFiles(responseList(payload, 'files')));
      const nextFiles = allFiles.filter((file) => !readBoolean(file, 'disabled') && quotaProviderForFile(file));
      setFiles(nextFiles);
      const validQuotaKeys = new Set(allFiles.map(quotaKey));
      pruneQuotaCache(validQuotaKeys);
      updateQuotaCache((current) => {
        const next = { ...current };
        nextFiles.forEach((file) => {
          const key = quotaKey(file);
          if (!next[key]) next[key] = idleQuota();
        });
        return next;
      });
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const refreshOne = useCallback(async (file: AuthFile) => {
    const key = quotaKey(file);
    if (getQuotaCacheSnapshot()[key]?.status === 'loading') return;
    const cacheGeneration = captureQuotaCacheGeneration();
    updateQuotaCache((current) => ({ ...current, [key]: { status: 'loading', rows: [] } }));
    const result = await loadQuota(file);
    commitFetchedQuota(cacheGeneration, file, result);
  }, [t]);

  const resetQuota = useQuotaReset(askConfirmation, setError);

  const refreshAll = useCallback(async () => {
    if (Object.values(getQuotaCacheSnapshot()).some((quota) => quota.status === 'loading')) return;
    setRefreshing(true);
    setError('');
    const cacheGeneration = captureQuotaCacheGeneration();
    updateQuotaCache((current) => ({
      ...current,
      ...Object.fromEntries(files.map((file) => [quotaKey(file), {
        ...current[quotaKey(file)], status: 'loading', rows: [],
      }])),
    }));
    try {
      for (let index = 0; index < files.length; index += REFRESH_CONCURRENCY) {
        const batch = files.slice(index, index + REFRESH_CONCURRENCY);
        await Promise.all(batch.map(async (file) => {
          const result = await loadQuota(file);
          commitFetchedQuota(cacheGeneration, file, result);
        }));
      }
    } finally {
      setRefreshing(false);
    }
  }, [files, t]);

  const grouped = useMemo(() => {
    const groups = new Map<QuotaDisplayProvider, { file: AuthFile; quota: QuotaState }[]>();
    files.forEach((file) => {
      const provider = quotaProviderForFile(file);
      if (!provider) return;
      const items = groups.get(provider) ?? [];
      items.push({ file, quota: quotas[quotaKey(file)] ?? idleQuota() });
      groups.set(provider, items);
    });
    return providerOrder.flatMap((provider) => {
      const items = groups.get(provider);
      return items ? [[provider, items] as const] : [];
    });
  }, [files, quotas]);
  const activeCategory = category !== 'all' && grouped.some(([provider]) => provider === category) ? category : 'all';
  const visibleItems = (activeCategory === 'all' ? grouped : grouped.filter(([provider]) => provider === activeCategory))
    .flatMap(([provider, items]) => items.map((item) => ({ provider, ...item })));

  return (
    <section className="page management-page quota-page" aria-label={t('quota.title')}>
      {confirmationDialog}
      {error ? <MessageNotice message={error} /> : null}
      <OAuthPageToolbar
        icon={<Gauge size={18} />}
        summary={t(files.length === 1 ? 'quota.queryableCredentials.one' : 'quota.queryableCredentials.other', { count: files.length })}
      >
        <button type="button" className="secondary-button compact-button" onClick={() => void loadFiles()} disabled={loading || refreshing || querying}>
          {loading ? <RefreshCw size={16} className="spin" /> : <ListRestart size={16} />}{t('quota.readList')}
        </button>
        <button type="button" className="primary-button compact-button" onClick={() => void refreshAll()} disabled={refreshing || loading || querying || files.length === 0}>
          <RefreshCw size={16} className={refreshing ? 'spin' : ''} />{t('quota.refreshAll')}
        </button>
      </OAuthPageToolbar>
      {loading ? (
        <div className="management-loading"><LoaderCircle size={20} className="spin" />{t('quota.loadingFiles')}</div>
      ) : grouped.length === 0 ? (
        <EmptyState className="management-empty" icon={<AlertCircle size={24} />} title={t('quota.empty.title')}>{t('quota.empty.description')}</EmptyState>
      ) : (
        <>
          <SegmentedControl className="quota-category-filter" aria-label={t('quota.filter.label')} value={activeCategory} onChange={setCategory}
            items={([['all', files.length] as const, ...grouped.map(([provider, items]) => [provider, items.length] as const)]).map(([provider, count]) => {
              const label = provider === 'all' ? t('quota.filter.all') : provider === 'plugin' ? t('quota.pluginCategory') : providerMeta[provider].label;
              return { value: provider, 'aria-label': `${label}, ${t(count === 1 ? 'quota.credentials.one' : 'quota.credentials.other', { count })}`, label: <>
                {provider === 'all' ? null : provider === 'plugin' ? <Gauge size={18} aria-hidden="true" /> : <img src={providerMeta[provider].icon} alt="" className={provider === 'devin' ? 'provider-logo devin-logo' : 'provider-logo'} />}
                <span>{label}</span><span className="quota-filter-count">{count}</span>
              </> };
            })} />
          <div className="real-quota-grid">{visibleItems.map(({ provider, file, quota }) => <QuotaCard key={quotaKey(file)} file={file} quota={quota} onRefresh={() => void refreshOne(file)} onReset={provider === 'codex' || provider === 'claude' ? () => void resetQuota(file, quota) : undefined} />)}</div>
        </>
      )}
    </section>
  );
}

export function QuotaCard({ file, quota, onRefresh, onReset }: { file: AuthFile; quota: QuotaState; onRefresh: () => void; onReset?: () => void }) {
  const { locale, t } = useI18n();
  const now = useQuotaClock() + (quota.serverTimeOffsetMs ?? 0);
  const provider = quotaProviderForFile(file);
  const privacy = usePrivacyMask();
  const name = privacy.credentialName(file);
  const disabled = readBoolean(file, 'disabled');
  const groups = quota.rows.reduce<{ label?: string; description?: string; rows: QuotaState['rows'] }[]>((result, row) => {
    const previous = result[result.length - 1];
    if (previous && previous.label === row.groupLabel) previous.rows.push(row);
    else result.push({ label: row.groupLabel, description: row.groupDescription, rows: [row] });
    return result;
  }, []);
  const countdown = (row: QuotaState['rows'][number]) => {
    if (row.resetAtMs === undefined || !Number.isFinite(row.resetAtMs)) return row.reset || '';
    const minutes = Math.max(0, Math.ceil((row.resetAtMs - now) / 60000));
    if (!minutes) return t('quota.resetPassed');
    if (minutes >= 1440) return t('quota.service.relative.daysHours', { days: Math.floor(minutes / 1440), hours: Math.floor(minutes % 1440 / 60) });
    if (minutes >= 60) return t('quota.service.relative.hoursMinutes', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
    return t('quota.service.relative.minutes', { minutes });
  };
  return (
    <article className="panel real-quota-card surface-card">
      <div className="real-quota-card-header">
        <div className="quota-identity">
          {provider === 'plugin' && String(file.provider ?? file.type).toLowerCase() !== 'gemini' ? <Gauge size={24} aria-hidden="true" /> : <img src={provider === 'plugin' && String(file.provider ?? file.type).toLowerCase() === 'gemini' ? geminiIcon : provider ? providerMeta[provider].icon : geminiIcon} alt="" className="quota-account-icon" />}
          <div><strong title={name}>{name}</strong></div>
        </div>
        {quota.plan || quota.subscriptionActiveUntil ? <div className="quota-plan">
          {quota.plan ? <span>{t('quota.planLabel')} <strong>{quota.plan}</strong></span> : null}
          {quota.subscriptionActiveUntil ? <span>{t('quota.expiresAt', { time: formatQuotaTimestamp(quota.subscriptionActiveUntil, locale) })}</span> : null}
        </div> : null}
      </div>
      <QuotaActionFeedback quota={quota} name={name} />
      {quota.status === 'idle' ? <div className="quota-card-message"><span>{disabled ? t('quota.fileDisabled') : t('quota.notFetched')}</span><button type="button" className="secondary-button compact-button" onClick={onRefresh} disabled={disabled}>{disabled ? t('quota.disabled') : t('quota.fetch')}</button></div> : null}
      {quota.status === 'loading' ? <div className="quota-card-message"><LoaderCircle size={18} className="spin" />{t(quota.pendingAction === 'reset' ? 'quota.resetting' : 'quota.querying')}</div> : null}
      {quota.status === 'error' ? <>
        <Notice tone="error" variant="text" className="quota-card-error" icon={<AlertCircle size={18} />}>{t('authFiles.quota.failed')}{quota.error ? <small>{privacy.text(quota.error)}</small> : null}</Notice>
      </> : null}
      {quota.status === 'success' && (provider === 'codex' || provider === 'claude') ? <div className="quota-reset-credit-summary surface-section surface-muted">
        {(quota.creditsUnlimited || quota.creditBalance !== undefined) ? <span>{t('quota.creditBalance')} <strong>{quota.creditsUnlimited ? t('quota.creditUnlimited') : quota.creditBalance}</strong></span> : null}
        <ResetCreditExpiries quota={quota} />
        <MessageNotice message={quota.resetCreditsError ? name + ': ' + t('quota.resetCreditsWarning', { error: quota.resetCreditsError }) : null} />
      </div> : null}
      {quota.status === 'success' ? <div className="quota-row-list">{groups.map((group, groupIndex) => <section className="quota-model-group" key={groupIndex}>
        {group.label ? <div className="quota-model-heading"><h3>{group.label}</h3>{group.description ? <p>{group.description}</p> : null}</div> : null}
        {group.rows.map((row, index) => {
          const reset = countdown(row);
          const percent = row.remainingPercent !== null && Number.isFinite(row.remainingPercent)
            ? Math.max(0, Math.min(100, row.remainingPercent)) : null;
          return <div className="real-quota-row" key={index} title={group.label ? row.detail : undefined}>
            <div className="quota-window-summary"><span>{row.windowLabel || row.label}</span><div className="quota-window-status">
              <strong>{row.quotaAvailable ? t('quota.service.antigravity.available') : percent === null ? '—' : t('quota.remaining', { percent: Math.round(percent) })}</strong>
              {reset ? <small title={formatQuotaReset(row.resetAtMs, row.reset, locale, now)}>{reset}</small> : null}
            </div></div>
            {percent !== null ? <div className="real-quota-track" role="progressbar" aria-label={row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: percent + '%', background: requestRateColor(percent / 100) }} /></div> : null}
            {!group.label && row.detail ? <small>{row.detail}</small> : null}
          </div>;
        })}
      </section>)}</div> : null}
      <div className="quota-card-actions">
        <button type="button" className="secondary-button tiny-button" onClick={onRefresh} disabled={disabled || quota.status === 'loading'} title={disabled ? t('quota.fileDisabled') : t('quota.refresh')}><RefreshCw size={12} className={quota.status === 'loading' ? 'spin' : ''} aria-hidden="true" />{t('authFiles.quota.refresh')}</button>
      </div>
      {onReset && ((quota.resetCredits ?? 0) > 0 || hasPendingClaudeReset(file)) ? <button type="button" className="secondary-button compact-button quota-reset-footer" onClick={onReset} disabled={!canResetQuota(file, quota)} title={t('quota.reset')}>{t(hasPendingClaudeReset(file) ? 'quota.claude.retry' : 'quota.reset')}</button> : null}
    </article>
  );
}
