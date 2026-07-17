import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileDown,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
  Upload,
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
} from '../services/authFiles';
import {
  exclusionsForOpenOAuthModels,
  oauthExcludedRulesFromPayload,
  oauthModelsFromPayload,
  openOAuthModelNames,
  type OAuthModelDefinition,
} from '../services/oauthModels';

type AuthFile = Record<string, unknown>;

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
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '未知提供商';
};

const providerKey = (file: AuthFile) => {
  const value = readString(file, 'provider', 'type', 'account_type').toLowerCase();
  return value === 'anthropic' ? 'claude' : value === 'anti-gravity' ? 'antigravity' : value;
};

const fileName = authFileName;

const isRuntimeOnly = isRuntimeOnlyAuthFile;

const statusText = (file: AuthFile) => {
  if (readBoolean(file, 'disabled')) return '已停用';
  if (readBoolean(file, 'unavailable')) return '不可用';
  return readString(file, 'status') || '就绪';
};

function AuthFileQuotaSummary({ quota }: { quota: QuotaState }) {
  if (quota.status === 'loading') {
    return (
      <div className="auth-file-quota loading">
        <LoaderCircle size={13} className="spin" />
        <span>额度查询中</span>
      </div>
    );
  }
  if (quota.status === 'error') {
    return (
      <div className="auth-file-quota error" title={quota.error}>
        <span>额度获取失败</span>
        {quota.error ? <small>{quota.error}</small> : null}
      </div>
    );
  }
  if (quota.status !== 'success') return null;

  return (
    <div className="auth-file-quota" aria-label="额度信息">
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
      }) : <span className="auth-file-quota-empty">暂无额度数据</span>}
      {quota.resetCredits !== undefined ? (
        <span className="auth-file-quota-credit">主动重置 {quota.resetCredits} 次</span>
      ) : null}
      {quota.resetCreditsEarliestExpiry ? (
        <span className="auth-file-quota-credit">最早过期 {formatQuotaTimestamp(quota.resetCreditsEarliestExpiry)}</span>
      ) : null}
    </div>
  );
}

