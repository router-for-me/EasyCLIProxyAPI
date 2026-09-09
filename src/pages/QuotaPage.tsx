import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, KeyRound, LoaderCircle, RefreshCw, Settings2, ShieldCheck, X } from 'lucide-react';
import { useConfirmation } from '../components/ConfirmationDialog';
import { QuotaActionFeedback } from '../components/QuotaActionFeedback';
import { canResetCodexQuota, resetCodexQuotaWithConfirmation } from '../services/quotaActions';
import antigravityIcon from '../assets/icons/antigravity.svg';
import claudeIcon from '../assets/icons/claude.svg';
import codexIcon from '../assets/icons/codex.svg';
import deepseekIcon from '../assets/icons/deepseek.svg';
import grokIcon from '../assets/icons/grok.svg';
import kimiIcon from '../assets/icons/kimi-light.svg';
import novitaIcon from '../assets/icons/novita.svg';
import openrouterIcon from '../assets/icons/openrouter.svg';
import openaiIcon from '../assets/icons/openai-light.svg';
import siliconflowIcon from '../assets/icons/siliconflow.svg';
import stepfunIcon from '../assets/icons/stepfun.svg';
import {
  apiQuotaCacheKey,
  apiQuotaSourceLabel,
  apiQuotaVendorLabel,
  countApiQuotaSources,
  countApiQuotaUnsupported,
  discoverApiQuotaSources,
  loadQuotaSourceStages,
  saveApiQuotaBalanceUrl,
  isApiQuotaSourceQueryable,
  queryApiQuotaSource,
  type ApiQuotaSource,
  type ApiQuotaVendor,
} from '../services/apiQuota';
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
  API_QUOTA_CACHE_PREFIX,
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  getQuotaCacheSnapshot,
  pruneQuotaCache,
  pruneQuotaCacheNamespace,
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
const apiProviderOrder: ApiQuotaVendor[] = ['deepseek', 'stepfun', 'siliconflow', 'openrouter', 'novita'];
const apiProviderIcons: Record<ApiQuotaVendor, string> = {
  deepseek: deepseekIcon,
  stepfun: stepfunIcon,
  siliconflow: siliconflowIcon,
  openrouter: openrouterIcon,
  novita: novitaIcon,
};

export const apiQuotaProviderIcon = (provider: ApiQuotaVendor) => apiProviderIcons[provider];
const REFRESH_CONCURRENCY = 4;

