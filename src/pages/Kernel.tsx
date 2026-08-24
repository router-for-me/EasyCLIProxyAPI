import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  AlertCircle,
  AppWindow,
  ArrowRight,
  Box,
  Check,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  PackageOpen,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { type CoreStatus, useCoreRuntime } from '../coreRuntime';
import openaiIcon from '../assets/icons/openai-light.svg';
import claudeIcon from '../assets/icons/claude.svg';
import geminiIcon from '../assets/icons/gemini.svg';
import { clientApiProfiles } from '../services/clientAccess';
import { useI18n } from '../i18n';
import { useAppUpdate } from '../appUpdate';

type CorePlatform = {
  os: string;
  arch: string;
  assetOs: string;
  assetArch: string;
  archiveKind: 'tar.gz' | 'zip';
};

type CoreLatest = {
  version: string;
  assetName: string;
};

type BundledCoreInfo = {
  version: string;
  assetName: string;
  sizeBytes: number;
};

type CoreInstallResult = {
  version: string;
  assetName: string;
  installDir: string;
  binaryPath: string | null;
};

type CoreInstallTask = {
  running: boolean;
  cancellable: boolean;
  phase: string;
  downloaded: number;
  total: number | null;
  percent: number | null;
  message: string | null;
  result: CoreInstallResult | null;
};

type CodexModelCatalogUpdateResult = {
  outcome: 'updated' | 'unchanged';
};

type MessageType = 'info' | 'success' | 'error';
type CoreProcessCommand = 'start_core_process' | 'stop_core_process' | 'restart_core_process';

type GuiSettings = {
  host: string;
  port: number;
  runOnStartup: boolean;
};

type VersionSourceSettings = {
  preferGitcodeDownloads: boolean;
  gitcodeAvailable: boolean;
};

type CoreConfigSummary = {
  apiKeys: Array<{ apiKey: string }>;
};

type CoreTlsSettings = {
  enabled: boolean;
  cert: string;
  key: string;
};

const APP_RELEASE_URL = 'https://github.com/router-for-me/EasyCLIProxyAPI/releases/latest';

let latestAutoCheckStarted = false;
let cachedLatest: CoreLatest | null = null;
let cachedLatestError = '';
let latestCheckPromise: Promise<CoreLatest> | null = null;
let latestRequestEpoch = 0;

function displayAppVersion(version: string) {
  const resolvedVersion = version.trim();
  return resolvedVersion.startsWith('v') ? resolvedVersion : `v${resolvedVersion}`;
}

function requestLatestCore(force = false) {
  if (!force && latestCheckPromise) {
    return latestCheckPromise;
  }

  const requestEpoch = ++latestRequestEpoch;
  const request = invoke<CoreLatest>('check_latest_core')
    .then((result) => {
      if (requestEpoch === latestRequestEpoch) {
        cachedLatest = result;
        cachedLatestError = '';
      }
      return result;
    })
    .catch((error) => {
      if (requestEpoch === latestRequestEpoch) {
        cachedLatest = null;
        cachedLatestError = String(error);
      }
      throw error;
    })
    .finally(() => {
      if (latestCheckPromise === request) {
        latestCheckPromise = null;
      }
    });
  latestCheckPromise = request;

  return request;
}

export type KernelView = 'home' | 'versions';

