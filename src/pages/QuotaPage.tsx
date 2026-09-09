import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useConfirmation } from '../components/ConfirmationDialog';
import { QuotaActionFeedback } from '../components/QuotaActionFeedback';
import { canResetCodexQuota, resetCodexQuotaWithConfirmation } from '../services/quotaActions';
import antigravityIcon from '../assets/icons/antigravity.svg';
import claudeIcon from '../assets/icons/claude.svg';
import codexIcon from '../assets/icons/codex.svg';
import grokIcon from '../assets/icons/grok.svg';
import kimiIcon from '../assets/icons/kimi-light.svg';
import { managementApi, readBoolean, responseList } from '../services/managementApi';
import { formatQuotaReset, useQuotaClock } from '../services/quotaTime';
import {
  fileName,
  formatQuotaTimestamp,
  idleQuota,
  loadQuota,
  providerForFile,
  quotaKey,
  type AuthFile,
  type QuotaProvider,
  type QuotaState,
} from '../services/quotaService';
import {
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  getQuotaCacheSnapshot,
  pruneQuotaCache,
  updateQuotaCache,
  useQuotaCache,
} from '../services/quotaCache';
import { dedupeAuthFiles } from '../services/authFiles';
import { useI18n } from '../i18n';

const providerMeta: Record<QuotaProvider, { label: string; icon: string }> = {
  claude: { label: 'Claude', icon: claudeIcon },
  codex: { label: 'Codex', icon: codexIcon },
  kimi: { label: 'Kimi', icon: kimiIcon },
  xai: { label: 'xAI', icon: grokIcon },
  antigravity: { label: 'Antigravity', icon: antigravityIcon },
};

const providerOrder: QuotaProvider[] = ['claude', 'antigravity', 'codex', 'xai', 'kimi'];
const REFRESH_CONCURRENCY = 4;