export function QuotaPage() {
  const { locale, t } = useI18n();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [files, setFiles] = useState<AuthFile[]>([]);
  const [apiSources, setApiSources] = useState<ApiQuotaSource[]>([]);
  const quotas = useQuotaCache();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [balanceEditorSource, setBalanceEditorSource] = useState<ApiQuotaSource | null>(null);
  const [balanceEditorError, setBalanceEditorError] = useState('');
  const [balanceEditorSaving, setBalanceEditorSaving] = useState(false);
  const querying = Object.values(quotas).some((quota) => quota.status === 'loading');

  const loadOAuthFiles = useCallback(async () => {
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
  }, []);

  const loadSources = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await loadQuotaSourceStages(discoverApiQuotaSources, loadOAuthFiles, (apiResult) => {
        setApiSources(apiResult.sources);
        const validApiKeys = new Set(apiResult.sources.map(apiQuotaCacheKey));
        pruneQuotaCacheNamespace('api-quota::', validApiKeys);
        updateQuotaCache((current) => {
          const next = { ...current };
          apiResult.sources.forEach((source) => {
            const key = apiQuotaCacheKey(source);
            if (!next[key]) next[key] = idleQuota();
          });
          return next;
        });
      });
    } catch (requestError) {
      setError(String(requestError));
      setLoading(false);
      return;
    }
    setLoading(false);
  }, [loadOAuthFiles]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const refreshOne = useCallback(async (file: AuthFile) => {
    const key = quotaKey(file);
    if (getQuotaCacheSnapshot()[key]?.status === 'loading') return;
    const cacheGeneration = captureQuotaCacheGeneration();
    updateQuotaCache((current) => ({ ...current, [key]: { status: 'loading', rows: [] } }));
    const result = await loadQuota(file);
    commitQuotaCacheIfCurrent(cacheGeneration, () => {
      updateQuotaCache((current) => ({ ...current, [key]: result }));
    });
  }, []);

  const refreshApiOne = useCallback(async (source: ApiQuotaSource) => {
    const key = apiQuotaCacheKey(source);
    if (getQuotaCacheSnapshot()[key]?.status === 'loading') return;
    const cacheGeneration = captureQuotaCacheGeneration(API_QUOTA_CACHE_PREFIX);
    updateQuotaCache((current) => ({ ...current, [key]: { status: 'loading', rows: [] } }));
    const result = await queryApiQuotaSource(source);
    commitQuotaCacheIfCurrent(cacheGeneration, () => {
      updateQuotaCache((current) => ({ ...current, [key]: result }));
    }, API_QUOTA_CACHE_PREFIX);
  }, []);

  const saveBalanceUrl = useCallback(async (source: ApiQuotaSource, value: string) => {
    setBalanceEditorSaving(true);
    setBalanceEditorError('');
    try {
      await saveApiQuotaBalanceUrl(source, value);
      updateQuotaCache((current) => ({ ...current, [apiQuotaCacheKey(source)]: idleQuota() }));
      await loadSources();
      setBalanceEditorSource(null);
    } catch (saveError) {
      setBalanceEditorError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBalanceEditorSaving(false);
    }
  }, [loadSources]);

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
    const refreshableApiSources = apiSources.filter(isApiQuotaSourceQueryable);
    const targets: Array<
      | { kind: 'oauth'; file: AuthFile }
      | { kind: 'api'; source: ApiQuotaSource }
    > = [
      ...files.map((file) => ({ kind: 'oauth' as const, file })),
      ...refreshableApiSources.map((source) => ({ kind: 'api' as const, source })),
    ];
    updateQuotaCache((current) => ({
      ...current,
      ...Object.fromEntries(targets.map((target) => {
        const key = target.kind === 'oauth' ? quotaKey(target.file) : apiQuotaCacheKey(target.source);
        return [key, { ...current[key], status: 'loading', rows: [] }];
      })),
    }));
    try {
      for (let index = 0; index < targets.length; index += REFRESH_CONCURRENCY) {
        const batch = targets.slice(index, index + REFRESH_CONCURRENCY);
        await Promise.all(batch.map(async (target) => {
          const key = target.kind === 'oauth' ? quotaKey(target.file) : apiQuotaCacheKey(target.source);
          const result = target.kind === 'oauth'
            ? await loadQuota(target.file)
            : await queryApiQuotaSource(target.source);
          commitQuotaCacheIfCurrent(cacheGeneration, () => {
            updateQuotaCache((current) => ({ ...current, [key]: result }));
          });
        }));
      }
    } finally {
      setRefreshing(false);
    }
  }, [apiSources, files]);

  const oauthCards = useMemo(() => {
    const groups = new Map<QuotaProvider, { file: AuthFile; quota: QuotaState }[]>();
    files.forEach((file) => {
      const provider = providerForFile(file);
      if (!provider) return;
      const items = groups.get(provider) ?? [];
      items.push({ file, quota: quotas[quotaKey(file)] ?? idleQuota() });
      groups.set(provider, items);
    });
    return providerOrder.flatMap((provider) => groups.get(provider) ?? []);
  }, [files, quotas]);

  const apiCards = useMemo(() => {
    const groups = new Map<ApiQuotaVendor | 'unsupported', ApiQuotaSource[]>();
    apiSources.forEach((source) => {
      const provider = source.adapter?.vendor ?? 'unsupported';
      const items = groups.get(provider) ?? [];
      items.push(source);
      groups.set(provider, items);
    });
    return [
      ...apiProviderOrder.flatMap((provider) => groups.get(provider) ?? []),
      ...(groups.get('unsupported') ?? []),
    ];
  }, [apiSources]);

  const oauthCount = files.length;
  const apiCount = countApiQuotaSources(apiSources);
  const apiUnsupportedCount = countApiQuotaUnsupported(apiSources);
  const sourceCount = oauthCount + apiCount;

  return (
    <section className="page management-page quota-page">
      {confirmationDialog}
      <header className="management-header quota-page-heading">
        <div>
          <h1>{t('quota.title')}</h1>
        </div>
        <div className="management-heading-actions">
          <span className="muted-summary">{t(sourceCount === 1 ? 'quota.queryableCredentials.one' : 'quota.queryableCredentials.other', { count: sourceCount })}</span>
          <button type="button" className="secondary-button compact-button" onClick={() => void loadSources()} disabled={loading || refreshing || querying}>
            <RefreshCw size={16} />{t('quota.readList')}
          </button>
          <button type="button" className="primary-button compact-button" onClick={() => void refreshAll()} disabled={refreshing || loading || querying || sourceCount === 0}>
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />{t('quota.refreshAll')}
          </button>
        </div>
      </header>
      {error ? <div className="management-alert error">{error}</div> : null}
      {loading ? (
        <div className="management-loading"><LoaderCircle size={20} className="spin" />{t('quota.loadingFiles')}</div>
      ) : oauthCards.length === 0 && apiCards.length === 0 ? (
        <div className="management-empty"><AlertCircle size={24} /><strong>{t('quota.empty.title')}</strong><span>{t('quota.empty.description')}</span></div>
      ) : (
        <div className="quota-source-sections">
          {oauthCards.length > 0 ? (
            <section className="quota-source-section quota-oauth-section">
              <div className="quota-source-section-heading"><div className="quota-source-section-icon"><ShieldCheck size={18} aria-hidden="true" /></div><h2>{t('quota.oauth.title')}</h2><span>{t(oauthCount === 1 ? 'quota.credentials.one' : 'quota.credentials.other', { count: oauthCount })}</span></div>
              <div className="quota-credential-grid">{oauthCards.map(({ file, quota }) => {
                const provider = providerForFile(file);
                return <QuotaCard key={quotaKey(file)} file={file} quota={quota} onRefresh={() => void refreshOne(file)} onReset={provider === 'codex' ? () => void resetCodexQuota(file, quota) : undefined} />;
              })}</div>
            </section>
          ) : null}
          {apiCards.length > 0 ? (
            <section className="quota-source-section quota-api-section">
              <div className="quota-source-section-heading"><div className="quota-source-section-icon"><KeyRound size={18} aria-hidden="true" /></div><h2>{t('quota.api.sectionTitle')}</h2><span>{t('quota.api.sectionCount', { supported: apiCount, unsupported: apiUnsupportedCount })}</span></div>
              <div className="quota-credential-grid">{apiCards.map((source) => <ApiQuotaCard key={apiQuotaCacheKey(source)} source={source} quota={quotas[apiQuotaCacheKey(source)] ?? idleQuota()} onRefresh={() => void refreshApiOne(source)} onConfigure={() => { setBalanceEditorError(''); setBalanceEditorSource(source); }} />)}</div>
            </section>
          ) : null}
        </div>
      )}
      {balanceEditorSource ? (
        <ApiBalanceUrlDialog source={balanceEditorSource} busy={balanceEditorSaving} error={balanceEditorError} onClose={() => { if (!balanceEditorSaving) setBalanceEditorSource(null); }} onSave={(value) => void saveBalanceUrl(balanceEditorSource, value)} />
      ) : null}
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
        <span className="quota-source-badge oauth">{t('quota.oauth.badge')}</span>
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
      <QuotaRows quota={quota} now={now} />
    </article>
  );
}

