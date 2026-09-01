import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  FileDown,
  FolderOpen,
  Import,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import antigravityIcon from '../assets/icons/antigravity.svg';
import claudeIcon from '../assets/icons/claude.svg';
import codexIcon from '../assets/icons/codex.svg';
import geminiIcon from '../assets/icons/gemini.svg';
import grokIcon from '../assets/icons/grok.svg';
import kimiIcon from '../assets/icons/kimi-light.svg';
import vertexIcon from '../assets/icons/vertex.svg';
import {
  formatDate,
  managementApi,
  readBoolean,
  readNumber,
  readString,
  responseList,
} from '../services/managementApi';
import {
  formatQuotaTimestamp,
  idleQuota,
  loadQuota,
  providerForFile as quotaProviderForFile,
  quotaKey,
  type QuotaState,
} from '../services/quotaService';
import {
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  pruneQuotaCache,
  updateQuotaCache,
  useQuotaCache,
} from '../services/quotaCache';
import {
  authFileName,
  dedupeAuthFiles,
  isRuntimeOnlyAuthFile,
  normalizeAuthFilePriorityInput,
  parseAuthFilePriority,
} from '../services/authFiles';
import {
  exclusionsForOpenOAuthModels,
  oauthExcludedRulesFromPayload,
  oauthModelsFromPayload,
  openOAuthModelNames,
  type OAuthModelDefinition,
} from '../services/oauthModels';
import { getCurrentLocale, translate, useI18n } from '../i18n';

type AuthFile = Record<string, unknown>;

type PriorityEditor = {
  fileName: string;
  originalPriority: number;
  value: string;
  error: string;
};

const providerIcons: Record<string, string> = {
  antigravity: antigravityIcon,
  claude: claudeIcon,
  codex: codexIcon,
  gemini: geminiIcon,
  kimi: kimiIcon,
  vertex: vertexIcon,
  xai: grokIcon,
};

const providerName = (file: AuthFile) => {
  const value = readString(file, 'provider', 'type', 'account_type').toLowerCase();
  if (value === 'anthropic') return 'Claude';
  if (value === 'anti-gravity') return 'Antigravity';
  if (value === 'xai') return 'xAI';
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : translate(getCurrentLocale(), 'authFiles.unknownProvider');
};

const providerKey = (file: AuthFile) => {
  const value = readString(file, 'provider', 'type', 'account_type').toLowerCase();
  return value === 'anthropic' ? 'claude' : value === 'anti-gravity' ? 'antigravity' : value;
};

const fileName = authFileName;

const isRuntimeOnly = isRuntimeOnlyAuthFile;

const statusText = (file: AuthFile) => {
  if (readBoolean(file, 'disabled')) return translate(getCurrentLocale(), 'authFiles.status.disabled');
  if (readBoolean(file, 'unavailable')) return translate(getCurrentLocale(), 'authFiles.status.unavailable');
  return readString(file, 'status') || translate(getCurrentLocale(), 'authFiles.status.ready');
};

function AuthFileQuotaSummary({ quota }: { quota: QuotaState }) {
  const { locale, t } = useI18n();
  if (quota.status === 'loading') {
    return (
      <div className="auth-file-quota loading">
        <LoaderCircle size={13} className="spin" />
        <span>{t('authFiles.quota.loading')}</span>
      </div>
    );
  }
  if (quota.status === 'error') {
    return (
      <div className="auth-file-quota error" title={quota.error}>
        <span>{t('authFiles.quota.failed')}</span>
        {quota.error ? <small>{quota.error}</small> : null}
      </div>
    );
  }
  if (quota.status !== 'success') return null;

  return (
    <div className="auth-file-quota" aria-label={t('authFiles.quota.aria')}>
      {quota.plan ? <span className="auth-file-quota-plan">{quota.plan}</span> : null}
      {quota.rows.length > 0 ? quota.rows.map((row, index) => {
        const detail = [row.detail, row.reset].filter(Boolean).join(' · ');
        return (
          <span className="auth-file-quota-item" key={`${row.label}-${index}`} title={detail || undefined}>
            <span>{row.label}</span>
            <strong>{row.remainingPercent === null ? '—' : `${Math.round(row.remainingPercent)}%`}</strong>
            {row.reset ? <small>{row.reset}</small> : null}
          </span>
        );
      }) : <span className="auth-file-quota-empty">{t('authFiles.quota.empty')}</span>}
      {quota.resetCredits !== undefined ? (
        <span className="auth-file-quota-credit">{t('authFiles.quota.resets', { count: quota.resetCredits })}</span>
      ) : null}
      {quota.resetCreditsEarliestExpiry ? (
        <span className="auth-file-quota-credit">{t('authFiles.quota.expiry', { time: formatQuotaTimestamp(quota.resetCreditsEarliestExpiry, locale) })}</span>
      ) : null}
    </div>
  );
}

