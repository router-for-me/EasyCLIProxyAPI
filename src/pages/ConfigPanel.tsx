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
  saveCoreProxySettings,
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
import { managementApi } from '../services/managementApi';
import { selectedRemoteEndpoint } from '../services/remoteCpa';
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
import { SensitiveWordsPage, type SensitiveWordsPageHandle } from './SensitiveWordsPage';
import { Tabs } from '../components/Tabs';
import { SegmentedControl } from '../components/SegmentedControl';
import { Dialog } from '../components/Dialog';
import { useConfirmation } from '../components/ConfirmationDialog';
import { TemplateConfigSection, type TemplateConfigSectionHandle } from '../components/TemplateConfigSection';
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
  | 'outbound-proxy'
  | 'logging'
  | 'open-logs'
  | 'routing'
  | 'network'
  | 'retry'
  | 'tls'
  | null;
type ConfigSubpage = SettingsCategory;

type SoftwarePreferenceValues = {
  closeBehavior: CloseBehavior;
  autostartEnabled: boolean;
  startCoreOnLaunch: boolean;
  silentStartEnabled: boolean;
  defaultTerminal: string;
};

const DEFAULT_SOFTWARE_PREFERENCES: SoftwarePreferenceValues = {
  closeBehavior: 'ask',
  autostartEnabled: false,
  startCoreOnLaunch: true,
  silentStartEnabled: false,
  defaultTerminal: 'auto',
};

const pickSoftwarePreferences = (source: SoftwareSettings): SoftwarePreferenceValues => ({
  closeBehavior: source.closeBehavior,
  autostartEnabled: source.autostartEnabled,
  startCoreOnLaunch: source.startCoreOnLaunch,
  silentStartEnabled: source.silentStartEnabled,
  defaultTerminal: source.defaultTerminal,
});

const sameSoftwarePreferences = (a: SoftwarePreferenceValues, b: SoftwarePreferenceValues) => (
  a.closeBehavior === b.closeBehavior
  && a.autostartEnabled === b.autostartEnabled
  && a.startCoreOnLaunch === b.startCoreOnLaunch
  && a.silentStartEnabled === b.silentStartEnabled
  && a.defaultTerminal === b.defaultTerminal
);
type SettingDestination = { category: ConfigSubpage; target: string; field?: string };
type SettingSearchEntry = SettingDestination & { title: string; context: string; keywords: string };

type NetworkDraftField =
  | 'port'
  | 'host'
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
const isInvalidListenHost = (value: string) => /[\s/\\]|^[^:]+:\d+$/.test(value);

type ReverseProxyFieldError = Partial<Record<'listenHost' | 'listenPort' | 'targetPort' | 'certPath' | 'keyPath', string>>;

