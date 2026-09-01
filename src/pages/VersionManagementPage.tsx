import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  AlertCircle,
  Check,
  Download,
  ExternalLink,
  Info,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import { useAppUpdate } from '../appUpdate';

export type CoreLatest = {
  version: string;
  assetName: string;
};

export type CoreInstallResult = {
  version: string;
  assetName: string;
  installDir: string;
  binaryPath: string | null;
};

export type CoreInstallTask = {
  running: boolean;
  cancellable: boolean;
  phase: string;
  downloaded: number;
  total: number | null;
  percent: number | null;
  message: string | null;
  result: CoreInstallResult | null;
};

export type VersionSourceSettings = {
  source: VersionDownloadSource;
  gitcodeAvailable: boolean;
  customMirrors: string[];
};

export type VersionDownloadSource = string;

function downloadSourceLabel(source: VersionDownloadSource, t: ReturnType<typeof useI18n>['t']) {
  const keys: Record<string, Parameters<typeof t>[0]> = {
    github: 'kernel.versions.source.github',
    gitcode: 'kernel.versions.source.gitcode',
    'gh-proxy': 'kernel.versions.source.ghProxy',
    'gh-fast': 'kernel.versions.source.ghFast',
  };
  if (source.startsWith('custom:')) {
    const url = source.slice('custom:'.length);
    try {
      return `${t('kernel.versions.source.custom')} · ${new URL(url).host}`;
    } catch {
      return t('kernel.versions.source.custom');
    }
  }
  return t(keys[source] ?? 'kernel.versions.source.github');
}

export type MessageType = 'info' | 'success' | 'error';
const APP_RELEASE_URL = 'https://github.com/router-for-me/EasyCLIProxyAPI/releases/latest';

let latestAutoCheckStarted = false;
let cachedLatest: CoreLatest | null = null;
let cachedLatestError = '';
let latestCheckPromise: Promise<CoreLatest> | null = null;
let latestRequestEpoch = 0;

export function displayAppVersion(version: string) {
  const resolvedVersion = version.trim();
  return resolvedVersion.startsWith('v') ? resolvedVersion : `v${resolvedVersion}`;
}