export function AuthFileManagementPage() {
  const { t } = useI18n();
  const [files, setFiles] = useState<AuthFile[]>([]);
  const [filter, setFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled' | 'runtime'>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState('');
  const [priorityEditor, setPriorityEditor] = useState<PriorityEditor | null>(null);
  const [oauthModelProvider, setOauthModelProvider] = useState('');
  const [oauthModelProviderLabel, setOauthModelProviderLabel] = useState('');
  const [oauthModels, setOauthModels] = useState<OAuthModelDefinition[]>([]);
  const [oauthExcludedRules, setOauthExcludedRules] = useState<string[]>([]);
  const [openOauthModelNames, setOpenOauthModelNames] = useState<Set<string>>(new Set());
  const [oauthModelSearch, setOauthModelSearch] = useState('');
  const [oauthModelLoading, setOauthModelLoading] = useState(false);
  const [oauthModelSaving, setOauthModelSaving] = useState(false);
  const [oauthModelError, setOauthModelError] = useState('');
  const quotas = useQuotaCache();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const oauthModelRequestRef = useRef(0);
  const noticeTimerRef = useRef<number | null>(null);

  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice('');
      noticeTimerRef.current = null;
    }, 3600);
  }, []);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await managementApi.get('/auth-files');
      const nextFiles = dedupeAuthFiles(responseList(payload, 'files'));
      setFiles(nextFiles);
      const validQuotaKeys = new Set(nextFiles.map(quotaKey));
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

  const refreshQuota = async (file: AuthFile) => {
    if (readBoolean(file, 'disabled')) return;
    const key = quotaKey(file);
    const cacheGeneration = captureQuotaCacheGeneration();
    updateQuotaCache((current) => ({ ...current, [key]: { status: 'loading', rows: [] } }));
    const result = await loadQuota(file);
    commitQuotaCacheIfCurrent(cacheGeneration, () => {
      updateQuotaCache((current) => ({ ...current, [key]: result }));
    });
  };

  const closeOauthModels = () => {
    oauthModelRequestRef.current += 1;
    setOauthModelProvider('');
  };

  const openOauthModels = async (file: AuthFile) => {
    const provider = providerKey(file);
    if (!provider) return;
    const requestId = oauthModelRequestRef.current + 1;
    oauthModelRequestRef.current = requestId;
    setOauthModelProvider(provider);
    setOauthModelProviderLabel(providerName(file));
    setOauthModels([]);
    setOauthExcludedRules([]);
    setOpenOauthModelNames(new Set());
    setOauthModelSearch('');
    setOauthModelError('');
    setOauthModelLoading(true);
    try {
      const [definitionsPayload, excludedPayload] = await Promise.all([
        managementApi.get(`/model-definitions/${encodeURIComponent(provider)}`),
        managementApi.get('/oauth-excluded-models'),
      ]);
      if (oauthModelRequestRef.current !== requestId) return;
      const models = oauthModelsFromPayload(definitionsPayload);
      const excludedRules = oauthExcludedRulesFromPayload(excludedPayload, provider);
      setOauthModels(models);
      setOauthExcludedRules(excludedRules);
      setOpenOauthModelNames(openOAuthModelNames(models, excludedRules));
      if (models.length === 0) setOauthModelError(t('authFiles.models.noneForProvider'));
    } catch (requestError) {
      if (oauthModelRequestRef.current === requestId) setOauthModelError(String(requestError));
    } finally {
      if (oauthModelRequestRef.current === requestId) setOauthModelLoading(false);
    }
  };

  const saveOauthModels = async () => {
    if (!oauthModelProvider) return;
    const excludedModels = exclusionsForOpenOAuthModels(
      oauthExcludedRules,
      oauthModels,
      openOauthModelNames,
    );
    setOauthModelSaving(true);
    setOauthModelError('');
    try {
      if (excludedModels.length > 0 || oauthExcludedRules.length > 0) {
        await managementApi.patch('/oauth-excluded-models', {
          provider: oauthModelProvider,
          models: excludedModels,
        });
      }
      showNotice(t('authFiles.models.updated', { provider: oauthModelProviderLabel }));
      closeOauthModels();
    } catch (requestError) {
      setOauthModelError(String(requestError));
    } finally {
      setOauthModelSaving(false);
    }
  };

  const visibleOauthModels = useMemo(() => {
    const query = oauthModelSearch.trim().toLowerCase();
    if (!query) return oauthModels;
    return oauthModels.filter((model) =>
      `${model.id} ${model.displayName ?? ''}`.toLowerCase().includes(query),
    );
  }, [oauthModelSearch, oauthModels]);

  const allVisibleOauthModelsOpen = visibleOauthModels.length > 0
    && visibleOauthModels.every((model) => openOauthModelNames.has(model.id.toLowerCase()));

  const toggleOauthModel = (model: OAuthModelDefinition) => {
    const key = model.id.toLowerCase();
    setOpenOauthModelNames((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllVisibleOauthModels = () => {
    setOpenOauthModelNames((current) => {
      const next = new Set(current);
      visibleOauthModels.forEach((model) => {
        const key = model.id.toLowerCase();
        if (allVisibleOauthModelsOpen) next.delete(key);
        else next.add(key);
      });
      return next;
    });
  };

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
  }, []);

  const providers = useMemo(
    () => Array.from(new Set(files.map(providerName))).sort((left, right) => left.localeCompare(right)),
    [files],
  );

  const visibleFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return files.filter((file) => {
      const providerMatch = providerFilter === 'all' || providerName(file) === providerFilter;
      const disabled = readBoolean(file, 'disabled');
      const runtimeMatch =
        statusFilter === 'all' ||
        (statusFilter === 'disabled' && disabled) ||
        (statusFilter === 'enabled' && !disabled) ||
        (statusFilter === 'runtime' && isRuntimeOnly(file));
      const searchMatch =
        !query ||
        [fileName(file), providerName(file), readString(file, 'email', 'account', 'label')]
          .join(' ')
          .toLowerCase()
          .includes(query);
      return providerMatch && runtimeMatch && searchMatch;
    });
  }, [files, filter, providerFilter, statusFilter]);

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (selected.length === 0) return;
    setBusy(true);
    setError('');
    let uploaded = 0;
    const failures: string[] = [];
    for (const file of selected) {
      try {
        await managementApi.uploadAuthFile(file);
        uploaded += 1;
      } catch (requestError) {
        failures.push(`${file.name}：${String(requestError)}`);
      }
    }
    try {
      await loadFiles();
      if (uploaded > 0) showNotice(t('authFiles.uploaded', { count: uploaded }));
      if (failures.length > 0) setError(t('authFiles.uploadFailed', { count: failures.length, errors: failures.join('; ') }));
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (file: AuthFile) => {
    const name = fileName(file);
    setBusy(true);
    setError('');
    try {
      await managementApi.patch('/auth-files/status', {
        name,
        disabled: !readBoolean(file, 'disabled'),
      });
      showNotice(readBoolean(file, 'disabled') ? t('authFiles.notice.enabled') : t('authFiles.notice.disabled'));
      await loadFiles();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const openPriorityEditor = (file: AuthFile) => {
    const priority = parseAuthFilePriority(file.priority);
    setPriorityEditor({
      fileName: fileName(file),
      originalPriority: priority ?? 0,
      value: priority === undefined || priority === 0 ? '' : String(priority),
      error: '',
    });
  };

  const closePriorityEditor = () => {
    if (!busy) setPriorityEditor(null);
  };

  const savePriority = async () => {
    if (!priorityEditor || busy) return;
    const priority = normalizeAuthFilePriorityInput(priorityEditor.value);
    if (priority === null) {
      setPriorityEditor((current) => current
        ? { ...current, error: t('authFiles.priority.invalid') }
        : current);
      return;
    }
    if (priority === priorityEditor.originalPriority) {
      setPriorityEditor(null);
      return;
    }

    const name = priorityEditor.fileName;
    setBusy(true);
    setError('');
    try {
      await managementApi.patch('/auth-files/fields', { name, priority });
      setPriorityEditor(null);
      showNotice(t('authFiles.priority.updated', { name }));
      await loadFiles();
    } catch (requestError) {
      setPriorityEditor((current) => current
        ? { ...current, error: String(requestError) }
        : current);
    } finally {
      setBusy(false);
    }
  };

  const deleteFile = async (file: AuthFile) => {
    const name = fileName(file);
    if (isRuntimeOnly(file)) {
      setError(t('authFiles.runtimeDeleteError'));
      return;
    }
    if (!window.confirm(t('authFiles.deleteConfirm', { name }))) return;
    setBusy(true);
    setError('');
    try {
      await managementApi.delete('/auth-files', { query: { name } });
      showNotice(t('authFiles.deleted'));
      await loadFiles();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const openAuthFilesDirectory = async () => {
    setBusy(true);
    setError('');
    try {
      await managementApi.openAuthFilesDirectory();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const copyName = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(name);
      window.setTimeout(() => setCopied((current) => (current === name ? '' : current)), 1500);
    } catch {
      setError(t('common.copyFailed'));
    }
  };

  const disabledCount = files.filter((file) => readBoolean(file, 'disabled')).length;
  const runtimeCount = files.filter(isRuntimeOnly).length;

  return (
    <section className="page management-page auth-files-page">
      <header className="management-header">
        <div>
          <span>Auth Files</span>
          <h1>{t('authFiles.title')}</h1>
        </div>
        <div className="management-heading-actions">
          <span className="muted-summary">{t('authFiles.summary', { files: files.length, disabled: disabledCount })}</span>
          <button type="button" className="secondary-button compact-button" onClick={() => void loadFiles()} disabled={loading || busy}>
            <RefreshCw size={16} />{t('common.refresh')}
          </button>
          <button type="button" className="secondary-button compact-button" onClick={() => void openAuthFilesDirectory()} disabled={busy}>
            <FolderOpen size={16} />{t('authFiles.openDirectory')}
          </button>
          <button type="button" className="primary-button compact-button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Import size={16} />{t('authFiles.import')}
          </button>
          <input ref={fileInputRef} type="file" accept=".json,application/json" multiple hidden onChange={(event) => void handleUpload(event)} />
        </div>
      </header>

      {error ? <div className="management-alert error">{error}</div> : null}
      {notice ? (
        <div className="config-toast success" role="status" title={notice}>
          <Check size={17} aria-hidden="true" />
          <span>{notice}</span>
        </div>
      ) : null}

      <section className="panel auth-files-panel real-auth-files-panel">
        <div className="management-toolbar auth-files-toolbar">
          <Search size={16} />
          <input value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder={t('authFiles.searchPlaceholder')} />
          <select value={providerFilter} onChange={(event) => setProviderFilter(event.currentTarget.value)}>
            <option value="all">{t('authFiles.filter.allProviders')}</option>
            {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as typeof statusFilter)}>
            <option value="all">{t('authFiles.filter.allStatuses')}</option>
            <option value="enabled">{t('authFiles.filter.enabled')}</option>
            <option value="disabled">{t('authFiles.filter.disabled')}</option>
            <option value="runtime">{t('authFiles.filter.runtime')}</option>
          </select>
        </div>

        {loading ? (
          <div className="management-loading"><LoaderCircle size={20} className="spin" />{t('authFiles.loading')}</div>
        ) : visibleFiles.length === 0 ? (
          <div className="management-empty"><FileDown size={24} /><strong>{files.length ? t('authFiles.empty.filtered') : t('authFiles.empty.none')}</strong><span>{files.length ? t('authFiles.empty.tryFilter') : t('authFiles.empty.upload')}</span></div>
        ) : (
          <div className="real-auth-file-list">
            {visibleFiles.map((file) => {
              const name = fileName(file);
              const icon = providerIcons[providerKey(file)] ?? geminiIcon;
              const disabled = readBoolean(file, 'disabled');
              const priority = parseAuthFilePriority(file.priority) ?? 0;
              return (
                <article className={`real-auth-file-row ${disabled ? 'disabled' : ''}`} key={`${name}-${readString(file, 'auth_index', 'authIndex')}`}>
                  <img src={icon} alt="" className="provider-logo" />
                  <div className="auth-file-main">
                    <div className="auth-file-title"><strong title={name}>{name}</strong><span className={`state-pill ${disabled ? 'error' : readBoolean(file, 'unavailable') ? 'error' : 'success'}`} title={readString(file, 'status_message', 'statusMessage') || undefined}>{statusText(file)}</span></div>
                    <span>{providerName(file)}{readString(file, 'email', 'account', 'label') ? ` · ${readString(file, 'email', 'account', 'label')}` : ''}</span>
                  </div>
                  <div className="auth-file-meta">
                    <span>{readNumber(file, 'size') === null ? t('authFiles.unknownSize') : `${Math.ceil((readNumber(file, 'size') ?? 0) / 1024)} KB`}</span>
                    <span>{formatDate(file.modtime ?? file.updated_at ?? file.last_refresh)}</span>
                    {isRuntimeOnly(file) ? <span className="state-pill">{t('authFiles.runtime')}</span> : null}
                  </div>
                  <div className="auth-file-actions">
                    {quotaProviderForFile(file) ? <button type="button" className="secondary-button compact-button" onClick={() => void refreshQuota(file)} disabled={busy || disabled || quotas[quotaKey(file)]?.status === 'loading'}>{disabled ? t('authFiles.status.disabled') : quotas[quotaKey(file)]?.status === 'loading' ? t('authFiles.quota.querying') : quotas[quotaKey(file)]?.status === 'success' ? t('authFiles.quota.refresh') : t('authFiles.quota.fetch')}</button> : null}
                    {providerKey(file) ? <button type="button" className="secondary-button compact-button" onClick={() => void openOauthModels(file)} disabled={busy} title={t('authFiles.models.settings')}>{t('authFiles.models.button')}</button> : null}
                    <button type="button" className="secondary-button compact-button auth-file-priority-button" onClick={() => openPriorityEditor(file)} disabled={busy} title={t('authFiles.priority.hint')}><Pencil size={14} />{t('authFiles.priority.button', { priority })}</button>
                    <button type="button" className="icon-button quiet" onClick={() => void copyName(name)} disabled={busy} title={t('authFiles.copyName')}>{copied === name ? <Check size={16} /> : <Copy size={16} />}</button>
                    <button type="button" className="secondary-button compact-button" onClick={() => void toggleStatus(file)} disabled={busy}>{disabled ? t('common.enable') : t('common.disable')}</button>
                    <button type="button" className="icon-button danger" onClick={() => void deleteFile(file)} disabled={busy || isRuntimeOnly(file)} title={t('common.delete')}><Trash2 size={16} /></button>
                  </div>
                  {quotaProviderForFile(file) && quotas[quotaKey(file)]?.status !== 'idle' ? <AuthFileQuotaSummary quota={quotas[quotaKey(file)] ?? idleQuota()} /> : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
      {runtimeCount > 0 ? <p className="page-footnote">{t('authFiles.runtimeFootnote', { count: runtimeCount })}</p> : null}

      {priorityEditor ? (
        <div className="config-dialog-backdrop" onMouseDown={(event) => event.currentTarget === event.target && closePriorityEditor()}>
          <form
            className="config-dialog auth-priority-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-priority-title"
            onSubmit={(event) => {
              event.preventDefault();
              void savePriority();
            }}
          >
            <div className="config-dialog-heading">
              <div><Pencil size={19} /><h2 id="auth-priority-title">{t('authFiles.priority.title')}</h2></div>
              <button type="button" className="icon-button quiet" onClick={closePriorityEditor} disabled={busy} title={t('common.close')}><X size={18} /></button>
            </div>
            <div className="auth-priority-target" title={priorityEditor.fileName}>{priorityEditor.fileName}</div>
            <label className="auth-priority-field" htmlFor="auth-file-priority-input">
              <span>{t('authFiles.priority.label')}</span>
              <input
                id="auth-file-priority-input"
                autoFocus
                type="text"
                inputMode="numeric"
                value={priorityEditor.value}
                placeholder={t('authFiles.priority.placeholder')}
                disabled={busy}
                aria-invalid={Boolean(priorityEditor.error)}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setPriorityEditor((current) => current
                    ? { ...current, value, error: '' }
                    : current);
                }}
              />
              <small>{t('authFiles.priority.hint')}</small>
            </label>
            <div className={`config-form-message ${priorityEditor.error ? 'error' : ''}`} role={priorityEditor.error ? 'alert' : undefined}>
              {priorityEditor.error || ' '}
            </div>
            <div className="config-dialog-actions two-actions">
              <button type="button" className="secondary-button" onClick={closePriorityEditor} disabled={busy}>{t('common.cancel')}</button>
              <button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{busy ? t('common.saving') : t('common.save')}</button>
            </div>
          </form>
        </div>
      ) : null}

      {oauthModelProvider ? (
        <div className="model-discovery-backdrop" onMouseDown={(event) => event.currentTarget === event.target && !oauthModelSaving && closeOauthModels()}>
          <section className="model-discovery-dialog" role="dialog" aria-modal="true" aria-labelledby="oauth-model-title">
            <div className="model-discovery-header">
              <div><h2 id="oauth-model-title">{t('authFiles.models.title')}</h2><span>{t('authFiles.models.description', { provider: oauthModelProviderLabel })}</span></div>
              <button type="button" className="icon-button quiet" onClick={closeOauthModels} disabled={oauthModelSaving} title={t('common.close')}><X size={18} /></button>
            </div>

            <div className="model-discovery-search">
              <Search size={16} aria-hidden="true" />
              <input value={oauthModelSearch} onChange={(event) => setOauthModelSearch(event.currentTarget.value)} placeholder={t('authFiles.models.search')} />
            </div>

            <div className="model-discovery-toolbar">
              <span>{t('authFiles.models.summary', { total: oauthModels.length, open: openOauthModelNames.size })}</span>
              <div>
                <button type="button" className="secondary-button compact-button" onClick={toggleAllVisibleOauthModels} disabled={oauthModelLoading || visibleOauthModels.length === 0}>{allVisibleOauthModelsOpen ? t('authFiles.models.closeVisible') : t('authFiles.models.openVisible')}</button>
                <button type="button" className="secondary-button compact-button" onClick={() => setOpenOauthModelNames(new Set(oauthModels.map((model) => model.id.toLowerCase())))} disabled={oauthModelLoading || oauthModels.length === 0 || openOauthModelNames.size === oauthModels.length}>{t('authFiles.models.openAll')}</button>
                <button type="button" className="secondary-button compact-button" onClick={() => setOpenOauthModelNames(new Set())} disabled={oauthModelLoading || openOauthModelNames.size === 0}>{t('authFiles.models.closeAll')}</button>
              </div>
            </div>

            <div className="model-discovery-content">
              {oauthModelLoading ? (
                <div className="model-discovery-message"><LoaderCircle size={20} className="spin" />{t('authFiles.models.loading')}</div>
              ) : oauthModelError ? (
                <div className="model-discovery-message error"><strong>{t('authFiles.models.loadFailed')}</strong><span>{oauthModelError}</span></div>
              ) : visibleOauthModels.length === 0 ? (
                <div className="model-discovery-message"><strong>{oauthModels.length ? t('authFiles.models.noMatch') : t('authFiles.models.empty')}</strong></div>
              ) : (
                <div className="model-discovery-list">
                  {visibleOauthModels.map((model) => {
                    const checked = openOauthModelNames.has(model.id.toLowerCase());
                    return (
                      <label className={`model-discovery-row ${checked ? 'selected' : ''}`} key={model.id}>
                        <input type="checkbox" checked={checked} onChange={() => toggleOauthModel(model)} />
                        <span><strong title={model.id}>{model.id}</strong>{model.displayName ? <small title={model.displayName}>{model.displayName}</small> : null}</span>
                        {checked ? <Check size={16} aria-hidden="true" /> : null}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="model-discovery-actions">
              <button type="button" className="secondary-button" onClick={closeOauthModels} disabled={oauthModelSaving}>{t('common.cancel')}</button>
              <button type="button" className="primary-button" onClick={() => void saveOauthModels()} disabled={oauthModelLoading || oauthModelSaving || oauthModels.length === 0}>{oauthModelSaving ? t('common.saving') : t('authFiles.models.save', { count: openOauthModelNames.size })}</button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
