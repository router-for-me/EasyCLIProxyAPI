import { FormEvent, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  AlertCircle,
  Check,
  Copy,
  Clock3,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useCoreRuntime, type CoreStatus } from '../coreRuntime';
import { useI18n } from '../i18n';
import { webUiManagementUrl } from '../services/clientAccess';
import { ThinkingAliasesPage } from './ThinkingAliasesPage';

type CoreConfigSettings = {
  apiKeys: CoreApiKey[];
  managementSecretConfigured: boolean;
  port: number;
  allowLan: boolean;
  routingStrategy: string;
  proxyUrl: string;
  routingSessionAffinity: boolean;
  routingSessionAffinityTtl: string;
};

type CoreApiKey = {
  apiKey: string;
  remark: string;
};

type ConfigAction =
  | 'add-key'
  | 'update-key'
  | 'delete-key'
  | 'management-secret'
  | 'routing'
  | 'network'
  | null;
type NoticeTone = 'success' | 'error';
type ConfigSubpage = 'general' | 'network' | 'aliases';

const ROUTING_OPTIONS = [
  { value: 'round-robin', labelKey: 'config.routing.roundRobin' },
  { value: 'fill-first', labelKey: 'config.routing.fillFirst' },
] as const;

export function ConfigPanelPage() {
  const { t } = useI18n();
  const { status: coreStatus, publishStatus, refreshStatus } = useCoreRuntime();
  const [settings, setSettings] = useState<CoreConfigSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyAction, setBusyAction] = useState<ConfigAction>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingApiKey, setEditingApiKey] = useState<string | null>(null);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [newApiKey, setNewApiKey] = useState('');
  const [newApiKeyRemark, setNewApiKeyRemark] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [formError, setFormError] = useState('');
  const [managementSecretDraft, setManagementSecretDraft] = useState('');
  const [managementSecretConfirm, setManagementSecretConfirm] = useState('');
  const [showManagementSecret, setShowManagementSecret] = useState(false);
  const [managementSecretError, setManagementSecretError] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ message: string; tone: NoticeTone } | null>(null);
  const [activeSubpage, setActiveSubpage] = useState<ConfigSubpage>('general');
  const [portDraft, setPortDraft] = useState('8317');
  const [allowLanDraft, setAllowLanDraft] = useState(false);
  const [proxyUrlDraft, setProxyUrlDraft] = useState('');
  const [sessionAffinityDraft, setSessionAffinityDraft] = useState(false);
  const [sessionTtlDraft, setSessionTtlDraft] = useState('');
  const [portError, setPortError] = useState('');
  const [savedStatusVisible, setSavedStatusVisible] = useState(false);
  const settingsRef = useRef<CoreConfigSettings | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void loadSettings();
    void listen('config-files-changed', () => {
      if (!disposed) void loadSettings('preserve-dirty');
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const showNotice = (message: string, tone: NoticeTone) => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    setNotice({ message, tone });
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 3200);
  };

  type DraftSyncMode = 'sync' | 'preserve-dirty' | 'keep';

  const applySettings = (result: CoreConfigSettings, drafts: DraftSyncMode = 'sync') => {
    const previous = settingsRef.current;
    settingsRef.current = result;
    setSettings(result);
    if (drafts === 'keep') {
      return;
    }
    // On externally triggered reloads keep drafts the user has already edited
    // so unsaved toggles/inputs are not silently reverted.
    const base = drafts === 'preserve-dirty' ? previous : null;
    setPortDraft((draft) => (base && draft !== String(base.port) ? draft : String(result.port)));
    setAllowLanDraft((draft) => (base && draft !== base.allowLan ? draft : result.allowLan));
    setProxyUrlDraft((draft) => (base && draft !== base.proxyUrl ? draft : result.proxyUrl));
    setSessionAffinityDraft((draft) =>
      base && draft !== base.routingSessionAffinity ? draft : result.routingSessionAffinity,
    );
    setSessionTtlDraft((draft) =>
      base && draft !== base.routingSessionAffinityTtl ? draft : result.routingSessionAffinityTtl,
    );
    if (!base) {
      setPortError('');
    }
  };

  async function loadSettings(drafts: DraftSyncMode = 'sync') {
    setLoading(true);
    setLoadError('');
    try {
      const result = await invoke<CoreConfigSettings>('get_core_config_settings');
      applySettings(result, drafts);
    } catch (error) {
      settingsRef.current = null;
      setSettings(null);
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  }

  const runMutation = async (
    action: Exclude<ConfigAction, null>,
    command: string,
    args: Record<string, unknown>,
    successMessage: string,
  ) => {
    setBusyAction(action);
    try {
      const result = await invoke<CoreConfigSettings>(command, args);
      applySettings(result, 'keep');
      setLoadError('');
      showNotice(successMessage, 'success');
      return true;
    } catch (error) {
      if (settings) applySettings(settings, 'keep');
      showNotice(t('config.error.saveFailed', { error: String(error) }), 'error');
      void loadSettings('keep');
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const openAddDialog = () => {
    setEditingApiKey(null);
    setNewApiKey('');
    setNewApiKeyRemark('');
    setShowApiKey(false);
    setFormError('');
    setAddDialogOpen(true);
  };

  const openEditDialog = (entry: CoreApiKey) => {
    setEditingApiKey(entry.apiKey);
    setNewApiKey(entry.apiKey);
    setNewApiKeyRemark(entry.remark);
    setShowApiKey(false);
    setFormError('');
    setAddDialogOpen(true);
  };

  const closeAddDialog = () => {
    if (busyAction === 'add-key' || busyAction === 'update-key') {
      return;
    }
    setAddDialogOpen(false);
    setEditingApiKey(null);
    setFormError('');
  };

  const generateApiKey = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    setNewApiKey(`sk-${value}`);
    setShowApiKey(true);
    setFormError('');
  };

  const generateManagementSecret = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const secret = `webui-${value}`;
    setManagementSecretDraft(secret);
    setManagementSecretConfirm(secret);
    setShowManagementSecret(true);
    setManagementSecretError('');
  };

  const saveManagementSecret = async (event: FormEvent) => {
    event.preventDefault();
    const secretKey = managementSecretDraft.trim();
    if (!secretKey) {
      setManagementSecretError(t('config.webuiKey.error.empty'));
      return;
    }
    if (secretKey === '123456') {
      setManagementSecretError(t('config.webuiKey.error.legacyDefault'));
      return;
    }
    if (secretKey.length > 512) {
      setManagementSecretError(t('config.webuiKey.error.tooLong'));
      return;
    }
    if (/[\u0000-\u001f\u007f-\u009f]/.test(secretKey)) {
      setManagementSecretError(t('config.webuiKey.error.invalid'));
      return;
    }
    if (secretKey !== managementSecretConfirm.trim()) {
      setManagementSecretError(t('config.webuiKey.error.mismatch'));
      return;
    }

    const saved = await runMutation(
      'management-secret',
      'set_core_management_secret_key',
      { secretKey },
      t('config.webuiKey.notice.updated'),
    );
    if (saved) {
      setManagementSecretDraft('');
      setManagementSecretConfirm('');
      setShowManagementSecret(false);
      setManagementSecretError('');
    }
  };

  const submitApiKey = async (event: FormEvent) => {
    event.preventDefault();
    const apiKey = newApiKey.trim();
    if (!apiKey) {
      setFormError(t('config.error.emptyKey'));
      return;
    }
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      setFormError(t('config.error.invalidKey'));
      return;
    }
    if (settings?.apiKeys.some((entry) => entry.apiKey === apiKey && entry.apiKey !== editingApiKey)) {
      setFormError(t('config.error.duplicateKey'));
      return;
    }
    const remark = newApiKeyRemark.trim();
    if (remark.length > 80) {
      setFormError(t('config.error.remarkTooLong'));
      return;
    }

    const editing = editingApiKey !== null;
    const saved = await runMutation(
      editing ? 'update-key' : 'add-key',
      editing ? 'update_core_api_key' : 'add_core_api_key',
      editing ? { originalApiKey: editingApiKey, apiKey, remark } : { apiKey, remark },
      editing ? t('config.notice.keyUpdated') : t('config.notice.keyAdded'),
    );
    if (saved) {
      setAddDialogOpen(false);
      setEditingApiKey(null);
      setNewApiKey('');
      setNewApiKeyRemark('');
    }
  };

  const confirmDelete = async () => {
    if (deleteIndex === null) {
      return;
    }
    const deleted = await runMutation(
      'delete-key',
      'delete_core_api_key',
      { apiKey: selectedDeleteKey },
      t('config.notice.keyDeleted'),
    );
    if (deleted) {
      setDeleteIndex(null);
    }
  };

  const copyApiKey = async (apiKey: string, index: number) => {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopiedIndex(index);
      showNotice(t('config.notice.keyCopied'), 'success');
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedIndex(null);
        copyTimerRef.current = null;
      }, 1800);
    } catch {
      showNotice(t('config.notice.keyCopyFailed'), 'error');
    }
  };

  const openWebUi = async () => {
    try {
      await invoke('open_external_url', {
        url: webUiManagementUrl(settings?.port ?? 8317),
      });
    } catch (error) {
      showNotice(t('config.webuiKey.error.openFailed', { error: String(error) }), 'error');
    }
  };

  const changeRoutingStrategy = async (strategy: string) => {
    if (strategy === settings?.routingStrategy) {
      return;
    }
    setSavedStatusVisible(false);
    const saved = await runMutation(
      'routing',
      'set_core_routing_strategy',
      { strategy },
      t('config.notice.routingUpdated'),
    );
    if (saved) setSavedStatusVisible(true);
  };

  const saveNetworkRoutingSettings = async () => {
    if (!settings || busyAction !== null) return;
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortError(t('config.error.portRange'));
      showNotice(t('config.error.portRange'), 'error');
      return;
    }

    const proxyUrl = proxyUrlDraft.trim();
    const routingSessionAffinityTtl = sessionTtlDraft.trim();
    const networkChanged = port !== settings.port || allowLanDraft !== settings.allowLan;
    setPortError('');
    setSavedStatusVisible(false);
    setBusyAction('network');
    try {
      const result = await invoke<CoreConfigSettings>('save_network_routing_settings', {
        settings: {
          port,
          allowLan: allowLanDraft,
          proxyUrl,
          routingSessionAffinity: sessionAffinityDraft,
          routingSessionAffinityTtl,
        },
      });
      applySettings(result);
      setLoadError('');
      setSavedStatusVisible(true);

      if (networkChanged && coreStatus?.running) {
        try {
          const status = await invoke<CoreStatus>('restart_core_process');
          publishStatus(status);
          showNotice(t('config.notice.networkRestarted'), 'success');
        } catch (error) {
          await refreshStatus();
          showNotice(t('config.error.networkRestartFailed', { error: String(error) }), 'error');
        }
      } else if (networkChanged) {
        showNotice(t('config.notice.networkNextStart'), 'success');
      } else {
        showNotice(t('config.notice.networkUpdated'), 'success');
      }
    } catch (error) {
      applySettings(settings);
      showNotice(t('config.error.saveFailed', { error: String(error) }), 'error');
      void loadSettings();
    } finally {
      setBusyAction(null);
    }
  };

  const controlsDisabled = loading || settings === null || busyAction !== null;
  const networkRoutingDirty = Boolean(settings) && (
    portDraft !== String(settings?.port)
    || allowLanDraft !== settings?.allowLan
    || proxyUrlDraft.trim() !== settings?.proxyUrl
    || sessionAffinityDraft !== settings?.routingSessionAffinity
    || sessionTtlDraft.trim() !== settings?.routingSessionAffinityTtl
  );
  const networkStatusLabel = loading
    ? t('common.loading')
    : settings === null
      ? t('common.unavailable')
      : busyAction === 'network' || busyAction === 'routing'
        ? t('config.network.saving')
        : networkRoutingDirty
          ? t('config.network.unsaved')
          : savedStatusVisible
            ? t('config.network.saved')
            : '';
  const networkStatusIsSaved = !loading
    && settings !== null
    && busyAction === null
    && !networkRoutingDirty
    && savedStatusVisible;
  const selectedDeleteKey =
    deleteIndex === null ? '' : settings?.apiKeys[deleteIndex]?.apiKey || '';
  const deletingLastKey = deleteIndex !== null && settings?.apiKeys.length === 1;
  const keyMutationBusy = busyAction === 'add-key' || busyAction === 'update-key';
  const managementSecretBusy = busyAction === 'management-secret';

  return (
    <section className="page config-page">
      <div className="agent-subpage-tabs config-subpage-tabs" role="tablist" aria-label={t('config.tabs.label')}>
        <button
          type="button"
          id="config-subpage-tab-general"
          role="tab"
          className={activeSubpage === 'general' ? 'active' : ''}
          aria-selected={activeSubpage === 'general'}
          aria-controls="config-subpage-panel-general"
          tabIndex={activeSubpage === 'general' ? 0 : -1}
          onClick={() => setActiveSubpage('general')}
        >
          {t('config.tabs.general')}
        </button>
        <button
          type="button"
          id="config-subpage-tab-network"
          role="tab"
          className={activeSubpage === 'network' ? 'active' : ''}
          aria-selected={activeSubpage === 'network'}
          aria-controls="config-subpage-panel-network"
          tabIndex={activeSubpage === 'network' ? 0 : -1}
          onClick={() => setActiveSubpage('network')}
        >
          {t('config.tabs.network')}
        </button>
        <button
          type="button"
          id="config-subpage-tab-aliases"
          role="tab"
          className={activeSubpage === 'aliases' ? 'active' : ''}
          aria-selected={activeSubpage === 'aliases'}
          aria-controls="config-subpage-panel-aliases"
          tabIndex={activeSubpage === 'aliases' ? 0 : -1}
          onClick={() => setActiveSubpage('aliases')}
        >
          {t('app.nav.thinkingAliases')}
        </button>
      </div>

      {activeSubpage === 'general' ? (
        <div
          className="config-subpage-panel"
          id="config-subpage-panel-general"
          role="tabpanel"
          aria-labelledby="config-subpage-tab-general"
        >
        <section className="panel config-keys-panel">
          <div className="config-panel-heading">
            <div className="config-heading-title">
              <KeyRound size={18} aria-hidden="true" />
              <h2>{t('config.keys.title')}</h2>
            </div>
            <div className="config-heading-actions">
              <span className="config-count" aria-label={t('config.keys.count')}>
                {settings?.apiKeys.length ?? 0}
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={openAddDialog}
                disabled={controlsDisabled}
                title={t('config.keys.add')}
                aria-label={t('config.keys.add')}
              >
                <Plus size={18} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="config-key-list" aria-busy={loading || undefined}>
            {loading ? (
              Array.from({ length: 5 }, (_, index) => (
                <div className="config-key-row skeleton" key={index} aria-hidden="true">
                  <span />
                  <span />
                </div>
              ))
            ) : loadError ? (
              <div className="config-unavailable">
                <AlertCircle size={24} aria-hidden="true" />
                <strong>{t('config.unavailable')}</strong>
                <span title={loadError}>{loadError}</span>
                <button type="button" className="secondary-button compact-button" onClick={() => void loadSettings()}>
                  <RefreshCw size={16} aria-hidden="true" />
                  {t('common.retry')}
                </button>
              </div>
            ) : settings && settings.apiKeys.length > 0 ? (
              settings.apiKeys.map((entry, index) => (
                <div className="config-key-row" key={`${index}-${entry.apiKey}`}>
                  <div className="config-key-identity">
                    <span className="config-key-index">{String(index + 1).padStart(2, '0')}</span>
                    <div className="config-key-details">
                      <div className="config-key-label-line">
                        <strong title={entry.remark || t('config.keys.noRemark')}>
                          {entry.remark || t('config.keys.noRemark')}
                        </strong>
                      </div>
                      <code title={maskApiKey(entry.apiKey)}>{maskApiKey(entry.apiKey)}</code>
                    </div>
                  </div>
                  <div className="config-key-actions">
                    <button
                      type="button"
                      className="icon-button quiet"
                      onClick={() => void copyApiKey(entry.apiKey, index)}
                      disabled={controlsDisabled}
                      title={t('config.keys.copy')}
                      aria-label={t('config.keys.copyNth', { number: index + 1 })}
                    >
                      {copiedIndex === index ? (
                        <Check size={16} aria-hidden="true" />
                      ) : (
                        <Copy size={16} aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="icon-button quiet"
                      onClick={() => openEditDialog(entry)}
                      disabled={controlsDisabled}
                      title={t('config.keys.edit')}
                      aria-label={t('config.keys.editNth', { number: index + 1 })}
                    >
                      <Pencil size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      onClick={() => setDeleteIndex(index)}
                      disabled={controlsDisabled}
                      title={t('config.keys.delete')}
                      aria-label={t('config.keys.deleteNth', { number: index + 1 })}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="config-empty-list">
                <KeyRound size={26} aria-hidden="true" />
                <strong>{t('config.keys.empty')}</strong>
              </div>
            )}
          </div>
        </section>
        <section className="panel config-management-panel">
          <div className="config-panel-heading">
            <div className="config-heading-title">
              <ShieldCheck size={18} aria-hidden="true" />
              <h2>{t('config.webuiKey.title')}</h2>
            </div>
            <div className="config-heading-actions">
              {!loading && settings ? (
                <span
                  className={`state-pill ${settings.managementSecretConfigured ? 'success' : ''}`}
                >
                  {settings.managementSecretConfigured
                    ? t('config.webuiKey.configured')
                    : t('config.webuiKey.unconfigured')}
                </span>
              ) : null}
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={loading || settings === null}
                onClick={() => void openWebUi()}
                title={settings ? webUiManagementUrl(settings.port) : undefined}
              >
                {t('config.webuiKey.open')}
              </button>
            </div>
          </div>

          <div className="config-management-content">
            <div className="config-management-description">
              <strong>{t('config.webuiKey.heading')}</strong>
              <p>{t('config.webuiKey.description')}</p>
              <small>{t('config.webuiKey.securityHint')}</small>
            </div>

            <form
              className="config-management-form"
              onSubmit={(event) => void saveManagementSecret(event)}
            >
              <label className="config-management-field">
                <span>{t('config.webuiKey.newKey')}</span>
                <div className="config-secret-input">
                  <input
                    type={showManagementSecret ? 'text' : 'password'}
                    autoComplete="new-password"
                    maxLength={512}
                    value={managementSecretDraft}
                    disabled={controlsDisabled}
                    aria-invalid={Boolean(managementSecretError)}
                    placeholder={t('config.webuiKey.placeholder')}
                    onChange={(event) => {
                      setManagementSecretDraft(event.currentTarget.value);
                      setManagementSecretError('');
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button quiet"
                    disabled={controlsDisabled}
                    onClick={() => setShowManagementSecret((value) => !value)}
                    title={showManagementSecret ? t('config.keys.hide') : t('config.keys.show')}
                    aria-label={showManagementSecret ? t('config.keys.hide') : t('config.keys.show')}
                  >
                    {showManagementSecret ? (
                      <EyeOff size={16} aria-hidden="true" />
                    ) : (
                      <Eye size={16} aria-hidden="true" />
                    )}
                  </button>
                </div>
              </label>

              <label className="config-management-field">
                <span>{t('config.webuiKey.confirmKey')}</span>
                <input
                  className="config-dialog-text-input"
                  type={showManagementSecret ? 'text' : 'password'}
                  autoComplete="new-password"
                  maxLength={512}
                  value={managementSecretConfirm}
                  disabled={controlsDisabled}
                  aria-invalid={Boolean(managementSecretError)}
                  placeholder={t('config.webuiKey.confirmPlaceholder')}
                  onChange={(event) => {
                    setManagementSecretConfirm(event.currentTarget.value);
                    setManagementSecretError('');
                  }}
                />
              </label>

              <div className="config-management-form-footer">
                <span
                  className={`config-management-error ${managementSecretError ? 'visible' : ''}`}
                  role="alert"
                >
                  {managementSecretError || ' '}
                </span>
                <div className="config-management-actions">
                  <button
                    type="button"
                    className="secondary-button compact-button"
                  disabled={controlsDisabled}
                  onClick={generateManagementSecret}
                >
                    {t('config.webuiKey.generate')}
                  </button>
                  <button
                    type="submit"
                    className="primary-button compact-button"
                    disabled={controlsDisabled || !managementSecretDraft.trim()}
                  >
                    <Check size={16} aria-hidden="true" />
                    {managementSecretBusy ? t('common.saving') : t('config.webuiKey.save')}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </section>
        </div>
      ) : activeSubpage === 'network' ? (
        <div
          className="config-subpage-panel config-network-subpage"
          id="config-subpage-panel-network"
          role="tabpanel"
          aria-labelledby="config-subpage-tab-network"
        >
      <section className="panel config-network-panel">
        <div className="config-panel-heading">
          <div className="config-heading-title">
            <Network size={18} aria-hidden="true" />
            <h2>{t('config.network.title')}</h2>
          </div>
          <div className="config-heading-actions">
            {networkStatusLabel ? (
              <span className={`state-pill ${networkStatusIsSaved ? 'success' : ''}`}>
                {networkStatusLabel}
              </span>
            ) : null}
            <button
              type="button"
              className="primary-button compact-button"
              disabled={controlsDisabled || !networkRoutingDirty}
              onClick={() => void saveNetworkRoutingSettings()}
            >
              <Check size={16} aria-hidden="true" />
              {busyAction === 'network'
                ? t('config.network.saving')
                : t('config.network.confirmSave')}
            </button>
          </div>
        </div>

        <div className="config-network-sections">
          <section className="config-network-section" aria-labelledby="config-network-section-title">
            <div className="config-network-section-heading">
              <Network size={16} aria-hidden="true" />
              <h3 id="config-network-section-title">{t('config.network.networkSection')}</h3>
            </div>
            <div className="config-network-grid">
              <label className="config-network-field config-network-port-field">
            <span>{t('config.network.port')}</span>
            <input
              className={`config-network-input ${portError ? 'error' : ''}`}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={5}
              value={portDraft}
              disabled={controlsDisabled}
              aria-invalid={Boolean(portError)}
              title={portError || t('config.network.portHint')}
              onChange={(event) => {
                setSavedStatusVisible(false);
                setPortDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 5));
                setPortError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && settings) {
                  setPortDraft(String(settings.port));
                  setPortError('');
                  event.currentTarget.blur();
                }
              }}
            />
            <small>{t('config.network.portHint')}</small>
              </label>

              <div className="config-network-field config-network-toggle">
                <div>
                  <span>{t('config.network.allowLan')}</span>
                  <small>{t('config.network.allowLanHint')}</small>
                </div>
                <label className="switch-control" title={t('config.network.allowLan')}>
                  <input
                    type="checkbox"
                    aria-label={t('config.network.allowLan')}
                    checked={allowLanDraft}
                    disabled={controlsDisabled}
                    onChange={(event) => {
                      setSavedStatusVisible(false);
                      setAllowLanDraft(event.currentTarget.checked);
                    }}
                  />
                  <span className="switch-track" />
                </label>
              </div>

              <label className="config-network-field">
                <span className="config-network-label">
                  <Link2 size={15} aria-hidden="true" />
                  {t('config.network.proxyUrl')}
                </span>
                <input
                  className="config-network-input"
                  type="text"
                  value={proxyUrlDraft}
                  disabled={controlsDisabled}
                  placeholder={t('config.network.proxyPlaceholder')}
                  onChange={(event) => {
                    setSavedStatusVisible(false);
                    setProxyUrlDraft(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      setProxyUrlDraft(settings.proxyUrl);
                      event.currentTarget.blur();
                    }
                  }}
                />
                <small>{t('config.network.proxyHint')}</small>
              </label>
            </div>
          </section>

          <section className="config-network-section" aria-labelledby="config-routing-section-title">
            <div className="config-network-section-heading">
              <Route size={16} aria-hidden="true" />
              <h3 id="config-routing-section-title">{t('config.network.routingSection')}</h3>
            </div>
            <div className="config-network-grid">
              <div className="config-network-field config-network-toggle">
                <div>
                  <span>{t('config.network.sessionAffinity')}</span>
                  <small>{t('config.network.sessionAffinityHint')}</small>
                </div>
                <label className="switch-control" title={t('config.network.sessionAffinity')}>
                  <input
                    type="checkbox"
                    aria-label={t('config.network.sessionAffinity')}
                    checked={sessionAffinityDraft}
                    disabled={controlsDisabled}
                    onChange={(event) => {
                      setSavedStatusVisible(false);
                      setSessionAffinityDraft(event.currentTarget.checked);
                    }}
                  />
                  <span className="switch-track" />
                </label>
              </div>

              <label className="config-network-field">
                <span className="config-network-label">
                  <Clock3 size={15} aria-hidden="true" />
                  {t('config.network.sessionTtl')}
                </span>
                <input
                  className="config-network-input"
                  type="text"
                  value={sessionTtlDraft}
                  disabled={controlsDisabled}
                  placeholder="1h"
                  onChange={(event) => {
                    setSavedStatusVisible(false);
                    setSessionTtlDraft(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      setSessionTtlDraft(settings.routingSessionAffinityTtl);
                      event.currentTarget.blur();
                    }
                  }}
                />
                <small>{t('config.network.sessionTtlHint')}</small>
              </label>

              <div className="config-network-field config-network-routing-field">
                <span className="config-network-label">
                  <Route size={15} aria-hidden="true" />
                  {t('config.routing.title')}
                </span>
                <div className="routing-segmented" role="group" aria-label={t('config.routing.title')}>
                  {ROUTING_OPTIONS.map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      className={settings?.routingStrategy === option.value ? 'active' : ''}
                      aria-pressed={settings?.routingStrategy === option.value}
                      disabled={controlsDisabled}
                      onClick={() => void changeRoutingStrategy(option.value)}
                      title={option.value}
                    >
                      {t(option.labelKey)}
                    </button>
                  ))}
                </div>
                <small title={settings?.routingStrategy || undefined}>
                  {loading
                    ? t('common.loading')
                    : settings === null
                      ? t('common.unavailable')
                      : routingStrategyLabel(settings.routingStrategy, t)}
                </small>
              </div>
            </div>
          </section>
        </div>
      </section>
        </div>
      ) : (
        <div
          className="config-subpage-panel"
          id="config-subpage-panel-aliases"
          role="tabpanel"
          aria-labelledby="config-subpage-tab-aliases"
        >
          <ThinkingAliasesPage />
        </div>
      )}

      {addDialogOpen ? (
        <div className="config-dialog-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeAddDialog();
        }}>
          <form
            className="config-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-api-key-title"
            onSubmit={(event) => void submitApiKey(event)}
          >
            <div className="config-dialog-heading">
              <div>
                <KeyRound size={19} aria-hidden="true" />
                <h2 id="add-api-key-title">
                  {editingApiKey === null ? t('config.keys.addTitle') : t('config.keys.editTitle')}
                </h2>
              </div>
              <button
                type="button"
                className="icon-button quiet"
                onClick={closeAddDialog}
                disabled={keyMutationBusy}
                title={t('common.close')}
                aria-label={t('common.close')}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <label className="config-dialog-field">
              <span>{t('config.keys.label')}</span>
              <div className="config-secret-input">
                <input
                  autoFocus
                  type={showApiKey ? 'text' : 'password'}
                  value={newApiKey}
                  onChange={(event) => {
                    setNewApiKey(event.currentTarget.value);
                    setFormError('');
                  }}
                  disabled={keyMutationBusy}
                  aria-invalid={Boolean(formError)}
                  placeholder="sk-..."
                />
                <button
                  type="button"
                  className="icon-button quiet"
                  onClick={() => setShowApiKey((visible) => !visible)}
                  disabled={keyMutationBusy}
                  title={showApiKey ? t('config.keys.hide') : t('config.keys.show')}
                  aria-label={showApiKey ? t('config.keys.hide') : t('config.keys.show')}
                >
                  {showApiKey ? (
                    <EyeOff size={17} aria-hidden="true" />
                  ) : (
                    <Eye size={17} aria-hidden="true" />
                  )}
                </button>
              </div>
            </label>

            <label className="config-dialog-field">
              <span>{t('config.keys.remark')}</span>
              <input
                className="config-dialog-text-input"
                type="text"
                value={newApiKeyRemark}
                maxLength={80}
                onChange={(event) => {
                  setNewApiKeyRemark(event.currentTarget.value);
                  setFormError('');
                }}
                disabled={keyMutationBusy}
                placeholder={t('config.keys.remarkPlaceholder')}
              />
            </label>

            <div className={`config-form-message ${formError ? 'error' : ''}`}>
              {formError || ' '}
            </div>

            <div className="config-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={generateApiKey}
                disabled={keyMutationBusy}
              >
                <Sparkles size={16} aria-hidden="true" />
                {t('config.keys.generate')}
              </button>
              <button type="submit" className="primary-button" disabled={keyMutationBusy}>
                {editingApiKey === null ? <Plus size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                {keyMutationBusy
                  ? editingApiKey === null ? t('config.keys.adding') : t('common.saving')
                  : editingApiKey === null ? t('common.add') : t('common.save')}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {deleteIndex !== null ? (
        <div className="config-dialog-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target && busyAction !== 'delete-key') {
            setDeleteIndex(null);
          }
        }}>
          <div
            className={`config-dialog config-delete-dialog ${deletingLastKey ? 'has-warning' : ''}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-api-key-title"
          >
            <div className="config-dialog-heading">
              <div>
                <Trash2 size={19} aria-hidden="true" />
                <h2 id="delete-api-key-title">{t('config.keys.deleteTitle')}</h2>
              </div>
            </div>
            <code className="config-delete-key">{maskApiKey(selectedDeleteKey)}</code>
            {deletingLastKey ? (
              <div className="config-delete-warning">
                <AlertCircle size={17} aria-hidden="true" />
                <span>{t('config.keys.deleteAllWarning')}</span>
              </div>
            ) : null}
            <div className="config-dialog-actions two-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setDeleteIndex(null)}
                disabled={busyAction === 'delete-key'}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void confirmDelete()}
                disabled={busyAction === 'delete-key'}
              >
                <Trash2 size={16} aria-hidden="true" />
                {busyAction === 'delete-key' ? t('common.deleting') : t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className={`config-toast ${notice.tone}`} role="status" title={notice.message}>
          {notice.tone === 'success' ? (
            <Check size={17} aria-hidden="true" />
          ) : (
            <AlertCircle size={17} aria-hidden="true" />
          )}
          <span>{notice.message}</span>
        </div>
      ) : null}
    </section>
  );
}

function maskApiKey(apiKey: string) {
  const value = apiKey.trim();
  if (!value) {
    return '';
  }
  const visible = value.length < 4 ? 1 : 2;
  return `${value.slice(0, visible)}${'*'.repeat(Math.max(6, 10 - visible * 2))}${value.slice(-visible)}`;
}

function routingStrategyLabel(strategy: string | undefined, t: ReturnType<typeof useI18n>['t']) {
  if (!strategy) {
    return t('common.loading');
  }
  const option = ROUTING_OPTIONS.find((item) => item.value === strategy);
  return option ? t(option.labelKey) : strategy;
}
