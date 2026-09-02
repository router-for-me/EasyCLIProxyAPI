import { FormEvent, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import {
  AlertCircle,
  Check,
  Copy,
  Clock3,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Link2,
  LockKeyhole,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Settings2,
  ShieldCheck,
  Sparkles,
  Power,
  Terminal,
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
  host: string;
  port: number;
  allowLan: boolean;
  routingStrategy: string;
  proxyUrl: string;
  routingSessionAffinity: boolean;
  routingSessionAffinityTtl: string;
  disableCooling: boolean;
  requestRetry: number;
  maxRetryCredentials: number;
  maxRetryInterval: number;
  streamingBootstrapRetries: number;
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
  | 'retry'
  | 'tls'
  | 'software'
  | null;
type NoticeTone = 'success' | 'error';
type ConfigSubpage = 'general' | 'network' | 'routing' | 'software' | 'aliases';
type CloseBehavior = 'ask' | 'exit' | 'minimize-to-tray';
type NetworkDraftField =
  | 'port'
  | 'host'
  | 'proxyUrl'
  | 'sessionAffinity'
  | 'sessionTtl'
  | 'disableCooling'
  | 'requestRetry'
  | 'maxRetryCredentials'
  | 'maxRetryInterval'
  | 'streamingBootstrapRetries';
type DraftRefreshMode = 'replace' | 'preserve';

type NetworkDraftDirty = Record<NetworkDraftField, boolean>;

type AgentTerminalOption = {
  id: string;
  label: string;
};

type SoftwareSettings = {
  closeBehavior: CloseBehavior;
  autostartEnabled: boolean;
  startCoreOnLaunch: boolean;
  silentStartEnabled: boolean;
  defaultTerminal: string;
  availableTerminals: AgentTerminalOption[];
};

type CoreTlsSettings = {
  enabled: boolean;
  cert: string;
  key: string;
};

const cleanNetworkDraft = (): NetworkDraftDirty => ({
  port: false,
  host: false,
  proxyUrl: false,
  sessionAffinity: false,
  sessionTtl: false,
  disableCooling: false,
  requestRetry: false,
  maxRetryCredentials: false,
  maxRetryInterval: false,
  streamingBootstrapRetries: false,
});

const ROUTING_OPTIONS = [
  { value: 'round-robin', labelKey: 'config.routing.roundRobin' },
  { value: 'fill-first', labelKey: 'config.routing.fillFirst' },
] as const;

export function ConfigPanelPage() {
  const { t } = useI18n();
  const { status: coreStatus, publishStatus, refreshStatus } = useCoreRuntime();
  const [settings, setSettings] = useState<CoreConfigSettings | null>(null);
  const [softwareSettings, setSoftwareSettings] = useState<SoftwareSettings | null>(null);
  const [softwareSettingsLoading, setSoftwareSettingsLoading] = useState(true);
  const [softwareCloseBehaviorDraft, setSoftwareCloseBehaviorDraft] = useState<CloseBehavior>('ask');
  const [softwareAutostartDraft, setSoftwareAutostartDraft] = useState(false);
  const [softwareStartCoreDraft, setSoftwareStartCoreDraft] = useState(true);
  const [softwareSilentStartDraft, setSoftwareSilentStartDraft] = useState(false);
  const [softwareDefaultTerminalDraft, setSoftwareDefaultTerminalDraft] = useState('auto');
  const [softwareSavedStatusVisible, setSoftwareSavedStatusVisible] = useState(false);
  const [tlsSettings, setTlsSettings] = useState<CoreTlsSettings | null>(null);
  const [tlsSettingsLoading, setTlsSettingsLoading] = useState(true);
  const [tlsEnabledDraft, setTlsEnabledDraft] = useState(false);
  const [tlsCertDraft, setTlsCertDraft] = useState('');
  const [tlsKeyDraft, setTlsKeyDraft] = useState('');
  const [tlsError, setTlsError] = useState('');
  const [tlsFileSelecting, setTlsFileSelecting] = useState<'cert' | 'key' | null>(null);
  const [tlsSavedStatusVisible, setTlsSavedStatusVisible] = useState(false);
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
  const [hostDraft, setHostDraft] = useState('127.0.0.1');
  const [proxyUrlDraft, setProxyUrlDraft] = useState('');
  const [sessionAffinityDraft, setSessionAffinityDraft] = useState(false);
  const [sessionTtlDraft, setSessionTtlDraft] = useState('');
  const [disableCoolingDraft, setDisableCoolingDraft] = useState(false);
  const [requestRetryDraft, setRequestRetryDraft] = useState('3');
  const [maxRetryCredentialsDraft, setMaxRetryCredentialsDraft] = useState('0');
  const [maxRetryIntervalDraft, setMaxRetryIntervalDraft] = useState('30');
  const [streamingBootstrapRetriesDraft, setStreamingBootstrapRetriesDraft] = useState('0');
  const [portError, setPortError] = useState('');
  const [hostError, setHostError] = useState('');
  const [retryError, setRetryError] = useState('');
  const networkDraftDirtyRef = useRef<NetworkDraftDirty>(cleanNetworkDraft());
  const noticeTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void loadSettings();
    void loadSoftwareSettings();
    void loadTlsSettings();
    void listen('config-files-changed', () => {
      if (!disposed) {
        void loadSettings('preserve');
        void loadSoftwareSettings();
        void loadTlsSettings();
      }
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

  const applySettings = (result: CoreConfigSettings, mode: DraftRefreshMode = 'replace') => {
    setSettings(result);
    if (mode === 'preserve') {
      const dirty = networkDraftDirtyRef.current;
      if (!dirty.port) setPortDraft(String(result.port));
      if (!dirty.host) setHostDraft(result.host);
      if (!dirty.proxyUrl) setProxyUrlDraft(result.proxyUrl);
      if (!dirty.sessionAffinity) setSessionAffinityDraft(result.routingSessionAffinity);
      if (!dirty.sessionTtl) setSessionTtlDraft(result.routingSessionAffinityTtl);
      if (!dirty.disableCooling) setDisableCoolingDraft(result.disableCooling);
      if (!dirty.requestRetry) setRequestRetryDraft(String(result.requestRetry));
      if (!dirty.maxRetryCredentials) setMaxRetryCredentialsDraft(String(result.maxRetryCredentials));
      if (!dirty.maxRetryInterval) setMaxRetryIntervalDraft(String(result.maxRetryInterval));
      if (!dirty.streamingBootstrapRetries) {
        setStreamingBootstrapRetriesDraft(String(result.streamingBootstrapRetries));
      }
      return;
    }
    networkDraftDirtyRef.current = cleanNetworkDraft();
    setPortDraft(String(result.port));
    setHostDraft(result.host);
    setProxyUrlDraft(result.proxyUrl);
    setSessionAffinityDraft(result.routingSessionAffinity);
    setSessionTtlDraft(result.routingSessionAffinityTtl);
    setDisableCoolingDraft(result.disableCooling);
    setRequestRetryDraft(String(result.requestRetry));
    setMaxRetryCredentialsDraft(String(result.maxRetryCredentials));
    setMaxRetryIntervalDraft(String(result.maxRetryInterval));
    setStreamingBootstrapRetriesDraft(String(result.streamingBootstrapRetries));
    setPortError('');
    setHostError('');
    setRetryError('');
  };

  const markDraftDirty = (field: NetworkDraftField) => {
    networkDraftDirtyRef.current[field] = true;
  };

  const clearDraftDirty = (field: NetworkDraftField) => {
    networkDraftDirtyRef.current[field] = false;
  };

  async function loadSettings(mode: DraftRefreshMode = 'replace') {
    setLoading(true);
    setLoadError('');
    try {
      const result = await invoke<CoreConfigSettings>('get_core_config_settings');
      applySettings(result, mode);
    } catch (error) {
      setSettings(null);
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadSoftwareSettings() {
    setSoftwareSettingsLoading(true);
    setSoftwareSavedStatusVisible(false);
    try {
      const result = await invoke<SoftwareSettings>('get_software_settings');
      setSoftwareSettings(result);
      setSoftwareCloseBehaviorDraft(result.closeBehavior);
      setSoftwareAutostartDraft(result.autostartEnabled);
      setSoftwareStartCoreDraft(result.startCoreOnLaunch);
      setSoftwareSilentStartDraft(result.silentStartEnabled);
      setSoftwareDefaultTerminalDraft(result.defaultTerminal);
    } catch (error) {
      setSoftwareSettings(null);
      showNotice(t('config.error.saveFailed', { error: String(error) }), 'error');
    } finally {
      setSoftwareSettingsLoading(false);
    }
  }

  async function loadTlsSettings() {
    setTlsSettingsLoading(true);
    try {
      const result = await invoke<CoreTlsSettings>('get_core_tls_settings');
      setTlsSettings(result);
      setTlsEnabledDraft(result.enabled);
      setTlsCertDraft(result.cert);
      setTlsKeyDraft(result.key);
      setTlsError('');
    } catch (error) {
      setTlsSettings(null);
      setTlsError(String(error));
    } finally {
      setTlsSettingsLoading(false);
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
      setSettings(result);
      setLoadError('');
      showNotice(successMessage, 'success');
      return true;
    } catch (error) {
      if (settings) setSettings(settings);
      showNotice(t('config.error.saveFailed', { error: String(error) }), 'error');
      void loadSettings('preserve');
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
      const [latestSettings, latestTlsSettings] = await Promise.all([
        invoke<CoreConfigSettings>('get_core_config_settings'),
        invoke<CoreTlsSettings>('get_core_tls_settings'),
      ]);
      applySettings(latestSettings, 'preserve');
      setTlsSettings(latestTlsSettings);
      setTlsEnabledDraft(latestTlsSettings.enabled);
      setTlsCertDraft(latestTlsSettings.cert);
      setTlsKeyDraft(latestTlsSettings.key);
      await invoke('open_external_url', {
        url: webUiManagementUrl(latestSettings.port, latestTlsSettings.enabled, latestSettings.host),
      });
    } catch (error) {
      showNotice(t('config.webuiKey.error.openFailed', { error: String(error) }), 'error');
    }
  };

  const saveTlsSettings = async () => {
    if (tlsSettings === null || busyAction !== null) return;
    const cert = tlsCertDraft.trim();
    const key = tlsKeyDraft.trim();
    if (tlsEnabledDraft && (!cert || !key)) {
      setTlsError(t('config.tls.error.pathsRequired'));
      return;
    }

    setBusyAction('tls');
    setTlsError('');
    setTlsSavedStatusVisible(false);
    try {
      const result = await invoke<CoreTlsSettings>('save_core_tls_settings', {
        settings: { enabled: tlsEnabledDraft, cert, key },
      });
      setTlsSettings(result);
      setTlsEnabledDraft(result.enabled);
      setTlsCertDraft(result.cert);
      setTlsKeyDraft(result.key);
      if (coreStatus?.running) {
        const status = await invoke<CoreStatus>('restart_core_process');
        publishStatus(status);
        showNotice(t('config.tls.notice.savedAndRestarted'), 'success');
      } else {
        showNotice(t('config.tls.notice.saved'), 'success');
      }
      setTlsSavedStatusVisible(true);
    } catch (error) {
      setTlsError(String(error));
      showNotice(t('config.error.saveFailed', { error: String(error) }), 'error');
      void refreshStatus();
      void loadTlsSettings();
    } finally {
      setBusyAction(null);
    }
  };

  const selectTlsFile = async (target: 'cert' | 'key') => {
    if (tlsSettings === null || busyAction !== null || tlsFileSelecting !== null) return;
    setTlsFileSelecting(target);
    setTlsError('');
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: target === 'cert'
          ? t('config.tls.selectCertTitle')
          : t('config.tls.selectKeyTitle'),
        filters: [{
          name: target === 'cert' ? t('config.tls.certFile') : t('config.tls.keyFile'),
          extensions: target === 'cert' ? ['pem', 'crt', 'cer'] : ['pem', 'key'],
        }],
      });
      if (typeof selected !== 'string') return;
      setTlsSavedStatusVisible(false);
      if (target === 'cert') setTlsCertDraft(selected);
      else setTlsKeyDraft(selected);
    } catch (error) {
      const message = t('config.tls.error.selectFileFailed', { error: String(error) });
      setTlsError(message);
      showNotice(message, 'error');
    } finally {
      setTlsFileSelecting(null);
    }
  };

  const changeRoutingStrategy = async (strategy: string) => {
    if (strategy === settings?.routingStrategy) {
      return;
    }
    await runMutation(
      'routing',
      'set_core_routing_strategy',
      { strategy },
      t('config.notice.routingUpdated'),
    );
  };

  const saveNetworkEndpointSettings = async () => {
    if (!settings || busyAction !== null) return;
    const host = hostDraft.trim();
    if (!host) {
      setHostError(t('config.error.hostRequired'));
      showNotice(t('config.error.hostRequired'), 'error');
      return;
    }
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortError(t('config.error.portRange'));
      showNotice(t('config.error.portRange'), 'error');
      return;
    }

    const proxyUrl = proxyUrlDraft.trim();
    const networkChanged = port !== settings.port || host !== settings.host;
    setHostError('');
    setPortError('');
    setBusyAction('network');
    try {
      const result = await invoke<CoreConfigSettings>('save_network_endpoint_settings', {
        settings: { host, port, proxyUrl },
      });
      clearDraftDirty('host');
      clearDraftDirty('port');
      clearDraftDirty('proxyUrl');
      applySettings(result, 'preserve');
      setLoadError('');

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
      showNotice(t('config.error.saveFailed', { error: String(error) }), 'error');
      void loadSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const saveRetrySettings = async () => {
    if (!settings || busyAction !== null) return;
    const retryDrafts = [
      requestRetryDraft,
      maxRetryCredentialsDraft,
      maxRetryIntervalDraft,
      streamingBootstrapRetriesDraft,
    ];
    const retryValues = retryDrafts.map(Number);
    if (
      retryDrafts.some((value) => value.length === 0)
      || retryValues.some((value) => !Number.isInteger(value) || value < 0 || value > 4294967295)
    ) {
      setRetryError(t('config.error.retryRange'));
      showNotice(t('config.error.retryRange'), 'error');
      return;
    }
    const [requestRetry, maxRetryCredentials, maxRetryInterval, streamingBootstrapRetries] = retryValues;
    setRetryError('');
    setBusyAction('retry');
    try {
      const result = await invoke<CoreConfigSettings>('save_retry_settings', {
        settings: {
          disableCooling: disableCoolingDraft,
          requestRetry,
          maxRetryCredentials,
          maxRetryInterval,
          streamingBootstrapRetries,
        },
      });
      clearDraftDirty('disableCooling');
      clearDraftDirty('requestRetry');
      clearDraftDirty('maxRetryCredentials');
      clearDraftDirty('maxRetryInterval');
      clearDraftDirty('streamingBootstrapRetries');
      applySettings(result, 'preserve');
      setLoadError('');
      showNotice(t('config.notice.retryUpdated'), 'success');
    } catch (error) {
      showNotice(t('config.error.saveFailed', { error: String(error) }), 'error');
      void loadSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const saveSessionRoutingSettings = async () => {
    if (!settings || busyAction !== null) return;
    const routingSessionAffinityTtl = sessionTtlDraft.trim();
    setBusyAction('routing');
    try {
      const result = await invoke<CoreConfigSettings>('save_session_routing_settings', {
        settings: {
          routingSessionAffinity: sessionAffinityDraft,
          routingSessionAffinityTtl,
        },
      });
      clearDraftDirty('sessionAffinity');
      clearDraftDirty('sessionTtl');
      applySettings(result, 'preserve');
      setLoadError('');
      showNotice(t('config.notice.sessionRoutingUpdated'), 'success');
    } catch (error) {
      showNotice(t('config.error.saveFailed', { error: String(error) }), 'error');
      void loadSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const saveSoftwareSettings = async () => {
    if (!softwareSettings || busyAction !== null) return;
    if (
      softwareCloseBehaviorDraft === softwareSettings.closeBehavior
      && softwareAutostartDraft === softwareSettings.autostartEnabled
      && softwareStartCoreDraft === softwareSettings.startCoreOnLaunch
      && softwareSilentStartDraft === softwareSettings.silentStartEnabled
      && softwareDefaultTerminalDraft === softwareSettings.defaultTerminal
    ) return;

    setBusyAction('software');
    try {
      const result = await invoke<SoftwareSettings>('save_software_settings', {
        settings: {
          closeBehavior: softwareCloseBehaviorDraft,
          autostartEnabled: softwareAutostartDraft,
          startCoreOnLaunch: softwareStartCoreDraft,
          silentStartEnabled: softwareSilentStartDraft,
          defaultTerminal: softwareDefaultTerminalDraft,
        },
      });
      setSoftwareSettings(result);
      setSoftwareCloseBehaviorDraft(result.closeBehavior);
      setSoftwareAutostartDraft(result.autostartEnabled);
      setSoftwareStartCoreDraft(result.startCoreOnLaunch);
      setSoftwareSilentStartDraft(result.silentStartEnabled);
      setSoftwareDefaultTerminalDraft(result.defaultTerminal);
      setSoftwareSavedStatusVisible(true);
      showNotice(t('config.notice.softwareUpdated'), 'success');
    } catch (error) {
      setSoftwareCloseBehaviorDraft(softwareSettings.closeBehavior);
      setSoftwareAutostartDraft(softwareSettings.autostartEnabled);
      setSoftwareStartCoreDraft(softwareSettings.startCoreOnLaunch);
      setSoftwareSilentStartDraft(softwareSettings.silentStartEnabled);
      setSoftwareDefaultTerminalDraft(softwareSettings.defaultTerminal);
      setSoftwareSavedStatusVisible(false);
      showNotice(t('config.error.saveFailed', { error: String(error) }), 'error');
      void loadSoftwareSettings();
    } finally {
      setBusyAction(null);
    }
  };

  const controlsDisabled = loading || settings === null || busyAction !== null;
  const networkSettingsDirty = Boolean(settings) && (
    hostDraft.trim() !== settings?.host
    || portDraft !== String(settings?.port)
    || proxyUrlDraft.trim() !== settings?.proxyUrl
  );
  const sessionRoutingDirty = Boolean(settings) && (
    sessionAffinityDraft !== settings?.routingSessionAffinity
    || sessionTtlDraft.trim() !== settings?.routingSessionAffinityTtl
  );
  const retrySettingsDirty = Boolean(settings) && (
    disableCoolingDraft !== settings?.disableCooling
    || requestRetryDraft !== String(settings?.requestRetry)
    || maxRetryCredentialsDraft !== String(settings?.maxRetryCredentials)
    || maxRetryIntervalDraft !== String(settings?.maxRetryInterval)
    || streamingBootstrapRetriesDraft !== String(settings?.streamingBootstrapRetries)
  );
  const softwareCloseBehaviorDirty = softwareSettings !== null
    && softwareCloseBehaviorDraft !== softwareSettings.closeBehavior;
  const softwareAutostartDirty = softwareSettings !== null
    && softwareAutostartDraft !== softwareSettings.autostartEnabled;
  const softwareSilentStartDirty = softwareSettings !== null
    && softwareSilentStartDraft !== softwareSettings.silentStartEnabled;
  const softwareStartCoreDirty = softwareSettings !== null
    && softwareStartCoreDraft !== softwareSettings.startCoreOnLaunch;
  const softwareDefaultTerminalDirty = softwareSettings !== null
    && softwareDefaultTerminalDraft !== softwareSettings.defaultTerminal;
  const softwareSettingsDirty = softwareCloseBehaviorDirty
    || softwareAutostartDirty
    || softwareStartCoreDirty
    || softwareSilentStartDirty
    || softwareDefaultTerminalDirty;
  const softwareStatusLabel = softwareSettingsLoading
    ? t('common.loading')
    : softwareSettings === null
      ? t('common.unavailable')
      : softwareSettingsDirty
        ? t('config.network.unsaved')
        : softwareSavedStatusVisible
          ? t('config.network.saved')
          : '';
  const softwareStatusIsSaved = !softwareSettingsLoading
    && softwareSettings !== null
    && !softwareSettingsDirty
    && softwareSavedStatusVisible;
  const tlsSettingsDirty = tlsSettings !== null && (
    tlsEnabledDraft !== tlsSettings.enabled
    || tlsCertDraft.trim() !== tlsSettings.cert
    || tlsKeyDraft.trim() !== tlsSettings.key
  );
  const tlsStatusLabel = tlsSettingsLoading
    ? t('common.loading')
    : tlsSettings === null
      ? t('common.unavailable')
      : tlsSettingsDirty
        ? t('config.network.unsaved')
        : tlsSavedStatusVisible
          ? t('config.network.saved')
          : '';
  const tlsStatusIsSaved = !tlsSettingsLoading
    && tlsSettings !== null
    && !tlsSettingsDirty
    && tlsSavedStatusVisible;
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
          id="config-subpage-tab-routing"
          role="tab"
          className={activeSubpage === 'routing' ? 'active' : ''}
          aria-selected={activeSubpage === 'routing'}
          aria-controls="config-subpage-panel-routing"
          tabIndex={activeSubpage === 'routing' ? 0 : -1}
          onClick={() => setActiveSubpage('routing')}
        >
          {t('config.tabs.routing')}
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
        <button
          type="button"
          id="config-subpage-tab-software"
          role="tab"
          className={activeSubpage === 'software' ? 'active' : ''}
          aria-selected={activeSubpage === 'software'}
          aria-controls="config-subpage-panel-software"
          tabIndex={activeSubpage === 'software' ? 0 : -1}
          onClick={() => setActiveSubpage('software')}
        >
          {t('config.tabs.software')}
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
                title={settings ? webUiManagementUrl(settings.port, tlsSettings?.enabled, settings.host) : undefined}
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
      ) : activeSubpage === 'network' || activeSubpage === 'routing' ? (
        <div
          className="config-subpage-panel config-network-subpage"
          id={`config-subpage-panel-${activeSubpage}`}
          role="tabpanel"
          aria-labelledby={`config-subpage-tab-${activeSubpage}`}
        >
      <div className="config-network-panel">
        <div className="config-network-sections">
          <section
            className="config-network-section"
            aria-labelledby="config-network-section-title"
            hidden={activeSubpage !== 'network'}
          >
            <div className="config-network-section-heading config-section-heading-with-actions">
              <div className="config-network-section-title">
                <Network size={16} aria-hidden="true" />
                <h3 id="config-network-section-title">{t('config.network.networkSection')}</h3>
              </div>
              <button
                type="button"
                className="primary-button compact-button"
                disabled={controlsDisabled || !networkSettingsDirty}
                onClick={() => void saveNetworkEndpointSettings()}
              >
                <Check size={16} aria-hidden="true" />
                {busyAction === 'network' ? t('common.saving') : t('config.network.confirmSave')}
              </button>
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
                markDraftDirty('port');
                setPortDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 5));
                setPortError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && settings) {
                  clearDraftDirty('port');
                  setPortDraft(String(settings.port));
                  setPortError('');
                  event.currentTarget.blur();
                }
              }}
            />
            <small>{t('config.network.portHint')}</small>
              </label>

              <label className="config-network-field">
                <span>{t('config.network.listenHost')}</span>
                <input
                  className={`config-network-input ${hostError ? 'error' : ''}`}
                  type="text"
                  value={hostDraft}
                  disabled={controlsDisabled}
                  placeholder="127.0.0.1"
                  aria-invalid={Boolean(hostError)}
                  title={hostError || t('config.network.listenHostHint')}
                  onChange={(event) => {
                    markDraftDirty('host');
                    setHostDraft(event.currentTarget.value);
                    setHostError('');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      clearDraftDirty('host');
                      setHostDraft(settings.host);
                      setHostError('');
                      event.currentTarget.blur();
                    }
                  }}
                />
                <small>{t('config.network.listenHostHint')}</small>
              </label>

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
                    markDraftDirty('proxyUrl');
                    setProxyUrlDraft(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      clearDraftDirty('proxyUrl');
                      setProxyUrlDraft(settings.proxyUrl);
                      event.currentTarget.blur();
                    }
                  }}
                />
                <small>{t('config.network.proxyHint')}</small>
              </label>
            </div>
          </section>

          <section
            className="config-network-section"
            aria-labelledby="config-routing-section-title"
            hidden={activeSubpage !== 'routing'}
          >
            <div className="config-network-section-heading config-section-heading-with-actions">
              <div className="config-network-section-title">
                <Route size={16} aria-hidden="true" />
                <h3 id="config-routing-section-title">{t('config.network.routingSection')}</h3>
              </div>
              <button
                type="button"
                className="primary-button compact-button"
                disabled={controlsDisabled || !sessionRoutingDirty}
                onClick={() => void saveSessionRoutingSettings()}
              >
                <Check size={16} aria-hidden="true" />
                {busyAction === 'routing' ? t('common.saving') : t('config.network.confirmSave')}
              </button>
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
                      markDraftDirty('sessionAffinity');
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
                    markDraftDirty('sessionTtl');
                    setSessionTtlDraft(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      clearDraftDirty('sessionTtl');
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

          <section
            className="config-network-section"
            aria-labelledby="config-retry-section-title"
            hidden={activeSubpage !== 'network'}
          >
            <div className="config-network-section-heading config-section-heading-with-actions">
              <div className="config-network-section-title">
                <RefreshCw size={16} aria-hidden="true" />
                <h3 id="config-retry-section-title">{t('config.network.retrySection')}</h3>
              </div>
              <button
                type="button"
                className="primary-button compact-button"
                disabled={controlsDisabled || !retrySettingsDirty}
                onClick={() => void saveRetrySettings()}
              >
                <Check size={16} aria-hidden="true" />
                {busyAction === 'retry' ? t('common.saving') : t('config.network.confirmSave')}
              </button>
            </div>
            <div className="config-network-grid">
              <div className="config-network-field config-network-toggle">
                <div>
                  <span>{t('config.network.disableCooling')}</span>
                  <small>{t('config.network.disableCoolingHint')}</small>
                </div>
                <label className="switch-control" title={t('config.network.disableCooling')}>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={t('config.network.disableCooling')}
                    checked={disableCoolingDraft}
                    disabled={controlsDisabled}
                    onChange={(event) => {
                      markDraftDirty('disableCooling');
                      setDisableCoolingDraft(event.currentTarget.checked);
                    }}
                  />
                  <span className="switch-track" />
                </label>
              </div>

              <label className="config-network-field">
                <span>{t('config.network.requestRetry')}</span>
                <input
                  className={`config-network-input ${retryError ? 'error' : ''}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={10}
                  value={requestRetryDraft}
                  disabled={controlsDisabled}
                  aria-invalid={Boolean(retryError)}
                  onChange={(event) => {
                    markDraftDirty('requestRetry');
                    setRequestRetryDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 10));
                    setRetryError('');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      clearDraftDirty('requestRetry');
                      setRequestRetryDraft(String(settings.requestRetry));
                      setRetryError('');
                      event.currentTarget.blur();
                    }
                  }}
                />
                <small>{t('config.network.requestRetryHint')}</small>
              </label>

              <label className="config-network-field">
                <span>{t('config.network.maxRetryCredentials')}</span>
                <input
                  className={`config-network-input ${retryError ? 'error' : ''}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={10}
                  value={maxRetryCredentialsDraft}
                  disabled={controlsDisabled}
                  aria-invalid={Boolean(retryError)}
                  onChange={(event) => {
                    markDraftDirty('maxRetryCredentials');
                    setMaxRetryCredentialsDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 10));
                    setRetryError('');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      clearDraftDirty('maxRetryCredentials');
                      setMaxRetryCredentialsDraft(String(settings.maxRetryCredentials));
                      setRetryError('');
                      event.currentTarget.blur();
                    }
                  }}
                />
                <small>{t('config.network.maxRetryCredentialsHint')}</small>
              </label>

              <label className="config-network-field">
                <span>{t('config.network.maxRetryInterval')}</span>
                <input
                  className={`config-network-input ${retryError ? 'error' : ''}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={10}
                  value={maxRetryIntervalDraft}
                  disabled={controlsDisabled}
                  aria-invalid={Boolean(retryError)}
                  onChange={(event) => {
                    markDraftDirty('maxRetryInterval');
                    setMaxRetryIntervalDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 10));
                    setRetryError('');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      clearDraftDirty('maxRetryInterval');
                      setMaxRetryIntervalDraft(String(settings.maxRetryInterval));
                      setRetryError('');
                      event.currentTarget.blur();
                    }
                  }}
                />
                <small>{t('config.network.maxRetryIntervalHint')}</small>
              </label>

              <label className="config-network-field">
                <span>{t('config.network.streamingBootstrapRetries')}</span>
                <input
                  className={`config-network-input ${retryError ? 'error' : ''}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={10}
                  value={streamingBootstrapRetriesDraft}
                  disabled={controlsDisabled}
                  aria-invalid={Boolean(retryError)}
                  onChange={(event) => {
                    markDraftDirty('streamingBootstrapRetries');
                    setStreamingBootstrapRetriesDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 10));
                    setRetryError('');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && settings) {
                      clearDraftDirty('streamingBootstrapRetries');
                      setStreamingBootstrapRetriesDraft(String(settings.streamingBootstrapRetries));
                      setRetryError('');
                      event.currentTarget.blur();
                    }
                  }}
                />
                <small>{t('config.network.streamingBootstrapRetriesHint')}</small>
              </label>
            </div>
          </section>
          <section
            className="config-network-section"
            aria-labelledby="config-tls-section-title"
            hidden={activeSubpage !== 'network'}
          >
          <div className="config-network-section-heading config-tls-section-heading">
            <div className="config-tls-section-title">
              <LockKeyhole size={18} aria-hidden="true" />
              <h3 id="config-tls-section-title">{t('config.tls.enable')}</h3>
            </div>
            <div className="config-heading-actions">
              {tlsStatusLabel ? (
                <span className={`state-pill ${tlsStatusIsSaved ? 'success' : ''}`}>
                  {tlsStatusLabel}
                </span>
              ) : null}
              <button
                type="button"
                className="primary-button compact-button"
                disabled={tlsSettingsLoading || tlsSettings === null || busyAction !== null || tlsFileSelecting !== null || !tlsSettingsDirty}
                onClick={() => void saveTlsSettings()}
              >
                <Check size={16} aria-hidden="true" />
                {busyAction === 'tls' ? t('common.saving') : t('config.network.confirmSave')}
              </button>
            </div>
          </div>

          <div className="config-tls-content">
            <div className="config-software-setting-row config-tls-toggle-row">
              <div className="config-software-setting-copy">
                <span className="config-software-setting-icon" aria-hidden="true">
                  <ShieldCheck size={18} />
                </span>
                <div>
                  <strong>{t('config.tls.enable')}</strong>
                  <small>{t('config.tls.enableDescription')}</small>
                </div>
              </div>
              <label className="switch-control" title={t('config.tls.enable')}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={t('config.tls.enable')}
                  checked={tlsEnabledDraft}
                  disabled={tlsSettingsLoading || tlsSettings === null || busyAction !== null}
                  onChange={(event) => {
                    setTlsSavedStatusVisible(false);
                    setTlsError('');
                    setTlsEnabledDraft(event.currentTarget.checked);
                  }}
                />
                <span className="switch-track" />
              </label>
            </div>

            {tlsEnabledDraft ? (
              <div className="config-tls-fields">
                <div className="config-network-field">
                  <span>{t('config.tls.cert')}</span>
                  <div className="config-tls-path-control">
                    <input
                      className={`config-network-input ${tlsError && !tlsCertDraft.trim() ? 'error' : ''}`}
                      type="text"
                      value={tlsCertDraft}
                      aria-label={t('config.tls.cert')}
                      disabled={tlsSettingsLoading || tlsSettings === null || busyAction !== null || tlsFileSelecting !== null}
                      placeholder={t('config.tls.certPlaceholder')}
                      onChange={(event) => {
                        setTlsSavedStatusVisible(false);
                        setTlsError('');
                        setTlsCertDraft(event.currentTarget.value);
                      }}
                    />
                    <button
                      type="button"
                      className="secondary-button compact-button config-tls-browse-button"
                      disabled={tlsSettingsLoading || tlsSettings === null || busyAction !== null || tlsFileSelecting !== null}
                      title={t('config.tls.selectCertTitle')}
                      onClick={() => void selectTlsFile('cert')}
                    >
                      <FolderOpen size={16} aria-hidden="true" />
                      {tlsFileSelecting === 'cert' ? t('common.processing') : t('config.tls.browse')}
                    </button>
                  </div>
                  <small>{t('config.tls.certHint')}</small>
                </div>
                <div className="config-network-field">
                  <span>{t('config.tls.key')}</span>
                  <div className="config-tls-path-control">
                    <input
                      className={`config-network-input ${tlsError && !tlsKeyDraft.trim() ? 'error' : ''}`}
                      type="text"
                      value={tlsKeyDraft}
                      aria-label={t('config.tls.key')}
                      disabled={tlsSettingsLoading || tlsSettings === null || busyAction !== null || tlsFileSelecting !== null}
                      placeholder={t('config.tls.keyPlaceholder')}
                      onChange={(event) => {
                        setTlsSavedStatusVisible(false);
                        setTlsError('');
                        setTlsKeyDraft(event.currentTarget.value);
                      }}
                    />
                    <button
                      type="button"
                      className="secondary-button compact-button config-tls-browse-button"
                      disabled={tlsSettingsLoading || tlsSettings === null || busyAction !== null || tlsFileSelecting !== null}
                      title={t('config.tls.selectKeyTitle')}
                      onClick={() => void selectTlsFile('key')}
                    >
                      <FolderOpen size={16} aria-hidden="true" />
                      {tlsFileSelecting === 'key' ? t('common.processing') : t('config.tls.browse')}
                    </button>
                  </div>
                  <small>{t('config.tls.keyHint')}</small>
                </div>
              </div>
            ) : null}

            <div className={`config-tls-message ${tlsError ? 'error' : ''}`} role={tlsError ? 'alert' : undefined}>
              {tlsError || t('config.tls.restartHint')}
            </div>
          </div>
        </section>
        </div>
      </div>
        </div>
      ) : activeSubpage === 'software' ? (
        <div
          className="config-subpage-panel"
          id="config-subpage-panel-software"
          role="tabpanel"
          aria-labelledby="config-subpage-tab-software"
        >
          <section className="panel config-software-panel">
            <div className="config-panel-heading">
              <div className="config-heading-title">
                <Settings2 size={18} aria-hidden="true" />
                <h2>{t('config.software.title')}</h2>
              </div>
              <div className="config-heading-actions">
                {softwareStatusLabel ? (
                  <span className={`state-pill ${softwareStatusIsSaved ? 'success' : ''}`}>
                    {softwareStatusLabel}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="primary-button compact-button"
                  disabled={softwareSettingsLoading || softwareSettings === null || busyAction !== null || !softwareSettingsDirty}
                  onClick={() => void saveSoftwareSettings()}
                >
                  <Check size={16} aria-hidden="true" />
                  {busyAction === 'software' ? t('common.saving') : t('config.network.confirmSave')}
                </button>
              </div>
            </div>
            <div className="config-software-content">
              <div className="config-software-settings-list">
                <div className="config-software-setting-row">
                  <div className="config-software-setting-copy">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <Clock3 size={18} />
                    </span>
                    <div>
                      <strong>{t('config.software.autostart')}</strong>
                      <small>{t('config.software.autostartDescription')}</small>
                    </div>
                  </div>
                  <label className="switch-control" title={t('config.software.autostart')}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={t('config.software.autostart')}
                      checked={softwareAutostartDraft}
                      disabled={softwareSettingsLoading || softwareSettings === null || busyAction !== null}
                      onChange={(event) => {
                        setSoftwareSavedStatusVisible(false);
                        setSoftwareAutostartDraft(event.currentTarget.checked);
                      }}
                    />
                    <span className="switch-track" />
                  </label>
                </div>
                <div className="config-software-setting-row">
                  <div className="config-software-setting-copy">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <Power size={18} />
                    </span>
                    <div>
                      <strong>{t('config.software.startCoreOnLaunch')}</strong>
                      <small>{t('config.software.startCoreOnLaunchDescription')}</small>
                    </div>
                  </div>
                  <label className="switch-control" title={t('config.software.startCoreOnLaunch')}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={t('config.software.startCoreOnLaunch')}
                      checked={softwareStartCoreDraft}
                      disabled={softwareSettingsLoading || softwareSettings === null || busyAction !== null}
                      onChange={(event) => {
                        setSoftwareSavedStatusVisible(false);
                        setSoftwareStartCoreDraft(event.currentTarget.checked);
                      }}
                    />
                    <span className="switch-track" />
                  </label>
                </div>
                <div className="config-software-setting-row">
                  <div className="config-software-setting-copy">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <EyeOff size={18} />
                    </span>
                    <div>
                      <strong>{t('config.software.silentStart')}</strong>
                      <small>{t('config.software.silentStartDescription')}</small>
                    </div>
                  </div>
                  <label className="switch-control" title={t('config.software.silentStart')}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={t('config.software.silentStart')}
                      checked={softwareSilentStartDraft}
                      disabled={softwareSettingsLoading || softwareSettings === null || busyAction !== null}
                      onChange={(event) => {
                        setSoftwareSavedStatusVisible(false);
                        setSoftwareSilentStartDraft(event.currentTarget.checked);
                      }}
                    />
                    <span className="switch-track" />
                  </label>
                </div>
                <div className="config-software-setting-row config-software-close-row">
                  <div className="config-software-setting-copy">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <Terminal size={18} />
                    </span>
                    <div>
                      <strong>{t('config.software.defaultTerminal')}</strong>
                      <small>{t('config.software.defaultTerminalDescription')}</small>
                    </div>
                  </div>
                  <label className="config-software-select">
                    <span className="sr-only">{t('config.software.defaultTerminal')}</span>
                    <select
                      className="config-network-input"
                      value={softwareDefaultTerminalDraft}
                      disabled={softwareSettingsLoading || softwareSettings === null || busyAction !== null}
                      onChange={(event) => {
                        setSoftwareSavedStatusVisible(false);
                        setSoftwareDefaultTerminalDraft(event.currentTarget.value);
                      }}
                    >
                      {(softwareSettings?.availableTerminals ?? []).map((terminal) => (
                        <option value={terminal.id} key={terminal.id}>
                          {terminal.id === 'auto' ? t('config.software.terminal.auto') : terminal.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="config-software-setting-row config-software-close-row">
                  <div className="config-software-setting-copy">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <X size={18} />
                    </span>
                    <div>
                      <strong>{t('config.software.closeBehavior')}</strong>
                      <small>{t('config.software.closeBehaviorDescription')}</small>
                    </div>
                  </div>
                  <label className="config-software-select">
                    <span className="sr-only">{t('config.software.closeBehavior')}</span>
                    <select
                      className="config-network-input"
                      value={softwareCloseBehaviorDraft}
                      disabled={softwareSettingsLoading || softwareSettings === null || busyAction !== null}
                      onChange={(event) => {
                        setSoftwareSavedStatusVisible(false);
                        setSoftwareCloseBehaviorDraft(event.currentTarget.value as CloseBehavior);
                      }}
                    >
                      <option value="ask">{t('config.software.behavior.ask')}</option>
                      <option value="minimize-to-tray">{t('config.software.behavior.minimize')}</option>
                      <option value="exit">{t('config.software.behavior.exit')}</option>
                    </select>
                  </label>
                </div>
              </div>
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
