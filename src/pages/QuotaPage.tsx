import { requestRateColor } from '../services/authFileRequests';
import { PluginLogo, usePluginList } from '../components/ProviderLogo';
import { findPluginLogo } from '../services/pluginLogos';
import { credentialQuotaPlugin } from '../services/pluginCredentialQuota';
import { Notice } from '../components/Notice';
import { EmptyState } from '../components/EmptyState';
import { SegmentedControl } from '../components/SegmentedControl';
import { commitFetchedQuota } from '../services/quotaEnrichment';
import { ResetCreditExpiries } from '../components/ResetCreditExpiries';
import { MessageNotice } from '../appNotice';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronLeft, ChevronRight, Gauge, ListRestart, LoaderCircle, Pencil, RefreshCw, Search, X } from 'lucide-react';
import { SelectMenu } from '../components/SelectMenu';
import {
  filterQuotaRows,
  nextRecoveryMs,
  paginate,
  sortQuotaRows,
  type QuotaSortMode,
} from '../services/quotaPageLogic';
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
import metaIcon from '../assets/icons/meta.svg';
import zaiIcon from '../assets/icons/zai.svg';
import { loadZaiCodingPlanFiles } from '../services/zaiQuota';
import { managementApi, normalizeAuthIndex, readBoolean, readString, responseList } from '../services/managementApi';
import { formatQuotaReset, useQuotaClock } from '../services/quotaTime';
import {
  formatQuotaTimestamp,
  idleQuota,
  loadQuota,
  quotaProviderForFile,
  quotaKey,
  quotaResetExpiries,
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
import { estimateQuotaCardHeight } from '../services/quotaLayout';
import { CardLayoutGrid, CardLayoutSwitch, useCardLayout, useExpandedCards, useSettledHeights, type StackedColumns } from '../components/CardLayout';
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
  meta: { label: 'Muse', icon: metaIcon },
  zai: { label: 'z.ai', icon: zaiIcon },
  antigravity: { label: 'Antigravity', icon: antigravityIcon },
};

const providerOrder: QuotaDisplayProvider[] = ['claude', 'antigravity', 'codex', 'xai', 'kimi', 'zai', 'devin', 'meta', 'plugin'];
const REFRESH_CONCURRENCY = 4;
const QUOTA_PAGE_SIZE = 20;
const QUOTA_UI_STORAGE_KEY = 'cpa-gui.quota-ui.v1';

const readStoredQuotaUi = (): { category?: 'all' | QuotaDisplayProvider; sortMode?: QuotaSortMode } => {
  if (typeof window === 'undefined') return {};
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(QUOTA_UI_STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const record = parsed as Record<string, unknown>;
    return {
      category: typeof record.category === 'string' && (record.category === 'all' || providerOrder.includes(record.category as QuotaDisplayProvider))
        ? record.category as 'all' | QuotaDisplayProvider : undefined,
      sortMode: record.sortMode === 'soonest' || record.sortMode === 'default' ? record.sortMode : undefined,
    };
  } catch {
    return {};
  }
};

const writeStoredQuotaUi = (value: { category: 'all' | QuotaDisplayProvider; sortMode: QuotaSortMode }) => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(QUOTA_UI_STORAGE_KEY, JSON.stringify(value));
  } catch {
  }
};

// Stacked matches .real-quota-grid (minmax(min(300px, 100%), 1fr), 12px gap); Compact uses narrower columns and 8px gaps.
const quotaColumns: StackedColumns = { stacked: { minWidth: 300, gap: 12 }, compact: { minWidth: 240, gap: 8 } };