export function requestLatestCore(force = false) {
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

export function VersionManagementPage() {
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
  } = useCoreRuntime();

  const [installedAppVersion, setInstalledAppVersion] = useState('');
  const [latest, setLatest] = useState<CoreLatest | null>(cachedLatest);
  const [latestError, setLatestError] = useState(cachedLatestError);
  const [checkingLatest, setCheckingLatest] = useState(Boolean(latestCheckPromise));

  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<CoreInstallTask | null>(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [confirmUpdateOpen, setConfirmUpdateOpen] = useState(false);
  const [cancellingInstall, setCancellingInstall] = useState(false);

  const [versionSource, setVersionSource] = useState<VersionSourceSettings | null>(null);
  const [versionSourceSaving, setVersionSourceSaving] = useState(false);
  const [versionSourceError, setVersionSourceError] = useState('');
  const [customMirrorDraft, setCustomMirrorDraft] = useState('');
  const [customMirrorDialogOpen, setCustomMirrorDialogOpen] = useState(false);

  const [toastNotice, setToastNotice] = useState<{
    message: string;
    tone: MessageType;
  } | null>(null);

  const installDialogRef = useRef<HTMLDivElement>(null);
  const customMirrorInputRef = useRef<HTMLInputElement>(null);
  const latestCheckEpochRef = useRef(0);
  const toastTimerRef = useRef<number | null>(null);
  const completedInstallKeyRef = useRef('');
  const manualInstallInProgressRef = useRef(false);

  const showToast = (message: string, tone: MessageType = 'info') => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToastNotice({ message, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToastNotice(null);
      toastTimerRef.current = null;
    }, 4000);
  };

  const showInstallCompletedToast = (result: CoreInstallResult, message?: string | null) => {
    const key = `${result.version}\u0000${result.assetName}\u0000${result.binaryPath ?? ''}`;
    if (completedInstallKeyRef.current === key) return;
    completedInstallKeyRef.current = key;
    showToast(message || t('kernel.install.completed', { version: result.version }), 'success');
  };

  const applyInstallTask = (
    task: CoreInstallTask,
    showFinishedDialog = true,
    showCompletionToast = true,
  ) => {
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

    if (showCompletionToast && (task.running || showFinishedDialog)) {
      setProgress(task);
      setInstallDialogOpen(true);
    } else {
      setProgress(null);
      setInstallDialogOpen(false);
    }

    if (task.result) {
      if (showCompletionToast) {
        showInstallCompletedToast(task.result, task.message);
      }
      setInstallDialogOpen(false);
      setProgress(null);
      setCancellingInstall(false);
      void refreshStatus();
      return;
    }

    if (task.message && !task.running) {
      showToast(task.message, task.phase === '安装失败' ? 'error' : 'info');
    }
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

  const loadInstallTask = async () => {
    try {
      const task = await invoke<CoreInstallTask>('get_core_install_task');
      applyInstallTask(task, false, false);
    } catch {}
  };

  const checkLatest = async (force = false) => {
    const checkEpoch = ++latestCheckEpochRef.current;
    setCheckingLatest(true);
    setLatestError('');

    try {
      const result = await requestLatestCore(force);
      if (checkEpoch === latestCheckEpochRef.current) {
        setLatest(result);
      }
    } catch (error) {
      if (checkEpoch === latestCheckEpochRef.current) {
        setLatest(null);
        setLatestError(String(error));
      }
    } finally {
      if (checkEpoch === latestCheckEpochRef.current) {
        setCheckingLatest(false);
      }
    }
  };

  const updateVersionSource = async (source: VersionDownloadSource) => {
    setVersionSourceSaving(true);
    setVersionSourceError('');
    try {
      const settings = await invoke<VersionSourceSettings>('set_download_source', { source });
      setVersionSource(settings);
      cachedLatest = null;
      cachedLatestError = '';
      setLatest(null);
      showToast(t('kernel.versions.sourceSwitched', {
        source: downloadSourceLabel(settings.source, t),
      }), 'info');
      setVersionSourceSaving(false);
      await checkAppUpdate();
      await checkLatest(true);
    } catch (error) {
      await loadVersionSourceSettings();
      setVersionSourceError(t('kernel.versions.gitcodeSaveFailed', { error: String(error) }));
      showToast(t('kernel.versions.gitcodeSaveFailed', { error: String(error) }), 'error');
    } finally {
      setVersionSourceSaving(false);
    }
  };

  const addCustomMirror = async () => {
    const url = customMirrorDraft.trim();
    if (!url) return;
    setVersionSourceSaving(true);
    setVersionSourceError('');
    try {
      const settings = await invoke<VersionSourceSettings>('add_custom_download_mirror', { url });
      setVersionSource(settings);
      setCustomMirrorDraft('');
      setCustomMirrorDialogOpen(false);
      cachedLatest = null;
      cachedLatestError = '';
      setLatest(null);
      showToast(t('kernel.versions.customMirrorAdded'), 'success');
      setVersionSourceSaving(false);
      await checkAppUpdate();
      await checkLatest(true);
    } catch (error) {
      const message = t('kernel.versions.customMirrorAddFailed', { error: String(error) });
      setVersionSourceError(message);
      showToast(message, 'error');
    } finally {
      setVersionSourceSaving(false);
    }
  };

  const removeCustomMirror = async (url: string) => {
    const wasSelected = versionSource?.source === `custom:${url}`;
    setVersionSourceSaving(true);
    setVersionSourceError('');
    try {
      const settings = await invoke<VersionSourceSettings>('remove_custom_download_mirror', {
        url,
      });
      setVersionSource(settings);
      showToast(t('kernel.versions.customMirrorRemoved'), 'success');
      setVersionSourceSaving(false);
      if (wasSelected) {
        await checkAppUpdate();
        await checkLatest(true);
      }
    } catch (error) {
      const message = t('kernel.versions.customMirrorRemoveFailed', { error: String(error) });
      setVersionSourceError(message);
      showToast(message, 'error');
    } finally {
      setVersionSourceSaving(false);
    }
  };

  const installVersion = async (version: string) => {
    completedInstallKeyRef.current = '';
    manualInstallInProgressRef.current = true;
    setInstalling(true);
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
      showInstallCompletedToast(result, t('kernel.install.completed', { version: result.version }));
      manualInstallInProgressRef.current = false;
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
      setInstallDialogOpen(false);
      setProgress(null);
      setCancellingInstall(false);
      await refreshStatus();
    } catch (error) {
      manualInstallInProgressRef.current = false;
      const errorMessage = String(error);
      showToast(errorMessage, errorMessage.includes('取消') ? 'info' : 'error');
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

  const cancelInstall = async () => {
    if (cancellingInstall || !progress?.running || !progress.cancellable) {
      return;
    }

    setCancellingInstall(true);
    try {
      await invoke('cancel_core_install');
    } catch (error) {
      setCancellingInstall(false);
      showToast(String(error), 'error');
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

  const openAppRelease = async () => {
    try {
      await invoke('open_external_url', { url: appUpdate?.releaseUrl || APP_RELEASE_URL });
    } catch (error) {
      showToast(t('kernel.error.openUpdate', { error: String(error) }), 'error');
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let unlistenConfig: (() => void) | null = null;
    let unlistenVersionSource: (() => void) | null = null;

    listen<CoreInstallTask>('core-install-progress', (event) => {
      const showTaskUi = manualInstallInProgressRef.current;
      applyInstallTask(event.payload, showTaskUi, showTaskUi);
      if (!event.payload.running) {
        manualInstallInProgressRef.current = false;
      }
    })
      .then((unlistenProgress) => {
        if (disposed) unlistenProgress();
        else unlisten = unlistenProgress;
      })
      .catch(() => undefined);

    void listen('config-files-changed', () => {
      if (disposed) return;
      void loadVersionSourceSettings();
      void refreshStatus();
    }).then((stop) => {
      if (disposed) stop();
      else unlistenConfig = stop;
    });

    void listen<VersionSourceSettings>('version-download-source-changed', (event) => {
      if (disposed) return;
      setVersionSource(event.payload);
      setVersionSourceError('');
      showToast(t('kernel.versions.sourceAutoSwitched', {
        source: downloadSourceLabel(event.payload.source, t),
      }), 'info');
    }).then((stop) => {
      if (disposed) stop();
      else unlistenVersionSource = stop;
    });

    loadInstallTask();
    loadVersionSourceSettings();

    void getVersion()
      .then((version) => {
        if (!disposed) setInstalledAppVersion(version);
      })
      .catch(() => undefined);

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
      unlistenVersionSource?.();
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!installDialogOpen) return;

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

  useEffect(() => {
    if (!customMirrorDialogOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => customMirrorInputRef.current?.focus(), 0);

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !versionSourceSaving) {
        setCustomMirrorDialogOpen(false);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [customMirrorDialogOpen, versionSourceSaving]);

  // Derived state calculations
  const latestVersion = latest?.version ?? '';
  const currentVersion = coreStatus?.currentVersion ?? '';
  const coreInstalled = Boolean(coreStatus?.installed);
  const coreProcessBusy = Boolean(coreStatus?.starting);
  const busy = checkingLatest || installing || coreProcessBusy;
  const installDisabled = busy || installing;

  const resolvedAppVersion = appUpdate?.currentVersion || installedAppVersion;
  const currentAppVersion = resolvedAppVersion ? displayAppVersion(resolvedAppVersion) : t('common.detecting');
  const latestAppVersion = appUpdate?.latestVersion ? displayAppVersion(appUpdate.latestVersion) : '';

  const appHasUpdate = Boolean(appUpdate?.updateAvailable);
  const appVersionStatusLabel: string | null = appUpdateTask.running
    ? t(`appUpdate.phase.${appUpdateTask.phase}` as Parameters<typeof t>[0])
    : appUpdateError
      ? t('kernel.update.failed')
      : appHasUpdate
        ? t('appUpdate.available', { version: latestAppVersion })
        : checkingAppUpdate || !appUpdate
          ? t('appUpdate.phase.checking')
          : null;
  const appVersionStatusTone = appUpdateError
    ? 'error'
    : appUpdateTask.running || checkingAppUpdate || !appUpdate
      ? 'info'
      : 'update';

  const coreHasUpdate = Boolean(latestVersion && currentVersion && currentVersion !== latestVersion);

  const coreVersionStatusTone = installing || progress?.running
    ? 'info'
    : latestError
      ? 'error'
      : coreHasUpdate
        ? 'update'
        : 'neutral';

  const coreVersionStatusLabel: string | null = installing || progress?.running
    ? (cancellingInstall ? t('kernel.install.cancelling') : progress?.phase ? localizeInstallPhase(progress.phase, t) : t('kernel.install.inProgress'))
    : latestError
      ? t('kernel.update.failed')
      : coreHasUpdate
        ? t('kernel.update.available')
        : !coreInstalled
          ? t('kernel.status.notInstalled')
          : null;

  // Install dialog calculations
  const computedPercent = progress?.percent ?? (progress?.total && progress.total > 0 ? (progress.downloaded / progress.total) * 100 : null);
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

  const installDialogTone: MessageType = progress?.result
    ? 'success'
    : progress?.phase === '安装失败'
      ? 'error'
      : 'info';

  const installDialogTitle = progress?.running || installing
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
    : progress?.message || (installing ? t('kernel.install.taskRunning') : '');

  const installDialogAction = installing || progress?.running
    ? cancellingInstall
      ? t('kernel.install.cancellingShort')
      : progress?.cancellable
        ? t('kernel.install.cancel')
        : t('common.processing')
    : t('common.close');

  const installDialogActionDisabled = (installing || progress?.running) && (cancellingInstall || !progress?.cancellable);

  return (
    <section className="page management-page version-management-page">
      <section className="panel version-list">
        <div className="version-source-row" aria-label={t('kernel.versions.downloadSource')}>
          <div className="version-source-copy">
            <strong>{t('kernel.versions.downloadSource')}</strong>
            <span>{t('kernel.versions.downloadSourceHint')}</span>
            {versionSource?.gitcodeAvailable === false ? (
              <span>{t('kernel.versions.gitcodeUnavailable')}</span>
            ) : null}
            {versionSourceError ? (
              <span className="version-source-error" role="alert">{versionSourceError}</span>
            ) : null}
          </div>
          <div className="version-source-control">
            <label>
              <span className="sr-only">{t('kernel.versions.downloadSource')}</span>
              <select
                value={versionSource?.source ?? 'github'}
                disabled={
                  !versionSource
                  || versionSourceSaving
                  || appUpdateTask.running
                  || installing
                }
                aria-label={t('kernel.versions.downloadSource')}
                onChange={(event) => void updateVersionSource(event.currentTarget.value as VersionDownloadSource)}
              >
                <option value="github">{t('kernel.versions.source.github')}</option>
                <option value="gitcode" disabled={!versionSource?.gitcodeAvailable}>
                  {t('kernel.versions.source.gitcode')}
                </option>
                <option value="gh-proxy">{t('kernel.versions.source.ghProxy')}</option>
                <option value="gh-fast">{t('kernel.versions.source.ghFast')}</option>
                {versionSource?.customMirrors.map((url) => (
                  <option key={url} value={`custom:${url}`}>
                    {downloadSourceLabel(`custom:${url}`, t)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="primary-button version-source-add-button"
              disabled={versionSourceSaving || appUpdateTask.running || installing}
              onClick={() => {
                setVersionSourceError('');
                setCustomMirrorDialogOpen(true);
              }}
            >
              <span>{t('kernel.versions.customMirrorAdd')}</span>
            </button>
          </div>
        </div>

        <div className="version-card-grid">
        <article className="version-list-item app-module-card">
          <div className="version-item-content">
            <div className="version-card-top">
              <h2>{t('kernel.versions.appCardTitle')}</h2>
              {appVersionStatusLabel ? (
                <span className={`version-row-status ${appVersionStatusTone}`} title={appUpdateError || appVersionStatusLabel}>
                  {appVersionStatusLabel}
                </span>
              ) : null}
            </div>

            <dl className="version-metrics-comparison">
              <div className="version-metric-tile">
                <dt className="version-metric-label">{t('appUpdate.current')}</dt>
                <dd className="version-metric-value">{currentAppVersion}</dd>
              </div>
              <div className={`version-metric-tile ${appHasUpdate ? 'has-update' : ''}`}>
                <dt className="version-metric-label">{t('appUpdate.latest')}</dt>
                <dd className="version-metric-value">
                  {appUpdate ? (latestAppVersion || currentAppVersion) : (checkingAppUpdate ? t('appUpdate.checking') : t('common.detecting'))}
                </dd>
              </div>
            </dl>

            {appUpdateError ? (
              <div className="version-alert-banner error" role="alert">
                <AlertCircle size={14} />
                <span>{appUpdateError}</span>
              </div>
            ) : !appUpdate?.autoUpdateSupported ? (
              <div className="version-alert-banner neutral">
                <Info size={14} />
                <span>{t('appUpdate.manualFallback')}</span>
              </div>
            ) : null}
          </div>

          <div className="version-card-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={checkingAppUpdate || appUpdateTask.running}
              onClick={() => void checkAppUpdate()}
            >
              <RefreshCw size={15} className={checkingAppUpdate ? 'spin' : ''} aria-hidden="true" />
              <span>{checkingAppUpdate ? t('appUpdate.checking') : t('appUpdate.check')}</span>
            </button>

            {appHasUpdate && appUpdate?.autoUpdateSupported ? (
              <button
                type="button"
                className="primary-button"
                disabled={appUpdateTask.running}
                onClick={requestAppUpdate}
              >
                <Download size={15} aria-hidden="true" />
                <span>{t('appUpdate.installNow')}</span>
              </button>
            ) : null}

            <button
              type="button"
              className={appHasUpdate && !appUpdate?.autoUpdateSupported ? 'primary-button' : 'secondary-button'}
              onClick={() => void openAppRelease()}
            >
              <ExternalLink size={15} aria-hidden="true" />
              <span>{t('appUpdate.openRelease')}</span>
            </button>
          </div>
        </article>

        <article className="version-list-item core-module-card">
          <div className="version-item-content">
            <div className="version-card-top">
              <h2>{t('kernel.versions.coreCardTitle')}</h2>
              {coreVersionStatusLabel ? (
                <span className={`version-row-status ${coreVersionStatusTone}`} title={coreVersionStatusLabel}>
                  {coreVersionStatusLabel}
                </span>
              ) : null}
            </div>

            <dl className="version-metrics-comparison">
              <div className="version-metric-tile">
                <dt className="version-metric-label">{t('kernel.versions.current')}</dt>
                <dd className="version-metric-value" title={currentVersion || t('kernel.status.notInstalled')}>
                  {currentVersion || t('kernel.status.notInstalled')}
                </dd>
              </div>
              <div className={`version-metric-tile ${coreHasUpdate ? 'has-update' : ''}`}>
                <dt className="version-metric-label">{t('kernel.versions.latest')}</dt>
                <dd className="version-metric-value" title={latestVersion || latestError || t('kernel.update.notChecked')}>
                  {checkingLatest ? t('kernel.update.checking') : (latestVersion || (latestError ? t('common.detectionFailed') : t('kernel.update.notChecked')))}
                </dd>
              </div>
            </dl>

            {latestError ? (
              <div className="version-alert-banner error" role="alert">
                <AlertCircle size={14} />
                <span>{latestError}</span>
              </div>
            ) : null}
          </div>

          <div className="version-card-actions core-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void checkLatest(true)}
            >
              <RefreshCw size={15} className={checkingLatest ? 'spin' : ''} aria-hidden="true" />
              <span>{checkingLatest ? t('kernel.update.checking') : t('kernel.versions.check')}</span>
            </button>

            <button
              type="button"
              className={latestVersion && (!coreInstalled || currentVersion !== latestVersion) ? 'primary-button' : 'secondary-button'}
              title={latestVersion ? t('kernel.versions.stopAndUpdateVersion', { version: latestVersion }) : t('kernel.versions.installLatest')}
              disabled={!latestVersion || busy}
              onClick={() => setConfirmUpdateOpen(true)}
            >
              <Download size={15} aria-hidden="true" />
              <span>{!coreInstalled ? t('kernel.versions.installLatestMissing') : t('kernel.versions.installLatest')}</span>
            </button>

            <button
              type="button"
              className="secondary-button"
              title={t('kernel.versions.reinstallTitle')}
              disabled={!currentVersion || installDisabled}
              onClick={() => void installVersion(currentVersion)}
            >
              <RotateCcw size={15} aria-hidden="true" />
              <span>{t('kernel.versions.reinstall')}</span>
            </button>
          </div>
        </article>

        </div>
      </section>

      {customMirrorDialogOpen ? (
        <div className="install-dialog-backdrop custom-mirror-dialog-backdrop">
          <form
            className="install-dialog app-update-dialog custom-mirror-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-mirror-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              void addCustomMirror();
            }}
          >
            <div className="install-dialog-heading">
              <span>{t('kernel.versions.downloadSource')}</span>
              <h2 id="custom-mirror-dialog-title">{t('kernel.versions.customMirrorDialogTitle')}</h2>
            </div>
            <p className="custom-mirror-dialog-description">
              {t('kernel.versions.customMirrorDialogDescription')}
            </p>
            <input
              ref={customMirrorInputRef}
              type="url"
              value={customMirrorDraft}
              disabled={versionSourceSaving}
              placeholder={t('kernel.versions.customMirrorPlaceholder')}
              aria-label={t('kernel.versions.customMirrorPlaceholder')}
              onChange={(event) => setCustomMirrorDraft(event.currentTarget.value)}
            />
            {versionSourceError ? (
              <span className="custom-mirror-dialog-error" role="alert">{versionSourceError}</span>
            ) : null}
            {versionSource?.customMirrors.length ? (
              <div className="custom-mirror-dialog-list">
                <span>{t('kernel.versions.customMirrorSaved')}</span>
                {versionSource.customMirrors.map((url) => (
                  <div key={url}>
                    <span title={url}>{url}</span>
                    <button
                      type="button"
                      disabled={versionSourceSaving}
                      title={t('kernel.versions.customMirrorRemove')}
                      aria-label={t('kernel.versions.customMirrorRemove')}
                      onClick={() => void removeCustomMirror(url)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="app-update-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={versionSourceSaving}
                onClick={() => {
                  setCustomMirrorDialogOpen(false);
                  setCustomMirrorDraft('');
                  setVersionSourceError('');
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="secondary-button"
                disabled={!customMirrorDraft.trim() || versionSourceSaving}
              >
                <span>{t('kernel.versions.customMirrorConfirm')}</span>
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* Core Update Confirmation Dialog */}
      {confirmUpdateOpen ? (
        <div className="install-dialog-backdrop app-update-dialog-backdrop">
          <section
            className="install-dialog app-update-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="core-update-confirm-title"
          >
            <div className="install-dialog-heading">
              <span className="install-dialog-eyebrow">{t('kernel.dialog.install')}</span>
              <h2 id="core-update-confirm-title">
                {t('kernel.versions.confirmUpdateTitle')}
              </h2>
            </div>

            <p className="app-update-confirm-copy">
              {t('kernel.versions.stopAndConfirmDescription', { version: latestVersion })}
            </p>

            <div className="app-update-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setConfirmUpdateOpen(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setConfirmUpdateOpen(false);
                  void installVersion(latestVersion);
                }}
              >
                <Download size={15} aria-hidden="true" />
                <span>{t('kernel.versions.installLatest')}</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {/* Installation Progress Modal Dialog */}
      {installDialogOpen && progress ? (
        <div className="install-dialog-backdrop">
          <div
            ref={installDialogRef}
            className={`install-dialog ${installDialogTone}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="install-dialog-title"
            aria-describedby="install-dialog-message"
            aria-busy={installing || progress?.running}
            tabIndex={-1}
          >
            <div className="install-dialog-heading">
              <span className="install-dialog-eyebrow">{t('kernel.dialog.install')}</span>
              <h2 id="install-dialog-title">{installDialogTitle}</h2>
            </div>

            <div className="install-dialog-phase">
              <span>{t('kernel.dialog.phase')}</span>
              <strong className="phase-badge">
                {cancellingInstall ? t('kernel.install.cancellingShort') : localizeInstallPhase(progress.phase, t)}
              </strong>
            </div>

            <div
              className={`install-progress-track ${
                progressKnown ? '' : (installing || progress?.running) ? 'unknown is-running' : 'unknown'
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
              {installDialogMessage || ' '}
            </div>

            <div className="install-dialog-actions">
              <button
                type="button"
                className={(installing || progress?.running) ? 'danger-button' : 'primary-button'}
                disabled={installDialogActionDisabled}
                onClick={(installing || progress?.running) ? cancelInstall : closeInstallDialog}
              >
                {installDialogAction}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Floating Notice Toast */}
      {toastNotice ? (
        <div
          className={`config-toast ${toastNotice.tone}`}
          role="status"
          title={toastNotice.message}
        >
          {toastNotice.tone === 'success' ? (
            <Check size={18} aria-hidden="true" />
          ) : toastNotice.tone === 'error' ? (
            <AlertCircle size={18} aria-hidden="true" />
          ) : (
            <Info size={18} aria-hidden="true" />
          )}
          <span>{toastNotice.message}</span>
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
