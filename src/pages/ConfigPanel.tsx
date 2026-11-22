import { Notice } from '../components/Notice';
import { EmptyState } from '../components/EmptyState';
import { Switch } from '../components/Switch';
import { onConfigFilesChanged } from '../services/events';
import { openExternalUrl } from '../services/appSettings';
import { pollWhileActive } from '../services/windowActivity';
import {
  getCoreConfigSettings,
  getSoftwareSettings,
  followSystemCoreProxy,
  getCoreTlsSettings,
  setCoreManagementSecretKey,
  openCoreLogsDirectory,
  saveSoftwareSettings as saveSoftwareSettingsCommand,
} from '../services/coreSettings';
import { managementApi } from '../services/managementApi';
import { selectedRemoteEndpoint } from '../services/remoteCpa';
import type { CoreConfigSettings, SoftwareSettings, CloseBehavior } from '../services/coreSettings';
import {
  getReverseProxyState,
  applyReverseProxyConfig,
  reverseProxyPathErrors,
  type ReverseProxyConfig,
  type ReverseProxyPathField,
  type ReverseProxyState,
} from '../services/reverseProxy';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { open } from '../services/platform';
import {
  AlertCircle,
  ArrowRight,
  Search,
  ChevronRight,
  Check,
  Clock3,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Link2,
  LockKeyhole,
  Network,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Power,
  Terminal,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { useCoreRuntime } from '../coreRuntime';
import { MessageNotice, FloatingNotice, useAppNotice } from '../appNotice';
import { webUiManagementUrl } from '../services/clientAccess';
import { ThinkingAliasesPage } from './ThinkingAliasesPage';
import { Tabs } from '../components/Tabs';
import { SegmentedControl } from '../components/SegmentedControl';
import { Dialog } from '../components/Dialog';
import { TemplateConfigSection } from '../components/TemplateConfigSection';
import { SettingsHelp } from '../components/SettingsHelp';
import { templateMessages, templateText } from '../i18n/templateConfig';
import {
  settingsCategories, settingsTemplateGroups,
  allSettingsTemplateGroups, settingsMessages, type SettingsCategory,
  getLanIpv4, resolveReverseProxySaveConfig,
} from '../services/settingsNavigation';
import { Select } from '../components/Select';

type ConfigAction = 'management-secret' | 'open-logs' | 'system-proxy' | 'software' | null;
type DraftRefreshMode = 'replace' | 'preserve';
type ConfigSubpage = SettingsCategory;
type SettingDestination = { category: ConfigSubpage; target: string; field?: string };
type SettingSearchEntry = SettingDestination & { title: string; context: string; keywords: string };

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
  const { status: coreStatus } = useCoreRuntime();
  const external = Boolean(selectedRemoteEndpoint());
  const [serverLogs, setServerLogs] = useState<string[] | null>(null);
  const [settings, setSettings] = useState<CoreConfigSettings | null>(null);
  const [softwareSettings, setSoftwareSettings] = useState<SoftwareSettings | null>(null);
  const [softwareSettingsLoading, setSoftwareSettingsLoading] = useState(true);
  const [softwareCloseBehaviorDraft, setSoftwareCloseBehaviorDraft] = useState<CloseBehavior>('ask');
  const [softwareAutostartDraft, setSoftwareAutostartDraft] = useState(false);
  const [softwareStartCoreDraft, setSoftwareStartCoreDraft] = useState(true);
  const [softwareSilentStartDraft, setSoftwareSilentStartDraft] = useState(false);
  const [softwareDefaultTerminalDraft, setSoftwareDefaultTerminalDraft] = useState('auto');
  const [softwareSavedStatusVisible, setSoftwareSavedStatusVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyAction, setBusyAction] = useState<ConfigAction>(null);
  const [managementSecretDraft, setManagementSecretDraft] = useState('');
  const [managementSecretConfirm, setManagementSecretConfirm] = useState('');
  const [showManagementSecret, setShowManagementSecret] = useState(false);
  const [managementSecretError, setManagementSecretError] = useState('');
  const managementFeedback = useAppNotice();
  const loggingFeedback = useAppNotice();
  const networkFeedback = useAppNotice();
  const proxyFeedback = useAppNotice();
  const softwareFeedback = useAppNotice();
  const renderFeedback = (feedback: ReturnType<typeof useAppNotice>) => (
    <FloatingNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
  );
  const [activeSubpage, setActiveSubpage] = useState<ConfigSubpage>('general');
  const [settingsSearch, setSettingsSearch] = useState('');
  const [dirtyTemplateGroups, setDirtyTemplateGroups] = useState<readonly string[]>([]);
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
  const [proxyFieldErrors, setProxyFieldErrors] = useState<ReverseProxyFieldError>({});
  const softwareDraftDirtyRef = useRef(false);

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
    let disposed = false;
    let stop: (() => void) | null = null;
    void loadSettings();
    void loadSoftwareSettings();
    if (!external) void loadReverseProxy();
    void onConfigFilesChanged(() => {
      if (!disposed) {
        void loadSettings('preserve');
        void loadSoftwareSettings('preserve');
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  async function loadSettings(mode: DraftRefreshMode = 'replace') {
    if (mode === 'replace') setLoading(true);
    setLoadError('');
    try {
      const result = await getCoreConfigSettings();
      setSettings(result);
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
      if (mode === 'preserve' && softwareDraftDirtyRef.current) return;
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

  const runMutation = async (
    action: Exclude<ConfigAction, null>,
    mutation: () => Promise<CoreConfigSettings>,
    successMessage: string,
  ) => {
    if (busyAction !== null) return false;
    setBusyAction(action);
    const mutationFeedback = action === 'system-proxy' ? networkFeedback : managementFeedback;
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

  const openWebUi = async () => {
    try {
      const endpoint = selectedRemoteEndpoint();
      if (endpoint) {
        await openExternalUrl({ url: webUiManagementUrl(0) });
        return;
      }
      const [latestSettings, latestTlsSettings] = await Promise.all([
        getCoreConfigSettings(),
        getCoreTlsSettings(),
      ]);
      setSettings(latestSettings);
      await openExternalUrl({
        url: webUiManagementUrl(latestSettings.port, latestTlsSettings.enabled, latestSettings.host),
      });
    } catch (error) {
      managementFeedback.showNotice({ key: 'config.webuiKey.error.openFailed', variables: { error: String(error) } }, 'error');
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

  const discardProxyDraft = () => {
    setProxyDraft(proxyState?.config ?? DEFAULT_REVERSE_PROXY_DRAFT);
    setProxyDirty(false);
    setProxyFieldErrors({});
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
  softwareDraftDirtyRef.current = softwareSettingsDirty;
  const managementSecretBusy = busyAction === 'management-secret';
  const canRestoreManagement = !external && (settings?.managementSecretConfigured === false || coreStatus?.ready === false);
  const managementControlsDisabled = coreUnavailable || managementSecretBusy;
  const softwareControlsDisabled = softwareSettingsLoading || softwareSettings === null || busyAction === 'software';
  const proxyControlsDisabled = coreUnavailable || proxyInitialLoading || proxyAction !== null || proxyFileSelecting !== null;
  const activateConfigSubpage = (subpage: ConfigSubpage) => {
    setSettingsSearch('');
    setActiveSubpage(subpage);
    if (subpage === 'aliases') setAliasesVisited(true);
  };
  const navigateToSetting = (destination: SettingDestination) => {
    activateConfigSubpage(destination.category);
    setPendingDestination(destination);
  };
  const nativeEntries: SettingSearchEntry[] = [
    { category: 'general', target: 'config-native-management', title: t('config.webuiKey.open'), context: canRestoreManagement ? st('restoreManagement') : '', keywords: 'WebUI 管理面板' },
    ...(!external ? [{ category: 'general' as const, target: 'config-system-proxy', title: t('config.network.systemProxy'), context: '', keywords: 'system proxy 系统代理' }] : []),
    { category: 'proxy', target: 'config-native-reverse-proxy', title: st('reverseProxyTitle'), context: '', keywords: [st('reverseProxyListenHost'), st('reverseProxyListenPort'), st('reverseProxyTargetPort'), st('reverseProxyCertPath'), st('reverseProxyKeyPath'), 'reverse proxy 反向代理 HTTPS 转发 监听 端口'].join(' ') },
    { category: 'diagnostics', target: 'config-native-logging', title: t('config.diagnostics.title'), context: '', keywords: [t('config.diagnostics.debug.title'), t('config.diagnostics.commercial.title'), t('config.diagnostics.fileLogging.title'), t('config.diagnostics.usage.title'), t('config.diagnostics.maxSize.title'), t('config.diagnostics.errorFiles.title'), t('config.diagnostics.redisRetention.title'), 'debug commercial-mode logging logs usage statistics redis retention 日志 调试 商业模式 用量 统计 留存 文件 容量'].join(' ') },
    { category: 'software', target: 'config-native-software', title: t('config.software.title'), context: '', keywords: [t('config.software.autostart'), t('config.software.startCoreOnLaunch'), t('config.software.silentStart'), t('config.software.closeBehavior'), t('config.software.defaultTerminal'), 'startup autostart silent tray close terminal 软件 自启动 启动 静默 托盘 关闭 终端'].join(' ') },
    { category: 'aliases', target: 'config-native-aliases', title: t('app.nav.thinkingAliases'), context: '', keywords: 'thinking reasoning speed aliases effort 思考 推理 速度 别名 模型' },
  ];
  const nativeCategoryDirty: Record<ConfigSubpage, boolean> = {
    general: Boolean(managementSecretDraft || managementSecretConfirm),
    proxy: proxyDirty,
    aliases: false,
    routing: false,
    requests: false,
    diagnostics: false,
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
<section id="config-native-management" tabIndex={-1} hidden={searching || activeSubpage !== 'general'} className="panel surface-card config-management-panel">
          <div className="config-panel-heading">
            <div className="config-heading-title">
              <ShieldCheck size={18} aria-hidden="true" />
              <h2>WebUI</h2>
            </div>
            <div className="config-heading-actions">
              {managementSecretBusy ? <span className="state-pill">{t('common.saving')}</span> : null}
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={coreUnavailable}
                onClick={() => void openWebUi()}
              >
                {t('config.webuiKey.open')}
              </button>
            </div>
          </div>

          {canRestoreManagement && <details className="config-management-content" open={settings?.managementSecretConfigured === false || undefined}>
            <summary>{st('restoreManagement')}</summary>
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
          </details>}
          {renderFeedback(managementFeedback)}
        </section>
        {!external && <section id="config-system-proxy" tabIndex={-1} hidden={searching || activeSubpage !== 'general'} className="panel surface-card">
          <div className="config-panel-heading">
            <div className="config-heading-title">
              <Link2 size={18} aria-hidden="true" />
              <h2>{t('config.network.systemProxy')}</h2>
              <SettingsHelp label={t('config.network.systemProxy')}>{t('config.network.systemProxyHint')}</SettingsHelp>
            </div>
            <button type="button" className="secondary-button compact-button"
              disabled={coreUnavailable || busyAction !== null || settings?.proxyOverride === false}
              onClick={() => void runMutation('system-proxy', followSystemCoreProxy, t('config.notice.networkUpdated'))}>
              {settings?.proxyOverride === false ? st('followingSystemProxy') : t('config.network.systemProxy')}
            </button>
          </div>
          {renderFeedback(networkFeedback)}
        </section>}
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

          {!external && <div className="config-settings-save-row">
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
          </div>}
        </section>
<section id="config-native-logging" tabIndex={-1} hidden={searching || activeSubpage !== 'diagnostics'} className="panel surface-card config-diagnostics-panel">
          <div className="config-panel-heading">
            <div className="config-heading-title">
              <FileText size={18} aria-hidden="true" />
              <h2>{t('config.diagnostics.title')}</h2>
            </div>
            <button type="button" className="secondary-button compact-button"
              disabled={busyAction === 'open-logs' || (external && (coreUnavailable || !settings?.loggingToFile))}
              title={external && !settings?.loggingToFile ? st('enableFileLogs') : undefined}
              onClick={() => void handleOpenCoreLogsDirectory()}>
              <FolderOpen size={16} aria-hidden="true" />
              {external ? st('readLogs') : t('config.diagnostics.openLogs')}
            </button>
          </div>
          {renderFeedback(loggingFeedback)}
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
                      <strong>{t('config.software.startCoreOnLaunch')}</strong>{external && <small>{st('externalUnsupported')}</small>}
                    </div>
                  </div>
                  <Switch title={t('config.software.startCoreOnLaunch')} aria-label={t('config.software.startCoreOnLaunch')} checked={softwareStartCoreDraft} disabled={external || softwareControlsDisabled} onChange={(event) => {
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
        </div>
      </div>

      {external && serverLogs !== null && <Dialog title={st('readLogs')} onClose={() => setServerLogs(null)}>
        <pre style={{ maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{serverLogs.join('\n') || st('emptyLogs')}</pre>
      </Dialog>}
    </section>
  );
}