export function QuotaPage() {
  const { t } = useI18n();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [files, setFiles] = useState<AuthFile[]>([]);
  const quotas = useQuotaCache();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [storedQuotaUi] = useState(readStoredQuotaUi);
  const [category, setCategory] = useState<'all' | QuotaDisplayProvider>(storedQuotaUi.category ?? 'all');
  const [sortMode, setSortMode] = useState<QuotaSortMode>(storedQuotaUi.sortMode ?? 'default');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const searchRef = useRef<HTMLInputElement>(null);
  const [layout, setLayout] = useCardLayout('cpa-gui.quota-layout.v1');
  const [expanded, toggleExpanded] = useExpandedCards();
  const settledHeight = useSettledHeights();
  const querying = Object.values(quotas).some((quota) => quota.status === 'loading');

  useEffect(() => {
    writeStoredQuotaUi({ category, sortMode });
  }, [category, sortMode]);

  const saveCredentialNote = useCallback(async (file: AuthFile, nextNote: string) => {
    const credentialName = readString(file, 'name');
    if (!credentialName) return;
    const trimmed = nextNote.trim();
    await managementApi.patch('/credentials/fields', { name: credentialName, note: trimmed });
    setFiles((current) => current.map((item) => readString(item, 'name') === credentialName
      ? { ...item, note: trimmed }
      : item));
  }, []);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [payload, zaiFiles] = await Promise.all([
        managementApi.get('/credentials'),
        loadZaiCodingPlanFiles(),
      ]);
      const listed = dedupeAuthFiles(responseList(payload, 'files'));
      const listedIndexes = new Set(listed.map((file) => normalizeAuthIndex(file.auth_index ?? file.authIndex)).filter(Boolean));
      const allFiles = sortAuthFilesByPriority([
        ...listed,
        ...zaiFiles.filter((file) => {
          const authIndex = normalizeAuthIndex(file.auth_index);
          return authIndex && !listedIndexes.has(authIndex);
        }),
      ]);
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
  const listedItems = paginate(
    sortQuotaRows(filterQuotaRows(visibleItems, search), sortMode, nextRecoveryMs),
    page,
    QUOTA_PAGE_SIZE,
  );
  const pageItems = listedItems.pageItems;
  const glance = (file: AuthFile) => layout === 'compact' && !expanded.has(quotaKey(file));
  const cards = pageItems.map(({ provider, file, quota }) => <QuotaCard key={quotaKey(file)} file={file} quota={quota} onRefresh={() => void refreshOne(file)} onReset={provider === 'codex' || provider === 'claude' ? () => void resetQuota(file, quota) : undefined}
    glance={layout === 'compact' ? glance(file) : undefined} onToggleGlance={() => toggleExpanded(quotaKey(file))} onSaveNote={(nextNote) => saveCredentialNote(file, nextNote)} />);

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
          <div className="quota-view-bar">
            <SegmentedControl className="quota-category-filter" aria-label={t('quota.filter.label')} value={activeCategory} onChange={(value) => { setCategory(value); setPage(1); }}
              items={([['all', files.length] as const, ...grouped.map(([provider, items]) => [provider, items.length] as const)]).map(([provider, count]) => {
                const label = provider === 'all' ? t('quota.filter.all') : provider === 'plugin' ? t('quota.pluginCategory') : providerMeta[provider].label;
                return { value: provider, 'aria-label': `${label}, ${t(count === 1 ? 'quota.credentials.one' : 'quota.credentials.other', { count })}`, label: <>
                  {provider === 'all' ? null : provider === 'plugin' ? <Gauge size={18} aria-hidden="true" /> : <img src={providerMeta[provider].icon} alt="" className={provider === 'devin' ? 'provider-logo devin-logo' : 'provider-logo'} />}
                  <span>{label}</span><span className="quota-filter-count">{count}</span>
                </> };
              })} />
            <CardLayoutSwitch className="quota-layout-control" value={layout} onChange={setLayout} />
          </div>
          <div className="quota-view-bar" style={{ gap: 8 }}>
            <div className="quota-search-control search-control" data-size="compact" style={{ flex: '1 1 auto', maxWidth: 320 }}>
              <Search size={16} aria-hidden="true" />
              <input ref={searchRef} type="search" value={search} placeholder={t('quota.search.placeholder')} aria-label={t('quota.search.placeholder')}
                onChange={(event) => { setSearch(event.currentTarget.value); setPage(1); }}
                onKeyDown={(event) => { if (event.key === 'Escape') { setSearch(''); setPage(1); } }} />
              {search ? <button type="button" className="icon-button quiet tiny-button" aria-label={t('quota.search.clear')} title={t('quota.search.clear')}
                onClick={() => { setSearch(''); setPage(1); searchRef.current?.focus(); }}><X size={14} aria-hidden="true" /></button> : null}
            </div>
            <SelectMenu className="quota-sort-control" value={sortMode} ariaLabel={t('quota.sort.label')}
              onChange={(value) => { setSortMode(value === 'soonest' ? 'soonest' : 'default'); setPage(1); }}
              options={[
                { value: 'default', label: t('quota.sort.default') },
                { value: 'soonest', label: t('quota.sort.soonest') },
              ]} />
          </div>
          {pageItems.length === 0
            ? <EmptyState className="management-empty" icon={<Search size={24} />} title={t('quota.search.empty')} />
            : <CardLayoutGrid layout={layout} className="real-quota-grid" columns={quotaColumns}
              heights={pageItems.map(({ provider, file, quota }) => settledHeight(quotaKey(file), estimateQuotaCardHeight(quota, provider, glance(file)), quota.status === 'loading'))}>{cards}</CardLayoutGrid>}
          {listedItems.totalPages > 1 ? <nav className="usage-pagination-controls quota-pagination" style={{ display: 'flex', justifyContent: 'center', gap: 12, padding: '6px 0 2px' }} aria-label={t('quota.page.status', { page: listedItems.currentPage, total: listedItems.totalPages })}>
            <button
              type="button"
              className="secondary-button tiny-button"
              aria-label={t('quota.page.prev')}
              title={t('quota.page.prev')}
              disabled={listedItems.currentPage <= 1}
              onClick={() => setPage(listedItems.currentPage - 1)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <span className="usage-pagination-info quota-page-status">{t('quota.page.status', { page: listedItems.currentPage, total: listedItems.totalPages })}</span>
            <button
              type="button"
              className="secondary-button tiny-button"
              aria-label={t('quota.page.next')}
              title={t('quota.page.next')}
              disabled={listedItems.currentPage >= listedItems.totalPages}
              onClick={() => setPage(listedItems.currentPage + 1)}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </nav> : null}
        </>
      )}
    </section>
  );
}