const formatQuotaAmount = (value: number | null, unit: string, locale: string) => {
  if (value === null) return '—';
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
};

function QuotaAmountSummary({ amount }: { amount: NonNullable<QuotaState['rows'][number]['amount']> }) {
  const { t, locale } = useI18n();
  return (
    <div className="quota-amount-summary">
      {amount.remaining !== null ? <span>{t('quota.amount.remaining')}: <strong>{formatQuotaAmount(amount.remaining, amount.unit, locale)}</strong></span> : null}
      {amount.used !== null ? <span>{t('quota.amount.used')}: <strong>{formatQuotaAmount(amount.used, amount.unit, locale)}</strong></span> : null}
      {amount.total !== null ? <span>{t('quota.amount.total')}: <strong>{formatQuotaAmount(amount.total, amount.unit, locale)}</strong></span> : null}
    </div>
  );
}

function QuotaRows({ quota, now }: { quota: QuotaState; now: number }) {
  const { locale, t } = useI18n();
  if (quota.status !== 'success') return null;
  return (
    <div className="quota-row-list">
      {quota.rows.map((row, index) => {
        const reset = formatQuotaReset(row.resetAtMs, row.reset, locale, now);
        return (
          <div className="real-quota-row" key={`${row.label}-${index}`}>
            <div>
              <span>{row.label}</span>
              {row.amount ? null : <strong>{row.remainingPercent === null ? '—' : t('quota.remaining', { percent: Math.round(row.remainingPercent) })}</strong>}
            </div>
            {row.amount ? <QuotaAmountSummary amount={row.amount} /> : null}
            {row.remainingPercent !== null ? <div className="real-quota-track"><span style={{ width: `${Math.max(0, Math.min(100, row.remainingPercent))}%` }} /></div> : null}
            <small>{[row.detail, reset].filter(Boolean).join(' · ')}</small>
          </div>
        );
      })}
    </div>
  );
}

