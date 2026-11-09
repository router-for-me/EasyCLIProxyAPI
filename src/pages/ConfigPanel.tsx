import { Notice } from '../components/Notice';
import { EmptyState } from '../components/EmptyState';
import { Switch } from '../components/Switch';
import { onConfigFilesChanged } from '../services/events';
import { restartCoreProcess } from '../services/coreLifecycle';
import { openExternalUrl } from '../services/appSettings';
import { pollWhileActive } from '../services/windowActivity';
import {
  getCoreConfigSettings,
  getSoftwareSettings,
  getCoreTlsSettings,
  setCoreManagementSecretKey,
  clearCoreManagementSecretKey,
  updateCoreApiKey,
  addCoreApiKey,
  saveCoreLoggingSettings as saveCoreLoggingSettingsCommand,
  openCoreLogsDirectory,
  deleteCoreApiKey,
  saveCoreTlsSettings,
  setCoreRoutingStrategy,
  saveNetworkEndpointSettings as saveNetworkEndpointSettingsCommand,
  saveRetrySettings as saveRetrySettingsCommand,
  saveSessionRoutingSettings as saveSessionRoutingSettingsCommand,
  saveSoftwareSettings as saveSoftwareSettingsCommand,
} from '../services/coreSettings';
import type { CoreConfigSettings, CoreApiKey, SoftwareSettings, CloseBehavior, CoreTlsSettings } from '../services/coreSettings';
import {
  getReverseProxyState,
  applyReverseProxyConfig,
  reverseProxyPathErrors,
  type ReverseProxyConfig,
  type ReverseProxyPathField,
  type ReverseProxyState,
} from '../services/reverseProxy';
import { CoolingToggle } from '../components/settings/CoolingToggle';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { open } from '../services/platform';
import {
  AlertCircle,
  ArrowRight,
  Search,
  ChevronRight,
  Bug,
  Check,
  Copy,
  Clock3,
  Database,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Gauge,
  HardDrive,
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
  Power,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import { MessageNotice, FloatingNotice, useAppNotice } from '../appNotice';
import { webUiManagementUrl } from '../services/clientAccess';
import { ThinkingAliasesPage } from './ThinkingAliasesPage';
import { SensitiveWordsPage } from './SensitiveWordsPage';
import { Tabs } from '../components/Tabs';
import { SegmentedControl } from '../components/SegmentedControl';
import { Dialog } from '../components/Dialog';
import { useConfirmation } from '../components/ConfirmationDialog';
import { TemplateConfigSection } from '../components/TemplateConfigSection';
import { SettingsHelp } from '../components/SettingsHelp';
import { templateMessages, templateText } from '../i18n/templateConfig';
import {
  settingsCategories, settingsTemplateGroups,
  allSettingsTemplateGroups, settingsMessages, takeRequestedSettingField, type SettingsCategory,
  getLanIpv4, resolveReverseProxySaveConfig,
} from '../services/settingsNavigation';
import { Select } from '../components/Select';

type ConfigAction =
  | 'add-key'
  | 'update-key'
  | 'delete-key'
  | 'management-secret'
  | 'logging'
  | 'open-logs'
  | 'routing'
  | 'network'
  | 'retry'
  | 'tls'
  | 'software'
  | null;
type ConfigSubpage = SettingsCategory;
type SettingDestination = { category: ConfigSubpage; target: string; field?: string };
type SettingSearchEntry = SettingDestination & { title: string; context: string; keywords: string };

type NetworkDraftField =
  | 'port'
  | 'host'
  | 'proxyUrl'
  | 'proxyOverride'
  | 'sessionAffinity'
  | 'sessionTtl'
  | 'disableCooling'
  | 'requestRetry'
  | 'maxRetryCredentials'
  | 'maxRetryInterval'
  | 'streamingBootstrapRetries';
type DraftRefreshMode = 'replace' | 'preserve';

type NetworkDraftDirty = Record<NetworkDraftField, boolean>;

const cleanNetworkDraft = (): NetworkDraftDirty => ({
  port: false,
  host: false,
  proxyUrl: false,
  proxyOverride: false,
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
  { value: 'weighted-round-robin', labelKey: 'config.routing.roundRobin' },
  { value: 'fill-first', labelKey: 'config.routing.fillFirst' },
] as const;

const SESSION_TTL_PATTERN = /^(\d+(?:\.\d+)?(?:ms|s|m|h))+$/;

const DEFAULT_REVERSE_PROXY_DRAFT: ReverseProxyConfig = {
  enabled: false,
  listenHost: '0.0.0.0',
  listenPort: 443,
  targetPort: 8317,
  certPath: '',
  keyPath: '',
};

const isValidPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535;

type ReverseProxyFieldError = Partial<Record<'listenPort' | 'targetPort' | 'certPath' | 'keyPath', string>>;

export function ConfigPanelPage() {
  const { t, locale } = useI18n();
  const { askConfirmation, confirmationDialog } = useConfirmation();
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
  const [debugDraft, setDebugDraft] = useState(false);
  const [commercialModeDraft, setCommercialModeDraft] = useState(false);
  const [loggingToFileDraft, setLoggingToFileDraft] = useState(false);
  const [logsMaxTotalSizeDraft, setLogsMaxTotalSizeDraft] = useState('0');
  const [errorLogsMaxFilesDraft, setErrorLogsMaxFilesDraft] = useState('10');
  const [usageStatisticsDraft, setUsageStatisticsDraft] = useState(true);
  const [redisUsageRetentionDraft, setRedisUsageRetentionDraft] = useState('60');
  const [loggingError, setLoggingError] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const keyFeedback = useAppNotice();
  const managementFeedback = useAppNotice();
  const loggingFeedback = useAppNotice();
  const networkFeedback = useAppNotice();
  const routingFeedback = useAppNotice();
  const retryFeedback = useAppNotice();
  const tlsFeedback = useAppNotice();
  const proxyFeedback = useAppNotice();
  const softwareFeedback = useAppNotice();
  const renderFeedback = (feedback: ReturnType<typeof useAppNotice>) => (
    <FloatingNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
  );
  const [activeSubpage, setActiveSubpage] = useState<ConfigSubpage>('general');
  const [settingsSearch, setSettingsSearch] = useState('');
  const [dirtyTemplateGroups, setDirtyTemplateGroups] = useState<readonly string[]>([]);
  const [sensitiveWordsDirty, setSensitiveWordsDirty] = useState(false);
  const [sensitiveWordsVisited, setSensitiveWordsVisited] = useState(false);
  const [aliasesVisited, setAliasesVisited] = useState(false);
  const [pendingDestination, setPendingDestination] = useState<SettingDestination | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const categoryNavigationRef = useRef<HTMLDivElement>(null);
  const st = (key: keyof typeof settingsMessages) => templateText(settingsMessages[key], locale);
  const searching = settingsSearch.trim().length > 0;

  useEffect(() => {
    const navigation = categoryNavigationRef.current;
    const tab = document.getElementById(`config-subpage-tab-${activeSubpage}`);
    if (!navigation || !tab) return;
    const revealSelectedTab = () => {
      const bounds = navigation.getBoundingClientRect();
      const tabBounds = tab.getBoundingClientRect();
      if (tabBounds.left < bounds.left) navigation.scrollLeft += tabBounds.left - bounds.left;
      else if (tabBounds.right > bounds.right) navigation.scrollLeft += tabBounds.right - bounds.right;
    };
    revealSelectedTab();
    const observer = new ResizeObserver(revealSelectedTab);
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [activeSubpage]);

  useEffect(() => {
    const focusSearchFromKeyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const isSlash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey;
      const isShortcutK = event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey;
      if (!isSlash && !isShortcutK) return;
      const target = event.target;
      const typingElsewhere = target instanceof HTMLElement
        && target.closest('input, textarea, select, [contenteditable="true"]')
        && !(isShortcutK && target === searchRef.current);
      if (typingElsewhere) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', focusSearchFromKeyboard);
    return () => window.removeEventListener('keydown', focusSearchFromKeyboard);
  }, []);

  useEffect(() => {
    if (!pendingDestination) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(pendingDestination.field ?? pendingDestination.target)
        ?? document.getElementById(pendingDestination.target);
      if (target) {
        const details = target.closest<HTMLDetailsElement>('.template-config-custom') ?? target.querySelector<HTMLDetailsElement>('.template-config-custom');
        if (details) details.open = true;
        target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        const control = target.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')
          ?? target.querySelector<HTMLElement>('.template-config-custom > summary');
        (control ?? target).focus({ preventScroll: true });
      }
      setPendingDestination(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingDestination]);
  const [portDraft, setPortDraft] = useState('8317');
  const [hostDraft, setHostDraft] = useState('127.0.0.1');
  const [proxyUrlDraft, setProxyUrlDraft] = useState('');
  const [proxyOverrideDraft, setProxyOverrideDraft] = useState(false);
  const [sessionAffinityDraft, setSessionAffinityDraft] = useState(false);
  const [sessionTtlDraft, setSessionTtlDraft] = useState('');
  const [disableCoolingDraft, setDisableCoolingDraft] = useState(true);
  const [requestRetryDraft, setRequestRetryDraft] = useState('3');
  const [maxRetryCredentialsDraft, setMaxRetryCredentialsDraft] = useState('0');
  const [maxRetryIntervalDraft, setMaxRetryIntervalDraft] = useState('30');
  const [streamingBootstrapRetriesDraft, setStreamingBootstrapRetriesDraft] = useState('0');
  const [portError, setPortError] = useState('');
  const [hostError, setHostError] = useState('');
  const [proxyUrlError, setProxyUrlError] = useState('');
  const [sessionTtlError, setSessionTtlError] = useState('');
  const [proxyFieldErrors, setProxyFieldErrors] = useState<ReverseProxyFieldError>({});
  const [retryError, setRetryError] = useState('');
  const networkDraftDirtyRef = useRef<NetworkDraftDirty>(cleanNetworkDraft());
  const loggingDraftDirtyRef = useRef(false);
  const otherDraftDirtyRef = useRef({ software: false, tls: false });
  const copyTimerRef = useRef<number | null>(null);

  const [proxyState, setProxyState] = useState<ReverseProxyState | null>(null);
  const [proxyInitialLoading, setProxyInitialLoading] = useState(true);
  const [proxyAction, setProxyAction] = useState<'start' | 'stop' | 'save' | null>(null);
  const [proxyDirty, setProxyDirty] = useState(false);
  const [backendNotReady, setBackendNotReady] = useState(false);
  const [proxyFileSelecting, setProxyFileSelecting] = useState<'cert' | 'key' | null>(null);
  const proxyFileSelectingRef = useRef(false);
  const [proxyDraft, setProxyDraft] = useState<ReverseProxyConfig>(DEFAULT_REVERSE_PROXY_DRAFT);
  const [proxyLanIp, setProxyLanIp] = useState<string | null>(null);

  const loadReverseProxy = async () => {
    setProxyInitialLoading(true);
    try {
      const [state, lanIp] = await Promise.all([
        getReverseProxyState(),
        getLanIpv4().catch(() => null),
      ]);
      setProxyState(state);
      setProxyLanIp(lanIp);
      if (state.config) {
        setProxyDraft({ ...DEFAULT_REVERSE_PROXY_DRAFT, ...state.config });
      }
      setBackendNotReady(false);
    } catch (error) {
      setBackendNotReady(true);
      proxyFeedback.showNotice(String(error), 'error');
    } finally {
      setProxyInitialLoading(false);
    }
  };

  const validateReverseProxyDraft = (draft: ReverseProxyConfig): ReverseProxyFieldError => {
    const errors: ReverseProxyFieldError = {};
    // Ports stay validated while disabled so an already stopped proxy reports
    // field errors instead of silently discarding an unusable draft.
    if (!isValidPort(draft.listenPort)) {
      errors.listenPort = t('config.error.portRange');
    }
    if (!isValidPort(draft.targetPort)) {
      errors.targetPort = t('config.error.portRange');
    }
    if (draft.enabled) {
      if (!draft.certPath.trim()) errors.certPath = t('config.error.reverseProxyPathsRequired');
      if (!draft.keyPath.trim()) errors.keyPath = t('config.error.reverseProxyPathsRequired');
    }
    return errors;
  };

  const clearProxyFieldError = (field: keyof ReverseProxyFieldError) => {
    setProxyFieldErrors(prev => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const handleProxyToggle = (enabled: boolean) => {
    if (proxyControlsDisabled) return;
    setProxyDraft(prev => ({ ...prev, enabled }));
    setProxyDirty(true);
    if (!enabled) setProxyFieldErrors({});
  };

  const updateProxyPath = (field: ReverseProxyPathField, value: string) => {
    if (proxyFileSelectingRef.current) return;
    setProxyDraft(prev => ({ ...prev, [field]: value }));
    setProxyDirty(true);
    try {
      const errors = validateReverseProxyDraft({ ...proxyDraft, [field]: value });
      setProxyFieldErrors(prev => ({ ...prev, [field]: errors[field] }));
    } catch (error) {
      setProxyFieldErrors(prev => ({ ...prev, [field]: String(error) }));
    }
  };

  const handleProxySave = async () => {
    if (proxyControlsDisabled || proxyFileSelectingRef.current) return;
    const normalizedDraft = {
      ...proxyDraft,
      listenHost: proxyDraft.listenHost.trim() || '0.0.0.0',
      certPath: proxyDraft.certPath.trim(),
      keyPath: proxyDraft.keyPath.trim(),
    };
    proxyFeedback.clearNotice();
    const saveConfig = resolveReverseProxySaveConfig(normalizedDraft, proxyState?.config, proxyState?.running);
    const fieldErrors = validateReverseProxyDraft(saveConfig);
    setProxyFieldErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) {
      proxyFeedback.showNotice(Object.values(fieldErrors)[0], 'error');
      return;
    }
    setProxyDraft(saveConfig);
    setProxyAction('save');
    try {
      const state = await applyReverseProxyConfig(saveConfig);
      setProxyState(state);
      if (state.config) setProxyDraft(state.config);
      setBackendNotReady(false);
      setProxyDirty(false);
      proxyFeedback.showNotice(state.error || st('reverseProxySaved'), state.error ? 'error' : 'success');
    } catch (error) {
      setProxyFieldErrors(prev => ({ ...prev, ...reverseProxyPathErrors(error) }));
      proxyFeedback.showNotice(String(error), 'error');
      try {
        setProxyState(await getReverseProxyState());
        setBackendNotReady(false);
      } catch {
        setBackendNotReady(true);
      }
    } finally {
      setProxyAction(null);
    }
  };

  const selectProxyFile = async (target: 'cert' | 'key') => {
    if (proxyControlsDisabled || proxyFileSelectingRef.current) return;
    proxyFileSelectingRef.current = true;
    setProxyFileSelecting(target);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: target === 'cert'
          ? st('reverseProxySelectCertTitle')
          : st('reverseProxySelectKeyTitle'),
        filters: [{
          name: target === 'cert' ? st('reverseProxyCertFile') : st('reverseProxyKeyFile'),
          extensions: target === 'cert' ? ['pem', 'crt', 'cer'] : ['pem', 'key'],
        }],
      });
      if (typeof selected !== 'string') return;
      if (target === 'cert') {
        setProxyDraft(prev => ({ ...prev, certPath: selected }));
      } else {
        setProxyDraft(prev => ({ ...prev, keyPath: selected }));
      }
      setProxyDirty(true);
      clearProxyFieldError(target === 'cert' ? 'certPath' : 'keyPath');
    } catch (error) {
      const message = t('config.tls.error.selectFileFailed', { error: String(error) });
      setProxyFieldErrors(prev => ({ ...prev, [target === 'cert' ? 'certPath' : 'keyPath']: message }));
      proxyFeedback.showNotice(message, 'error');
    } finally {
      proxyFileSelectingRef.current = false;
      setProxyFileSelecting(null);
    }
  };

  useEffect(() => {
    if (activeSubpage !== 'proxy' || proxyAction !== null || proxyInitialLoading) return;
    let disposed = false;
    const stopPolling = pollWhileActive(() => {
      void getReverseProxyState().then(state => {
        if (!disposed) setProxyState(state);
      }).catch(error => {
        if (!disposed) proxyFeedback.showNotice(String(error), 'error');
      });
    }, 2000);
    return () => {
      disposed = true;
      stopPolling();
    };
  }, [activeSubpage, proxyAction, proxyInitialLoading]);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void loadSettings();
    void loadSoftwareSettings();
    void loadTlsSettings();
    void loadReverseProxy();
    void onConfigFilesChanged(() => {
      if (!disposed) {
        void loadSettings('preserve');
        void loadSoftwareSettings('preserve');
        void loadTlsSettings('preserve');
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const applySettings = (result: CoreConfigSettings, mode: DraftRefreshMode = 'replace') => {
    setSettings(result);
    if (mode === 'preserve') {
      const dirty = networkDraftDirtyRef.current;
      if (!dirty.port) setPortDraft(String(result.port));
      if (!dirty.host) setHostDraft(result.host);
      if (!dirty.proxyUrl) setProxyUrlDraft(result.proxyUrl);
      if (!dirty.proxyOverride) setProxyOverrideDraft(result.proxyOverride);
      if (!dirty.sessionAffinity) setSessionAffinityDraft(result.routingSessionAffinity);
      if (!dirty.sessionTtl) setSessionTtlDraft(result.routingSessionAffinityTtl);
      if (!dirty.disableCooling) setDisableCoolingDraft(result.disableCooling);
      if (!dirty.requestRetry) setRequestRetryDraft(String(result.requestRetry));
      if (!dirty.maxRetryCredentials) setMaxRetryCredentialsDraft(String(result.maxRetryCredentials));
      if (!dirty.maxRetryInterval) setMaxRetryIntervalDraft(String(result.maxRetryInterval));
      if (!dirty.streamingBootstrapRetries) {
        setStreamingBootstrapRetriesDraft(String(result.streamingBootstrapRetries));
      }
      if (!loggingDraftDirtyRef.current) {
        setDebugDraft(result.debug);
        setCommercialModeDraft(result.commercialMode);
        setLoggingToFileDraft(result.loggingToFile);
        setLogsMaxTotalSizeDraft(String(result.logsMaxTotalSizeMb));
        setErrorLogsMaxFilesDraft(String(result.errorLogsMaxFiles));
        setUsageStatisticsDraft(result.usageStatisticsEnabled);
        setRedisUsageRetentionDraft(String(result.redisUsageQueueRetentionSeconds));
      }
      return;
    }
    networkDraftDirtyRef.current = cleanNetworkDraft();
    loggingDraftDirtyRef.current = false;
    setPortDraft(String(result.port));
    setHostDraft(result.host);
    setProxyUrlDraft(result.proxyUrl);
    setProxyOverrideDraft(result.proxyOverride);
    setSessionAffinityDraft(result.routingSessionAffinity);
    setSessionTtlDraft(result.routingSessionAffinityTtl);
    setDisableCoolingDraft(result.disableCooling);
    setRequestRetryDraft(String(result.requestRetry));
    setMaxRetryCredentialsDraft(String(result.maxRetryCredentials));
    setMaxRetryIntervalDraft(String(result.maxRetryInterval));
    setStreamingBootstrapRetriesDraft(String(result.streamingBootstrapRetries));
    setDebugDraft(result.debug);
    setCommercialModeDraft(result.commercialMode);
    setLoggingToFileDraft(result.loggingToFile);
    setLogsMaxTotalSizeDraft(String(result.logsMaxTotalSizeMb));
    setErrorLogsMaxFilesDraft(String(result.errorLogsMaxFiles));
    setUsageStatisticsDraft(result.usageStatisticsEnabled);
    setRedisUsageRetentionDraft(String(result.redisUsageQueueRetentionSeconds));
    setPortError('');
    setHostError('');
    setProxyUrlError('');
    setSessionTtlError('');
    setProxyFieldErrors({});
    setRetryError('');
    setLoggingError('');
  };

  const markLoggingDraftDirty = () => {
    loggingDraftDirtyRef.current = true;
    setLoggingError('');
  };

  const markDraftDirty = (field: NetworkDraftField) => {
    networkDraftDirtyRef.current[field] = true;
  };

  const clearDraftDirty = (field: NetworkDraftField) => {
    networkDraftDirtyRef.current[field] = false;
  };

  async function loadSettings(mode: DraftRefreshMode = 'replace') {
    if (mode === 'replace') setLoading(true);
    setLoadError('');
    try {
      const result = await getCoreConfigSettings();
      applySettings(result, mode);
    } catch (error) {
      setSettings(null);
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadSoftwareSettings(mode: DraftRefreshMode = 'replace') {
    if (mode === 'replace') {
      setSoftwareSettingsLoading(true);
      setSoftwareSavedStatusVisible(false);
    }
    try {
      const result = await getSoftwareSettings();
      if (mode === 'preserve' && otherDraftDirtyRef.current.software) return;
      setSoftwareSettings(result);
      setSoftwareCloseBehaviorDraft(result.closeBehavior);
      setSoftwareAutostartDraft(result.autostartEnabled);
      setSoftwareStartCoreDraft(result.startCoreOnLaunch);
      setSoftwareSilentStartDraft(result.silentStartEnabled);
      setSoftwareDefaultTerminalDraft(result.defaultTerminal);
    } catch (error) {
      setSoftwareSettings(null);
      softwareFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
    } finally {
      setSoftwareSettingsLoading(false);
    }
  }

  async function loadTlsSettings(mode: DraftRefreshMode = 'replace') {
    if (mode === 'replace') setTlsSettingsLoading(true);
    try {
      const result = await getCoreTlsSettings();
      if (mode === 'preserve' && otherDraftDirtyRef.current.tls) return;
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
    mutation: () => Promise<CoreConfigSettings>,
    successMessage: string,
  ) => {
    if (busyAction !== null) return false;
    setBusyAction(action);
    const mutationFeedback = action === 'management-secret'
      ? managementFeedback
      : action === 'routing' ? routingFeedback : keyFeedback;
    mutationFeedback.clearNotice();
    try {
      const result = await mutation();
      setSettings(result);
      setLoadError('');
      mutationFeedback.showNotice(successMessage, 'success');
      return true;
    } catch (error) {
      if (settings) setSettings(settings);
      mutationFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
      void loadSettings('preserve');
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const openAddDialog = () => {
    keyFeedback.clearNotice();
    setEditingApiKey(null);
    setNewApiKey('');
    setNewApiKeyRemark('');
    setShowApiKey(false);
    setFormError('');
    setAddDialogOpen(true);
  };

  const openEditDialog = (entry: CoreApiKey) => {
    keyFeedback.clearNotice();
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
      () => setCoreManagementSecretKey({ secretKey }),
      t('config.webuiKey.notice.updated'),
    );
    if (saved) {
      setManagementSecretDraft('');
      setManagementSecretConfirm('');
      setShowManagementSecret(false);
      setManagementSecretError('');
    }
  };

  const disableManagement = async () => {
    const confirmed = await askConfirmation({
      title: templateText(templateMessages.disableManagement, locale),
      message: templateText(templateMessages.disableManagementMessage, locale),
      confirmText: templateText(templateMessages.disableManagement, locale),
      variant: 'danger',
    });
    if (!confirmed) return;
    const saved = await runMutation('management-secret', () => clearCoreManagementSecretKey(), templateText(templateMessages.managementDisabled, locale));
    if (saved) { setManagementSecretDraft(''); setManagementSecretConfirm(''); setShowManagementSecret(false); setManagementSecretError(''); }
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
      () => editing
        ? updateCoreApiKey({ originalApiKey: editingApiKey!, apiKey, remark })
        : addCoreApiKey({ apiKey, remark }),
      editing ? t('config.notice.keyUpdated') : t('config.notice.keyAdded'),
    );
    if (saved) {
      setAddDialogOpen(false);
      setEditingApiKey(null);
      setNewApiKey('');
      setNewApiKeyRemark('');
    }
  };

  const saveCoreLoggingSettings = async () => {
    if (!settings || busyAction !== null) return;
    loggingFeedback.clearNotice();
    const logsMaxTotalSizeMb = Number(logsMaxTotalSizeDraft);
    const errorLogsMaxFiles = Number(errorLogsMaxFilesDraft);
    const redisUsageQueueRetentionSeconds = Number(redisUsageRetentionDraft);
    if (
      !Number.isInteger(logsMaxTotalSizeMb)
      || logsMaxTotalSizeMb < 0
      || logsMaxTotalSizeMb > 4294967295
      || !Number.isInteger(errorLogsMaxFiles)
      || errorLogsMaxFiles < 0
      || errorLogsMaxFiles > 4294967295
    ) {
      const message = t('config.diagnostics.error.nonNegativeInteger');
      setLoggingError(message);
      return;
    }
    if (
      !Number.isInteger(redisUsageQueueRetentionSeconds)
      || redisUsageQueueRetentionSeconds < 1
      || redisUsageQueueRetentionSeconds > 3600
    ) {
      const message = t('config.diagnostics.error.redisRetention');
      setLoggingError(message);
      return;
    }

    const commercialModeChanged = commercialModeDraft !== settings.commercialMode;
    setBusyAction('logging');
    setLoggingError('');
    try {
      const result = await saveCoreLoggingSettingsCommand({
        settings: {
          debug: debugDraft,
          commercialMode: commercialModeDraft,
          loggingToFile: loggingToFileDraft,
          logsMaxTotalSizeMb,
          errorLogsMaxFiles,
          usageStatisticsEnabled: usageStatisticsDraft,
          redisUsageQueueRetentionSeconds,
        },
      });
      loggingDraftDirtyRef.current = false;
      applySettings(result, 'preserve');
      if (commercialModeChanged && coreStatus?.running) {
        const status = await restartCoreProcess();
        publishStatus(status);
        loggingFeedback.showNotice({ key: 'config.diagnostics.notice.savedAndRestarted' }, 'success');
      } else {
        loggingFeedback.showNotice({ key: 'config.diagnostics.notice.saved' }, 'success');
      }
    } catch (error) {
      const message = t('config.error.saveFailed', { error: String(error) });
      setLoggingError(message);
      void refreshStatus();
      void loadSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenCoreLogsDirectory = async () => {
    if (busyAction !== null) return;
    setBusyAction('open-logs');
    try {
      await openCoreLogsDirectory();
    } catch (error) {
      loggingFeedback.showNotice({ key: 'config.diagnostics.error.openLogs', variables: { error: String(error) } }, 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const confirmDelete = async () => {
    if (deleteIndex === null) {
      return;
    }
    const deleted = await runMutation(
      'delete-key',
      () => deleteCoreApiKey({ apiKey: selectedDeleteKey }),
      t('config.notice.keyDeleted'),
    );
    if (deleted) {
      setDeleteIndex(null);
    }
  };

  const copyApiKey = async (apiKey: string, index: number) => {
    keyFeedback.clearNotice();
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopiedIndex(index);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedIndex(null);
        copyTimerRef.current = null;
      }, 1800);
    } catch {
      keyFeedback.showNotice({ key: 'config.notice.keyCopyFailed' }, 'error');
    }
  };

  const openWebUi = async () => {
    try {
      const [latestSettings, latestTlsSettings] = await Promise.all([
        getCoreConfigSettings(),
        getCoreTlsSettings(),
      ]);
      applySettings(latestSettings, 'preserve');
      setTlsSettings(latestTlsSettings);
      if (!otherDraftDirtyRef.current.tls) {
        setTlsEnabledDraft(latestTlsSettings.enabled);
        setTlsCertDraft(latestTlsSettings.cert);
        setTlsKeyDraft(latestTlsSettings.key);
      }
      await openExternalUrl({
        url: webUiManagementUrl(latestSettings.port, latestTlsSettings.enabled, latestSettings.host),
      });
    } catch (error) {
      managementFeedback.showNotice({ key: 'config.webuiKey.error.openFailed', variables: { error: String(error) } }, 'error');
    }
  };

  const saveTlsSettings = async () => {
    tlsFeedback.clearNotice();
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
      const result = await saveCoreTlsSettings({
        settings: { enabled: tlsEnabledDraft, cert, key },
      });
      setTlsSettings(result);
      setTlsEnabledDraft(result.enabled);
      setTlsCertDraft(result.cert);
      setTlsKeyDraft(result.key);
      if (coreStatus?.running) {
        const status = await restartCoreProcess();
        publishStatus(status);
        tlsFeedback.showNotice({ key: 'config.tls.notice.savedAndRestarted' }, 'success');
      } else {
        tlsFeedback.showNotice({ key: 'config.tls.notice.saved' }, 'success');
      }
      setTlsSavedStatusVisible(true);
    } catch (error) {
      setTlsError(String(error));
      void refreshStatus();
      void loadTlsSettings('preserve');
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
      () => setCoreRoutingStrategy({ strategy }),
      t('config.notice.routingUpdated'),
    );
  };

  const saveNetworkEndpointSettings = async () => {
    networkFeedback.clearNotice();
    if (!settings || busyAction !== null) return;
    const host = hostDraft.trim();
    const port = Number(portDraft);
    const proxyUrl = proxyUrlDraft.trim();
    setHostError('');
    setPortError('');
    setProxyUrlError('');
    if (!host) {
      setHostError(t('config.error.hostRequired'));
      networkFeedback.showNotice({ key: 'config.error.hostRequired' }, 'error');
      return;
    }
    if (!isValidPort(port)) {
      setPortError(t('config.error.portRange'));
      networkFeedback.showNotice({ key: 'config.error.portRange' }, 'error');
      return;
    }
    if (proxyOverrideDraft && proxyUrl && !/^(https?|socks|socks5h?):\/\//i.test(proxyUrl)) {
      setProxyUrlError(t('config.error.proxyUrlScheme'));
      networkFeedback.showNotice({ key: 'config.error.proxyUrlScheme' }, 'error');
      return;
    }

    const networkChanged = port !== settings.port || host !== settings.host;
    setBusyAction('network');
    try {
      const result = await saveNetworkEndpointSettingsCommand({
        settings: networkDraftDirtyRef.current.proxyUrl || networkDraftDirtyRef.current.proxyOverride
          ? { host, port, proxyUrl, proxyOverride: proxyOverrideDraft }
          : { host, port },
      });
      clearDraftDirty('host');
      clearDraftDirty('port');
      clearDraftDirty('proxyUrl');
      clearDraftDirty('proxyOverride');
      applySettings(result, 'preserve');
      setLoadError('');

      if (networkChanged && coreStatus?.running) {
        try {
          const status = await restartCoreProcess();
          publishStatus(status);
          networkFeedback.showNotice({ key: 'config.notice.networkRestarted' }, 'success');
        } catch (error) {
          await refreshStatus();
          networkFeedback.showNotice({ key: 'config.error.networkRestartFailed', variables: { error: String(error) } }, 'error');
        }
      } else if (networkChanged) {
        networkFeedback.showNotice({ key: 'config.notice.networkNextStart' }, 'success');
      } else {
        networkFeedback.showNotice({ key: 'config.notice.networkUpdated' }, 'success');
      }
    } catch (error) {
      networkFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
      void loadSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const saveRetrySettings = async () => {
    retryFeedback.clearNotice();
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
      || retryValues.some((value, index) => !Number.isInteger(value) || value < (index === 2 ? -2147483648 : 0) || value > (index === 2 ? 2147483647 : 4294967295))
    ) {
      setRetryError(templateText(templateMessages.retryRange, locale));
      retryFeedback.showNotice(templateText(templateMessages.retryRange, locale), 'error');
      return;
    }
    const [requestRetry, maxRetryCredentials, maxRetryInterval, streamingBootstrapRetries] = retryValues;
    setRetryError('');
    setBusyAction('retry');
    try {
      const result = await saveRetrySettingsCommand({
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
      retryFeedback.showNotice({ key: 'config.notice.retryUpdated' }, 'success');
    } catch (error) {
      retryFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
      void loadSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const saveSessionRoutingSettings = async () => {
    routingFeedback.clearNotice();
    if (!settings || busyAction !== null) return;
    const routingSessionAffinityTtl = sessionTtlDraft.trim();
    if (routingSessionAffinityTtl && !SESSION_TTL_PATTERN.test(routingSessionAffinityTtl)) {
      setSessionTtlError(t('config.error.sessionTtlFormat'));
      routingFeedback.showNotice({ key: 'config.error.sessionTtlFormat' }, 'error');
      return;
    }
    setSessionTtlError('');
    setBusyAction('routing');
    try {
      const result = await saveSessionRoutingSettingsCommand({
        settings: {
          routingSessionAffinity: sessionAffinityDraft,
          routingSessionAffinityTtl,
        },
      });
      clearDraftDirty('sessionAffinity');
      clearDraftDirty('sessionTtl');
      applySettings(result, 'preserve');
      setLoadError('');
      routingFeedback.showNotice({ key: 'config.notice.sessionRoutingUpdated' }, 'success');
    } catch (error) {
      routingFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
      void loadSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const saveSoftwareSettings = async () => {
    softwareFeedback.clearNotice();
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
      const result = await saveSoftwareSettingsCommand({
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
    } catch (error) {
      setSoftwareSavedStatusVisible(false);
      softwareFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
      void loadSoftwareSettings('preserve');
    } finally {
      setBusyAction(null);
    }
  };

  const discardNetworkEndpointDraft = () => {
    if (!settings) return;
    setPortDraft(String(settings.port));
    setHostDraft(settings.host);
    setProxyUrlDraft(settings.proxyUrl);
    setProxyOverrideDraft(settings.proxyOverride);
    clearDraftDirty('port');
    clearDraftDirty('host');
    clearDraftDirty('proxyUrl');
    clearDraftDirty('proxyOverride');
    setPortError('');
    setHostError('');
    setProxyUrlError('');
  };

  const discardTlsDraft = () => {
    if (!tlsSettings) return;
    setTlsEnabledDraft(tlsSettings.enabled);
    setTlsCertDraft(tlsSettings.cert);
    setTlsKeyDraft(tlsSettings.key);
    setTlsError('');
  };

  const discardProxyDraft = () => {
    setProxyDraft(proxyState?.config ?? DEFAULT_REVERSE_PROXY_DRAFT);
    setProxyDirty(false);
    setProxyFieldErrors({});
  };

  const discardSessionRoutingDraft = () => {
    if (!settings) return;
    setSessionAffinityDraft(settings.routingSessionAffinity);
    setSessionTtlDraft(settings.routingSessionAffinityTtl);
    clearDraftDirty('sessionAffinity');
    clearDraftDirty('sessionTtl');
    setSessionTtlError('');
  };

  const discardRetryDraft = () => {
    if (!settings) return;
    setDisableCoolingDraft(settings.disableCooling);
    setRequestRetryDraft(String(settings.requestRetry));
    setMaxRetryCredentialsDraft(String(settings.maxRetryCredentials));
    setMaxRetryIntervalDraft(String(settings.maxRetryInterval));
    setStreamingBootstrapRetriesDraft(String(settings.streamingBootstrapRetries));
    clearDraftDirty('disableCooling');
    clearDraftDirty('requestRetry');
    clearDraftDirty('maxRetryCredentials');
    clearDraftDirty('maxRetryInterval');
    clearDraftDirty('streamingBootstrapRetries');
    setRetryError('');
  };

  const discardLoggingDraft = () => {
    if (!settings) return;
    setDebugDraft(settings.debug);
    setCommercialModeDraft(settings.commercialMode);
    setLoggingToFileDraft(settings.loggingToFile);
    setLogsMaxTotalSizeDraft(String(settings.logsMaxTotalSizeMb));
    setErrorLogsMaxFilesDraft(String(settings.errorLogsMaxFiles));
    setUsageStatisticsDraft(settings.usageStatisticsEnabled);
    setRedisUsageRetentionDraft(String(settings.redisUsageQueueRetentionSeconds));
    loggingDraftDirtyRef.current = false;
    setLoggingError('');
  };

  const discardSoftwareDraft = () => {
    if (!softwareSettings) return;
    setSoftwareCloseBehaviorDraft(softwareSettings.closeBehavior);
    setSoftwareAutostartDraft(softwareSettings.autostartEnabled);
    setSoftwareStartCoreDraft(softwareSettings.startCoreOnLaunch);
    setSoftwareSilentStartDraft(softwareSettings.silentStartEnabled);
    setSoftwareDefaultTerminalDraft(softwareSettings.defaultTerminal);
  };

  const coreUnavailable = loading || settings === null;
  const nativeSectionsPending = loading || loadError !== '';
  const renderNativeSkeleton = () => (
    <div className="config-native-skeleton" aria-busy="true">
      {Array.from({ length: 3 }, (_, index) => (
        <div className="config-key-row skeleton" key={index} aria-hidden="true">
          <span />
          <span />
        </div>
      ))}
    </div>
  );
  const networkSettingsDirty = Boolean(settings) && (
    hostDraft.trim() !== settings?.host
    || portDraft !== String(settings?.port)
    || proxyUrlDraft.trim() !== settings?.proxyUrl
    || proxyOverrideDraft !== settings?.proxyOverride
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
  const loggingSettingsDirty = Boolean(settings) && (
    debugDraft !== settings?.debug
    || commercialModeDraft !== settings?.commercialMode
    || loggingToFileDraft !== settings?.loggingToFile
    || logsMaxTotalSizeDraft !== String(settings?.logsMaxTotalSizeMb)
    || errorLogsMaxFilesDraft !== String(settings?.errorLogsMaxFiles)
    || usageStatisticsDraft !== settings?.usageStatisticsEnabled
    || redisUsageRetentionDraft !== String(settings?.redisUsageQueueRetentionSeconds)
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
  otherDraftDirtyRef.current = { software: softwareSettingsDirty, tls: tlsSettingsDirty };
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
  const loggingSettingsBusy = busyAction === 'logging';
  const keysDisabled = coreUnavailable || keyMutationBusy || busyAction === 'delete-key';
  const managementControlsDisabled = coreUnavailable || managementSecretBusy;
  const networkControlsDisabled = coreUnavailable || busyAction === 'network';
  const routingControlsDisabled = coreUnavailable || busyAction === 'routing';
  const retryControlsDisabled = coreUnavailable || busyAction === 'retry';
  const diagnosticsControlsDisabled = coreUnavailable || busyAction === 'logging' || busyAction === 'open-logs';
  const tlsControlsDisabled = tlsSettingsLoading || tlsSettings === null || busyAction === 'tls';
  const softwareControlsDisabled = softwareSettingsLoading || softwareSettings === null || busyAction === 'software';
  const proxyControlsDisabled = coreUnavailable || proxyInitialLoading || proxyAction !== null || proxyFileSelecting !== null;
  const activateConfigSubpage = (subpage: ConfigSubpage) => {
    setSettingsSearch('');
    setActiveSubpage(subpage);
    if (subpage === 'requests') {
      setSensitiveWordsVisited(true);
    }
    if (subpage === 'aliases') setAliasesVisited(true);
  };
  const navigateToSetting = (destination: SettingDestination) => {
    activateConfigSubpage(destination.category);
    setPendingDestination(destination);
  };
  useEffect(() => {
    const destination = takeRequestedSettingField();
    if (destination) navigateToSetting(destination);
  }, []);
  const nativeDirty = {
    keys: false, management: Boolean(managementSecretDraft || managementSecretConfirm),
    network: networkSettingsDirty, tls: tlsSettingsDirty, routing: sessionRoutingDirty,
    retry: retrySettingsDirty, logging: loggingSettingsDirty, software: softwareSettingsDirty,
  };
  const nativeEntries: SettingSearchEntry[] = [
    { category: 'general', target: 'config-native-keys', title: t('config.keys.title'), context: '', keywords: 'API key token 鉴权密钥 api-keys access' },
    { category: 'general', target: 'config-native-management', title: t('config.webuiKey.title'), context: '', keywords: 'WebUI secret-key 密钥 管理接口 面板 密码 management security' },
    { category: 'general', target: 'config-native-network', title: st('nativeNetwork'), context: '', keywords: [t('config.network.port'), t('config.network.listenHost'), t('config.network.proxyUrl'), t('config.network.systemProxy'), 'server host port proxy URL 8317 127.0.0.1 0.0.0.0 监听 地址 系统代理'].join(' ') },
    { category: 'general', target: 'config-native-tls', title: t('config.tls.enable'), context: '', keywords: [t('config.tls.cert'), t('config.tls.key'), 'TLS HTTPS cert key certificate 证书 私钥 加密'].join(' ') },
    { category: 'proxy', target: 'config-native-reverse-proxy', title: st('reverseProxyTitle'), context: '', keywords: [st('reverseProxyListenHost'), st('reverseProxyListenPort'), st('reverseProxyTargetPort'), st('reverseProxyCertPath'), st('reverseProxyKeyPath'), 'reverse proxy 反向代理 HTTPS 转发 监听 端口'].join(' ') },
    { category: 'routing', target: 'config-native-routing', title: st('nativeRouting'), context: '', keywords: [t('config.network.sessionAffinity'), t('config.network.sessionTtl'), t('config.routing.title'), 'session affinity ttl routing strategy round-robin 会话 粘性 加权 轮询'].join(' ') },
    { category: 'routing', target: 'config-native-retry', title: st('nativeRetry'), context: '', keywords: [t('config.network.enableCooling'), t('config.network.disableCooling'), t('config.network.requestRetry'), t('config.network.maxRetryCredentials'), t('config.network.maxRetryInterval'), t('config.network.streamingBootstrapRetries'), 'retry retries cooldown 重试 冷却 流式 失败 fallback'].join(' ') },
    { category: 'diagnostics', target: 'config-native-logging', title: t('config.diagnostics.title'), context: '', keywords: [t('config.diagnostics.debug.title'), t('config.diagnostics.commercial.title'), t('config.diagnostics.fileLogging.title'), t('config.diagnostics.usage.title'), t('config.diagnostics.maxSize.title'), t('config.diagnostics.errorFiles.title'), t('config.diagnostics.redisRetention.title'), 'debug commercial-mode logging logs usage statistics redis retention 日志 调试 商业模式 用量 统计 留存 文件 容量'].join(' ') },
    { category: 'software', target: 'config-native-software', title: t('config.software.title'), context: '', keywords: [t('config.software.autostart'), t('config.software.startCoreOnLaunch'), t('config.software.silentStart'), t('config.software.closeBehavior'), t('config.software.defaultTerminal'), 'startup autostart silent tray close terminal 软件 自启动 启动 静默 托盘 关闭 终端'].join(' ') },
    { category: 'aliases', target: 'config-native-aliases', title: t('app.nav.thinkingAliases'), context: '', keywords: 'thinking reasoning speed aliases effort 思考 推理 速度 别名 模型' },
    { category: 'requests', target: 'config-native-sensitive-words', title: t('config.sensitiveWords.title'), context: '', keywords: 'sensitive words filters antigravity devin 敏感词 内容 过滤' },
  ];
  const nativeCategoryDirty: Record<ConfigSubpage, boolean> = {
    general: nativeDirty.management || networkSettingsDirty || tlsSettingsDirty,
    proxy: proxyDirty,
    aliases: false,
    routing: sessionRoutingDirty || retrySettingsDirty,
    requests: sensitiveWordsDirty,
    diagnostics: loggingSettingsDirty,
    oauth: false,
    software: softwareSettingsDirty,
  };
  const categoryDirty = (id: ConfigSubpage) => nativeCategoryDirty[id]
    || settingsTemplateGroups[id].some(group => dirtyTemplateGroups.includes(group.id));
  const templateGroups = settingsTemplateGroups[activeSubpage];
  const searchEntries: SettingSearchEntry[] = [
    ...nativeEntries,
    ...settingsCategories.flatMap(item => settingsTemplateGroups[item.id].flatMap(group => group.fields.map((field, index) => ({
      category: item.id,
      target: `config-group-${group.id}`, field: `template-field-${group.id}-${index}`,
      title: templateText(field.label, locale), context: templateText(group.title, locale),
      keywords: `${JSON.stringify(field)} ${templateText(group.description, locale)} ${field.path.join('.')}`,
    })))),
  ];
  const searchTerms = settingsSearch.trim().toLocaleLowerCase().split(/\s+/);
  const searchResults = searchEntries.filter(entry => {
    const categoryTitle = templateText(settingsCategories.find(item => item.id === entry.category)!.title, locale);
    const text = `${entry.title} ${entry.context} ${entry.keywords} ${categoryTitle}`.toLocaleLowerCase();
    return searchTerms.every(term => text.includes(term));
  });

  return (
    <section className="page config-page" aria-label={st('title')}>
      {confirmationDialog}
      <div className="config-settings-layout">
        <div className="config-settings-topnav">
          <Tabs ref={categoryNavigationRef} className="config-subpage-tabs secondary-page-tabs" aria-label={t('config.tabs.label')} value={activeSubpage} onChange={activateConfigSubpage}
            items={settingsCategories.map(item => {
              const title = templateText(item.title, locale);
              const dirty = categoryDirty(item.id);
              return {
                value: item.id, id: `config-subpage-tab-${item.id}`, panelId: 'config-subpage-panel',
                title: dirty ? `${title} · ${st('dirty')}` : undefined,
                label: <><span>{title}</span>{dirty ? <><span className="config-nav-dirty" aria-hidden="true" /><span className="config-nav-dirty-text" aria-hidden="true">{st('dirty')}</span></> : null}</>,
              };
            })} />
          <div className="config-settings-search search-control" data-size="default"><Search size={18} aria-hidden="true" /><input ref={searchRef} type="search" aria-label={st('search')} placeholder={st('searchHint')} value={settingsSearch} onChange={event => setSettingsSearch(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Escape') setSettingsSearch(''); }} />{searching ? <button type="button" className="icon-button quiet tiny-button" aria-label={st('clearSearch')} onClick={() => { setSettingsSearch(''); searchRef.current?.focus(); }}><X size={16} /></button> : <kbd className="config-settings-search-key" aria-hidden="true">/</kbd>}</div>
        </div>
        <div className="config-settings-content" id="config-subpage-panel" role="tabpanel" aria-labelledby={`config-subpage-tab-${activeSubpage}`}>
          {searching ? <section className="config-search-results" aria-label={st('results')}><div className="config-search-heading"><h2>{st('results')}</h2><span role="status">{searchResults.length}</span></div>{searchResults.length ? <div className="surface-card config-search-result-list">{searchResults.map(entry => <button type="button" key={`${entry.target}-${entry.field ?? ''}`} onClick={() => navigateToSetting(entry)}><span className="config-search-result-copy"><strong>{entry.title}</strong><small>{templateText(settingsCategories.find(item => item.id === entry.category)!.title, locale)}{entry.context ? ` / ${entry.context}` : ''}</small></span><ChevronRight size={17} aria-hidden="true" /></button>)}</div> : <EmptyState variant="box" className="config-search-empty">{st('noResults')}</EmptyState>}</section> : null}
          {loadError ? (
            <EmptyState variant="box" className="config-load-error" tone="error" role="alert" icon={<AlertCircle size={24} />} title={t('config.unavailable')}
              action={<button type="button" className="secondary-button compact-button" onClick={() => void loadSettings()}>
                <RefreshCw size={16} aria-hidden="true" />
                {t('common.retry')}
              </button>}>
              <span title={loadError}>{loadError}</span>
            </EmptyState>
          ) : null}
          <div className="config-settings-cards">
<section id="config-native-keys" tabIndex={-1} hidden={searching || activeSubpage !== 'general'} className="panel surface-card config-keys-panel">
          <div className="config-panel-heading">
            <div className="config-heading-title">
              <KeyRound size={18} aria-hidden="true" />
              <h2>{t('config.keys.title')}</h2>
            </div>
            <div className="config-heading-actions">
              {keyMutationBusy ? <span className="state-pill">{t('common.saving')}</span> : null}
              <span className="config-count" aria-label={t('config.keys.count')}>
                {settings ? settings.apiKeys.length : '—'}
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={openAddDialog}
                disabled={keysDisabled}
                title={t('config.keys.add')}
                aria-label={t('config.keys.add')}
              >
                <Plus size={18} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="config-key-list" aria-busy={nativeSectionsPending || undefined}>
            {nativeSectionsPending ? (
              Array.from({ length: 5 }, (_, index) => (
                <div className="config-key-row skeleton" key={index} aria-hidden="true">
                  <span />
                  <span />
                </div>
              ))
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
                      className="icon-button quiet small-button"
                      onClick={() => void copyApiKey(entry.apiKey, index)}
                      disabled={keysDisabled}
                      title={copiedIndex === index ? t('config.notice.keyCopied') : t('config.keys.copy')}
                      aria-label={copiedIndex === index ? t('config.notice.keyCopied') : t('config.keys.copyNth', { number: index + 1 })}
                    >
                      {copiedIndex === index ? (
                        <Check size={16} aria-hidden="true" />
                      ) : (
                        <Copy size={16} aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="icon-button quiet small-button"
                      onClick={() => openEditDialog(entry)}
                      disabled={keysDisabled}
                      title={t('config.keys.edit')}
                      aria-label={t('config.keys.editNth', { number: index + 1 })}
                    >
                      <Pencil size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger small-button"
                      onClick={() => setDeleteIndex(index)}
                      disabled={keysDisabled}
                      title={t('config.keys.delete')}
                      aria-label={t('config.keys.deleteNth', { number: index + 1 })}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <EmptyState className="config-empty-list" icon={<KeyRound size={26} />} title={t('config.keys.empty')} />
            )}
          </div>
          {!addDialogOpen && deleteIndex === null ? renderFeedback(keyFeedback) : null}
        </section>
<section id="config-native-management" tabIndex={-1} hidden={searching || activeSubpage !== 'general'} className="panel surface-card config-management-panel">
          <div className="config-panel-heading">
            <div className="config-heading-title">
              <ShieldCheck size={18} aria-hidden="true" />
              <h2>{t('config.webuiKey.title')}</h2><SettingsHelp label={t('config.webuiKey.title')}>{t('config.webuiKey.description')} {t('config.webuiKey.securityHint')}</SettingsHelp>
            </div>
            <div className="config-heading-actions">
              {managementSecretBusy ? <span className="state-pill">{t('common.saving')}</span> : null}
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={coreUnavailable}
                onClick={() => void openWebUi()}
                title={settings ? webUiManagementUrl(settings.port, tlsSettings?.enabled, settings.host) : undefined}
              >
                {t('config.webuiKey.open')}
              </button>
            </div>
          </div>

          <div className="config-management-content">
            {settings?.managementSecretConfigured === false ? <p role="status">{templateText(templateMessages.managementDisabled, locale)}</p> : null}

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
                    disabled={managementControlsDisabled}
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
                    disabled={managementControlsDisabled}
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
                  disabled={managementControlsDisabled}
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
                  <button type="button" className="secondary-button compact-button" disabled={managementControlsDisabled || settings?.managementSecretConfigured === false} onClick={() => void disableManagement()}>
                    {templateText(templateMessages.disableManagement, locale)}
                  </button>
                  <button
                    type="button"
                    className="secondary-button compact-button"
                  disabled={managementControlsDisabled}
                  onClick={generateManagementSecret}
                >
                    {t('config.webuiKey.generate')}
                  </button>
                  <button
                    type="submit"
                    className="primary-button compact-button"
                    disabled={managementControlsDisabled || !managementSecretDraft.trim()}
                  >
                    <Check size={16} aria-hidden="true" />
                    {managementSecretBusy ? t('common.saving') : t('config.webuiKey.save')}
                  </button>
                </div>
              </div>
            </form>
            {renderFeedback(managementFeedback)}
          </div>
        </section>
<section id="config-native-network" tabIndex={-1} hidden={searching || activeSubpage !== 'general'}
            className="surface-card config-network-section"
            aria-labelledby="config-network-section-title"
          >
            <div className="config-network-section-heading config-section-heading-with-actions">
              <div className="config-network-section-title">
                <Network size={16} aria-hidden="true" />
                <h3 id="config-network-section-title">{st('nativeNetwork')}</h3>
              </div>
              <span className="config-card-status" role="status">{busyAction === 'network' ? <span className="state-pill">{t('common.saving')}</span> : nativeDirty.network ? st('dirty') : ''}</span>

            </div>
            {renderFeedback(networkFeedback)}
            {nativeSectionsPending ? renderNativeSkeleton() : (<>
            <div className="config-network-grid">
              <div className="config-network-field config-network-port-field">
            <span className="config-field-label"><label htmlFor="config-input-config-network-port">{t('config.network.port')}</label><SettingsHelp label={t('config.network.port')}>{t('config.network.portHint')}</SettingsHelp></span>
            <input
                  id="config-input-config-network-port"
              className={`config-network-input ${portError ? 'error' : ''}`}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={5}
              value={portDraft}
              disabled={networkControlsDisabled}
              aria-invalid={Boolean(portError)}
              aria-describedby={portError ? 'config-network-port-error' : undefined}
              title={portError || t('config.network.portHint')}
              onChange={(event) => {
                markDraftDirty('port');
                setPortDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 5));
                setPortError('');
              }}
            />
            <span id="config-network-port-error" className="config-field-error" role="alert">{portError || ' '}</span>

              </div>

              <div className="config-network-field">
                <span className="config-field-label"><label htmlFor="config-input-config-network-listenHost">{t('config.network.listenHost')}</label><SettingsHelp label={t('config.network.listenHost')}>{templateText(templateMessages.hostHint, locale)}</SettingsHelp></span>
                <input
                  id="config-input-config-network-listenHost"
                  className={`config-network-input ${hostError ? 'error' : ''}`}
                  type="text"
                  value={hostDraft}
                  disabled={networkControlsDisabled}
                  placeholder="127.0.0.1"
                  aria-invalid={Boolean(hostError)}
                  aria-describedby={hostError ? 'config-network-host-error' : undefined}
                  title={hostError || templateText(templateMessages.hostHint, locale)}
                  onChange={(event) => {
                    markDraftDirty('host');
                    setHostDraft(event.currentTarget.value);
                    setHostError('');
                  }}
                />
                <span id="config-network-host-error" className="config-field-error" role="alert">{hostError || ' '}</span>

              </div>

              <div className="config-network-field config-proxy-field">
                <div className="config-proxy-heading">
                  <label className="config-network-label" htmlFor="config-network-proxy-url">
                    <Link2 size={15} aria-hidden="true" />
                    {t('config.network.proxyUrl')}
                  </label>
                  <SettingsHelp label={t('config.network.proxyUrl')}>{t('config.network.proxyHint')} {t('config.network.systemProxyHint')}</SettingsHelp>
                  <label className="config-proxy-system-toggle" title={t('config.network.systemProxyHint')}>
                    <span>{t('config.network.systemProxy')}</span>
                    <Switch checked={!proxyOverrideDraft} disabled={networkControlsDisabled} onChange={(event) => {
                          markDraftDirty('proxyOverride');
                          setProxyOverrideDraft(!event.currentTarget.checked);
                        }} />
                  </label>
                </div>
                <input
                  id="config-network-proxy-url"
                  className={`config-network-input ${proxyUrlError ? 'error' : ''}`}
                  type="text"
                  value={proxyUrlDraft}
                  disabled={networkControlsDisabled || !proxyOverrideDraft}
                  placeholder={t('config.network.proxyPlaceholder')}
                  aria-invalid={Boolean(proxyUrlError)}
                  aria-describedby={proxyUrlError ? 'config-network-proxy-url-error' : undefined}
                  onChange={(event) => {
                    markDraftDirty('proxyUrl');
                    setProxyUrlDraft(event.currentTarget.value);
                    setProxyUrlError('');
                  }}
                />
                <span id="config-network-proxy-url-error" className="config-field-error" role="alert">{proxyUrlError || ' '}</span>

              </div>
            </div>

          {settings && (hostDraft.trim() !== settings.host || portDraft !== String(settings.port)) ? (
            <Notice tone="warn" icon={<AlertCircle size={16} />}>{st('restart')}</Notice>
          ) : null}

          <div className="config-settings-save-row"><button
                type="button"
                className="secondary-button compact-button"
                disabled={networkControlsDisabled || !networkSettingsDirty}
                onClick={discardNetworkEndpointDraft}
              >
                {t('agents.catalog.discard')}
              </button><button
                type="button"
                className="primary-button compact-button"
                disabled={networkControlsDisabled || !networkSettingsDirty}
                onClick={() => void saveNetworkEndpointSettings()}
              >
                <Check size={16} aria-hidden="true" />
                {busyAction === 'network' ? t('common.saving') : t('common.save')}
              </button></div></>)}
        </section>
<section id="config-native-tls" tabIndex={-1} hidden={searching || activeSubpage !== 'general'}
            className="surface-card config-network-section"
            aria-labelledby="config-tls-section-title"
          >
          <div className="config-network-section-heading config-tls-section-heading">
            <div className="config-tls-section-title">
              <LockKeyhole size={18} aria-hidden="true" />
              <h3 id="config-tls-section-title">{t('config.tls.enable')}</h3>
            </div>
            <div className="config-heading-actions">
              {busyAction === 'tls' ? (
                <span className="state-pill">{t('common.saving')}</span>
              ) : tlsStatusLabel ? (
                <span className={`state-pill ${tlsStatusIsSaved ? 'success' : ''}`}>
                  {tlsStatusLabel}
                </span>
              ) : null}

            </div>
          </div>

          {nativeSectionsPending ? renderNativeSkeleton() : (<>
          <div className="config-tls-content">
            <div className="config-software-setting-row config-tls-toggle-row">
              <div className="config-software-setting-copy">
                <span className="config-software-setting-icon" aria-hidden="true">
                  <ShieldCheck size={18} />
                </span>
                <div>
                  <span className="config-field-label"><strong>{t('config.tls.enable')}</strong><SettingsHelp label={t('config.tls.enable')}>{t('config.tls.enableDescription')} {t('config.tls.restartHint')}</SettingsHelp></span>

                </div>
              </div>
              <Switch title={t('config.tls.enable')} aria-label={t('config.tls.enable')} checked={tlsEnabledDraft} disabled={tlsControlsDisabled} onChange={(event) => {
                    setTlsSavedStatusVisible(false);
                    setTlsError('');
                    setTlsEnabledDraft(event.currentTarget.checked);
                  }} />
            </div>

            {tlsEnabledDraft ? (
              <div className="config-tls-fields">
                <div className="config-network-field">
                  <span className="config-field-label"><span>{t('config.tls.cert')}</span><SettingsHelp label={t('config.tls.cert')}>{t('config.tls.certHint')}</SettingsHelp></span>
                  <div className="config-tls-path-control">
                    <input
                      className={`config-network-input ${tlsError && !tlsCertDraft.trim() ? 'error' : ''}`}
                      type="text"
                      value={tlsCertDraft}
                      aria-label={t('config.tls.cert')}
                      disabled={tlsControlsDisabled || tlsFileSelecting !== null}
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
                      disabled={tlsControlsDisabled || tlsFileSelecting !== null}
                      title={t('config.tls.selectCertTitle')}
                      onClick={() => void selectTlsFile('cert')}
                    >
                      <FolderOpen size={16} aria-hidden="true" />
                      {tlsFileSelecting === 'cert' ? t('common.processing') : t('config.tls.browse')}
                    </button>
                  </div>

                </div>
                <div className="config-network-field">
                  <span className="config-field-label"><span>{t('config.tls.key')}</span><SettingsHelp label={t('config.tls.key')}>{t('config.tls.keyHint')}</SettingsHelp></span>
                  <div className="config-tls-path-control">
                    <input
                      className={`config-network-input ${tlsError && !tlsKeyDraft.trim() ? 'error' : ''}`}
                      type="text"
                      value={tlsKeyDraft}
                      aria-label={t('config.tls.key')}
                      disabled={tlsControlsDisabled || tlsFileSelecting !== null}
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
                      disabled={tlsControlsDisabled || tlsFileSelecting !== null}
                      title={t('config.tls.selectKeyTitle')}
                      onClick={() => void selectTlsFile('key')}
                    >
                      <FolderOpen size={16} aria-hidden="true" />
                      {tlsFileSelecting === 'key' ? t('common.processing') : t('config.tls.browse')}
                    </button>
                  </div>

                </div>
              </div>
            ) : null}

            <MessageNotice message={tlsError} onDismiss={() => setTlsError('')} />

            {renderFeedback(tlsFeedback)}
          </div>

          {tlsSettingsDirty ? (
            <Notice tone="warn" icon={<AlertCircle size={16} />}>{st('restart')}</Notice>
          ) : null}

          <div className="config-settings-save-row"><button
                type="button"
                className="secondary-button compact-button"
                disabled={tlsControlsDisabled || tlsFileSelecting !== null || !tlsSettingsDirty}
                onClick={discardTlsDraft}
              >
                {t('agents.catalog.discard')}
              </button><button
                type="button"
                className="primary-button compact-button"
                disabled={tlsControlsDisabled || tlsFileSelecting !== null || !tlsSettingsDirty}
                onClick={() => void saveTlsSettings()}
              >
                <Check size={16} aria-hidden="true" />
                {busyAction === 'tls' ? t('common.saving') : t('common.save')}
              </button></div></>)}
        </section>
        <section
          id="config-native-reverse-proxy"
          tabIndex={-1}
          hidden={searching || activeSubpage !== 'proxy'}
          className="surface-card config-network-section"
          aria-labelledby="config-reverse-proxy-section-title"
        >
          <div className="config-network-section-heading config-tls-section-heading">
            <div className="config-tls-section-title">
              <Network size={18} aria-hidden="true" />
              <h3 id="config-reverse-proxy-section-title">{st('reverseProxyTitle')}</h3>
            </div>
            <div className="config-heading-actions">
              {proxyAction !== null ? (
                <span className="state-pill">{t('common.saving')}</span>
              ) : proxyState ? (
                <span className={`state-pill ${proxyState.running ? 'success' : ''}`}>
                  {proxyState.running ? st('reverseProxyRunning') : st('reverseProxyStopped')}
                </span>
              ) : null}
            </div>
          </div>

          {proxyInitialLoading ? (
            <div className="config-tls-content" aria-busy="true">
              <div className="config-key-row skeleton" aria-hidden="true">
                <span />
                <span />
              </div>
              <div className="config-key-row skeleton" aria-hidden="true">
                <span />
                <span />
              </div>
              <div className="config-key-row skeleton" aria-hidden="true">
                <span />
                <span />
              </div>
            </div>
          ) : (
            <div className="config-tls-content">
              {backendNotReady ? (
                <Notice tone="warn" className="config-reverse-proxy-backend-notice">
                  {st('reverseProxyBackendNotReady')}
                </Notice>
              ) : null}

              <p className="config-diagnostics-intro">
                {st('reverseProxyIntro')}
              </p>

              <div className="config-software-setting-row config-tls-toggle-row">
                <div className="config-software-setting-copy">
                  <span className="config-software-setting-icon" aria-hidden="true">
                    <Network size={18} />
                  </span>
                  <div>
                    <span className="config-field-label">
                      <strong>{st('reverseProxyEnable')}</strong>
                      <SettingsHelp label={st('reverseProxyEnable')}>{st('reverseProxyEnableHint')}</SettingsHelp>
                    </span>
                  </div>
                </div>
                <Switch
                  title={st('reverseProxyEnable')}
                  aria-label={st('reverseProxyEnable')}
                  aria-checked={proxyDraft.enabled}
                  checked={proxyDraft.enabled}
                  disabled={proxyControlsDisabled}
                  onChange={(event) => {
                    void handleProxyToggle(event.currentTarget.checked);
                  }}
                />
              </div>

              <p className="config-diagnostics-intro">
                {st('reverseProxyEnableHint')} {st('reverseProxySaveApplyHint')}
              </p>

              <div className="config-network-label">
                <strong>{st('reverseProxyRouteTitle')}</strong>
              </div>
              <p className="config-diagnostics-intro">
                {st('reverseProxyRouteClientHint')}
              </p>

              <div className={`config-network-grid config-network-route${proxyDraft.enabled ? '' : ' is-muted'}`}>
                <div className="config-network-field">
                  <span className="config-field-label"><span>{st('reverseProxyRoutePreview')}</span></span>
                  <span>
                    <code>{`0.0.0.0:${proxyDraft.listenPort || 443}(HTTPS)`}</code>
                    {' '}
                    <ArrowRight size={14} aria-hidden="true" />
                    {' '}
                    <code>{`127.0.0.1:${proxyDraft.targetPort || (settings?.port ?? 8317)}`}</code>
                  </span>
                </div>

                <div className="config-network-field">
                  <span className="config-field-label">
                    <label htmlFor="config-input-reverse-proxy-listen-port">{st('reverseProxyListenPort')}</label>
                    <SettingsHelp label={st('reverseProxyListenPort')}>{st('reverseProxyListenPortHint')}</SettingsHelp>
                  </span>
                  <input
                    id="config-input-reverse-proxy-listen-port"
                    className={`config-network-input ${proxyFieldErrors.listenPort ? 'error' : ''}`}
                    type="number"
                    min={1}
                    max={65535}
                    value={proxyDraft.listenPort || ''}
                    disabled={proxyControlsDisabled}
                    placeholder="443"
                    aria-invalid={Boolean(proxyFieldErrors.listenPort)}
                    aria-describedby={proxyFieldErrors.listenPort ? 'config-reverse-proxy-listen-port-error' : undefined}
                    onChange={(event) => {
                      const val = parseInt(event.currentTarget.value, 10);
                      setProxyDraft(prev => ({ ...prev, listenPort: Number.isNaN(val) ? 0 : val }));
                      setProxyDirty(true);
                      clearProxyFieldError('listenPort');
                    }}
                  />
                  <span id="config-reverse-proxy-listen-port-error" className="config-field-error" role="alert">{proxyFieldErrors.listenPort || ' '}</span>
                </div>
              </div>

              {proxyState?.running && proxyState.listening ? (
                <div className="config-network-grid" aria-label={st('reverseProxyRouteTitle')}>
                  <div className="config-network-field">
                    <span className="config-field-label"><span>{st('reverseProxyRoutePublic')}</span></span>
                    <span>
                      <code>{`https://${proxyLanIp ?? `<${st('reverseProxyRouteHostPlaceholder')}>`}:${proxyState.listening.split(':').pop() ?? ''}`}</code>
                    </span>
                  </div>
                  <div className="config-network-field">
                    <span className="config-field-label"><span>{st('reverseProxyRouteLocal')}</span></span>
                    <span><code>{proxyState.target ?? '—'}</code></span>
                  </div>
                </div>
              ) : null}

              <div className="config-network-label">
                <strong>{st('reverseProxyCertTitle')}</strong>
              </div>
              <p className="config-diagnostics-intro">
                {st('reverseProxyCertIntro')}
              </p>

              <div className={`config-network-grid${proxyDraft.enabled ? '' : ' is-muted'}`}>
                <div className="config-network-field">
                  <span className="config-field-label">
                    <label htmlFor="config-input-reverse-proxy-cert-path">{st('reverseProxyCertPath')}</label>
                    <SettingsHelp label={st('reverseProxyCertPath')}>{st('reverseProxyCertPathHint')}</SettingsHelp>
                  </span>
                  <div className="config-tls-path-control">
                    <input
                      id="config-input-reverse-proxy-cert-path"
                      name="rp-cert-path-nofill"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      className={`config-network-input ${proxyFieldErrors.certPath ? 'error' : ''}`}
                      type="text"
                      value={proxyDraft.certPath}
                      disabled={proxyControlsDisabled || proxyFileSelecting !== null}
                      placeholder={st('reverseProxyCertPlaceholder')}
                      aria-invalid={Boolean(proxyFieldErrors.certPath)}
                      aria-describedby={proxyFieldErrors.certPath ? 'config-reverse-proxy-cert-path-error' : undefined}
                      onChange={(event) => {
                        updateProxyPath('certPath', event.currentTarget.value);
                      }}
                    />
                    <button
                      type="button"
                      className="secondary-button compact-button config-tls-browse-button"
                      disabled={proxyControlsDisabled || proxyFileSelecting !== null}
                      title={st('reverseProxySelectCertTitle')}
                      onClick={() => void selectProxyFile('cert')}
                    >
                      <FolderOpen size={16} aria-hidden="true" />
                      {proxyFileSelecting === 'cert' ? t('common.processing') : t('config.tls.browse')}
                    </button>
                  </div>
                  <span id="config-reverse-proxy-cert-path-error" className="config-field-error" role="alert">{proxyFieldErrors.certPath || ' '}</span>
                </div>

                <div className="config-network-field">
                  <span className="config-field-label">
                    <label htmlFor="config-input-reverse-proxy-key-path">{st('reverseProxyKeyPath')}</label>
                    <SettingsHelp label={st('reverseProxyKeyPath')}>{st('reverseProxyKeyPathHint')}</SettingsHelp>
                  </span>
                  <div className="config-tls-path-control">
                    <input
                      id="config-input-reverse-proxy-key-path"
                      name="rp-key-path-nofill"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      className={`config-network-input ${proxyFieldErrors.keyPath ? 'error' : ''}`}
                      type="text"
                      value={proxyDraft.keyPath}
                      disabled={proxyControlsDisabled || proxyFileSelecting !== null}
                      placeholder={st('reverseProxyKeyPlaceholder')}
                      aria-invalid={Boolean(proxyFieldErrors.keyPath)}
                      aria-describedby={proxyFieldErrors.keyPath ? 'config-reverse-proxy-key-path-error' : undefined}
                      onChange={(event) => {
                        updateProxyPath('keyPath', event.currentTarget.value);
                      }}
                    />
                    <button
                      type="button"
                      className="secondary-button compact-button config-tls-browse-button"
                      disabled={proxyControlsDisabled || proxyFileSelecting !== null}
                      title={st('reverseProxySelectKeyTitle')}
                      onClick={() => void selectProxyFile('key')}
                    >
                      <FolderOpen size={16} aria-hidden="true" />
                      {proxyFileSelecting === 'key' ? t('common.processing') : t('config.tls.browse')}
                    </button>
                  </div>
                  <span id="config-reverse-proxy-key-path-error" className="config-field-error" role="alert">{proxyFieldErrors.keyPath || ' '}</span>
                </div>
              </div>

              <div className="config-network-grid" aria-label={st('reverseProxyStatus')}>
                <div className="config-network-field">
                  <span className="config-field-label"><span>{st('reverseProxyStatusRunning')}</span></span>
                  <span>{proxyState?.running ? st('reverseProxyRunning') : st('reverseProxyStopped')}</span>
                </div>
                <div className="config-network-field">
                  <span className="config-field-label"><span>{st('reverseProxyStatusListening')}</span></span>
                  <span>{proxyState?.listening ?? '—'}</span>
                </div>
                <div className="config-network-field">
                  <span className="config-field-label"><span>{st('reverseProxyStatusTarget')}</span></span>
                  <span>{proxyState?.target ?? '—'}</span>
                </div>
                <div className="config-network-field">
                  <span className="config-field-label"><span>{st('reverseProxyStatusRequests')}</span></span>
                  <span>{String(proxyState?.requestsTotal ?? 0)}</span>
                </div>
              </div>

              {proxyState?.hardening ? (
                proxyState.hardening.loopbackBind && proxyState.hardening.trustedProxies && !proxyState.hardening.restartRequired ? (
                  <Notice tone="success">
                    {st('reverseProxyHardeningOk')}
                  </Notice>
                ) : proxyState.running && proxyState.hardening.restartRequired ? (
                  <Notice tone="warn">
                    {st('reverseProxyHardeningPending')}
                  </Notice>
                ) : proxyState.running && (!proxyState.hardening.loopbackBind || !proxyState.hardening.trustedProxies) ? (
                  <Notice tone="warn">
                    {st('reverseProxyHardeningFailed')}
                  </Notice>
                ) : null
              ) : null}

              <details>
                <summary>{st('reverseProxyAdvancedTitle')}</summary>
                <p className="config-diagnostics-intro">{st('reverseProxyAdvancedHint')}</p>
                <div className="config-network-grid">
                  <div className="config-network-field">
                    <span className="config-field-label">
                      <span>{st('reverseProxyListenHost')}</span>
                      <SettingsHelp label={st('reverseProxyListenHost')}>{st('reverseProxyListenHostHint')}</SettingsHelp>
                    </span>
                    <code>0.0.0.0</code>
                    <small>{st('reverseProxyBindHint')}</small>
                  </div>

                  <div className="config-network-field">
                    <span className="config-field-label">
                      <label htmlFor="config-input-reverse-proxy-target-port">{st('reverseProxyTargetPort')}</label>
                      <SettingsHelp label={st('reverseProxyTargetPort')}>{st('reverseProxyTargetPortHint')}</SettingsHelp>
                    </span>
                    <input
                      id="config-input-reverse-proxy-target-port"
                      className={`config-network-input ${proxyFieldErrors.targetPort ? 'error' : ''}`}
                      type="number"
                      min={1}
                      max={65535}
                      value={proxyDraft.targetPort || ''}
                      disabled={proxyControlsDisabled}
                      placeholder={String(settings?.port ?? 8317)}
                      aria-invalid={Boolean(proxyFieldErrors.targetPort)}
                      aria-describedby={proxyFieldErrors.targetPort ? 'config-reverse-proxy-target-port-error' : undefined}
                      onChange={(event) => {
                        const val = parseInt(event.currentTarget.value, 10);
                        setProxyDraft(prev => ({ ...prev, targetPort: Number.isNaN(val) ? 0 : val }));
                        setProxyDirty(true);
                        clearProxyFieldError('targetPort');
                      }}
                    />
                    <span id="config-reverse-proxy-target-port-error" className="config-field-error" role="alert">{proxyFieldErrors.targetPort || ' '}</span>
                  </div>
                </div>
              </details>

              {proxyState?.error ? (
                <Notice tone="error" className="config-reverse-proxy-error">
                  {proxyState.error}
                </Notice>
              ) : null}

              <div aria-live="polite">
                {renderFeedback(proxyFeedback)}
              </div>
            </div>
          )}

          <div className="config-settings-save-row">
            <button
              type="button"
              className="secondary-button compact-button"
              disabled={proxyControlsDisabled || proxyInitialLoading || !proxyDirty}
              onClick={discardProxyDraft}
            >
              {t('agents.catalog.discard')}
            </button>
            <button
              type="button"
              className="primary-button compact-button"
              disabled={proxyControlsDisabled || proxyInitialLoading || !proxyDirty}
              onClick={() => void handleProxySave()}
            >
              <Check size={16} aria-hidden="true" />
              {proxyAction === 'save' ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </section>
<section id="config-native-routing" tabIndex={-1} hidden={searching || activeSubpage !== 'routing'}
            className="surface-card config-network-section"
            aria-labelledby="config-routing-section-title"
          >
            <div className="config-network-section-heading config-section-heading-with-actions">
              <div className="config-network-section-title">
                <Route size={16} aria-hidden="true" />
                <h3 id="config-routing-section-title">{st('nativeRouting')}</h3>
              </div>
              <span className="config-card-status" role="status">{busyAction === 'routing' ? <span className="state-pill">{t('common.saving')}</span> : nativeDirty.routing ? st('dirty') : ''}</span>

            </div>
            {renderFeedback(routingFeedback)}
            {nativeSectionsPending ? renderNativeSkeleton() : (<>
            <div className="config-network-grid">
              <div className="config-network-field config-network-toggle">
                <div>
                  <span className="config-field-label"><span>{t('config.network.sessionAffinity')}</span><SettingsHelp label={t('config.network.sessionAffinity')}>{t('config.network.sessionAffinityHint')}</SettingsHelp></span>

                </div>
                <Switch title={t('config.network.sessionAffinity')} aria-label={t('config.network.sessionAffinity')} checked={sessionAffinityDraft} disabled={routingControlsDisabled} onChange={(event) => {
                      markDraftDirty('sessionAffinity');
                      setSessionAffinityDraft(event.currentTarget.checked);
                    }} />
              </div>

              <div className="config-network-field">
                <span className="config-field-label"><label htmlFor="config-input-config-network-sessionTtl">
                  <Clock3 size={15} aria-hidden="true" />
                  {t('config.network.sessionTtl')}
                </label><SettingsHelp label={t('config.network.sessionTtl')}>{t('config.network.sessionTtlHint')}</SettingsHelp></span>
                <input
                  id="config-input-config-network-sessionTtl"
                  className={`config-network-input ${sessionTtlError ? 'error' : ''}`}
                  type="text"
                  value={sessionTtlDraft}
                  disabled={routingControlsDisabled}
                  placeholder="1h"
                  aria-invalid={Boolean(sessionTtlError)}
                  aria-describedby={sessionTtlError ? 'config-network-sessionTtl-format config-network-sessionTtl-error' : 'config-network-sessionTtl-format'}
                  onChange={(event) => {
                    markDraftDirty('sessionTtl');
                    setSessionTtlDraft(event.currentTarget.value);
                    setSessionTtlError('');
                  }}
                />
                <small id="config-network-sessionTtl-format">{t('config.network.sessionTtlFormat')}</small>
                <span id="config-network-sessionTtl-error" className="config-field-error" role="alert">{sessionTtlError || ' '}</span>

              </div>

              <div className="config-network-field config-network-routing-field">
                <span className="config-network-label">
                  <Route size={15} aria-hidden="true" />
                  {t('config.routing.title')}
                  <span className="config-inline-status">{st('automatic')}</span>
                </span>
                <SegmentedControl className="routing-segmented" aria-label={t('config.routing.title')} value={settings?.routingStrategy ?? ''}
                  disabled={routingControlsDisabled} onChange={value => void changeRoutingStrategy(value)}
                  items={ROUTING_OPTIONS.map(option => ({ value: option.value, title: option.value, label: option.value === 'weighted-round-robin' ? templateText(templateMessages.weighted, locale) : t(option.labelKey) }))} />
                <small className="sr-only" title={settings?.routingStrategy || undefined}>
                  {loading
                    ? t('common.loading')
                    : settings === null
                      ? t('common.unavailable')
                      : routingStrategyLabel(settings.routingStrategy, t, locale)}
                </small>
              </div>
            </div>

          <div className="config-settings-save-row"><button
                type="button"
                className="secondary-button compact-button"
                disabled={routingControlsDisabled || !sessionRoutingDirty}
                onClick={discardSessionRoutingDraft}
              >
                {t('agents.catalog.discard')}
              </button><button
                type="button"
                className="primary-button compact-button"
                disabled={routingControlsDisabled || !sessionRoutingDirty}
                onClick={() => void saveSessionRoutingSettings()}
              >
                <Check size={16} aria-hidden="true" />
                {busyAction === 'routing' ? t('common.saving') : t('common.save')}
              </button></div></>)}
        </section>
<section id="config-native-retry" tabIndex={-1} hidden={searching || activeSubpage !== 'routing'}
            className="surface-card config-network-section"
            aria-labelledby="config-retry-section-title"
          >
            <div className="config-network-section-heading config-section-heading-with-actions">
              <div className="config-network-section-title">
                <RefreshCw size={16} aria-hidden="true" />
                <h3 id="config-retry-section-title">{st('nativeRetry')}</h3>
              </div>
              <span className="config-card-status" role="status">{busyAction === 'retry' ? <span className="state-pill">{t('common.saving')}</span> : nativeDirty.retry ? st('dirty') : ''}</span>

            </div>
            {renderFeedback(retryFeedback)}
            {nativeSectionsPending ? renderNativeSkeleton() : (<>
            <div className="config-network-grid">
              <CoolingToggle disabledCooling={disableCoolingDraft} disabled={retryControlsDisabled}
                onChange={(value) => {
                  markDraftDirty('disableCooling');
                  setDisableCoolingDraft(value);
                }} />

              <div className="config-network-field">
                <span className="config-field-label"><label htmlFor="config-input-config-network-requestRetry">{t('config.network.requestRetry')}</label><SettingsHelp label={t('config.network.requestRetry')}>{templateText(templateMessages.retryHint, locale)}</SettingsHelp></span>
                <input
                  id="config-input-config-network-requestRetry"
                  className={`config-network-input ${retryError ? 'error' : ''}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={10}
                  value={requestRetryDraft}
                  disabled={retryControlsDisabled}
                  aria-invalid={Boolean(retryError)}
                  onChange={(event) => {
                    markDraftDirty('requestRetry');
                    setRequestRetryDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 10));
                    setRetryError('');
                  }}
                />

              </div>

              <div className="config-network-field">
                <span className="config-field-label"><label htmlFor="config-input-config-network-maxRetryCredentials">{t('config.network.maxRetryCredentials')}</label><SettingsHelp label={t('config.network.maxRetryCredentials')}>{templateText(templateMessages.credentialsHint, locale)}</SettingsHelp></span>
                <input
                  id="config-input-config-network-maxRetryCredentials"
                  className={`config-network-input ${retryError ? 'error' : ''}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={10}
                  value={maxRetryCredentialsDraft}
                  disabled={retryControlsDisabled}
                  aria-invalid={Boolean(retryError)}
                  onChange={(event) => {
                    markDraftDirty('maxRetryCredentials');
                    setMaxRetryCredentialsDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 10));
                    setRetryError('');
                  }}
                />

              </div>

              <div className="config-network-field">
                <span className="config-field-label"><label htmlFor="config-input-config-network-maxRetryInterval">{t('config.network.maxRetryInterval')}</label><SettingsHelp label={t('config.network.maxRetryInterval')}>{templateText(templateMessages.waitHint, locale)}</SettingsHelp></span>
                <span className="config-input-with-unit">
                <input
                  id="config-input-config-network-maxRetryInterval"
                  className={`config-network-input ${retryError ? 'error' : ''}`}
                  type="text"
                  inputMode="numeric"
                  pattern="-?[0-9]*"
                  maxLength={11}
                  value={maxRetryIntervalDraft}
                  disabled={retryControlsDisabled}
                  aria-invalid={Boolean(retryError)}
                  onChange={(event) => {
                    markDraftDirty('maxRetryInterval');
                    const raw = event.currentTarget.value;
                    setMaxRetryIntervalDraft(`${raw.startsWith('-') ? '-' : ''}${raw.replace(/\D/g, '').slice(0, 10)}`);
                    setRetryError('');
                  }}
                />
                <span className="config-input-unit" aria-hidden="true">{t('config.unit.seconds')}</span>
                </span>

              </div>

              <div className="config-network-field">
                <span className="config-field-label"><label htmlFor="config-input-config-network-streamingBootstrapRetries">{t('config.network.streamingBootstrapRetries')}</label><SettingsHelp label={t('config.network.streamingBootstrapRetries')}>{t('config.network.streamingBootstrapRetriesHint')}</SettingsHelp></span>
                <input
                  id="config-input-config-network-streamingBootstrapRetries"
                  className={`config-network-input ${retryError ? 'error' : ''}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={10}
                  value={streamingBootstrapRetriesDraft}
                  disabled={retryControlsDisabled}
                  aria-invalid={Boolean(retryError)}
                  onChange={(event) => {
                    markDraftDirty('streamingBootstrapRetries');
                    setStreamingBootstrapRetriesDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 10));
                    setRetryError('');
                  }}
                />

              </div>
            </div>

          <div className="config-settings-save-row"><button
                type="button"
                className="secondary-button compact-button"
                disabled={retryControlsDisabled || !retrySettingsDirty}
                onClick={discardRetryDraft}
              >
                {t('agents.catalog.discard')}
              </button><button
                type="button"
                className="primary-button compact-button"
                disabled={retryControlsDisabled || !retrySettingsDirty}
                onClick={() => void saveRetrySettings()}
              >
                <Check size={16} aria-hidden="true" />
                {busyAction === 'retry' ? t('common.saving') : t('common.save')}
              </button></div></>)}
        </section>
<section id="config-native-logging" tabIndex={-1} hidden={searching || activeSubpage !== 'diagnostics'} className="panel surface-card config-diagnostics-panel">
          <div className="config-panel-heading">
            <div className="config-heading-title">
              <FileText size={18} aria-hidden="true" />
              <h2>{t('config.diagnostics.title')}</h2>
            </div>
            <div className="config-heading-actions">
              {loggingSettingsBusy ? <span className="state-pill">{t('common.saving')}</span> : null}
            </div>
          </div>

          {nativeSectionsPending ? renderNativeSkeleton() : (<>
          <div className="config-diagnostics-toggle-grid">
            <div className="config-diagnostics-setting">
              <span className="config-diagnostics-setting-icon" aria-hidden="true"><Bug size={18} /></span>
              <div className="config-diagnostics-setting-copy">
                <span className="config-field-label"><strong>{t('config.diagnostics.debug.title')}</strong><SettingsHelp label={t('config.diagnostics.debug.title')}>{t('config.diagnostics.debug.description')}</SettingsHelp></span>

              </div>
              <Switch title={t('config.diagnostics.debug.title')} checked={debugDraft} aria-label={t('config.diagnostics.debug.title')} disabled={diagnosticsControlsDisabled} onChange={(event) => {
                    setDebugDraft(event.currentTarget.checked);
                    markLoggingDraftDirty();
                  }} />
            </div>

            <div className="config-diagnostics-setting">
              <span className="config-diagnostics-setting-icon" aria-hidden="true"><Gauge size={18} /></span>
              <div className="config-diagnostics-setting-copy">
                <span className="config-field-label"><strong>{t('config.diagnostics.commercial.title')}</strong><SettingsHelp label={t('config.diagnostics.commercial.title')}>{t('config.diagnostics.commercial.description')} {t('config.diagnostics.commercial.warning')}</SettingsHelp></span>

              </div>
              <Switch title={t('config.diagnostics.commercial.title')} checked={commercialModeDraft} aria-label={t('config.diagnostics.commercial.title')} disabled={diagnosticsControlsDisabled} onChange={(event) => {
                    setCommercialModeDraft(event.currentTarget.checked);
                    markLoggingDraftDirty();
                  }} />
            </div>

            <div className="config-diagnostics-setting">
              <span className="config-diagnostics-setting-icon" aria-hidden="true"><HardDrive size={18} /></span>
              <div className="config-diagnostics-setting-copy">
                <span className="config-field-label"><strong>{t('config.diagnostics.fileLogging.title')}</strong><SettingsHelp label={t('config.diagnostics.fileLogging.title')}>{t('config.diagnostics.fileLogging.description')}</SettingsHelp></span>

              </div>
              <Switch title={t('config.diagnostics.fileLogging.title')} checked={loggingToFileDraft} aria-label={t('config.diagnostics.fileLogging.title')} disabled={diagnosticsControlsDisabled} onChange={(event) => {
                    setLoggingToFileDraft(event.currentTarget.checked);
                    markLoggingDraftDirty();
                  }} />
            </div>

            <div className="config-diagnostics-setting">
              <span className="config-diagnostics-setting-icon" aria-hidden="true"><Database size={18} /></span>
              <div className="config-diagnostics-setting-copy">
                <span className="config-field-label"><strong>{t('config.diagnostics.usage.title')}</strong><SettingsHelp label={t('config.diagnostics.usage.title')}>{t('config.diagnostics.usage.description')}</SettingsHelp></span>

              </div>
              <Switch title={t('config.diagnostics.usage.title')} checked={usageStatisticsDraft} aria-label={t('config.diagnostics.usage.title')} disabled={diagnosticsControlsDisabled} onChange={(event) => {
                    setUsageStatisticsDraft(event.currentTarget.checked);
                    markLoggingDraftDirty();
                  }} />
            </div>
          </div>

          <div className="config-diagnostics-fields">
            <div className="config-diagnostics-field">
              <span className="config-field-label"><label htmlFor="config-input-config-diagnostics-maxSize-title">{t('config.diagnostics.maxSize.title')}</label><SettingsHelp label={t('config.diagnostics.maxSize.title')}>{t('config.diagnostics.maxSize.hint')}</SettingsHelp></span>
              <span className="config-input-with-unit">
              <input
                  id="config-input-config-diagnostics-maxSize-title"
                className="config-dialog-text-input"
                type="number"
                min="0"
                step="1"
                value={logsMaxTotalSizeDraft}
                disabled={diagnosticsControlsDisabled}
                onChange={(event) => {
                  setLogsMaxTotalSizeDraft(event.currentTarget.value);
                  markLoggingDraftDirty();
                }}
              />
              <span className="config-input-unit" aria-hidden="true">{t('config.unit.mb')}</span>
              </span>

            </div>
            <div className="config-diagnostics-field">
              <span className="config-field-label"><label htmlFor="config-input-config-diagnostics-errorFiles-title">{t('config.diagnostics.errorFiles.title')}</label><SettingsHelp label={t('config.diagnostics.errorFiles.title')}>{t('config.diagnostics.errorFiles.hint')}</SettingsHelp></span>
              <span className="config-input-with-unit">
              <input
                  id="config-input-config-diagnostics-errorFiles-title"
                className="config-dialog-text-input"
                type="number"
                min="0"
                step="1"
                value={errorLogsMaxFilesDraft}
                disabled={diagnosticsControlsDisabled}
                onChange={(event) => {
                  setErrorLogsMaxFilesDraft(event.currentTarget.value);
                  markLoggingDraftDirty();
                }}
              />
              <span className="config-input-unit" aria-hidden="true">{t('config.unit.count')}</span>
              </span>

            </div>
            <div className="config-diagnostics-field">
              <span className="config-field-label"><label htmlFor="config-input-config-diagnostics-redisRetention-title">{t('config.diagnostics.redisRetention.title')}</label><SettingsHelp label={t('config.diagnostics.redisRetention.title')}>{t('config.diagnostics.redisRetention.hint')}</SettingsHelp></span>
              <span className="config-input-with-unit">
              <input
                  id="config-input-config-diagnostics-redisRetention-title"
                className="config-dialog-text-input"
                type="number"
                min="1"
                max="3600"
                step="1"
                value={redisUsageRetentionDraft}
                disabled={diagnosticsControlsDisabled}
                onChange={(event) => {
                  setRedisUsageRetentionDraft(event.currentTarget.value);
                  markLoggingDraftDirty();
                }}
              />
              <span className="config-input-unit" aria-hidden="true">{t('config.unit.seconds')} · 1–3600</span>
              </span>

            </div>
          </div>

          {settings && commercialModeDraft !== settings.commercialMode ? (
            <Notice tone="warn" icon={<AlertCircle size={16} />}>{st('restart')}</Notice>
          ) : null}

          <div className="config-diagnostics-footer">
            <span className={`config-form-message ${loggingError ? 'error' : ''}`} role="alert">
              {loggingError || ' '}
            </span>
            <div className="config-diagnostics-actions"><span className="config-card-status" role="status">{loggingSettingsDirty ? st('dirty') : ''}</span>
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={diagnosticsControlsDisabled}
                onClick={() => void handleOpenCoreLogsDirectory()}
              >
                <FolderOpen size={16} aria-hidden="true" />
                {t('config.diagnostics.openLogs')}
              </button>
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={diagnosticsControlsDisabled || !loggingSettingsDirty}
                onClick={discardLoggingDraft}
              >
                {t('agents.catalog.discard')}
              </button>
              <button
                type="button"
                className="primary-button compact-button"
                disabled={diagnosticsControlsDisabled || !loggingSettingsDirty}
                onClick={() => void saveCoreLoggingSettings()}
              >
                <Check size={16} aria-hidden="true" />
                {loggingSettingsBusy ? t('common.saving') : t('common.save')}
              </button>
            </div>
            {renderFeedback(loggingFeedback)}
          </div></>)}
        </section>
<section id="config-native-software" tabIndex={-1} hidden={searching || activeSubpage !== 'software'} className="panel surface-card config-software-panel">
            <div className="config-panel-heading">
              <div className="config-heading-title">
                <Settings2 size={18} aria-hidden="true" />
                <h2>{t('config.software.title')}</h2>
              </div>
              <div className="config-heading-actions">
                {busyAction === 'software' ? (
                  <span className="state-pill">{t('common.saving')}</span>
                ) : softwareStatusLabel ? (
                  <span className={`state-pill ${softwareStatusIsSaved ? 'success' : ''}`}>
                    {softwareStatusLabel}
                  </span>
                ) : null}

              </div>
            </div>
            {nativeSectionsPending ? renderNativeSkeleton() : (<>
            <div className="config-software-content">
              {renderFeedback(softwareFeedback)}
              <div className="config-software-settings-list">
                <div className="config-software-setting-row">
                  <div className="config-software-setting-copy">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <Clock3 size={18} />
                    </span>
                    <div>
                      <strong>{t('config.software.autostart')}</strong>
                    </div>
                  </div>
                  <Switch title={t('config.software.autostart')} aria-label={t('config.software.autostart')} checked={softwareAutostartDraft} disabled={softwareControlsDisabled} onChange={(event) => {
                        setSoftwareSavedStatusVisible(false);
                        setSoftwareAutostartDraft(event.currentTarget.checked);
                      }} />
                </div>
                <div className="config-software-setting-row">
                  <div className="config-software-setting-copy">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <Power size={18} />
                    </span>
                    <div>
                      <strong>{t('config.software.startCoreOnLaunch')}</strong>
                    </div>
                  </div>
                  <Switch title={t('config.software.startCoreOnLaunch')} aria-label={t('config.software.startCoreOnLaunch')} checked={softwareStartCoreDraft} disabled={softwareControlsDisabled} onChange={(event) => {
                        setSoftwareSavedStatusVisible(false);
                        setSoftwareStartCoreDraft(event.currentTarget.checked);
                      }} />
                </div>
                <div className="config-software-setting-row">
                  <div className="config-software-setting-copy">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <EyeOff size={18} />
                    </span>
                    <div>
                      <span className="config-field-label"><strong>{t('config.software.silentStart')}</strong><SettingsHelp label={t('config.software.silentStart')}>{t('config.software.silentStartDescription')}</SettingsHelp></span>

                    </div>
                  </div>
                  <Switch title={t('config.software.silentStart')} aria-label={t('config.software.silentStart')} checked={softwareSilentStartDraft} disabled={softwareControlsDisabled} onChange={(event) => {
                        setSoftwareSavedStatusVisible(false);
                        setSoftwareSilentStartDraft(event.currentTarget.checked);
                      }} />
                </div>
                <div className="config-software-setting-row config-software-close-row">
                  <div className="config-software-setting-copy">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <Terminal size={18} />
                    </span>
                    <div>
                      <strong>{t('config.software.defaultTerminal')}</strong>
                    </div>
                  </div>
                  <label className="config-software-select">
                    <span className="sr-only">{t('config.software.defaultTerminal')}</span>
                    <Select
                      className="config-network-input"
                      value={softwareDefaultTerminalDraft}
                      disabled={softwareControlsDisabled}
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
                    </Select>
                  </label>
                </div>
                <div className="config-software-setting-row config-software-close-row">
                  <div className="config-software-setting-copy">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <X size={18} />
                    </span>
                    <div>
                      <strong>{t('config.software.closeBehavior')}</strong>
                    </div>
                  </div>
                  <label className="config-software-select">
                    <span className="sr-only">{t('config.software.closeBehavior')}</span>
                    <Select
                      className="config-network-input"
                      value={softwareCloseBehaviorDraft}
                      disabled={softwareControlsDisabled}
                      onChange={(event) => {
                        setSoftwareSavedStatusVisible(false);
                        setSoftwareCloseBehaviorDraft(event.currentTarget.value as CloseBehavior);
                      }}
                    >
                      <option value="ask">{t('config.software.behavior.ask')}</option>
                      <option value="minimize-to-tray">{t('config.software.behavior.minimize')}</option>
                      <option value="exit">{t('config.software.behavior.exit')}</option>
                    </Select>
                  </label>
                </div>
              </div>
            </div>

          <div className="config-settings-save-row"><button
                  type="button"
                  className="secondary-button compact-button"
                  disabled={softwareControlsDisabled || !softwareSettingsDirty}
                  onClick={discardSoftwareDraft}
                >
                  {t('agents.catalog.discard')}
                </button><button
                  type="button"
                  className="primary-button compact-button"
                  disabled={softwareControlsDisabled || !softwareSettingsDirty}
                  onClick={() => void saveSoftwareSettings()}
                >
                  <Check size={16} aria-hidden="true" />
                  {busyAction === 'software' ? t('common.saving') : t('common.save')}
                </button></div></>)}
        </section>
          </div>
          <div id="config-template-panel" hidden={searching || templateGroups.length === 0}><TemplateConfigSection groups={allSettingsTemplateGroups} visibleGroups={templateGroups.map(group => group.id)} onDirtyGroupsChange={setDirtyTemplateGroups} /></div>
          <div className="surface-card" id="config-native-aliases" tabIndex={-1} role="region" aria-label={t('app.nav.thinkingAliases')} hidden={searching || activeSubpage !== 'aliases'}>{aliasesVisited ? <ThinkingAliasesPage embedded /> : null}</div>
          <div className="surface-card" id="config-native-sensitive-words" tabIndex={-1} role="region" aria-label={t('config.sensitiveWords.title')} hidden={searching || activeSubpage !== 'requests'}>{sensitiveWordsVisited ? <SensitiveWordsPage onDirtyChange={setSensitiveWordsDirty} /> : null}</div>
        </div>
      </div>

      {addDialogOpen ? (
        <Dialog
          as="form"
          labelledBy="add-api-key-title"
          onSubmit={(event) => void submitApiKey(event)}
          onClose={closeAddDialog}
          closeDisabled={keyMutationBusy}
          dismissOnBackdrop
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
          {renderFeedback(keyFeedback)}

          <div className="config-dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={generateApiKey}
              disabled={keyMutationBusy}
            >
              {t('config.keys.generate')}
            </button>
            <button type="submit" className="primary-button" disabled={keyMutationBusy}>
              {editingApiKey === null ? <Plus size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
              {keyMutationBusy
                ? editingApiKey === null ? t('config.keys.adding') : t('common.saving')
                : editingApiKey === null ? t('common.add') : t('common.save')}
            </button>
          </div>
        </Dialog>
      ) : null}

      {deleteIndex !== null ? (
        <Dialog
          as="div"
          alert
          className={`config-dialog config-delete-dialog ${deletingLastKey ? 'has-warning' : ''}`}
          labelledBy="delete-api-key-title"
          onClose={() => setDeleteIndex(null)}
          closeDisabled={busyAction === 'delete-key'}
          dismissOnBackdrop
        >
          <div className="config-dialog-heading">
            <div>
              <Trash2 size={19} aria-hidden="true" />
              <h2 id="delete-api-key-title">{t('config.keys.deleteTitle')}</h2>
            </div>
          </div>
          <code className="config-delete-key">{maskApiKey(selectedDeleteKey)}</code>
          {renderFeedback(keyFeedback)}
          {deletingLastKey ? (
            <Notice tone="error" icon={<AlertCircle size={17} />}>{t('config.keys.deleteAllWarning')}</Notice>
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
        </Dialog>
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

function routingStrategyLabel(strategy: string | undefined, t: ReturnType<typeof useI18n>['t'], locale: ReturnType<typeof useI18n>['locale']) {
  if (!strategy) {
    return t('common.loading');
  }
  const option = ROUTING_OPTIONS.find((item) => item.value === strategy);
  if (strategy === 'weighted-round-robin') return templateText(templateMessages.weighted, locale);
  return option ? t(option.labelKey) : strategy;
}