export function QuotaPage() {
  const { locale, t } = useI18n();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [files, setFiles] = useState<AuthFile[]>([]);
  const quotas = useQuotaCache();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const querying = Object.values(quotas).some((quota) => quota.status === 'loading');

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await managementApi.get('/auth-files');
      const allFiles = dedupeAuthFiles(responseList(payload, 'files'));
      const nextFiles = allFiles.filter((file) => !readBoolean(file, 'disabled') && providerForFile(file));
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
    commitQuotaCacheIfCurrent(cacheGeneration, () => {
      updateQuotaCache((current) => ({ ...current, [key]: result }));
    });
  }, [t]);

  const resetCodexQuota = useCallback(async (file: AuthFile, quota: QuotaState) => {
    setError('');
    try {
      await resetCodexQuotaWithConfirmation(file, () => askConfirmation({
        title: t('quota.reset'),
        message: t('quota.confirm.title', { name: fileName(file) }),
        confirmText: t('quota.confirm.button'),
        details: [
          { label: t('quota.resetCredits'), value: String(quota.resetCredits ?? '—') },
          { label: t('quota.earliestExpiry'), value: formatQuotaTimestamp(quota.resetCreditsEarliestExpiry, locale) },
        ],
        warning: t('quota.confirm.warning'),
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, [askConfirmation, locale, t]);

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
          commitQuotaCacheIfCurrent(cacheGeneration, () => {
            updateQuotaCache((current) => ({ ...current, [quotaKey(file)]: result }));
          });
        }));
      }
    } finally {
      setRefreshing(false);
    }
  }, [files, t]);

  const grouped = useMemo(() => {
    const groups = new Map<QuotaProvider, { file: AuthFile; quota: QuotaState }[]>();
    files.forEach((file) => {
      const provider = providerForFile(file);
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

  return (
    <section className="page management-page quota-page">
      {confirmationDialog}
      <header className="management-header">
        <div><h1>{t('quota.title')}</h1></div>
        <div className="management-heading-actions">
          <span className="muted-summary">{t(files.length === 1 ? 'quota.queryableCredentials.one' : 'quota.queryableCredentials.other', { count: files.length })}</span>
          <button type="button" className="secondary-button compact-button" onClick={() => void loadFiles()} disabled={loading || refreshing || querying}>
            <RefreshCw size={16} />{t('quota.readList')}
          </button>
          <button type="button" className="secondary-button compact-button" onClick={() => void refreshAll()} disabled={refreshing || loading || querying || files.length === 0}>
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />{t('quota.refreshAll')}
          </button>
        </div>
      </header>
      {error ? <div className="management-alert error">{error}</div> : null}
      {loading ? (
        <div className="management-loading"><LoaderCircle size={20} className="spin" />{t('quota.loadingFiles')}</div>
      ) : grouped.length === 0 ? (
        <div className="management-empty"><AlertCircle size={24} /><strong>{t('quota.empty.title')}</strong><span>{t('quota.empty.description')}</span></div>
      ) : (
        <div className="quota-group-list">
          {grouped.map(([provider, items]) => (
            <section className="quota-provider-group" key={provider}>
              <div className="quota-group-heading"><div><img src={providerMeta[provider].icon} alt="" className="provider-logo" /><h2>{providerMeta[provider].label}</h2></div><span>{t(items.length === 1 ? 'quota.credentials.one' : 'quota.credentials.other', { count: items.length })}</span></div>
              <div className="real-quota-grid">{items.map(({ file, quota }) => <QuotaCard key={quotaKey(file)} file={file} quota={quota} onRefresh={() => void refreshOne(file)} onReset={provider === 'codex' ? () => void resetCodexQuota(file, quota) : undefined} />)}</div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

export function QuotaCard({ file, quota, onRefresh, onReset }: { file: AuthFile; quota: QuotaState; onRefresh: () => void; onReset?: () => void }) {
  const { locale, t } = useI18n();
  const now = useQuotaClock() + (quota.serverTimeOffsetMs ?? 0);
  const provider = providerForFile(file);
  const name = fileName(file);
  const disabled = readBoolean(file, 'disabled');
  return (
    <article className="panel real-quota-card">
      <div className="real-quota-card-header">
        <div><strong title={name}>{name}</strong><span>{provider ? providerMeta[provider].label : t('quota.unknownProvider')}{quota.plan ? ' · ' + quota.plan : ''}</span></div>
        <div className="quota-card-actions">
          {onReset && (quota.resetCredits ?? 0) > 0 ? <button type="button" className="secondary-button compact-button" onClick={onReset} disabled={!canResetCodexQuota(file, quota)} title={t('quota.reset')}>{t('quota.reset')}</button> : null}
          <button type="button" className="icon-button quiet" onClick={onRefresh} disabled={disabled || quota.status === 'loading'} title={disabled ? t('quota.fileDisabled') : t('quota.refresh')}><RefreshCw size={16} className={quota.status === 'loading' ? 'spin' : ''} /></button>
        </div>
      </div>
      <QuotaActionFeedback quota={quota} />
      {quota.status === 'idle' ? <div className="quota-card-message"><span>{disabled ? t('quota.fileDisabled') : t('quota.notFetched')}</span><button type="button" className="secondary-button compact-button" onClick={onRefresh} disabled={disabled}>{disabled ? t('quota.disabled') : t('quota.fetch')}</button></div> : null}
      {quota.status === 'loading' ? <div className="quota-card-message"><LoaderCircle size={18} className="spin" />{t(quota.pendingAction === 'reset' ? 'quota.resetting' : 'quota.querying')}</div> : null}
      {quota.status === 'error' ? <div className="quota-card-error"><AlertCircle size={18} />{quota.error}</div> : null}
      {quota.status === 'success' && provider === 'codex' ? <div className="quota-reset-credit-summary">
        <span>{t('quota.resetCredits')} <strong>{quota.resetCredits ?? '—'}</strong></span>
        {quota.resetCreditsApplicable !== undefined ? <span>{t('quota.resetApplicable', { count: quota.resetCreditsApplicable })}</span> : null}
        <span>{t('quota.earliestExpiry')} <strong>{formatQuotaTimestamp(quota.resetCreditsEarliestExpiry, locale)}</strong></span>
        {quota.subscriptionActiveUntil ? <span>{t('quota.subscriptionExpiry', { time: formatQuotaTimestamp(quota.subscriptionActiveUntil, locale) })}</span> : null}
        {quota.resetCreditsError ? <small>{t('quota.resetCreditsWarning', { error: quota.resetCreditsError })}</small> : null}
      </div> : null}
      {quota.status === 'success' ? <div className="quota-row-list">{quota.rows.map((row, index) => {
        const reset = formatQuotaReset(row.resetAtMs, row.reset, locale, now);
        return <div className="real-quota-row" key={`${row.label}-${index}`}>
          <div><span>{row.label}</span><strong>{row.remainingPercent === null ? '—' : t('quota.remaining', { percent: Math.round(row.remainingPercent) })}</strong></div>
          {row.remainingPercent !== null ? <div className="real-quota-track"><span style={{ width: `${Math.max(0, Math.min(100, row.remainingPercent))}%` }} /></div> : null}
          <small>{[row.detail, reset].filter(Boolean).join(' · ')}</small>
        </div>;
      })}</div> : null}
    </article>
  );
}