export function ApiQuotaCard({
  source,
  quota,
  onRefresh,
  onConfigure,
}: {
  source: ApiQuotaSource;
  quota: QuotaState;
  onRefresh: () => void;
  onConfigure: () => void;
}) {
  const { t } = useI18n();
  const now = useQuotaClock() + (quota.serverTimeOffsetMs ?? 0);
  const unsupported = !source.adapter || Boolean(source.configurationError);
  const disabled = source.disabled;
  const label = apiQuotaSourceLabel(source);
  const icon = source.adapter ? apiProviderIcons[source.adapter.vendor] : openaiIcon;
  return (
    <article className="panel real-quota-card">
      <div className="real-quota-card-header">
        <img src={icon} alt="" className="provider-logo quota-card-provider-logo" />
        <div>
          <strong title={label}>{label}</strong>
          <span>{source.adapter ? apiQuotaVendorLabel(source.adapter.vendor) : t('quota.api.unsupported')}</span>
        </div>
        <span className="quota-source-badge api">{t('quota.api.badge')}</span>
        <div className="quota-card-actions">
          <button type="button" className="secondary-button compact-button" onClick={onConfigure} disabled={disabled}>{t('quota.api.balanceUrl.button')}</button>
          <button
            type="button"
            className="icon-button quiet"
            onClick={onRefresh}
            disabled={disabled || unsupported || quota.status === 'loading'}
            title={disabled ? t('quota.fileDisabled') : unsupported ? t('quota.api.unsupported') : t('quota.refresh')}
          >
            <RefreshCw size={16} className={quota.status === 'loading' ? 'spin' : ''} />
          </button>
        </div>
      </div>
      {source.configurationError ? <div className="quota-card-error"><AlertCircle size={18} />{source.configurationError}</div> : null}
      {quota.status === 'idle' && !source.configurationError ? (
        <div className="quota-card-message">
          <span>{disabled ? t('quota.fileDisabled') : unsupported ? t('quota.api.unsupported') : t('quota.notFetched')}</span>
          {disabled || unsupported ? null : <button type="button" className="secondary-button compact-button" onClick={onRefresh}>{t('quota.fetch')}</button>}
        </div>
      ) : null}
      {quota.status === 'loading' ? <div className="quota-card-message"><LoaderCircle size={18} className="spin" />{t('quota.querying')}</div> : null}
      {quota.status === 'error' ? <div className="quota-card-error"><AlertCircle size={18} />{quota.error}</div> : null}
      <QuotaRows quota={quota} now={now} />
    </article>
  );
}

export function ApiBalanceUrlDialog({
  source,
  busy,
  error,
  onClose,
  onSave,
}: {
  source: ApiQuotaSource;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(source.balanceUrl);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  const label = apiQuotaSourceLabel(source);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
      } else if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  const content = (
    <div className="config-dialog-backdrop app-confirm-backdrop quota-balance-url-backdrop" onMouseDown={(event) => event.currentTarget === event.target && !busy && onClose()}>
      <section ref={dialogRef} className="config-dialog quota-balance-url-dialog" role="dialog" aria-modal="true" aria-labelledby="quota-balance-url-title">
        <div className="config-dialog-heading">
          <div><Settings2 size={19} aria-hidden="true" /><h2 id="quota-balance-url-title">{t('quota.api.balanceUrl.configure')}</h2></div>
          <button type="button" className="icon-button quiet" onClick={onClose} disabled={busy} title={t('common.close')}><X size={18} /></button>
        </div>
        <p className="quota-balance-url-source">{label}</p>
        <label className="config-dialog-field"><span>{t('quota.api.balanceUrl.label')}</span><input ref={inputRef} className="config-dialog-text-input" type="url" value={value} onChange={(event) => setValue(event.currentTarget.value)} placeholder={t('quota.api.balanceUrl.placeholder')} disabled={busy} /></label>
        <p className="quota-balance-url-notice">{t('quota.api.balanceUrl.description')}</p>
        {error ? <div className="management-alert error" role="alert">{error}</div> : null}
        <div className="config-dialog-actions two-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{t('quota.api.balanceUrl.cancel')}</button>
          <button type="button" className="primary-button" onClick={() => onSave(value)} disabled={busy}>{busy ? t('common.saving') : t('quota.api.balanceUrl.save')}</button>
        </div>
      </section>
    </div>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