/** `glance` is set only in the Compact layout: true shows the one-line-per-quota summary, false the full card; `onToggleGlance` switches between them. */
export function QuotaCard({
  file,
  quota,
  onRefresh,
  onReset,
  glance,
  onToggleGlance,
  onSaveNote,
}: {
  file: AuthFile;
  quota: QuotaState;
  onRefresh: () => void;
  onReset?: () => void;
  glance?: boolean;
  onToggleGlance?: () => void;
  onSaveNote?: (note: string) => Promise<void> | void;
}) {
  const { locale, t } = useI18n();
  const now = useQuotaClock() + (quota.serverTimeOffsetMs ?? 0);
  const provider = quotaProviderForFile(file);
  const providerId = String(file.provider ?? file.type ?? '').toLowerCase();
  const plugins = usePluginList();
  const privacy = usePrivacyMask();
  const name = privacy.credentialName(file);
  const rawNote = readString(file, 'note');
  const note = privacy.text(rawNote);
  const disabled = readBoolean(file, 'disabled');
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(rawNote);
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    if (!editingNote) setNoteDraft(rawNote);
  }, [editingNote, rawNote]);

  const commitNote = async () => {
    if (!onSaveNote || savingNote) return;
    setSavingNote(true);
    try {
      await onSaveNote(noteDraft);
      setEditingNote(false);
    } finally {
      setSavingNote(false);
    }
  };
  const hasCreditBalance = Boolean(quota.creditsUnlimited) || quota.creditBalance !== undefined;
  const quotaUnknown = quota.status === 'success' && quota.rows.length > 0
    && quota.rows.every((row) => row.remainingPercent === null);
  const hasResetCreditSummary = hasCreditBalance || quotaResetExpiries(quota).length > 0;
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
    <article className="panel real-quota-card surface-card" data-glance={glance ? '' : undefined}>
      <div className="real-quota-card-header">
        <div className="quota-identity">
          {provider && provider !== 'plugin'
            ? <img src={providerMeta[provider].icon} alt="" className="quota-account-icon" />
            : providerId === 'gemini' ? <img src={geminiIcon} alt="" className="quota-account-icon" />
            : <PluginLogo src={findPluginLogo(plugins, providerId, credentialQuotaPlugin(file))} size={22} className="quota-account-icon" />}
          {glance && quota.plan ? <span className="quota-glance-plan" title={`${t('quota.planLabel')}: ${quota.plan}`}>{quota.plan}</span> : null}
          <div className="quota-identity-text">
            <div className="quota-identity-title-row">
              <strong title={name}>{name}</strong>
              {onSaveNote && !editingNote ? (
                <button
                  type="button"
                  className="icon-button quiet tiny-button quota-note-edit"
                  title={t(rawNote ? 'quota.note.edit' : 'quota.note.add')}
                  aria-label={t(rawNote ? 'quota.note.edit' : 'quota.note.add')}
                  onClick={() => { setNoteDraft(rawNote); setEditingNote(true); }}
                >
                  <Pencil size={12} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {note && !editingNote ? <small className="quota-account-note" title={note}>{note}</small> : null}
          </div>
          {glance !== undefined ? <button type="button" className="secondary-button tiny-button quota-glance-toggle" onClick={onToggleGlance} aria-expanded={!glance}
            aria-label={`${t(glance ? 'cardLayout.details.show' : 'cardLayout.details.hide')}: ${name}`} title={t(glance ? 'cardLayout.details.show' : 'cardLayout.details.hide')}>
            <ChevronDown size={14} aria-hidden="true" />
          </button> : null}
        </div>
        {editingNote && onSaveNote ? (
          <div className="quota-note-editor">
            <input
              type="text"
              value={noteDraft}
              placeholder={t('quota.note.placeholder')}
              aria-label={t('authFiles.settings.note')}
              disabled={savingNote}
              onChange={(event) => setNoteDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void commitNote();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditingNote(false);
                  setNoteDraft(rawNote);
                }
              }}
            />
            <button
              type="button"
              className="primary-button tiny-button quota-note-commit"
              disabled={savingNote}
              aria-label={t('common.save')}
              title={t('common.save')}
              onClick={() => void commitNote()}
            >
              {savingNote ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="secondary-button tiny-button quota-note-cancel"
              disabled={savingNote}
              aria-label={t('common.cancel')}
              title={t('common.cancel')}
              onClick={() => { setEditingNote(false); setNoteDraft(rawNote); }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        ) : null}
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
      {quota.status === 'success' && (provider === 'codex' || provider === 'claude') && hasResetCreditSummary ? <div className="quota-reset-credit-summary surface-section surface-muted">
        {hasCreditBalance ? <span>{t('quota.creditBalance')} <strong>{quota.creditsUnlimited ? t('quota.creditUnlimited') : quota.creditBalance}</strong></span> : null}
        <ResetCreditExpiries quota={quota} />
      </div> : null}
      {quota.status === 'success' && (provider === 'codex' || provider === 'claude')
        ? <MessageNotice message={quota.resetCreditsError ? name + ': ' + t('quota.resetCreditsWarning', { error: quota.resetCreditsError }) : null} /> : null}
      {quotaUnknown ? <p className="quota-account-note" style={{ margin: 0 }}>{t('quota.unknownHint')}</p> : null}
      {quota.status === 'success' ? <div className="quota-row-list">{groups.map((group, groupIndex) => <section className="quota-model-group" key={groupIndex}>
        {group.label ? <div className="quota-model-heading" title={group.description}><h3>{group.label}</h3>{group.description ? <p>{group.description}</p> : null}</div> : null}
        {group.rows.map((row, index) => {
          const reset = countdown(row);
          const percent = row.remainingPercent !== null && Number.isFinite(row.remainingPercent)
            ? Math.max(0, Math.min(100, row.remainingPercent)) : null;
          const percentLabel = percent === null ? null : Math.round(percent * 10) / 10;
          return <div className="real-quota-row" key={index} title={group.label ? row.detail : undefined}>
            <div className="quota-window-summary"><span>{row.windowLabel || row.label}</span><div className="quota-window-status">
              <strong>{row.quotaAvailable ? t('quota.service.antigravity.available') : percentLabel === null ? '—' : glance ? `${percentLabel}%` : t('quota.remaining', { percent: percentLabel })}</strong>
              {reset ? <small title={formatQuotaReset(row.resetAtMs, row.reset, locale, now)}>{reset}</small> : null}
            </div></div>
            {percent !== null ? <div className="real-quota-track" role="progressbar" aria-label={row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: percent + '%', background: requestRateColor(percent / 100) }} /></div> : null}
            {!group.label && row.detail ? <small>{row.detail}</small> : null}
          </div>;
        })}
      </section>)}</div> : null}
      <div className="quota-card-actions">
        {onReset && ((quota.resetCredits ?? 0) > 0 || hasPendingClaudeReset(file)) ? <button type="button" className="secondary-button tiny-button quota-reset-footer" onClick={onReset} disabled={!canResetQuota(file, quota)} title={t('quota.reset')}>{t(hasPendingClaudeReset(file) ? 'quota.claude.retry' : 'quota.reset')}</button> : null}
        <button type="button" className="secondary-button tiny-button" onClick={onRefresh} disabled={disabled || quota.status === 'loading'} title={disabled ? t('quota.fileDisabled') : t('quota.refresh')}><RefreshCw size={12} className={quota.status === 'loading' ? 'spin' : ''} aria-hidden="true" />{t('authFiles.quota.refresh')}</button>
      </div>
    </article>
  );
}