export function AuthFileManagementPage() {
  const [files, setFiles] = useState<AuthFile[]>([]);
  const [filter, setFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled' | 'runtime'>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState('');
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
      if (models.length === 0) setOauthModelError('该提供商没有可配置的模型定义');
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
      setNotice(`${oauthModelProviderLabel} 开放模型已更新`);
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
      if (uploaded > 0) setNotice(`已上传 ${uploaded} 个认证文件`);
      if (failures.length > 0) setError(`${failures.length} 个文件上传失败：${failures.join('；')}`);
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
      setNotice(readBoolean(file, 'disabled') ? '认证文件已启用' : '认证文件已停用');
      await loadFiles();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const deleteFile = async (file: AuthFile) => {
    const name = fileName(file);
    if (isRuntimeOnly(file)) {
      setError('运行时认证文件不能从磁盘删除');
      return;
    }
    if (!window.confirm(`确定删除「${name}」吗？`)) return;
    setBusy(true);
    setError('');
    try {
      await managementApi.delete('/auth-files', { query: { name } });
      setNotice('认证文件已删除');
      await loadFiles();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const deleteAll = async () => {
    if (!window.confirm('确定删除所有磁盘认证文件吗？运行时认证不会被删除。')) return;
    setBusy(true);
    setError('');
    try {
      await managementApi.delete('/auth-files', { query: { all: true } });
      setNotice('磁盘认证文件已全部删除');
      await loadFiles();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const downloadFile = async (file: AuthFile) => {
    const name = fileName(file);
    if (isRuntimeOnly(file)) {
      setError('运行时认证文件没有可下载的磁盘文件');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const content = await managementApi.downloadAuthFile(name);
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice('认证文件已下载');
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
      setError('复制失败');
    }
  };

  const disabledCount = files.filter((file) => readBoolean(file, 'disabled')).length;
  const runtimeCount = files.filter(isRuntimeOnly).length;
  const diskCount = files.length - runtimeCount;

  return (
    <section className="page management-page auth-files-page">
      <header className="management-header">
        <div>
          <span>Auth Files</span>
          <h1>认证文件</h1>
        </div>
        <div className="management-heading-actions">
          <span className="muted-summary">{files.length} 个文件 · {disabledCount} 个停用</span>
          <button type="button" className="secondary-button compact-button" onClick={() => void loadFiles()} disabled={loading || busy}>
            <RefreshCw size={16} />刷新
          </button>
          <button type="button" className="secondary-button compact-button" onClick={deleteAll} disabled={loading || busy || diskCount === 0}>
            <Trash2 size={16} />清空磁盘文件
          </button>
          <button type="button" className="primary-button compact-button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Upload size={16} />上传
          </button>
          <input ref={fileInputRef} type="file" accept=".json,application/json" multiple hidden onChange={(event) => void handleUpload(event)} />
        </div>
      </header>

      {error ? <div className="management-alert error">{error}</div> : null}
      {notice ? <div className="management-alert success">{notice}</div> : null}

      <section className="panel auth-files-panel real-auth-files-panel">
        <div className="management-toolbar auth-files-toolbar">
          <Search size={16} />
          <input value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="搜索文件名、账号或提供商" />
          <select value={providerFilter} onChange={(event) => setProviderFilter(event.currentTarget.value)}>
            <option value="all">全部提供商</option>
            {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as typeof statusFilter)}>
            <option value="all">全部状态</option>
            <option value="enabled">已启用</option>
            <option value="disabled">已停用</option>
            <option value="runtime">仅运行时</option>
          </select>
        </div>

        {loading ? (
          <div className="management-loading"><LoaderCircle size={20} className="spin" />读取认证文件中</div>
        ) : visibleFiles.length === 0 ? (
          <div className="management-empty"><FileDown size={24} /><strong>{files.length ? '没有匹配的认证文件' : '暂无认证文件'}</strong><span>{files.length ? '换个筛选条件试试' : '上传 JSON 认证文件后会显示在这里'}</span></div>
        ) : (
          <div className="real-auth-file-list">
            {visibleFiles.map((file) => {
              const name = fileName(file);
              const icon = providerIcons[providerKey(file)] ?? geminiIcon;
              const disabled = readBoolean(file, 'disabled');
              return (
                <article className={`real-auth-file-row ${disabled ? 'disabled' : ''}`} key={`${name}-${readString(file, 'auth_index', 'authIndex')}`}>
                  <img src={icon} alt="" className="provider-logo" />
                  <div className="auth-file-main">
                    <div className="auth-file-title"><strong title={name}>{name}</strong><span className={`state-pill ${disabled ? 'error' : readBoolean(file, 'unavailable') ? 'error' : 'success'}`} title={readString(file, 'status_message', 'statusMessage') || undefined}>{statusText(file)}</span></div>
                    <span>{providerName(file)}{readString(file, 'email', 'account', 'label') ? ` · ${readString(file, 'email', 'account', 'label')}` : ''}</span>
                  </div>
                  <div className="auth-file-meta">
                    <span>{readNumber(file, 'size') === null ? '大小未知' : `${Math.ceil((readNumber(file, 'size') ?? 0) / 1024)} KB`}</span>
                    <span>{formatDate(file.modtime ?? file.updated_at ?? file.last_refresh)}</span>
                    {isRuntimeOnly(file) ? <span className="state-pill">运行时</span> : null}
                  </div>
                  <div className="auth-file-actions">
                    {quotaProviderForFile(file) ? <button type="button" className="secondary-button compact-button" onClick={() => void refreshQuota(file)} disabled={busy || disabled || quotas[quotaKey(file)]?.status === 'loading'}>{disabled ? '已停用' : quotas[quotaKey(file)]?.status === 'loading' ? '查询中' : quotas[quotaKey(file)]?.status === 'success' ? '刷新额度' : '获取额度'}</button> : null}
                    {providerKey(file) ? <button type="button" className="secondary-button compact-button" onClick={() => void openOauthModels(file)} disabled={busy} title="设置开放模型">模型</button> : null}
                    <button type="button" className="icon-button quiet" onClick={() => void copyName(name)} disabled={busy} title="复制文件名">{copied === name ? <Check size={16} /> : <Copy size={16} />}</button>
                    <button type="button" className="icon-button quiet" onClick={() => void downloadFile(file)} disabled={busy || isRuntimeOnly(file)} title="下载"><Download size={16} /></button>
                    <button type="button" className="secondary-button compact-button" onClick={() => void toggleStatus(file)} disabled={busy}>{disabled ? '启用' : '停用'}</button>
                    <button type="button" className="icon-button danger" onClick={() => void deleteFile(file)} disabled={busy || isRuntimeOnly(file)} title="删除"><Trash2 size={16} /></button>
                  </div>
                  {quotaProviderForFile(file) && quotas[quotaKey(file)]?.status !== 'idle' ? <AuthFileQuotaSummary quota={quotas[quotaKey(file)] ?? idleQuota()} /> : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
      {runtimeCount > 0 ? <p className="page-footnote">{runtimeCount} 个凭据来自运行时存储，只能在对应提供商或认证源中管理。</p> : null}

      {oauthModelProvider ? (
        <div className="model-discovery-backdrop" onMouseDown={(event) => event.currentTarget === event.target && !oauthModelSaving && closeOauthModels()}>
          <section className="model-discovery-dialog" role="dialog" aria-modal="true" aria-labelledby="oauth-model-title">
            <div className="model-discovery-header">
              <div><h2 id="oauth-model-title">开放模型</h2><span>{oauthModelProviderLabel} · 默认全部开放，可取消不需要的模型</span></div>
              <button type="button" className="icon-button quiet" onClick={closeOauthModels} disabled={oauthModelSaving} title="关闭"><X size={18} /></button>
            </div>

            <div className="model-discovery-search">
              <Search size={16} aria-hidden="true" />
              <input value={oauthModelSearch} onChange={(event) => setOauthModelSearch(event.currentTarget.value)} placeholder="搜索模型名称" />
            </div>

            <div className="model-discovery-toolbar">
              <span>共 {oauthModels.length} 个 · 已开放 {openOauthModelNames.size} 个</span>
              <div>
                <button type="button" className="secondary-button compact-button" onClick={toggleAllVisibleOauthModels} disabled={oauthModelLoading || visibleOauthModels.length === 0}>{allVisibleOauthModelsOpen ? '关闭当前' : '开放当前'}</button>
                <button type="button" className="secondary-button compact-button" onClick={() => setOpenOauthModelNames(new Set(oauthModels.map((model) => model.id.toLowerCase())))} disabled={oauthModelLoading || oauthModels.length === 0 || openOauthModelNames.size === oauthModels.length}>全部开放</button>
                <button type="button" className="secondary-button compact-button" onClick={() => setOpenOauthModelNames(new Set())} disabled={oauthModelLoading || openOauthModelNames.size === 0}>全部关闭</button>
              </div>
            </div>

            <div className="model-discovery-content">
              {oauthModelLoading ? (
                <div className="model-discovery-message"><LoaderCircle size={20} className="spin" />正在读取模型定义</div>
              ) : oauthModelError ? (
                <div className="model-discovery-message error"><strong>读取模型失败</strong><span>{oauthModelError}</span></div>
              ) : visibleOauthModels.length === 0 ? (
                <div className="model-discovery-message"><strong>{oauthModels.length ? '没有匹配的模型' : '暂无模型定义'}</strong></div>
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
              <button type="button" className="secondary-button" onClick={closeOauthModels} disabled={oauthModelSaving}>取消</button>
              <button type="button" className="primary-button" onClick={() => void saveOauthModels()} disabled={oauthModelLoading || oauthModelSaving || oauthModels.length === 0}>{oauthModelSaving ? '保存中' : `保存（开放 ${openOauthModelNames.size} 个）`}</button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