export function KernelPage({ view = 'home' }: { view?: KernelView }) {
  const { t } = useI18n();
  const {
    info: appUpdate,
    error: appUpdateError,
    checking: checkingAppUpdate,
    task: appUpdateTask,
    check: checkAppUpdate,
    requestInstall: requestAppUpdate,
  } = useAppUpdate();
  const {
    status: coreStatus,
    statusError,
    refreshStatus,
    publishStatus,
  } = useCoreRuntime();
  const [installedAppVersion, setInstalledAppVersion] = useState('');
  const [platform, setPlatform] = useState<CorePlatform | null>(null);
  const [platformError, setPlatformError] = useState('');
  const [latest, setLatest] = useState<CoreLatest | null>(cachedLatest);
  const [latestError, setLatestError] = useState(cachedLatestError);
  const [bundledCore, setBundledCore] = useState<BundledCoreInfo | null>(null);
  const [bundledCoreError, setBundledCoreError] = useState('');
  const [checkingLatest, setCheckingLatest] = useState(Boolean(latestCheckPromise));
  const [listenHost, setListenHost] = useState('127.0.0.1');
  const [customPort, setCustomPort] = useState('8317');
  const [installing, setInstalling] = useState(false);
  const [processBusy, setProcessBusy] = useState(false);
  const [processNotice, setProcessNotice] = useState<{
    message: string;
    tone: MessageType;
  } | null>(null);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<MessageType>('info');
  const [catalogUpdating, setCatalogUpdating] = useState(false);
  const [catalogUpdateError, setCatalogUpdateError] = useState('');
  const [catalogUpdateNotice, setCatalogUpdateNotice] = useState('');
  const [progress, setProgress] = useState<CoreInstallTask | null>(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [cancellingInstall, setCancellingInstall] = useState(false);
  const [copiedApiField, setCopiedApiField] = useState('');
  const [homeApiKey, setHomeApiKey] = useState<string | null | undefined>(undefined);
  const [homeApiKeyError, setHomeApiKeyError] = useState(false);
  const [showHomeApiKey, setShowHomeApiKey] = useState(false);
  const [tlsEnabled, setTlsEnabled] = useState(false);
  const [versionSource, setVersionSource] = useState<VersionSourceSettings | null>(null);
  const [versionSourceSaving, setVersionSourceSaving] = useState(false);
  const [versionSourceError, setVersionSourceError] = useState('');
  const installDialogRef = useRef<HTMLDivElement>(null);
  const latestCheckEpochRef = useRef(0);
  const savedPortRef = useRef(8317);
  const processNoticeTimerRef = useRef<number | null>(null);
  const copiedApiTimerRef = useRef<number | null>(null);

  const showProcessNotice = (message: string, tone: MessageType) => {
    if (processNoticeTimerRef.current !== null) {
      window.clearTimeout(processNoticeTimerRef.current);
    }

    setProcessNotice({ message, tone });
    processNoticeTimerRef.current = window.setTimeout(() => {
      setProcessNotice(null);
      processNoticeTimerRef.current = null;
    }, 3600);
  };

  const applyInstallTask = (task: CoreInstallTask, showFinishedDialog = true) => {
    if (!task.running && !task.message && !task.result) {
      setProgress(null);
      setInstalling(false);
      setCancellingInstall(false);
      return;
    }

    setInstalling(task.running);
    if (!task.running) {
      setCancellingInstall(false);
    }

    if (task.running || showFinishedDialog) {
      setProgress(task);
      setInstallDialogOpen(true);
    } else {
      setProgress(null);
    }

    if (task.result) {
      setMessage(task.message || t('kernel.install.completed', { version: task.result.version }));
      setMessageType('success');
      void refreshStatus();
      return;
    }

    if (task.message) {
      setMessage(task.message);
      setMessageType(task.phase === '安装失败' ? 'error' : 'info');
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let unlistenConfig: (() => void) | null = null;

    listen<CoreInstallTask>('core-install-progress', (event) => {
      applyInstallTask(event.payload);
    })
      .then((unlistenProgress) => {
        if (disposed) {
          unlistenProgress();
        } else {
          unlisten = unlistenProgress;
        }
      })
      .catch((error) => {
        if (!disposed) {
          setMessage(t('kernel.error.progressListener', { error: String(error) }));
          setMessageType('error');
        }
      });

    void listen('config-files-changed', () => {
      if (disposed) return;
      void loadGuiSettings();
      void loadTlsSettings();
      void refreshStatus();
      if (view === 'versions') void loadVersionSourceSettings();
      if (view === 'home') void loadHomeApiKey();
    }).then((stop) => {
      if (disposed) stop();
      else unlistenConfig = stop;
    });

    loadPlatform();
    loadBundledCore();
    loadInstallTask();
    loadGuiSettings();
    if (view === 'versions') void loadVersionSourceSettings();
    void loadTlsSettings();
    void getVersion()
      .then((version) => {
        if (!disposed) setInstalledAppVersion(version);
      })
      .catch(() => undefined);
    if (view === 'home') {
      void loadHomeApiKey();
    }

    if (!latestAutoCheckStarted) {
      latestAutoCheckStarted = true;
      void checkLatest();
    } else if (latestCheckPromise) {
      void checkLatest();
    }

    return () => {
      disposed = true;
      unlisten?.();
      unlistenConfig?.();
      if (processNoticeTimerRef.current !== null) {
        window.clearTimeout(processNoticeTimerRef.current);
      }
      if (copiedApiTimerRef.current !== null) {
        window.clearTimeout(copiedApiTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!installDialogOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    installDialogRef.current?.focus();

    const preventEscapeClose = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
      }
    };

    document.addEventListener('keydown', preventEscapeClose);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', preventEscapeClose);
    };
  }, [installDialogOpen]);

  const runCoreProcessCommand = async (
    command: CoreProcessCommand,
    messages?: { success?: string; failure?: string },
  ) => {
    const actionLabel =
      command === 'start_core_process'
        ? t('kernel.action.start')
        : command === 'stop_core_process'
          ? t('kernel.action.stop')
          : t('kernel.action.restart');
    setProcessBusy(true);

    try {
      const result = await invoke<CoreStatus>(command);
      publishStatus(result);
      showProcessNotice(messages?.success ?? t('kernel.notice.actionSuccess', { action: actionLabel }), 'success');
      return true;
    } catch (error) {
      const errorMessage = String(error);
      await refreshStatus();
      showProcessNotice(
        messages?.failure
          ? `${messages.failure}: ${errorMessage}`
          : t('kernel.notice.actionFailed', { action: actionLabel, error: errorMessage }),
        'error',
      );
      return false;
    } finally {
      setProcessBusy(false);
    }
  };

  const loadGuiSettings = async () => {
    try {
      const settings = await invoke<GuiSettings>('get_gui_settings');
      setListenHost(settings.host);
      setCustomPort(String(settings.port));
      savedPortRef.current = settings.port;
    } catch {}
  };

  const loadVersionSourceSettings = async () => {
    try {
      const settings = await invoke<VersionSourceSettings>('get_version_source_settings');
      setVersionSource(settings);
      setVersionSourceError('');
    } catch (error) {
      setVersionSourceError(String(error));
    }
  };

  const loadHomeApiKey = async () => {
    try {
      const settings = await invoke<CoreConfigSummary>('get_core_config_settings');
      setHomeApiKey(settings.apiKeys[0]?.apiKey ?? null);
      setHomeApiKeyError(false);
    } catch {
      setHomeApiKey(undefined);
      setHomeApiKeyError(true);
    }
  };

  const loadTlsSettings = async () => {
    try {
      const settings = await invoke<CoreTlsSettings>('get_core_tls_settings');
      setTlsEnabled(settings.enabled);
    } catch {
      setTlsEnabled(false);
    }
  };

  const loadPlatform = async () => {
    try {
      const result = await invoke<CorePlatform>('detect_core_platform');
      setPlatform(result);
      setPlatformError('');
    } catch (error) {
      setPlatform(null);
      setPlatformError(String(error));
    }
  };

  const loadBundledCore = async () => {
    try {
      const result = await invoke<BundledCoreInfo | null>('detect_bundled_core');
      setBundledCore(result);
      setBundledCoreError('');
    } catch (error) {
      setBundledCore(null);
      setBundledCoreError(String(error));
    }
  };

  const checkLatest = async (force = false) => {
    const checkEpoch = ++latestCheckEpochRef.current;
    setCheckingLatest(true);
    setLatestError('');
    setMessage('');
    setMessageType('info');

    try {
      const result = await requestLatestCore(force);
      if (checkEpoch === latestCheckEpochRef.current) setLatest(result);
    } catch (error) {
      if (checkEpoch === latestCheckEpochRef.current) {
        setLatest(null);
        setLatestError(String(error));
      }
    } finally {
      if (checkEpoch === latestCheckEpochRef.current) setCheckingLatest(false);
    }
  };

  const updateVersionSource = async (enabled: boolean) => {
    setVersionSourceSaving(true);
    setVersionSourceError('');
    try {
      const settings = await invoke<VersionSourceSettings>('set_prefer_gitcode_downloads', { enabled });
      setVersionSource(settings);
      cachedLatest = null;
      cachedLatestError = '';
      setLatest(null);
      await Promise.all([checkAppUpdate(), checkLatest(true)]);
    } catch (error) {
      await loadVersionSourceSettings();
      setVersionSourceError(t('kernel.versions.gitcodeSaveFailed', { error: String(error) }));
    } finally {
      setVersionSourceSaving(false);
    }
  };

  const loadInstallTask = async () => {
    try {
      const task = await invoke<CoreInstallTask>('get_core_install_task');
      applyInstallTask(task, false);
    } catch (error) {
      setMessage(t('kernel.error.installTask', { error: String(error) }));
      setMessageType('error');
    }
  };

  const installVersion = async (version: string) => {
    setInstalling(true);
    setMessage(t('kernel.install.installingVersion', { version }));
    setMessageType('info');
    setCancellingInstall(false);
    setInstallDialogOpen(true);
    setProgress({
      running: true,
      cancellable: true,
      phase: '准备下载',
      downloaded: 0,
      total: null,
      percent: null,
      message: null,
      result: null,
    });

    try {
      const result = await invoke<CoreInstallResult>('install_core_version', { version });
      setMessage(t('kernel.install.completed', { version: result.version }));
      setMessageType('success');
      setProgress({
        running: false,
        cancellable: false,
        phase: '安装完成',
        downloaded: 1,
        total: 1,
        percent: 100,
        message: t('kernel.install.completed', { version: result.version }),
        result,
      });
      await Promise.all([refreshStatus(), loadBundledCore()]);
    } catch (error) {
      const errorMessage = String(error);
      setMessage(errorMessage);
      setMessageType(errorMessage.includes('取消') ? 'info' : 'error');
      setProgress((current) => ({
        running: false,
        cancellable: false,
        phase: errorMessage.includes('取消') ? '已取消' : '安装失败',
        downloaded: current?.downloaded ?? 0,
        total: current?.total ?? null,
        percent: current?.percent ?? null,
        message: errorMessage,
        result: null,
      }));
    } finally {
      setInstalling(false);
    }
  };

  const installBundledCore = async () => {
    if (!bundledCore) return;

    setInstalling(true);
    setMessage(t('kernel.install.installingBundled', { version: bundledCore.version }));
    setMessageType('info');
    setCancellingInstall(false);
    setInstallDialogOpen(true);
    setProgress({
      running: true,
      cancellable: false,
      phase: '准备内置内核',
      downloaded: 0,
      total: bundledCore.sizeBytes,
      percent: 0,
      message: null,
      result: null,
    });
    try {
      const result = await invoke<CoreInstallResult>('install_bundled_core');
      setMessage(t('kernel.install.bundledCompleted', { version: result.version }));
      setMessageType('success');
      await Promise.all([refreshStatus(), loadBundledCore()]);
    } catch (error) {
      const errorMessage = String(error);
      setMessage(errorMessage);
      setMessageType('error');
      setProgress((current) => ({
        running: false,
        cancellable: false,
        phase: '安装失败',
        downloaded: current?.downloaded ?? 0,
        total: current?.total ?? null,
        percent: current?.percent ?? null,
        message: errorMessage,
        result: null,
      }));
    } finally {
      setInstalling(false);
    }
  };

  const cancelInstall = async () => {
    if (cancellingInstall || !progress?.running || !progress.cancellable) {
      return;
    }

    setCancellingInstall(true);
    setMessage(t('kernel.install.cancelling'));
    setMessageType('info');

    try {
      await invoke('cancel_core_install');
    } catch (error) {
      setCancellingInstall(false);
      setMessage(String(error));
      setMessageType('error');
    }
  };

  const closeInstallDialog = () => {
    if (installing || progress?.running) {
      return;
    }

    setInstallDialogOpen(false);
    setProgress(null);
    setCancellingInstall(false);
  };

  const copyApiValue = async (value: string, field: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedApiField(field);
      showProcessNotice(message, 'success');
      if (copiedApiTimerRef.current !== null) {
        window.clearTimeout(copiedApiTimerRef.current);
      }
      copiedApiTimerRef.current = window.setTimeout(() => {
        setCopiedApiField('');
        copiedApiTimerRef.current = null;
      }, 1800);
    } catch {
      showProcessNotice(t('kernel.notice.copyFailed'), 'error');
    }
  };

  const openAppRelease = async () => {
    try {
      await invoke('open_external_url', { url: appUpdate?.releaseUrl || APP_RELEASE_URL });
    } catch (error) {
      showProcessNotice(t('kernel.error.openUpdate', { error: String(error) }), 'error');
    }
  };

  const updateCodexModelCatalog = async () => {
    setCatalogUpdating(true);
    setCatalogUpdateError('');
    setCatalogUpdateNotice('');
    try {
      const result = await invoke<CodexModelCatalogUpdateResult>('update_codex_model_catalog');
      setCatalogUpdateNotice(result.outcome === 'updated'
        ? t('appUpdate.catalog.updated')
        : t('appUpdate.catalog.unchanged'));
    } catch (error) {
      setCatalogUpdateError(String(error));
    } finally {
      setCatalogUpdating(false);
    }
  };

  const latestVersion = latest?.version ?? '';
  const currentVersion = coreStatus?.currentVersion ?? '';
  const coreInstalled = Boolean(coreStatus?.installed);
  const coreRunning = Boolean(coreStatus?.running);
  const coreProcessBusy = processBusy || Boolean(coreStatus?.starting);
  const busy = checkingLatest || installing || coreProcessBusy;
  const installDisabled = busy || Boolean(coreStatus?.running);
  const offlineInstallDisabled = installing || coreProcessBusy || coreRunning;

  const stopAndInstallLatest = async () => {
    if (!latestVersion) return;

    if (coreRunning) {
      const stopped = await runCoreProcessCommand('stop_core_process', {
        success: t('kernel.notice.stopped'),
      });
      if (!stopped) return;
    }

    await installVersion(latestVersion);
  };

  const computedPercent =
    progress?.percent ??
    (progress?.total && progress.total > 0 ? (progress.downloaded / progress.total) * 100 : null);
  const progressKnown = computedPercent !== null;
  const progressPercent = clampPercent(computedPercent ?? 0);
  const progressText = progress
    ? progress.phase === '安装完成'
      ? t('kernel.progress.completed')
      : progress.phase === '解压中'
        ? t('kernel.progress.extracting')
        : progress.total
          ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
          : progress.downloaded > 0
            ? formatBytes(progress.downloaded)
            : t('kernel.progress.waiting')
    : '';
  const statusTone = statusError ? 'error' : coreRunning ? 'success' : 'neutral';
  const statusLabel = coreStatus
    ? coreRunning
      ? t('kernel.status.running')
      : coreInstalled
        ? t('kernel.status.stopped')
        : t('kernel.status.notInstalled')
    : statusError
      ? t('common.detectionFailed')
      : t('common.detecting');
  const resolvedAppVersion = appUpdate?.currentVersion || installedAppVersion;
  const currentAppVersion = resolvedAppVersion
    ? displayAppVersion(resolvedAppVersion)
    : t('common.detecting');
  const appVersionStatusLabel = appUpdateTask.running
    ? t(`appUpdate.phase.${appUpdateTask.phase}` as Parameters<typeof t>[0])
    : appUpdateError
      ? t('kernel.update.failed')
      : appUpdate?.updateAvailable
        ? t('appUpdate.available', { version: displayAppVersion(appUpdate.latestVersion) })
        : appUpdate
          ? t('appUpdate.upToDate')
          : t('appUpdate.phase.checking');
  const appVersionStatusTone = appUpdateError
    ? 'error'
    : appUpdate?.updateAvailable
      ? 'update'
      : appUpdate
        ? 'success'
        : '';
  const latestLabel = checkingLatest
    ? t('kernel.update.checking')
    : latestVersion || (latestError ? t('kernel.update.failed') : t('kernel.update.notChecked'));
  const updateStateLabel = checkingLatest
    ? t('kernel.update.statusChecking')
    : latestError
      ? t('kernel.update.failed')
      : !latestVersion
        ? t('kernel.update.notYetChecked')
        : currentVersion === latestVersion
          ? t('kernel.update.latest')
          : t('kernel.update.available');
  const platformOsLabel = platform?.os || (platformError ? t('common.detectionFailed') : t('common.detecting'));
  const platformArchLabel = platform?.arch || (platformError ? t('common.detectionFailed') : t('common.detecting'));
  const installTaskRunning = Boolean(installing || progress?.running);
  const offlineInstallRequired = Boolean(coreStatus && !coreInstalled && latestError);
  const versionStatusLabel = installTaskRunning
    ? cancellingInstall
      ? t('kernel.install.cancelling')
      : progress?.phase ? localizeInstallPhase(progress.phase, t) : t('kernel.install.inProgress')
    : offlineInstallRequired
      ? t('kernel.install.githubFailed')
      : message || updateStateLabel;
  const versionStatusTone: MessageType | 'update' = installTaskRunning
    ? 'info'
    : offlineInstallRequired
      ? 'error'
    : message
      ? messageType
      : latestError
        ? 'error'
        : currentVersion && currentVersion === latestVersion
          ? 'success'
          : latestVersion && currentVersion !== latestVersion
            ? 'update'
            : 'info';
  const installDialogTone: MessageType = progress?.result
    ? 'success'
    : progress?.phase === '安装失败'
      ? 'error'
      : 'info';
  const installDialogTitle = installTaskRunning
    ? cancellingInstall
      ? t('kernel.install.titleCancelling')
      : t('kernel.install.titleInstalling')
    : progress?.result
      ? t('kernel.install.titleCompleted')
      : progress?.phase === '已取消'
        ? t('kernel.install.titleCancelled')
        : t('kernel.install.titleFailed');
  const installDialogMessage = cancellingInstall
    ? t('kernel.install.waitingStop')
    : progress?.message || (installTaskRunning ? message || t('kernel.install.taskRunning') : '');
  const installDialogAction = installTaskRunning
    ? cancellingInstall
      ? t('kernel.install.cancellingShort')
      : progress?.cancellable
        ? t('kernel.install.cancel')
        : t('common.processing')
    : t('common.close');
  const installDialogActionDisabled =
    installTaskRunning && (cancellingInstall || !progress?.cancellable);
  const apiPort = Number(customPort);
  const apiProfiles = clientApiProfiles(
    Number.isInteger(apiPort) && apiPort >= 1 && apiPort <= 65535
      ? apiPort
      : savedPortRef.current,
    tlsEnabled,
    listenHost,
  );
  const apiProfileIcons = {
    openai: openaiIcon,
    claude: claudeIcon,
    gemini: geminiIcon,
  } as const;

  return (
    <section className={`page kernel-page ${view === 'home' ? 'home-page' : 'version-management-page'}`}>
      {view === 'versions' ? (
        <header className="version-page-header">
          <div className="version-page-title">
            <span className="version-page-title-icon" aria-hidden="true">
              <PackageOpen size={22} />
            </span>
            <div>
              <h1>{t('app.nav.versions')}</h1>
              <p>{t('kernel.versions.offlineHint')}</p>
            </div>
          </div>

          <div className="version-source-control">
            <div className="version-source-copy">
              <Info size={17} aria-hidden="true" />
              <div>
                <strong>{t('kernel.versions.gitcodeSource')}</strong>
                <span>
                  {versionSource?.gitcodeAvailable === false
                    ? t('kernel.versions.gitcodeUnavailable')
                    : t('kernel.versions.gitcodeSourceHint')}
                </span>
              </div>
            </div>
            <label className="switch-control" title={t('kernel.versions.gitcodeSource')}>
              <input
                type="checkbox"
                role="switch"
                checked={versionSource?.preferGitcodeDownloads ?? false}
                disabled={
                  (!versionSource?.gitcodeAvailable && !versionSource?.preferGitcodeDownloads)
                  || versionSourceSaving
                  || appUpdateTask.running
                  || installing
                }
                aria-label={t('kernel.versions.gitcodeSource')}
                onChange={(event) => void updateVersionSource(event.currentTarget.checked)}
              />
              <span className="switch-track" />
            </label>
            {versionSourceError ? <p className="error version-source-error" role="alert">{versionSourceError}</p> : null}
          </div>
        </header>
      ) : null}

      <div className={view === 'home' ? 'kernel-layout home-layout' : 'kernel-layout version-management-layout'}>
        {view === 'home' ? (
        <div className="panel control-panel">
          <div className="panel-heading">
            <div>
              <h2>{t('kernel.control.title')}</h2>
            </div>
            <span className={`state-pill ${statusTone}`} title={statusError || undefined}>
              {coreProcessBusy ? t('common.processing') : statusLabel}
            </span>
          </div>

          <dl className="panel-detail-grid">
            <div className="panel-detail-row">
              <dt>{t('kernel.control.installStatus')}</dt>
              <dd>{coreStatus ? (coreInstalled ? t('kernel.control.installed') : t('kernel.status.notInstalled')) : t('common.detecting')}</dd>
            </div>
            <div className="panel-detail-row">
              <dt>{t('kernel.control.runStatus')}</dt>
              <dd>{coreStatus ? (coreRunning ? t('kernel.status.running') : t('kernel.control.notRunning')) : t('common.detecting')}</dd>
            </div>
            <div className="panel-detail-row">
              <dt>{t('kernel.control.pid')}</dt>
              <dd>{coreStatus?.processId || t('kernel.control.noPid')}</dd>
            </div>
            <div className="panel-detail-row">
              <dt>{t('kernel.overview.coreVersion')}</dt>
              <dd>
                {currentVersion
                  || (coreInstalled ? t('common.unavailable') : t('kernel.status.notInstalled'))}
              </dd>
            </div>
            <div className="panel-detail-row">
              <dt>{t('kernel.overview.appVersion')}</dt>
              <dd>{currentAppVersion}</dd>
            </div>
          </dl>

          <div className="button-row panel-action-row control-action-row">
            <button
              type="button"
              className={coreRunning ? 'danger-button' : 'primary-button'}
              disabled={!coreInstalled || installing || coreProcessBusy}
              onClick={() =>
                void runCoreProcessCommand(
                  coreRunning ? 'stop_core_process' : 'start_core_process',
                  { success: coreRunning ? t('kernel.notice.stopped') : t('kernel.notice.started') },
                )
              }
            >
              {coreProcessBusy ? t('common.processing') : coreRunning ? t('kernel.action.stop') : t('kernel.action.start')}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!coreInstalled || !coreRunning || installing || coreProcessBusy}
              onClick={() =>
                void runCoreProcessCommand('restart_core_process', { success: t('kernel.notice.restarted') })
              }
            >
              {t('kernel.action.restart')}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={coreProcessBusy}
              onClick={() => void refreshStatus()}
            >
              {t('kernel.control.refresh')}
            </button>
          </div>

        </div>
        ) : null}

        {view === 'versions' ? (
          <article className="panel version-product-card software-update-panel">
            <div className="version-product-heading">
              <div className="version-product-identity">
                <span className="version-product-icon software" aria-hidden="true">
                  <AppWindow size={21} />
                </span>
                <h2>{t('appUpdate.title')}</h2>
              </div>
              <span className={`state-pill ${appVersionStatusTone}`} title={appUpdateError || appVersionStatusLabel}>
                {appVersionStatusLabel}
              </span>
            </div>

            <div className="version-comparison" aria-label={t('appUpdate.title')}>
              <div className="version-value-block current">
                <span>{t('appUpdate.current')}</span>
                <strong>{currentAppVersion}</strong>
              </div>
              <ArrowRight className="version-comparison-arrow" size={20} aria-hidden="true" />
              <div className="version-value-block latest">
                <span>{t('appUpdate.latest')}</span>
                <strong>{appUpdate ? displayAppVersion(appUpdate.latestVersion) : t('common.detecting')}</strong>
              </div>
            </div>

            <div className="version-card-support">
              <Database size={17} aria-hidden="true" />
              <div>
                <strong>{t('appUpdate.catalog.label')}</strong>
                <span
                  className={catalogUpdateError ? 'error' : catalogUpdateNotice ? 'success' : ''}
                  role={catalogUpdateError ? 'alert' : undefined}
                  aria-live="polite"
                >
                  {catalogUpdateError
                    || catalogUpdateNotice
                    || t('appUpdate.catalog.description')}
                </span>
              </div>
            </div>

            <div className="version-card-note-slot">
              {appUpdateError ? (
                <p className="version-card-note error" role="alert">{appUpdateError}</p>
              ) : !appUpdate?.autoUpdateSupported ? (
                <p className="version-card-note">{t('appUpdate.manualFallback')}</p>
              ) : null}
            </div>

            <div className="button-row panel-action-row software-update-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={checkingAppUpdate || appUpdateTask.running}
                onClick={() => void checkAppUpdate()}
              >
                <RefreshCw size={15} aria-hidden="true" />
                {checkingAppUpdate ? t('appUpdate.checking') : t('appUpdate.check')}
              </button>
              {appUpdate?.updateAvailable && appUpdate.autoUpdateSupported ? (
                <button
                  type="button"
                  className="primary-button"
                  disabled={appUpdateTask.running}
                  onClick={requestAppUpdate}
                >
                  <Download size={15} aria-hidden="true" />
                  {t('appUpdate.installNow')}
                </button>
              ) : (
                <button
                  type="button"
                  className={appUpdate?.updateAvailable ? 'primary-button' : 'secondary-button'}
                  onClick={() => void openAppRelease()}
                >
                  {t('appUpdate.openRelease')} <ExternalLink size={14} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={catalogUpdating || appUpdateTask.running}
                onClick={() => void updateCodexModelCatalog()}
                title={t('appUpdate.catalog.updateHint')}
              >
                <Database size={15} aria-hidden="true" />
                {catalogUpdating
                  ? t('appUpdate.catalog.updating')
                  : t('appUpdate.catalog.update')}
              </button>
            </div>
          </article>
        ) : null}

        {view === 'versions' ? (
        <article className="panel version-product-card version-panel">
          <div className="version-product-heading">
            <div className="version-product-identity">
              <span className="version-product-icon core" aria-hidden="true">
                <Box size={21} />
              </span>
              <h2>{t('kernel.versions.title')}</h2>
            </div>
            <span className={`state-pill ${versionStatusTone}`} title={versionStatusLabel}>
              {versionStatusLabel}
            </span>
          </div>

          <div className="version-core-values">
            <div className="version-value-block current">
              <span>{t('kernel.versions.current')}</span>
              <strong>{currentVersion || t('kernel.status.notInstalled')}</strong>
            </div>
            <div className="version-value-block latest">
              <span>{t('kernel.versions.latest')}</span>
              <strong>{latestLabel}</strong>
            </div>
            <div className="version-value-block bundled">
              <span>{t('kernel.versions.bundled')}</span>
              <strong title={bundledCoreError || bundledCore?.assetName}>
                {bundledCore?.version ?? (bundledCoreError ? t('common.detectionFailed') : t('kernel.versions.notIncluded'))}
              </strong>
            </div>
          </div>

          <div className="version-card-support core-platform-line">
            <Box size={17} aria-hidden="true" />
            <div>
              <strong>{t('kernel.versions.platform')}</strong>
              <span title={platformError || undefined}>{platformOsLabel} / {platformArchLabel}</span>
            </div>
          </div>

          <div className="version-card-note-slot" aria-hidden="true" />

          <div className="button-row panel-action-row version-action-row">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void checkLatest()}
            >
              <RefreshCw size={15} aria-hidden="true" />
              {checkingLatest ? t('kernel.update.checking') : t('kernel.versions.check')}
            </button>
            <button
              type="button"
              className={latestVersion && currentVersion !== latestVersion ? 'primary-button' : 'secondary-button'}
              title={latestVersion ? t('kernel.versions.stopAndUpdateVersion', { version: latestVersion }) : t('kernel.versions.installLatest')}
              disabled={!latestVersion || busy}
              onClick={() => void stopAndInstallLatest()}
            >
              <Download size={15} aria-hidden="true" />
              {t('kernel.versions.installLatest')}
            </button>
            <button
              type="button"
              className="secondary-button"
              title={t('kernel.versions.reinstallTitle')}
              disabled={!currentVersion || installDisabled}
              onClick={() => installVersion(currentVersion)}
            >
              <RotateCcw size={15} aria-hidden="true" />
              {t('kernel.versions.reinstall')}
            </button>
            <button
              type="button"
              className={offlineInstallRequired ? 'primary-button' : 'secondary-button'}
              title={(bundledCore?.assetName ?? bundledCoreError) || t('kernel.versions.noBundled')}
              disabled={!bundledCore || offlineInstallDisabled}
              onClick={() => void installBundledCore()}
            >
              <PackageOpen size={15} aria-hidden="true" />
              {t('kernel.versions.offlineInstall')}
            </button>
          </div>

        </article>
        ) : null}
      </div>

      {view === 'home' ? (
      <section className="panel client-api-panel">
        <div className="panel-heading client-api-heading">
          <div>
            <h2>API URL</h2>
            {typeof homeApiKey === 'string' ? (
              <div className="client-api-key-actions">
                <button
                  type="button"
                  className="client-api-default-key"
                  aria-pressed={showHomeApiKey}
                  title={showHomeApiKey ? t('config.keys.hide') : t('config.keys.show')}
                  onClick={() => setShowHomeApiKey((visible) => !visible)}
                >
                  <span>{t('kernel.access.firstKey')}</span>
                  <code>{showHomeApiKey ? homeApiKey : '******'}</code>
                  {showHomeApiKey ? (
                    <EyeOff size={14} aria-hidden="true" />
                  ) : (
                    <Eye size={14} aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  className="icon-button quiet client-api-key-copy"
                  title={t('config.keys.copy')}
                  aria-label={t('config.keys.copy')}
                  onClick={() =>
                    void copyApiValue(
                      homeApiKey,
                      'home:api-key',
                      t('config.notice.keyCopied'),
                    )
                  }
                >
                  {copiedApiField === 'home:api-key' ? (
                    <Check size={14} aria-hidden="true" />
                  ) : (
                    <Copy size={14} aria-hidden="true" />
                  )}
                </button>
              </div>
            ) : homeApiKey === null ? (
              <p className="client-api-no-key">{t('kernel.access.noConfiguredKey')}</p>
            ) : (
              <p className={homeApiKeyError ? 'error' : undefined}>
                {homeApiKeyError ? t('common.unavailable') : t('common.loading')}
              </p>
            )}
          </div>
          <span className={`state-pill ${coreRunning ? 'success' : ''}`}>
            {coreRunning ? t('kernel.access.connectable') : t('kernel.access.waiting')}
          </span>
        </div>

        <div className="client-api-grid">
          {apiProfiles.map((profile) => (
            <article className={`client-api-card ${profile.id}`} key={profile.id}>
              <div className="client-api-card-heading">
                <span className="client-api-logo">
                  <img src={apiProfileIcons[profile.id]} alt="" />
                </span>
                <div>
                  <strong>{profile.name}</strong>
                  <span>{profile.description}</span>
                </div>
              </div>

              <div className="client-api-values">
                <div className="client-api-value-row">
                  <span>{t('kernel.access.apiUrl')}</span>
                  <code title={profile.baseUrl}>{profile.baseUrl}</code>
                  <button
                    type="button"
                    className="icon-button quiet"
                    onClick={() =>
                      void copyApiValue(
                        profile.baseUrl,
                        `${profile.id}:base`,
                        t('kernel.access.apiCopied', { name: profile.name }),
                      )
                    }
                    title={t('kernel.access.copyApi', { name: profile.name })}
                    aria-label={t('kernel.access.copyApi', { name: profile.name })}
                  >
                    {copiedApiField === `${profile.id}:base` ? (
                      <Check size={15} aria-hidden="true" />
                    ) : (
                      <Copy size={15} aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
      ) : null}

      {view === 'versions' && installDialogOpen && progress ? (
        <div className="install-dialog-backdrop">
          <div
            ref={installDialogRef}
            className={`install-dialog ${installDialogTone}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="install-dialog-title"
            aria-describedby="install-dialog-message"
            aria-busy={installTaskRunning}
            tabIndex={-1}
          >
            <div className="install-dialog-heading">
              <span>{t('kernel.dialog.install')}</span>
              <h2 id="install-dialog-title">{installDialogTitle}</h2>
            </div>

            <div className="install-dialog-phase">
              <span>{t('kernel.dialog.phase')}</span>
              <strong>{cancellingInstall ? t('kernel.install.cancellingShort') : localizeInstallPhase(progress.phase, t)}</strong>
            </div>

            <div
              className={`install-progress-track ${
                progressKnown ? '' : installTaskRunning ? 'unknown is-running' : 'unknown'
              }`}
            >
              <span
                className="install-progress-fill"
                style={progressKnown ? { width: `${progressPercent}%` } : undefined}
              />
            </div>

            <div className="install-progress-meta">
              <strong>{progressKnown ? `${progressPercent.toFixed(1)}%` : t('kernel.dialog.unknownProgress')}</strong>
              <span>{progressText}</span>
            </div>

            <div
              id="install-dialog-message"
              className={`install-dialog-message ${installDialogTone}`}
              aria-live="polite"
            >
              {installDialogMessage || '\u00a0'}
            </div>

            <button
              type="button"
              className={installTaskRunning ? 'danger-button' : 'primary-button'}
              disabled={installDialogActionDisabled}
              onClick={installTaskRunning ? cancelInstall : closeInstallDialog}
            >
              {installDialogAction}
            </button>
          </div>
        </div>
      ) : null}

      {processNotice ? (
        <div
          className={`config-toast ${processNotice.tone}`}
          role="status"
          title={processNotice.message}
        >
          {processNotice.tone === 'success' ? (
            <Check size={17} aria-hidden="true" />
          ) : processNotice.tone === 'error' ? (
            <AlertCircle size={17} aria-hidden="true" />
          ) : (
            <Info size={17} aria-hidden="true" />
          )}
          <span>{processNotice.message}</span>
        </div>
      ) : null}
    </section>
  );
}

function localizeInstallPhase(
  phase: string,
  t: ReturnType<typeof useI18n>['t'],
) {
  const keys = {
    '准备下载': 'kernel.phase.preparingDownload',
    '下载中': 'kernel.phase.downloading',
    '解压中': 'kernel.phase.extracting',
    '准备内置内核': 'kernel.phase.preparingBundled',
    '安装完成': 'kernel.phase.completed',
    '安装失败': 'kernel.phase.failed',
    '已取消': 'kernel.phase.cancelled',
  } as const;
  const key = keys[phase as keyof typeof keys];
  return key ? t(key) : phase;
}

function clampPercent(percent: number) {
  return Math.min(100, Math.max(0, percent));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