export function ConfigPanelPage() {
  const { t, locale } = useI18n();
  const external = Boolean(selectedRemoteEndpoint());
  const [serverLogs, setServerLogs] = useState<string[] | null>(null);
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const { status: coreStatus, publishStatus, refreshStatus } = useCoreRuntime();
  const [settings, setSettings] = useState<CoreConfigSettings | null>(null);
  const [softwareSettings, setSoftwareSettings] = useState<SoftwareSettings | null>(null);
  const [softwareSettingsLoading, setSoftwareSettingsLoading] = useState(true);
  const [softwareValues, setSoftwareValues] = useState<SoftwarePreferenceValues>(DEFAULT_SOFTWARE_PREFERENCES);
  const [softwareSaving, setSoftwareSaving] = useState(false);
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
  const [revealedKeyMap, setRevealedKeyMap] = useState<Record<string, boolean>>({});
  const [managementSecretError, setManagementSecretError] = useState('');
  const [outboundProxyDraft, setOutboundProxyDraft] = useState<Pick<CoreConfigSettings, 'proxyUrl' | 'proxyOverride'> | null>(null);
  const [outboundProxyError, setOutboundProxyError] = useState(false);
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
  const outboundProxyFeedback = useAppNotice();
  const routingFeedback = useAppNotice();
  const retryFeedback = useAppNotice();
  const tlsFeedback = useAppNotice();
  const proxyFeedback = useAppNotice();
  const softwareFeedback = useAppNotice();
  const renderFeedback = (feedback: ReturnType<typeof useAppNotice>, visible = true) => (
    visible ? <FloatingNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} /> : null
  );
  const [activeSubpage, setActiveSubpage] = useState<ConfigSubpage>('general');
  const [settingsSearch, setSettingsSearch] = useState('');
  const [dirtyTemplateGroups, setDirtyTemplateGroups] = useState<readonly string[]>([]);
  const [sensitiveWordsDirty, setSensitiveWordsDirty] = useState(false);
  const [sensitiveWordsVisited, setSensitiveWordsVisited] = useState(false);
  const [aliasesVisited, setAliasesVisited] = useState(false);
  const [pendingDestination, setPendingDestination] = useState<SettingDestination | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const categoryNavigationRef = useRef<HTMLDivElement>(null);
  const templateSectionRef = useRef<TemplateConfigSectionHandle>(null);
  const sensitiveWordsRef = useRef<SensitiveWordsPageHandle>(null);
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
  const [sessionAffinityDraft, setSessionAffinityDraft] = useState(false);
  const [sessionTtlDraft, setSessionTtlDraft] = useState('');
  const [disableCoolingDraft, setDisableCoolingDraft] = useState(true);
  const [requestRetryDraft, setRequestRetryDraft] = useState('3');
  const [maxRetryCredentialsDraft, setMaxRetryCredentialsDraft] = useState('0');
  const [maxRetryIntervalDraft, setMaxRetryIntervalDraft] = useState('30');
  const [streamingBootstrapRetriesDraft, setStreamingBootstrapRetriesDraft] = useState('0');
  const [portError, setPortError] = useState('');
  const [hostError, setHostError] = useState('');
  const [sessionTtlError, setSessionTtlError] = useState('');
  const [proxyFieldErrors, setProxyFieldErrors] = useState<ReverseProxyFieldError>({});
  const [retryError, setRetryError] = useState('');
  const networkDraftDirtyRef = useRef<NetworkDraftDirty>(cleanNetworkDraft());
  const loggingDraftDirtyRef = useRef(false);
  const otherDraftDirtyRef = useRef({ tls: false });
  const copyTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const softwarePersistedRef = useRef<SoftwareSettings | null>(null);
  const softwareDesiredRef = useRef<SoftwarePreferenceValues | null>(null);
  const softwareSaveInFlightRef = useRef(false);
  const softwareMutationSeqRef = useRef(0);
  const softwareSavedTimerRef = useRef<number | null>(null);

  const [proxyState, setProxyState] = useState<ReverseProxyState | null>(null);
  const [proxyInitialLoading, setProxyInitialLoading] = useState(true);
  const [proxyAction, setProxyAction] = useState<'start' | 'stop' | 'save' | null>(null);
  const [proxyDirty, setProxyDirty] = useState(false);
  const [backendNotReady, setBackendNotReady] = useState(false);
  const [proxyFileSelecting, setProxyFileSelecting] = useState<'cert' | 'key' | null>(null);
  const proxyFileSelectingRef = useRef(false);
  const [proxyDraft, setProxyDraft] = useState<ReverseProxyConfig>(DEFAULT_REVERSE_PROXY_DRAFT);
  const [listenPortInput, setListenPortInput] = useState(() => String(DEFAULT_REVERSE_PROXY_DRAFT.listenPort));
  const [targetPortInput, setTargetPortInput] = useState(() => String(DEFAULT_REVERSE_PROXY_DRAFT.targetPort));
  const [proxyLanIp, setProxyLanIp] = useState<string | null>(null);

  const normalizePortDigits = (raw: string): string =>
    raw
      .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\D/g, '')
      .slice(0, 5);

  const syncProxyPortInputs = (config: ReverseProxyConfig) => {
    setListenPortInput(config.listenPort > 0 ? String(config.listenPort) : '');
    setTargetPortInput(config.targetPort > 0 ? String(config.targetPort) : '');
  };

  const updateProxyPortInput = (field: 'listenPort' | 'targetPort', rawValue: string, composing = false) => {
    if (composing) {
      if (field === 'listenPort') setListenPortInput(rawValue);
      else setTargetPortInput(rawValue);
      return;
    }
    const digits = normalizePortDigits(rawValue);
    if (field === 'listenPort') setListenPortInput(digits);
    else setTargetPortInput(digits);
    const parsed = digits ? Number.parseInt(digits, 10) : 0;
    setProxyDraft(prev => ({ ...prev, [field]: Number.isNaN(parsed) ? 0 : parsed }));
    setProxyDirty(true);
    clearProxyFieldError(field);
  };

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
        syncProxyPortInputs({ ...DEFAULT_REVERSE_PROXY_DRAFT, ...state.config });
      }
      setBackendNotReady(false);
    } catch {
      setBackendNotReady(true);
    } finally {
      setProxyInitialLoading(false);
    }
  };

  const validateReverseProxyDraft = (draft: ReverseProxyConfig): ReverseProxyFieldError => {
    const errors: ReverseProxyFieldError = {};
    // Ports stay validated while disabled so an already stopped proxy reports
    // field errors instead of silently discarding an unusable draft.
    const hostCandidate = draft.listenHost.trim().replace(/^\[|\]$/g, '');
    if (hostCandidate && isInvalidListenHost(hostCandidate)) {
      errors.listenHost = st('reverseProxyListenHostInvalid');
    }
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

  const handleProxySave = async (): Promise<boolean> => {
    if (proxyControlsDisabled || proxyFileSelectingRef.current) return false;
    const parsedListenPort = Number.parseInt(normalizePortDigits(listenPortInput), 10);
    const parsedTargetPort = Number.parseInt(normalizePortDigits(targetPortInput), 10);
    const normalizedDraft = {
      ...proxyDraft,
      listenPort: Number.isNaN(parsedListenPort) ? 0 : parsedListenPort,
      targetPort: Number.isNaN(parsedTargetPort) ? 0 : parsedTargetPort,
      listenHost: proxyDraft.listenHost.trim().replace(/^\[|\]$/g, '') || '0.0.0.0',
      certPath: proxyDraft.certPath.trim(),
      keyPath: proxyDraft.keyPath.trim(),
    };
    proxyFeedback.clearNotice();
    const saveConfig = resolveReverseProxySaveConfig(normalizedDraft, proxyState?.config, proxyState?.running);
    const fieldErrors = validateReverseProxyDraft(saveConfig);
    setProxyFieldErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) {
      proxyFeedback.showNotice(Object.values(fieldErrors)[0], 'error');
      return false;
    }
    setProxyDraft(saveConfig);
    syncProxyPortInputs(saveConfig);
    setProxyAction('save');
    try {
      const state = await applyReverseProxyConfig(saveConfig);
      setProxyState(state);
      if (state.config) {
        setProxyDraft(state.config);
        syncProxyPortInputs(state.config);
      }
      if (saveConfig.enabled) {
        void loadSettings('preserve');
        void refreshStatus();
      }
      setBackendNotReady(false);
      setProxyDirty(false);
      proxyFeedback.showNotice(state.error || st('reverseProxySaved'), state.error ? 'error' : 'success');
      return !state.error;
    } catch (error) {
      setProxyFieldErrors(prev => ({ ...prev, ...reverseProxyPathErrors(error) }));
      proxyFeedback.showNotice(String(error), 'error');
      try {
        setProxyState(await getReverseProxyState());
        setBackendNotReady(false);
      } catch {
        setBackendNotReady(true);
      }
      return false;
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
    if (external || activeSubpage !== 'proxy' || proxyAction !== null || proxyInitialLoading) return;
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
  }, [external, activeSubpage, proxyAction, proxyInitialLoading]);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    let stop: (() => void) | null = null;
    void loadSettings();
    void loadSoftwareSettings();
    void loadTlsSettings();
    if (!external) void loadReverseProxy();
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
      mountedRef.current = false;
      disposed = true;
      stop?.();
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      if (softwareSavedTimerRef.current !== null) {
        window.clearTimeout(softwareSavedTimerRef.current);
        softwareSavedTimerRef.current = null;
      }
    };
  }, []);

  const applySettings = (result: CoreConfigSettings, mode: DraftRefreshMode = 'replace') => {
    setSettings(result);
    if (mode === 'preserve') {
      const dirty = networkDraftDirtyRef.current;
      if (!dirty.port) setPortDraft(String(result.port));
      if (!dirty.host) setHostDraft(result.host);
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
    const seqAtStart = softwareMutationSeqRef.current;
    if (mode === 'replace') {
      setSoftwareSettingsLoading(true);
      setSoftwareSavedStatusVisible(false);
    }
    try {
      const result = await getSoftwareSettings();
      if (!mountedRef.current) return;
      if (mode === 'preserve' && (softwareSaveInFlightRef.current || softwareMutationSeqRef.current !== seqAtStart)) return;
      softwarePersistedRef.current = result;
      const nextValues = pickSoftwarePreferences(result);
      softwareDesiredRef.current = nextValues;
      setSoftwareSettings(result);
      setSoftwareValues(nextValues);
    } catch (error) {
      if (!mountedRef.current) return;
      if (mode === 'replace') {
        softwarePersistedRef.current = null;
        softwareDesiredRef.current = null;
        setSoftwareSettings(null);
      }
      softwareFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
    } finally {
      if (mountedRef.current) setSoftwareSettingsLoading(false);
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
      : action === 'outbound-proxy' ? outboundProxyFeedback : action === 'routing' ? routingFeedback : keyFeedback;
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

  const outboundProxy = outboundProxyDraft ?? settings ?? { proxyUrl: '', proxyOverride: false };
  const detectedProxyUrl = settings && !settings.proxyOverride ? settings.proxyUrl : '';
  const outboundProxyDirty = settings !== null && (outboundProxy.proxyOverride !== settings.proxyOverride
    || (outboundProxy.proxyOverride && outboundProxy.proxyUrl.trim() !== settings.proxyUrl));
  const outboundProxyDisabled = loading || !settings || busyAction !== null;

  const updateOutboundProxy = (draft: typeof outboundProxyDraft) => {
    setOutboundProxyDraft(draft);
    setOutboundProxyError(false);
    outboundProxyFeedback.clearNotice();
  };

  const performSaveOutboundProxy = async (): Promise<boolean> => {
    if (outboundProxyDisabled || !outboundProxyDirty) return false;
    const proxyUrl = outboundProxy.proxyOverride ? outboundProxy.proxyUrl.trim() : '';
    if (proxyUrl && !/^(https?|socks|socks5h?):\/\//i.test(proxyUrl)) {
      outboundProxyFeedback.clearNotice();
      setOutboundProxyError(true);
      return false;
    }
    const saved = await runMutation('outbound-proxy', () => saveCoreProxySettings(proxyUrl, outboundProxy.proxyOverride), st('outboundProxySaved'));
    if (saved) setOutboundProxyDraft(null);
    return saved;
  };

  const saveOutboundProxy = async (event: FormEvent) => {
    event.preventDefault();
    await performSaveOutboundProxy();
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

  const discardManagementSecretDraft = () => {
    setManagementSecretDraft('');
    setManagementSecretConfirm('');
    setShowManagementSecret(false);
    setManagementSecretError('');
  };

  const performSaveManagementSecret = async (): Promise<boolean> => {
    const secretKey = managementSecretDraft.trim();
    if (!secretKey) {
      setManagementSecretError(t('config.webuiKey.error.empty'));
      return false;
    }
    if (secretKey.length > 512) {
      setManagementSecretError(t('config.webuiKey.error.tooLong'));
      return false;
    }
    if (/[\u0000-\u001f\u007f-\u009f]/.test(secretKey)) {
      setManagementSecretError(t('config.webuiKey.error.invalid'));
      return false;
    }
    if (secretKey !== managementSecretConfirm.trim()) {
      setManagementSecretError(t('config.webuiKey.error.mismatch'));
      return false;
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
    return saved;
  };

  const saveManagementSecret = async (event: FormEvent) => {
    event.preventDefault();
    await performSaveManagementSecret();
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

  const saveCoreLoggingSettings = async (): Promise<boolean> => {
    if (!settings || busyAction !== null) return false;
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
      return false;
    }
    if (
      !Number.isInteger(redisUsageQueueRetentionSeconds)
      || redisUsageQueueRetentionSeconds < 1
      || redisUsageQueueRetentionSeconds > 3600
    ) {
      const message = t('config.diagnostics.error.redisRetention');
      setLoggingError(message);
      return false;
    }

    const commercialModeChanged = commercialModeDraft !== settings.commercialMode;
    setBusyAction('logging');
    setLoggingError('');
    try {
      const result = await saveCoreLoggingSettingsCommand({
        expected: settings,
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
      if (commercialModeChanged && !selectedRemoteEndpoint() && coreStatus?.running) {
        const status = await restartCoreProcess();
        publishStatus(status);
        loggingFeedback.showNotice({ key: 'config.diagnostics.notice.savedAndRestarted' }, 'success');
      } else {
        loggingFeedback.showNotice({ key: 'config.diagnostics.notice.saved' }, 'success');
      }
      return true;
    } catch (error) {
      const message = t('config.error.saveFailed', { error: String(error) });
      setLoggingError(message);
      void refreshStatus();
      void loadSettings('preserve');
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenCoreLogsDirectory = async () => {
    if (busyAction !== null) return;
    setBusyAction('open-logs');
    try {
      if (external) {
        const result = await managementApi.get<{ lines: string[] }>('/observability/logs', { limit: 200 });
        if (!Array.isArray(result?.lines) || !result.lines.every(line => typeof line === 'string')) throw new Error(t('remote.error.invalidResponse'));
        setServerLogs(result.lines);
      } else await openCoreLogsDirectory();
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

  const saveTlsSettings = async (): Promise<boolean> => {
    tlsFeedback.clearNotice();
    if (tlsSettings === null || busyAction !== null) return false;
    const cert = tlsCertDraft.trim();
    const key = tlsKeyDraft.trim();
    if (tlsEnabledDraft && (!cert || !key)) {
      setTlsError(t('config.tls.error.pathsRequired'));
      return false;
    }

    setBusyAction('tls');
    setTlsError('');
    setTlsSavedStatusVisible(false);
    try {
      const result = await saveCoreTlsSettings({
        expected: tlsSettings,
        settings: { enabled: tlsEnabledDraft, cert, key },
      });
      setTlsSettings(result);
      setTlsEnabledDraft(result.enabled);
      setTlsCertDraft(result.cert);
      setTlsKeyDraft(result.key);
      if (!selectedRemoteEndpoint() && coreStatus?.running) {
        const status = await restartCoreProcess();
        publishStatus(status);
        tlsFeedback.showNotice({ key: 'config.tls.notice.savedAndRestarted' }, 'success');
      } else {
        tlsFeedback.showNotice({ key: 'config.tls.notice.saved' }, 'success');
      }
      setTlsSavedStatusVisible(true);
      return true;
    } catch (error) {
      setTlsError(String(error));
      void refreshStatus();
      void loadTlsSettings('preserve');
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const selectTlsFile = async (target: 'cert' | 'key') => {
    if (selectedRemoteEndpoint() || tlsSettings === null || busyAction !== null || tlsFileSelecting !== null) return;
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
      () => setCoreRoutingStrategy({ strategy, expected: { routingStrategy: settings?.routingStrategy } }),
      t('config.notice.routingUpdated'),
    );
  };

  const saveNetworkEndpointSettings = async (): Promise<boolean> => {
    networkFeedback.clearNotice();
    if (!settings || busyAction !== null) return false;
    const host = hostDraft.trim();
    const port = Number(portDraft);
    setHostError('');
    setPortError('');
    if (!host) {
      setHostError(t('config.error.hostRequired'));
      networkFeedback.showNotice({ key: 'config.error.hostRequired' }, 'error');
      return false;
    }
    if (!isValidPort(port)) {
      setPortError(t('config.error.portRange'));
      networkFeedback.showNotice({ key: 'config.error.portRange' }, 'error');
      return false;
    }
    const networkChanged = port !== settings.port || host !== settings.host;
    setBusyAction('network');
    try {
      const result = await saveNetworkEndpointSettingsCommand({
        expected: settings,
        settings: { host, port },
      });
      clearDraftDirty('host');
      clearDraftDirty('port');
      applySettings(result, 'preserve');
      setLoadError('');

      if (networkChanged && !selectedRemoteEndpoint() && coreStatus?.running) {
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
      return true;
    } catch (error) {
      networkFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
      void loadSettings('preserve');
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const saveRetrySettings = async (): Promise<boolean> => {
    retryFeedback.clearNotice();
    if (!settings || busyAction !== null) return false;
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
      return false;
    }
    const [requestRetry, maxRetryCredentials, maxRetryInterval, streamingBootstrapRetries] = retryValues;
    setRetryError('');
    setBusyAction('retry');
    try {
      const result = await saveRetrySettingsCommand({
        expected: settings,
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
      return true;
    } catch (error) {
      retryFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
      void loadSettings('preserve');
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const saveSessionRoutingSettings = async (): Promise<boolean> => {
    routingFeedback.clearNotice();
    if (!settings || busyAction !== null) return false;
    const routingSessionAffinityTtl = sessionTtlDraft.trim();
    if (routingSessionAffinityTtl && !SESSION_TTL_PATTERN.test(routingSessionAffinityTtl)) {
      setSessionTtlError(t('config.error.sessionTtlFormat'));
      routingFeedback.showNotice({ key: 'config.error.sessionTtlFormat' }, 'error');
      return false;
    }
    setSessionTtlError('');
    setBusyAction('routing');
    try {
      const result = await saveSessionRoutingSettingsCommand({
        expected: settings,
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
      return true;
    } catch (error) {
      routingFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
      void loadSettings('preserve');
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const flushSoftwarePreferences = async () => {
    if (softwareSaveInFlightRef.current) return;
    softwareSaveInFlightRef.current = true;
    setSoftwareSaving(true);
    let savedAny = false;
    try {
      while (softwareDesiredRef.current) {
        const target = softwareDesiredRef.current;
        const persisted = softwarePersistedRef.current;
        if (persisted && sameSoftwarePreferences(target, pickSoftwarePreferences(persisted))) {
          break;
        }
        const result = await saveSoftwareSettingsCommand({ settings: target });
        softwarePersistedRef.current = result;
        savedAny = true;
        if (!mountedRef.current) return;
        setSoftwareSettings(result);
        if (softwareDesiredRef.current === target) {
          const confirmed = pickSoftwarePreferences(result);
          softwareDesiredRef.current = confirmed;
          setSoftwareValues(confirmed);
          break;
        }
      }
      if (!mountedRef.current || !savedAny) return;
      setSoftwareSavedStatusVisible(true);
      if (softwareSavedTimerRef.current !== null) {
        window.clearTimeout(softwareSavedTimerRef.current);
      }
      softwareSavedTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) setSoftwareSavedStatusVisible(false);
        softwareSavedTimerRef.current = null;
      }, 2400);
    } catch (error) {
      if (!mountedRef.current) return;
      setSoftwareSavedStatusVisible(false);
      const seqAtFailure = softwareMutationSeqRef.current;
      if (softwarePersistedRef.current) {
        const rollback = pickSoftwarePreferences(softwarePersistedRef.current);
        softwareDesiredRef.current = rollback;
        setSoftwareValues(rollback);
      }
      softwareFeedback.showNotice({ key: 'config.error.saveFailed', variables: { error: String(error) } }, 'error');
      void getSoftwareSettings()
        .then((latest) => {
          if (!mountedRef.current || softwareSaveInFlightRef.current || softwareMutationSeqRef.current !== seqAtFailure) return;
          softwarePersistedRef.current = latest;
          const synced = pickSoftwarePreferences(latest);
          softwareDesiredRef.current = synced;
          setSoftwareSettings(latest);
          setSoftwareValues(synced);
        })
        .catch(() => {});
    } finally {
      softwareSaveInFlightRef.current = false;
      if (mountedRef.current) setSoftwareSaving(false);
    }
  };

  const updateSoftwarePreference = (patch: Partial<SoftwarePreferenceValues>) => {
    const persisted = softwarePersistedRef.current;
    if (!persisted) return;
    const base = softwareDesiredRef.current ?? pickSoftwarePreferences(persisted);
    const next: SoftwarePreferenceValues = { ...base, ...patch };
    if (sameSoftwarePreferences(base, next)) return;
    softwareMutationSeqRef.current += 1;
    softwareDesiredRef.current = next;
    setSoftwareValues(next);
    softwareFeedback.clearNotice();
    if (softwareSavedTimerRef.current !== null) {
      window.clearTimeout(softwareSavedTimerRef.current);
      softwareSavedTimerRef.current = null;
    }
    setSoftwareSavedStatusVisible(false);
    void flushSoftwarePreferences();
  };

  const discardNetworkEndpointDraft = () => {
    if (!settings) return;
    setPortDraft(String(settings.port));
    setHostDraft(settings.host);
    clearDraftDirty('port');
    clearDraftDirty('host');
    setPortError('');
    setHostError('');
  };

  const discardTlsDraft = () => {
    if (!tlsSettings) return;
    setTlsEnabledDraft(tlsSettings.enabled);
    setTlsCertDraft(tlsSettings.cert);
    setTlsKeyDraft(tlsSettings.key);
    setTlsError('');
  };

  const discardProxyDraft = () => {
    const restored = proxyState?.config ?? DEFAULT_REVERSE_PROXY_DRAFT;
    setProxyDraft(restored);
    syncProxyPortInputs(restored);
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
  const tlsSettingsDirty = tlsSettings !== null && (
    tlsEnabledDraft !== tlsSettings.enabled
    || tlsCertDraft.trim() !== tlsSettings.cert
    || tlsKeyDraft.trim() !== tlsSettings.key
  );
  otherDraftDirtyRef.current = { tls: tlsSettingsDirty };
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
  const softwareControlsDisabled = softwareSettingsLoading || softwareSettings === null;
  const proxyControlsDisabled = backendNotReady || proxyInitialLoading || proxyAction !== null || proxyFileSelecting !== null;
  const activateConfigSubpage = (subpage: ConfigSubpage) => {
    setSettingsSearch('');
    setActiveSubpage(subpage);
    if (subpage === 'sensitiveWords') {
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
  const normalizedNetworkHost = hostDraft.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const allowLanDraft = normalizedNetworkHost === '0.0.0.0' || normalizedNetworkHost === '::';
  const nativeDirty = {
    keys: false, management: Boolean(managementSecretDraft || managementSecretConfirm),
    network: networkSettingsDirty, tls: tlsSettingsDirty, routing: sessionRoutingDirty,
    retry: retrySettingsDirty, logging: loggingSettingsDirty,
  };
  const nativeEntries: SettingSearchEntry[] = [
    { category: 'general', target: 'config-native-keys', title: t('config.keys.title'), context: '', keywords: 'API key token 鉴权密钥 api-keys access' },
    { category: 'general', target: 'config-native-management', title: t('config.webuiKey.title'), context: '', keywords: 'WebUI secret-key 密钥 管理接口 面板 密码 management security' },
    { category: 'general', target: 'config-native-network', title: st('nativeNetwork'), context: '', keywords: [t('config.network.port'), t('config.network.listenHost'), t('kernel.control.allowLan'), 'server host port LAN 8317 127.0.0.1 0.0.0.0 允许局域网 局域网 监听 地址'].join(' ') },
    ...(!external ? [{ category: 'general' as const, target: 'config-system-proxy', title: st('outboundProxyTitle'), context: t('config.network.systemProxy'), keywords: 'IP proxy HTTP SOCKS 代理 URL 系统代理' }] : []),
    { category: 'general', target: 'config-native-tls', title: t('config.tls.enable'), context: '', keywords: [t('config.tls.cert'), t('config.tls.key'), 'TLS HTTPS cert key certificate 证书 私钥 加密'].join(' ') },
    { category: 'proxy', target: 'config-native-reverse-proxy', title: st('reverseProxyTitle'), context: '', keywords: [st('reverseProxyListenHost'), st('reverseProxyListenPort'), st('reverseProxyTargetPort'), st('reverseProxyCertPath'), st('reverseProxyKeyPath'), 'reverse proxy 反向代理 HTTPS 转发 监听 端口'].join(' ') },
    { category: 'routing', target: 'config-native-routing', title: st('nativeRouting'), context: '', keywords: [t('config.network.sessionAffinity'), t('config.network.sessionTtl'), t('config.routing.title'), 'session affinity ttl routing strategy round-robin 会话 粘性 加权 轮询'].join(' ') },
    { category: 'routing', target: 'config-native-retry', title: st('nativeRetry'), context: '', keywords: [t('config.network.enableCooling'), t('config.network.disableCooling'), t('config.network.requestRetry'), t('config.network.maxRetryCredentials'), t('config.network.maxRetryInterval'), t('config.network.streamingBootstrapRetries'), 'retry retries cooldown 重试 冷却 流式 失败 fallback'].join(' ') },
    { category: 'diagnostics', target: 'config-native-logging', title: t('config.diagnostics.title'), context: '', keywords: [t('config.diagnostics.debug.title'), t('config.diagnostics.commercial.title'), t('config.diagnostics.fileLogging.title'), t('config.diagnostics.usage.title'), t('config.diagnostics.maxSize.title'), t('config.diagnostics.errorFiles.title'), t('config.diagnostics.redisRetention.title'), 'debug commercial-mode logging logs usage statistics redis retention 日志 调试 商业模式 用量 统计 留存 文件 容量'].join(' ') },
    { category: 'software', target: 'config-native-software', title: t('config.software.title'), context: '', keywords: [t('config.software.autostart'), t('config.software.startCoreOnLaunch'), t('config.software.silentStart'), t('config.software.closeBehavior'), t('config.software.defaultTerminal'), 'startup autostart silent tray close terminal 软件 自启动 启动 静默 托盘 关闭 终端'].join(' ') },
    { category: 'aliases', target: 'config-native-aliases', title: t('app.nav.thinkingAliases'), context: '', keywords: 'thinking reasoning speed aliases effort 思考 推理 速度 别名 模型' },
    { category: 'sensitiveWords', target: 'config-native-sensitive-words', title: t('config.sensitiveWords.title'), context: t('config.sensitiveWords.replacements'), keywords: 'sensitive words replacements filters antigravity devin 敏感词 内容 过滤 替换' },
  ];
  const nativeCategoryDirty: Record<ConfigSubpage, boolean> = {
    general: nativeDirty.management || networkSettingsDirty || tlsSettingsDirty || outboundProxyDirty,
    proxy: proxyDirty,
    aliases: false,
    routing: sessionRoutingDirty || retrySettingsDirty,
    requests: false,
    sensitiveWords: sensitiveWordsDirty,
    diagnostics: loggingSettingsDirty,
    oauth: false,
    software: false,
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

  const softwareTabTitle = templateText(settingsCategories.find(item => item.id === 'software')!.title, locale);
  const dirtyDescriptors: Array<{ key: string; category: ConfigSubpage; target: string; label: string }> = [
    ...(nativeDirty.management ? [{ key: 'management', category: 'general' as const, target: 'config-native-management', label: t('config.webuiKey.title') }] : []),
    ...(networkSettingsDirty ? [{ key: 'network', category: 'general' as const, target: 'config-native-network', label: st('nativeNetwork') }] : []),
    ...(!external && outboundProxyDirty ? [{ key: 'outbound-proxy', category: 'general' as const, target: 'config-system-proxy', label: st('outboundProxyTitle') }] : []),
    ...(tlsSettingsDirty ? [{ key: 'tls', category: 'general' as const, target: 'config-native-tls', label: t('config.tls.enable') }] : []),
    ...(proxyDirty ? [{ key: 'proxy', category: 'proxy' as const, target: 'config-native-reverse-proxy', label: st('reverseProxyTitle') }] : []),
    ...(sessionRoutingDirty ? [{ key: 'routing', category: 'routing' as const, target: 'config-native-routing', label: st('nativeRouting') }] : []),
    ...(retrySettingsDirty ? [{ key: 'retry', category: 'routing' as const, target: 'config-native-retry', label: st('nativeRetry') }] : []),
    ...(loggingSettingsDirty ? [{ key: 'logging', category: 'diagnostics' as const, target: 'config-native-logging', label: t('config.diagnostics.title') }] : []),
    ...(sensitiveWordsDirty ? [{ key: 'sensitiveWords', category: 'sensitiveWords' as const, target: 'config-native-sensitive-words', label: t('config.sensitiveWords.title') }] : []),
    ...dirtyTemplateGroups.flatMap((groupId) => {
      const category = settingsCategories.find((item) => settingsTemplateGroups[item.id].some((group) => group.id === groupId));
      const group = allSettingsTemplateGroups.find((item) => item.id === groupId);
      if (!category || !group) return [];
      return [{ key: `template-${groupId}`, category: category.id, target: `config-group-${groupId}`, label: templateText(group.title, locale) }];
    }),
  ];
  const anySaveBusy = savingAll || busyAction !== null || proxyAction !== null;

  const discardAllDirty = () => {
    if (anySaveBusy) return;
    if (nativeDirty.management) discardManagementSecretDraft();
    if (networkSettingsDirty) discardNetworkEndpointDraft();
    if (!external && outboundProxyDirty) updateOutboundProxy(null);
    if (tlsSettingsDirty) discardTlsDraft();
    if (proxyDirty) discardProxyDraft();
    if (sessionRoutingDirty) discardSessionRoutingDraft();
    if (retrySettingsDirty) discardRetryDraft();
    if (loggingSettingsDirty) discardLoggingDraft();
    if (dirtyTemplateGroups.length > 0) templateSectionRef.current?.discardAllDirtyGroups();
    if (sensitiveWordsDirty) void sensitiveWordsRef.current?.discardImmediate();
  };

  const saveAllDirty = async () => {
    if (anySaveBusy || dirtyDescriptors.length === 0) return;
    setSavingAll(true);
    try {
      const steps: Array<{ category: ConfigSubpage; target: string; run: () => Promise<boolean> }> = [];
      if (nativeDirty.management) steps.push({ category: 'general', target: 'config-native-management', run: performSaveManagementSecret });
      if (networkSettingsDirty) steps.push({ category: 'general', target: 'config-native-network', run: saveNetworkEndpointSettings });
      if (!external && outboundProxyDirty) steps.push({ category: 'general', target: 'config-system-proxy', run: performSaveOutboundProxy });
      if (tlsSettingsDirty) steps.push({ category: 'general', target: 'config-native-tls', run: saveTlsSettings });
      if (proxyDirty) steps.push({ category: 'proxy', target: 'config-native-reverse-proxy', run: handleProxySave });
      if (sessionRoutingDirty) steps.push({ category: 'routing', target: 'config-native-routing', run: saveSessionRoutingSettings });
      if (retrySettingsDirty) steps.push({ category: 'routing', target: 'config-native-retry', run: saveRetrySettings });
      if (loggingSettingsDirty) steps.push({ category: 'diagnostics', target: 'config-native-logging', run: saveCoreLoggingSettings });
      if (dirtyTemplateGroups.length > 0) {
        const firstGroupId = dirtyTemplateGroups[0];
        const firstCategory = settingsCategories.find((item) => settingsTemplateGroups[item.id].some((group) => group.id === firstGroupId))?.id ?? activeSubpage;
        steps.push({
          category: firstCategory,
          target: `config-group-${firstGroupId}`,
          run: async () => (await templateSectionRef.current?.saveAllDirtyGroups()) ?? true,
        });
      }
      if (sensitiveWordsDirty) {
        steps.push({
          category: 'sensitiveWords',
          target: 'config-native-sensitive-words',
          run: async () => (await sensitiveWordsRef.current?.save()) ?? true,
        });
      }
      for (const step of steps) {
        const ok = await step.run();
        if (!ok) {
          navigateToSetting({ category: step.category, target: step.target });
          break;
        }
      }
    } finally {
      setSavingAll(false);
    }
  };

  const saveAllRef = useRef(saveAllDirty);
  saveAllRef.current = saveAllDirty;
  const hasDirtyRef = useRef(false);
  hasDirtyRef.current = dirtyDescriptors.length > 0;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
        if (!hasDirtyRef.current) return;
        event.preventDefault();
        void saveAllRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <section className="page config-page" aria-label={st('title')}>
      {confirmationDialog}
      <div className="config-settings-layout">
        <div className="config-settings-topnav">
          <Tabs ref={categoryNavigationRef} className="config-subpage-tabs secondary-page-tabs" aria-label={t('config.tabs.label')} value={activeSubpage} onChange={activateConfigSubpage}
            items={settingsCategories.map(item => {
              const title = templateText(item.title, locale);
              return {
                value: item.id, id: `config-subpage-tab-${item.id}`, panelId: 'config-subpage-panel',
                label: title,
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
              settings.apiKeys.map((entry, index) => {
                const keyRowId = `${index}-${entry.apiKey}`;
                const keyRevealed = Boolean(revealedKeyMap[keyRowId]);
                const displayKey = keyRevealed ? entry.apiKey : maskApiKey(entry.apiKey);
                return (
                <div className="config-key-row" key={keyRowId}>
                  <div className="config-key-identity">
                    <span className="config-key-index">{String(index + 1).padStart(2, '0')}</span>
                    <div className="config-key-details">
                      <div className="config-key-label-line">
                        <strong title={entry.remark || t('config.keys.noRemark')}>
                          {entry.remark || t('config.keys.noRemark')}
                        </strong>
                      </div>
                      <code className={keyRevealed ? 'is-revealed' : ''} title={displayKey}>{displayKey}</code>
                    </div>
                  </div>
                  <div className="config-key-actions">
                    <button
                      type="button"
                      className={`icon-button quiet small-button${keyRevealed ? ' is-revealed' : ''}`}
                      onClick={() => setRevealedKeyMap(prev => ({ ...prev, [keyRowId]: !prev[keyRowId] }))}
                      disabled={keysDisabled}
                      aria-pressed={keyRevealed}
                      title={keyRevealed ? t('config.keys.hide') : t('config.keys.show')}
                      aria-label={keyRevealed ? t('config.keys.hide') : t('config.keys.show')}
                    >
                      {keyRevealed ? (
                        <Eye size={15} strokeWidth={1.75} aria-hidden="true" />
                      ) : (
                        <EyeOff size={15} strokeWidth={1.75} aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="icon-button quiet small-button"
                      onClick={() => void copyApiKey(entry.apiKey, index)}
                      disabled={keysDisabled}
                      title={copiedIndex === index ? t('config.notice.keyCopied') : t('config.keys.copy')}
                      aria-label={copiedIndex === index ? t('config.notice.keyCopied') : t('config.keys.copyNth', { number: index + 1 })}
                    >
                      {copiedIndex === index ? (
                        <Check size={15} aria-hidden="true" />
                      ) : (
                        <Copy size={15} aria-hidden="true" />
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
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger small-button"
                      onClick={() => setDeleteIndex(index)}
                      disabled={keysDisabled}
                      title={t('config.keys.delete')}
                      aria-label={t('config.keys.deleteNth', { number: index + 1 })}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                );
              })
            ) : (
              <EmptyState className="config-empty-list" icon={<KeyRound size={26} />} title={t('config.keys.empty')} />
            )}
          </div>
          {!addDialogOpen && deleteIndex === null ? renderFeedback(keyFeedback, !searching && activeSubpage === 'general') : null}
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
              <div className="config-management-field">
                <label htmlFor="config-webui-new-key">{t('config.webuiKey.newKey')}</label>
                <div className="config-secret-input">
                  <input
                    id="config-webui-new-key"
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
                    className={`icon-button quiet config-secret-toggle${showManagementSecret ? ' is-revealed' : ''}`}
                    disabled={managementControlsDisabled}
                    aria-pressed={showManagementSecret}
                    onClick={() => setShowManagementSecret((value) => !value)}
                    title={showManagementSecret ? t('config.keys.hide') : t('config.keys.show')}
                    aria-label={showManagementSecret ? t('config.keys.hide') : t('config.keys.show')}
                  >
                    {showManagementSecret ? (
                      <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
                    ) : (
                      <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

              <div className="config-management-field">
                <label htmlFor="config-webui-confirm-key">{t('config.webuiKey.confirmKey')}</label>
                <div className="config-secret-input">
                  <input
                    id="config-webui-confirm-key"
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
                  <button
                    type="button"
                    className={`icon-button quiet config-secret-toggle${showManagementSecret ? ' is-revealed' : ''}`}
                    disabled={managementControlsDisabled}
                    aria-pressed={showManagementSecret}
                    onClick={() => setShowManagementSecret((value) => !value)}
                    title={showManagementSecret ? t('config.keys.hide') : t('config.keys.show')}
                    aria-label={showManagementSecret ? t('config.keys.hide') : t('config.keys.show')}
                  >
                    {showManagementSecret ? (
                      <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
                    ) : (
                      <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

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
                  {nativeDirty.management ? (
                    <>
                      <button
                        type="button"
                        className="secondary-button compact-button"
                        disabled={managementControlsDisabled}
                        onClick={discardManagementSecretDraft}
                      >
                        {t('agents.catalog.discard')}
                      </button>
                      <button
                        type="submit"
                        className="primary-button compact-button"
                        disabled={managementControlsDisabled || !managementSecretDraft.trim()}
                      >
                        <Check size={16} aria-hidden="true" />
                        {managementSecretBusy ? t('common.saving') : t('config.webuiKey.save')}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </form>
            {renderFeedback(managementFeedback, !searching && activeSubpage === 'general')}
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
              <div className="config-heading-actions">
                {busyAction === 'network' ? (
                  <span className="state-pill">{t('common.saving')}</span>
                ) : null}
                <label className="config-proxy-system-toggle" title={t('kernel.control.lanRestartHint')}>
                  <span>{t('kernel.control.allowLan')}</span>
                  <Switch
                    aria-label={t('kernel.control.allowLanAria')}
                    checked={allowLanDraft}
                    disabled={networkControlsDisabled}
                    onChange={(event) => {
                      markDraftDirty('host');
                      setHostDraft(event.currentTarget.checked ? '0.0.0.0' : '127.0.0.1');
                      setHostError('');
                    }}
                  />
                </label>
              </div>
            </div>
            {renderFeedback(networkFeedback, !searching && activeSubpage === 'general')}
            {nativeSectionsPending ? renderNativeSkeleton() : (<>
            <div className="config-network-grid">
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
                <span id="config-network-host-error" className="config-field-error" role="alert">{hostError}</span>
              </div>

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
                <span id="config-network-port-error" className="config-field-error" role="alert">{portError}</span>
              </div>
            </div>

          {networkSettingsDirty ? (
            <div className="config-card-dirty-footer">
              <span className="config-card-dirty-hint">
                <AlertCircle size={14} aria-hidden="true" />
                <span>{st(external ? 'externalRestart' : 'restart')}</span>
              </span>
              <div className="config-inline-dirty-actions">
                <button
                  type="button"
                  className="secondary-button compact-button"
                  disabled={networkControlsDisabled}
                  onClick={discardNetworkEndpointDraft}
                >
                  {t('agents.catalog.discard')}
                </button>
                <button
                  type="button"
                  className="primary-button compact-button"
                  disabled={networkControlsDisabled}
                  onClick={() => void saveNetworkEndpointSettings()}
                >
                  <Check size={15} aria-hidden="true" />
                  {busyAction === 'network' ? t('common.saving') : t('common.save')}
                </button>
              </div>
            </div>
          ) : null}</>)}
        </section>
        {!external && <section id="config-system-proxy" tabIndex={-1} hidden={searching || activeSubpage !== 'general'} className="panel surface-card config-outbound-proxy-section" aria-labelledby="config-outbound-proxy-title">
          <form className="config-outbound-proxy-form" onSubmit={saveOutboundProxy}>
            <div className="config-panel-heading">
              <div className="config-heading-title">
                <Link2 size={16} aria-hidden="true" />
                <h2 id="config-outbound-proxy-title">{st('outboundProxyTitle')}</h2>
              </div>
              <div className="config-heading-actions">
                {busyAction === 'outbound-proxy' ? (
                  <span className="state-pill">{t('common.saving')}</span>
                ) : null}
                <label className="config-proxy-system-toggle" title={t('config.network.systemProxyHint')}>
                  <span>{t('config.network.systemProxy')}</span>
                  <Switch checked={!outboundProxy.proxyOverride} disabled={outboundProxyDisabled} onChange={event =>
                    updateOutboundProxy({ proxyUrl: outboundProxy.proxyUrl, proxyOverride: !event.currentTarget.checked })
                  } />
                </label>
              </div>
            </div>
            <div className="config-network-field config-proxy-field">
              <span className="config-field-label">
                <label htmlFor="config-network-proxy-url">{t('config.network.proxyUrl')}</label>
                <SettingsHelp label={t('config.network.proxyUrl')}>{t('config.network.proxyHint')}</SettingsHelp>
              </span>
              <input
                id="config-network-proxy-url"
                className={`config-network-input ${outboundProxyError ? 'error' : ''}`}
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={outboundProxy.proxyOverride ? outboundProxy.proxyUrl : detectedProxyUrl}
                disabled={outboundProxyDisabled || !outboundProxy.proxyOverride}
                placeholder={outboundProxy.proxyOverride ? t('config.network.proxyPlaceholder') : t('config.network.systemProxy')}
                aria-invalid={outboundProxyError}
                aria-describedby={outboundProxyError ? 'config-network-proxy-url-error' : undefined}
                onChange={event => updateOutboundProxy({ proxyOverride: true, proxyUrl: event.currentTarget.value })}
              />
              {outboundProxyError && <span id="config-network-proxy-url-error" className="config-field-error" role="alert">{t('config.error.proxyUrlScheme')}</span>}
            </div>
            {outboundProxyDirty ? (
              <div className="config-card-dirty-footer">
                <div className="config-inline-dirty-actions">
                  <button type="button" className="secondary-button compact-button" disabled={outboundProxyDisabled} onClick={() => updateOutboundProxy(null)}>
                    {t('agents.catalog.discard')}
                  </button>
                  <button type="submit" className="primary-button compact-button" disabled={outboundProxyDisabled}>
                    <Check size={15} aria-hidden="true" />
                    {busyAction === 'outbound-proxy' ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              </div>
            ) : null}
          </form>
          {renderFeedback(outboundProxyFeedback, !searching && activeSubpage === 'general')}
        </section>}
<section id="config-native-tls" tabIndex={-1} hidden={searching || activeSubpage !== 'general'}
            className="surface-card config-network-section"
            aria-labelledby="config-tls-section-title"
          >
          <div className="config-network-section-heading config-tls-section-heading">
            <div className="config-tls-section-title">
              <LockKeyhole size={18} aria-hidden="true" />
              <h3 id="config-tls-section-title">{t('config.tls.enable')}</h3>
              <SettingsHelp label={t('config.tls.enable')}>{t('config.tls.enableDescription')} {t('config.tls.restartHint')}</SettingsHelp>
            </div>
            <div className="config-heading-actions">
              {tlsSettingsDirty ? (
                <div className="config-inline-dirty-actions">
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    disabled={tlsControlsDisabled || tlsFileSelecting !== null}
                    onClick={discardTlsDraft}
                  >
                    {t('agents.catalog.discard')}
                  </button>
                  <button
                    type="button"
                    className="primary-button compact-button"
                    disabled={tlsControlsDisabled || tlsFileSelecting !== null}
                    onClick={() => void saveTlsSettings()}
                  >
                    <Check size={15} aria-hidden="true" />
                    {busyAction === 'tls' ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              ) : busyAction === 'tls' ? (
                <span className="state-pill">{t('common.saving')}</span>
              ) : tlsStatusLabel ? (
                <span className={`state-pill ${tlsStatusIsSaved ? 'success' : ''}`}>
                  {tlsStatusLabel}
                </span>
              ) : null}
              <Switch title={t('config.tls.enable')} aria-label={t('config.tls.enable')} checked={tlsEnabledDraft} disabled={tlsControlsDisabled} onChange={(event) => {
                setTlsSavedStatusVisible(false);
                setTlsError('');
                setTlsEnabledDraft(event.currentTarget.checked);
              }} />
            </div>
          </div>

          {nativeSectionsPending ? renderNativeSkeleton() : (<>
          {tlsEnabledDraft || tlsError ? (
            <div className="config-tls-content">
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
                        disabled={Boolean(selectedRemoteEndpoint()) || tlsControlsDisabled || tlsFileSelecting !== null}
                        title={t(selectedRemoteEndpoint() ? 'remote.serverFilePath' : 'config.tls.selectCertTitle')}
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
                        disabled={Boolean(selectedRemoteEndpoint()) || tlsControlsDisabled || tlsFileSelecting !== null}
                        title={t(selectedRemoteEndpoint() ? 'remote.serverFilePath' : 'config.tls.selectKeyTitle')}
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
            </div>
          ) : null}
          {renderFeedback(tlsFeedback, !searching && activeSubpage === 'general')}
          {tlsSettingsDirty ? (
            <Notice tone="warn" icon={<AlertCircle size={16} />}>{st(external ? 'externalRestart' : 'restart')}</Notice>
          ) : null}</>)}
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
              <SettingsHelp label={st('reverseProxyTitle')}>{st('reverseProxyIntro')} {st('reverseProxyEnableHint')} {st('reverseProxySaveApplyHint')}</SettingsHelp>
            </div>
            <div className="config-heading-actions">
              {proxyAction !== null ? (
                <span className="state-pill">{t('common.saving')}</span>
              ) : proxyState ? (
                <span className={`state-pill ${proxyState.running ? 'success' : ''}`}>
                  {proxyState.running ? st('reverseProxyRunning') : st('reverseProxyStopped')}
                </span>
              ) : null}
              {!external && proxyDirty ? (
                <div className="config-inline-dirty-actions">
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    disabled={proxyControlsDisabled || proxyInitialLoading}
                    onClick={discardProxyDraft}
                  >
                    {t('agents.catalog.discard')}
                  </button>
                  <button
                    type="button"
                    className="primary-button compact-button"
                    disabled={proxyControlsDisabled || proxyInitialLoading}
                    onClick={() => void handleProxySave()}
                  >
                    <Check size={15} aria-hidden="true" />
                    {proxyAction === 'save' ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              ) : null}
              {!external ? (
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
              ) : null}
            </div>
          </div>

          {external ? <Notice tone="info">{st('externalUnsupported')}</Notice> : proxyInitialLoading ? (
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

              <div className={`surface-section surface-muted config-network-grid config-reverse-proxy-status-bar${proxyState?.running ? ' is-running' : ''}`} aria-label={st('reverseProxyStatus')}>
                <div className="config-network-field">
                  <span className="config-field-label"><span>{st('reverseProxyStatusRunning')}</span></span>
                  <span className="config-rp-status-value">
                    <span className={`config-rp-status-dot${proxyState?.running ? ' is-running' : ''}`} aria-hidden="true" />
                    <span>{proxyState?.running ? st('reverseProxyRunning') : st('reverseProxyStopped')}</span>
                  </span>
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

              {proxyState?.running && proxyState.listening ? (() => {
                const configuredHost = proxyState.config?.listenHost?.trim();
                const isWildcardHost = !configuredHost || configuredHost === '0.0.0.0' || configuredHost === '::';
                const clientHost = isWildcardHost
                  ? (proxyLanIp ?? `<${st('reverseProxyRouteHostPlaceholder')}>`)
                  : (configuredHost.includes(':') ? `[${configuredHost}]` : configuredHost);
                return (
                  <div className="config-rp-route-bar is-live" aria-label={st('reverseProxyRouteTitle')}>
                    <span className="config-rp-route-item">
                      <span className="config-rp-route-label">{st('reverseProxyRoutePublic')}</span>
                      <code>{`https://${clientHost}:${proxyState.listening.split(':').pop() ?? ''}`}</code>
                    </span>
                    <span className="config-rp-route-forward" aria-hidden="true">
                      <span>{st('reverseProxyForwardTo')}</span>
                      <ArrowRight size={14} />
                    </span>
                    <span className="config-rp-route-item">
                      <span className="config-rp-route-label">{st('reverseProxyRouteLocal')}</span>
                      <code>{proxyState.target ?? '—'}</code>
                    </span>
                    <SettingsHelp label={st('reverseProxyRouteTitle')}>{st('reverseProxyRouteClientHint')}</SettingsHelp>
                  </div>
                );
              })() : null}

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

              {proxyState?.error ? (
                <Notice tone="error" className="config-reverse-proxy-error">
                  {proxyState.error}
                </Notice>
              ) : null}

              <div aria-live="polite">
                {renderFeedback(proxyFeedback, !searching && activeSubpage === 'proxy')}
              </div>

              <div className="config-rp-topology">
                <div className="surface-section surface-muted config-rp-node">
                  <div className="config-rp-node-header">
                    <span className="config-field-label">
                      <label htmlFor="config-input-reverse-proxy-listen-host">{st('reverseProxyListenEndpoint')}</label>
                      <SettingsHelp label={st('reverseProxyListenEndpoint')}>
                        {st('reverseProxyListenHostHint')}（{st('reverseProxyBindHint')}） · {st('reverseProxyListenPortHint')} · {st('reverseProxyRoutePreview')}：{st('reverseProxyRouteClientHint')}
                      </SettingsHelp>
                    </span>
                    <span className="config-rp-proto-badge is-https">HTTPS</span>
                  </div>
                  <div className="config-rp-split-inputs">
                    <input
                      id="config-input-reverse-proxy-listen-host"
                      className={`config-network-input config-rp-host-input ${proxyFieldErrors.listenHost ? 'error' : ''}`}
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={proxyDraft.listenHost}
                      disabled={proxyControlsDisabled}
                      placeholder="0.0.0.0"
                      aria-label={st('reverseProxyListenHost')}
                      aria-invalid={Boolean(proxyFieldErrors.listenHost)}
                      aria-describedby={proxyFieldErrors.listenHost ? 'config-reverse-proxy-listen-port-error' : undefined}
                      onChange={(event) => {
                        const nextHost = event.currentTarget.value;
                        setProxyDraft(prev => ({ ...prev, listenHost: nextHost }));
                        setProxyDirty(true);
                        clearProxyFieldError('listenHost');
                      }}
                    />
                    <span className="config-rp-colon" aria-hidden="true">:</span>
                    <input
                      id="config-input-reverse-proxy-listen-port"
                      className={`config-network-input config-rp-port-input ${proxyFieldErrors.listenPort ? 'error' : ''}`}
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={5}
                      autoComplete="off"
                      spellCheck={false}
                      value={listenPortInput}
                      disabled={proxyControlsDisabled}
                      placeholder="1 - 65535"
                      aria-label={st('reverseProxyListenPort')}
                      aria-invalid={Boolean(proxyFieldErrors.listenPort)}
                      aria-describedby={proxyFieldErrors.listenPort ? 'config-reverse-proxy-listen-port-error' : undefined}
                      onChange={(event) => {
                        updateProxyPortInput('listenPort', event.currentTarget.value, Boolean((event.nativeEvent as InputEvent).isComposing));
                      }}
                      onCompositionEnd={(event) => {
                        updateProxyPortInput('listenPort', event.currentTarget.value, false);
                      }}
                    />
                  </div>
                  <span id="config-reverse-proxy-listen-port-error" className="config-field-error" role="alert">
                    {proxyFieldErrors.listenHost || proxyFieldErrors.listenPort}
                  </span>
                </div>

                <div className="config-rp-connector" aria-hidden="true">
                  <span className="config-rp-connector-label">{st('reverseProxyForwardTo')}</span>
                  <ArrowRight size={14} className="config-rp-connector-arrow" />
                </div>

                <div className="surface-section surface-muted config-rp-node">
                  <div className="config-rp-node-header">
                    <span className="config-field-label">
                      <label htmlFor="config-input-reverse-proxy-target-port">{st('reverseProxyTargetEndpoint')}</label>
                      <SettingsHelp label={st('reverseProxyTargetEndpoint')}>
                        {st('reverseProxyTargetPortHint')} {st('reverseProxyAdvancedHint')}
                      </SettingsHelp>
                    </span>
                    <span className="config-rp-proto-badge">{st('reverseProxyRouteLocal')}</span>
                  </div>
                  <div className="config-rp-split-inputs">
                    <label
                      htmlFor="config-input-reverse-proxy-target-port"
                      className="config-rp-locked-host"
                    >
                      <code>127.0.0.1</code>
                    </label>
                    <span className="config-rp-colon" aria-hidden="true">:</span>
                    <input
                      id="config-input-reverse-proxy-target-port"
                      className={`config-network-input config-rp-port-input ${proxyFieldErrors.targetPort ? 'error' : ''}`}
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={5}
                      autoComplete="off"
                      spellCheck={false}
                      value={targetPortInput}
                      disabled={proxyControlsDisabled}
                      placeholder={String(settings?.port ?? 8317)}
                      aria-label={st('reverseProxyTargetPort')}
                      aria-invalid={Boolean(proxyFieldErrors.targetPort)}
                      aria-describedby={proxyFieldErrors.targetPort ? 'config-reverse-proxy-target-port-error' : undefined}
                      onChange={(event) => {
                        updateProxyPortInput('targetPort', event.currentTarget.value, Boolean((event.nativeEvent as InputEvent).isComposing));
                      }}
                      onCompositionEnd={(event) => {
                        updateProxyPortInput('targetPort', event.currentTarget.value, false);
                      }}
                    />
                  </div>
                  <span id="config-reverse-proxy-target-port-error" className="config-field-error" role="alert">{proxyFieldErrors.targetPort}</span>
                </div>
              </div>

              <div className="config-network-grid">
                <div className="config-network-field">
                  <span className="config-field-label">
                    <label htmlFor="config-input-reverse-proxy-cert-path">{st('reverseProxyCertPath')}</label>
                    <SettingsHelp label={st('reverseProxyCertPath')}>{st('reverseProxyCertPathHint')} {st('reverseProxyCertIntro')}</SettingsHelp>
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
                  <span id="config-reverse-proxy-cert-path-error" className="config-field-error" role="alert">{proxyFieldErrors.certPath}</span>
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
                  <span id="config-reverse-proxy-key-path-error" className="config-field-error" role="alert">{proxyFieldErrors.keyPath}</span>
                </div>
              </div>
            </div>
          )}
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
              <div className="config-heading-actions">
                {sessionRoutingDirty ? (
                  <div className="config-inline-dirty-actions">
                    <button
                      type="button"
                      className="secondary-button compact-button"
                      disabled={routingControlsDisabled}
                      onClick={discardSessionRoutingDraft}
                    >
                      {t('agents.catalog.discard')}
                    </button>
                    <button
                      type="button"
                      className="primary-button compact-button"
                      disabled={routingControlsDisabled}
                      onClick={() => void saveSessionRoutingSettings()}
                    >
                      <Check size={15} aria-hidden="true" />
                      {busyAction === 'routing' ? t('common.saving') : t('common.save')}
                    </button>
                  </div>
                ) : busyAction === 'routing' ? (
                  <span className="state-pill">{t('common.saving')}</span>
                ) : null}
              </div>
            </div>
            {renderFeedback(routingFeedback, !searching && activeSubpage === 'routing')}
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
                <span id="config-network-sessionTtl-error" className="config-field-error" role="alert">{sessionTtlError}</span>

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
            </div></>)}
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
              <div className="config-heading-actions">
                {retrySettingsDirty ? (
                  <div className="config-inline-dirty-actions">
                    <button
                      type="button"
                      className="secondary-button compact-button"
                      disabled={retryControlsDisabled}
                      onClick={discardRetryDraft}
                    >
                      {t('agents.catalog.discard')}
                    </button>
                    <button
                      type="button"
                      className="primary-button compact-button"
                      disabled={retryControlsDisabled}
                      onClick={() => void saveRetrySettings()}
                    >
                      <Check size={15} aria-hidden="true" />
                      {busyAction === 'retry' ? t('common.saving') : t('common.save')}
                    </button>
                  </div>
                ) : busyAction === 'retry' ? (
                  <span className="state-pill">{t('common.saving')}</span>
                ) : null}
              </div>
            </div>
            {renderFeedback(retryFeedback, !searching && activeSubpage === 'routing')}
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
            </div></>)}
        </section>
<section id="config-native-logging" tabIndex={-1} hidden={searching || activeSubpage !== 'diagnostics'} className="panel surface-card config-diagnostics-panel">
          <div className="config-panel-heading">
            <div className="config-heading-title">
              <FileText size={18} aria-hidden="true" />
              <h2>{t('config.diagnostics.title')}</h2>
            </div>
            <div className="config-heading-actions">
              {loggingSettingsBusy ? (
                <span className="state-pill">{t('common.saving')}</span>
              ) : loggingSettingsDirty ? (
                <span className="state-pill">{t('config.network.unsaved')}</span>
              ) : null}
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={diagnosticsControlsDisabled || (external && !settings?.loggingToFile)}
                title={external && !settings?.loggingToFile ? st('enableFileLogs') : undefined}
                onClick={() => void handleOpenCoreLogsDirectory()}
              >
                <FolderOpen size={15} aria-hidden="true" />
                {external ? st('readLogs') : t('config.diagnostics.openLogs')}
              </button>
            </div>
          </div>

          {nativeSectionsPending ? renderNativeSkeleton() : (<>
          <div className="config-diagnostics-list">
            <div className="config-diagnostics-toggle-grid">
              <div className={`config-diagnostics-setting${diagnosticsControlsDisabled ? ' is-disabled' : ''}`}>
                <label className="config-diagnostics-setting-copy" htmlFor="config-diagnostics-debug">
                  <span className="config-diagnostics-setting-icon" aria-hidden="true"><Bug size={17} /></span>
                  <div>
                    <strong>{t('config.diagnostics.debug.title')}</strong>
                    <small>{t('config.diagnostics.debug.description')}</small>
                  </div>
                </label>
                <Switch
                  id="config-diagnostics-debug"
                  title={t('config.diagnostics.debug.title')}
                  checked={debugDraft}
                  aria-label={t('config.diagnostics.debug.title')}
                  disabled={diagnosticsControlsDisabled}
                  onChange={(event) => {
                    setDebugDraft(event.currentTarget.checked);
                    markLoggingDraftDirty();
                  }}
                />
              </div>

              <div className={`config-diagnostics-setting${diagnosticsControlsDisabled ? ' is-disabled' : ''}`}>
                <label className="config-diagnostics-setting-copy" htmlFor="config-diagnostics-commercial">
                  <span className="config-diagnostics-setting-icon" aria-hidden="true"><Gauge size={17} /></span>
                  <div>
                    <strong>{t('config.diagnostics.commercial.title')}</strong>
                    <small>{t('config.diagnostics.commercial.description')} {t('config.diagnostics.commercial.warning')}</small>
                  </div>
                </label>
                <Switch
                  id="config-diagnostics-commercial"
                  title={t('config.diagnostics.commercial.title')}
                  checked={commercialModeDraft}
                  aria-label={t('config.diagnostics.commercial.title')}
                  disabled={diagnosticsControlsDisabled}
                  onChange={(event) => {
                    setCommercialModeDraft(event.currentTarget.checked);
                    markLoggingDraftDirty();
                  }}
                />
              </div>

              <div className={`config-diagnostics-setting${diagnosticsControlsDisabled ? ' is-disabled' : ''}`}>
                <label className="config-diagnostics-setting-copy" htmlFor="config-diagnostics-file-logging">
                  <span className="config-diagnostics-setting-icon" aria-hidden="true"><HardDrive size={17} /></span>
                  <div>
                    <strong>{t('config.diagnostics.fileLogging.title')}</strong>
                    <small>{t('config.diagnostics.fileLogging.description')}</small>
                  </div>
                </label>
                <Switch
                  id="config-diagnostics-file-logging"
                  title={t('config.diagnostics.fileLogging.title')}
                  checked={loggingToFileDraft}
                  aria-label={t('config.diagnostics.fileLogging.title')}
                  disabled={diagnosticsControlsDisabled}
                  onChange={(event) => {
                    setLoggingToFileDraft(event.currentTarget.checked);
                    markLoggingDraftDirty();
                  }}
                />
              </div>

              <div className={`config-diagnostics-setting${diagnosticsControlsDisabled ? ' is-disabled' : ''}`}>
                <label className="config-diagnostics-setting-copy" htmlFor="config-diagnostics-usage">
                  <span className="config-diagnostics-setting-icon" aria-hidden="true"><Database size={17} /></span>
                  <div>
                    <strong>{t('config.diagnostics.usage.title')}</strong>
                    <small>{t('config.diagnostics.usage.description')}</small>
                  </div>
                </label>
                <Switch
                  id="config-diagnostics-usage"
                  title={t('config.diagnostics.usage.title')}
                  checked={usageStatisticsDraft}
                  aria-label={t('config.diagnostics.usage.title')}
                  disabled={diagnosticsControlsDisabled}
                  onChange={(event) => {
                    setUsageStatisticsDraft(event.currentTarget.checked);
                    markLoggingDraftDirty();
                  }}
                />
              </div>
            </div>

            <div className="config-diagnostics-fields">
              <div className={`config-diagnostics-field${diagnosticsControlsDisabled ? ' is-disabled' : ''}`}>
                <label className="config-diagnostics-setting-copy" htmlFor="config-input-config-diagnostics-maxSize-title">
                  <span className="config-diagnostics-setting-icon" aria-hidden="true"><FileText size={17} /></span>
                  <div>
                    <strong>{t('config.diagnostics.maxSize.title')}</strong>
                    <small>{t('config.diagnostics.maxSize.hint')}</small>
                  </div>
                </label>
                <input
                  id="config-input-config-diagnostics-maxSize-title"
                  className="config-network-input"
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
              </div>

              <div className={`config-diagnostics-field${diagnosticsControlsDisabled ? ' is-disabled' : ''}`}>
                <label className="config-diagnostics-setting-copy" htmlFor="config-input-config-diagnostics-errorFiles-title">
                  <span className="config-diagnostics-setting-icon" aria-hidden="true"><AlertCircle size={17} /></span>
                  <div>
                    <strong>{t('config.diagnostics.errorFiles.title')}</strong>
                    <small>{t('config.diagnostics.errorFiles.hint')}</small>
                  </div>
                </label>
                <input
                  id="config-input-config-diagnostics-errorFiles-title"
                  className="config-network-input"
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
              </div>

              <div className={`config-diagnostics-field${diagnosticsControlsDisabled ? ' is-disabled' : ''}`}>
                <label className="config-diagnostics-setting-copy" htmlFor="config-input-config-diagnostics-redisRetention-title">
                  <span className="config-diagnostics-setting-icon" aria-hidden="true"><Clock3 size={17} /></span>
                  <div>
                    <strong>{t('config.diagnostics.redisRetention.title')}</strong>
                    <small>{t('config.diagnostics.redisRetention.hint')}</small>
                  </div>
                </label>
                <input
                  id="config-input-config-diagnostics-redisRetention-title"
                  className="config-network-input"
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
              </div>
            </div>
          </div>

          {settings && commercialModeDraft !== settings.commercialMode ? (
            <Notice tone="warn" icon={<AlertCircle size={16} />}>{st(external ? 'externalRestart' : 'restart')}</Notice>
          ) : null}

          {loggingError ? (
            <span className="config-form-message error" role="alert">
              {loggingError}
            </span>
          ) : null}
          {renderFeedback(loggingFeedback, !searching && activeSubpage === 'diagnostics')}</>)}
        </section>
<section id="config-native-software" tabIndex={-1} hidden={searching || activeSubpage !== 'software'} className="panel surface-card config-software-panel">
            <div className="config-panel-heading">
              <div className="config-heading-title">
                <Settings2 size={18} aria-hidden="true" />
                <h2>{softwareTabTitle}</h2>
              </div>
              <div className="config-heading-actions">
                {softwareSettingsLoading && softwareSettings === null ? (
                  <span className="config-inline-status">{t('common.loading')}</span>
                ) : softwareSettings === null ? (
                  <span className="state-pill">{t('common.unavailable')}</span>
                ) : softwareSaving ? (
                  <span className="state-pill">{t('common.saving')}</span>
                ) : softwareSavedStatusVisible ? (
                  <span className="state-pill success">{t('config.network.saved')}</span>
                ) : (
                  <span className="config-inline-status">{st('automatic')}</span>
                )}
              </div>
            </div>
            {softwareSettingsLoading && softwareSettings === null ? renderNativeSkeleton() : (<>
            <div className="config-software-content">
              <div className="config-software-settings-list">
                <div className={`config-software-setting-row${softwareControlsDisabled ? ' is-disabled' : ''}`}>
                  <label className="config-software-setting-copy" htmlFor="config-software-autostart">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <Clock3 size={17} />
                    </span>
                    <div>
                      <strong>{t('config.software.autostart')}</strong>
                      <small>{t('config.software.autostartDescription')}</small>
                    </div>
                  </label>
                  <Switch
                    id="config-software-autostart"
                    title={t('config.software.autostart')}
                    aria-label={t('config.software.autostart')}
                    checked={softwareValues.autostartEnabled}
                    disabled={softwareControlsDisabled}
                    onChange={(event) => updateSoftwarePreference({ autostartEnabled: event.currentTarget.checked })}
                  />
                </div>
                <div className={`config-software-setting-row${external || softwareControlsDisabled ? ' is-disabled' : ''}`}>
                  <label className="config-software-setting-copy" htmlFor="config-software-start-core">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <Power size={17} />
                    </span>
                    <div>
                      <strong>{t('config.software.startCoreOnLaunch')}</strong>
                      <small>{external ? st('externalUnsupported') : t('config.software.startCoreOnLaunchDescription')}</small>
                    </div>
                  </label>
                  <Switch
                    id="config-software-start-core"
                    title={t('config.software.startCoreOnLaunch')}
                    aria-label={t('config.software.startCoreOnLaunch')}
                    checked={softwareValues.startCoreOnLaunch}
                    disabled={external || softwareControlsDisabled}
                    onChange={(event) => updateSoftwarePreference({ startCoreOnLaunch: event.currentTarget.checked })}
                  />
                </div>
                <div className={`config-software-setting-row${softwareControlsDisabled ? ' is-disabled' : ''}`}>
                  <label className="config-software-setting-copy" htmlFor="config-software-silent-start">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <EyeOff size={17} />
                    </span>
                    <div>
                      <strong>{t('config.software.silentStart')}</strong>
                      <small>{t('config.software.silentStartDescription')}</small>
                    </div>
                  </label>
                  <Switch
                    id="config-software-silent-start"
                    title={t('config.software.silentStart')}
                    aria-label={t('config.software.silentStart')}
                    checked={softwareValues.silentStartEnabled}
                    disabled={softwareControlsDisabled}
                    onChange={(event) => updateSoftwarePreference({ silentStartEnabled: event.currentTarget.checked })}
                  />
                </div>
                <div className={`config-software-setting-row config-software-close-row${softwareControlsDisabled ? ' is-disabled' : ''}`}>
                  <label className="config-software-setting-copy" htmlFor="config-software-default-terminal">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <Terminal size={17} />
                    </span>
                    <div>
                      <strong>{t('config.software.defaultTerminal')}</strong>
                      <small>{t('config.software.defaultTerminalDescription')}</small>
                    </div>
                  </label>
                  <div className="config-software-select">
                    <Select
                      id="config-software-default-terminal"
                      aria-label={t('config.software.defaultTerminal')}
                      className="config-network-input"
                      value={softwareValues.defaultTerminal}
                      disabled={softwareControlsDisabled}
                      onChange={(event) => updateSoftwarePreference({ defaultTerminal: event.currentTarget.value })}
                    >
                      {(softwareSettings?.availableTerminals ?? []).map((terminal) => (
                        <option value={terminal.id} key={terminal.id}>
                          {terminal.id === 'auto' ? t('config.software.terminal.auto') : terminal.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className={`config-software-setting-row config-software-close-row${softwareControlsDisabled ? ' is-disabled' : ''}`}>
                  <label className="config-software-setting-copy" htmlFor="config-software-close-behavior">
                    <span className="config-software-setting-icon" aria-hidden="true">
                      <X size={17} />
                    </span>
                    <div>
                      <strong>{t('config.software.closeBehavior')}</strong>
                      <small>{t('config.software.closeBehaviorDescription')}</small>
                    </div>
                  </label>
                  <div className="config-software-select">
                    <Select
                      id="config-software-close-behavior"
                      aria-label={t('config.software.closeBehavior')}
                      className="config-network-input"
                      value={softwareValues.closeBehavior}
                      disabled={softwareControlsDisabled}
                      onChange={(event) => updateSoftwarePreference({ closeBehavior: event.currentTarget.value as CloseBehavior })}
                    >
                      <option value="ask">{t('config.software.behavior.ask')}</option>
                      <option value="minimize-to-tray">{t('config.software.behavior.minimize')}</option>
                      <option value="exit">{t('config.software.behavior.exit')}</option>
                    </Select>
                  </div>
                </div>
              </div>
            </div>
            {renderFeedback(softwareFeedback, !searching && activeSubpage === 'software')}</>)}
        </section>
          </div>
          <div id="config-template-panel" hidden={searching || templateGroups.length === 0}><TemplateConfigSection ref={templateSectionRef} groups={allSettingsTemplateGroups} visibleGroups={templateGroups.map(group => group.id)} onDirtyGroupsChange={setDirtyTemplateGroups} /></div>
          <div className="surface-card" id="config-native-aliases" tabIndex={-1} role="region" aria-label={t('app.nav.thinkingAliases')} hidden={searching || activeSubpage !== 'aliases'}>{aliasesVisited ? <ThinkingAliasesPage embedded /> : null}</div>
          <div className="surface-card" id="config-native-sensitive-words" tabIndex={-1} role="region" aria-label={t('config.sensitiveWords.title')} hidden={searching || activeSubpage !== 'sensitiveWords'}>{sensitiveWordsVisited ? <SensitiveWordsPage ref={sensitiveWordsRef} active={!searching && activeSubpage === 'sensitiveWords'} onDirtyChange={setSensitiveWordsDirty} /> : null}</div>
        </div>
        {dirtyDescriptors.length > 0 ? (
          <div className="surface-card config-sticky-save-bar" role="region" aria-label={st('dirty')}>
            <div className="config-sticky-save-summary">
              <span className="config-nav-dirty" aria-hidden="true" />
              <strong>
                {locale === 'en'
                  ? `${dirtyDescriptors.length} unsaved ${dirtyDescriptors.length === 1 ? 'section' : 'sections'}`
                  : locale === 'ja'
                    ? `${dirtyDescriptors.length} 件の未保存変更`
                    : `${dirtyDescriptors.length} 项分组有未保存修改`}
              </strong>
              <div className="config-sticky-save-chips">
                {dirtyDescriptors.map((item) => (
                  <button
                    type="button"
                    key={item.key}
                    className="config-sticky-save-chip"
                    onClick={() => navigateToSetting({ category: item.category, target: item.target })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="config-sticky-save-actions">
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={anySaveBusy}
                onClick={discardAllDirty}
              >
                {dirtyDescriptors.length > 1
                  ? (locale === 'en' ? 'Discard all' : locale === 'ja' ? 'すべて破棄' : '全部放弃')
                  : t('agents.catalog.discard')}
              </button>
              <button
                type="button"
                className="primary-button compact-button config-save-all-button"
                disabled={anySaveBusy}
                onClick={() => void saveAllDirty()}
              >
                <Check size={15} aria-hidden="true" />
                <span>
                  {anySaveBusy
                    ? t('common.saving')
                    : dirtyDescriptors.length > 1
                      ? (locale === 'en' ? 'Save all changes' : locale === 'ja' ? 'すべて保存' : '一键全部保存')
                      : t('common.save')}
                </span>
                <kbd className="config-save-shortcut" aria-hidden="true">Ctrl+S</kbd>
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {external && serverLogs !== null && <Dialog title={st('readLogs')} onClose={() => setServerLogs(null)}>
        <pre style={{ maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{serverLogs.join('\n') || st('emptyLogs')}</pre>
      </Dialog>}
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

          <div className="config-dialog-field">
            <label htmlFor="config-dialog-api-key-input">{t('config.keys.label')}</label>
            <div className="config-secret-input">
              <input
                id="config-dialog-api-key-input"
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
                className={`icon-button quiet config-secret-toggle${showApiKey ? ' is-revealed' : ''}`}
                onClick={() => setShowApiKey((visible) => !visible)}
                disabled={keyMutationBusy}
                aria-pressed={showApiKey}
                title={showApiKey ? t('config.keys.hide') : t('config.keys.show')}
                aria-label={showApiKey ? t('config.keys.hide') : t('config.keys.show')}
              >
                {showApiKey ? (
                  <Eye size={17} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <EyeOff size={17} strokeWidth={1.75} aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

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
  return `${value.slice(0, visible)}${'•'.repeat(Math.max(6, 10 - visible * 2))}${value.slice(-visible)}`;
}

function routingStrategyLabel(strategy: string | undefined, t: ReturnType<typeof useI18n>['t'], locale: ReturnType<typeof useI18n>['locale']) {
  if (!strategy) {
    return t('common.loading');
  }
  const option = ROUTING_OPTIONS.find((item) => item.value === strategy);
  if (strategy === 'weighted-round-robin') return templateText(templateMessages.weighted, locale);
  return option ? t(option.labelKey) : strategy;
}
