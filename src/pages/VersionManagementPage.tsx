import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  AlertCircle,
  Check,
  Database,
  Download,
  ExternalLink,
  Info,
  RefreshCw,
  RotateCcw,
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

export type CodexModelCatalogUpdateResult = {
  outcome: 'updated' | 'unchanged';
};

export type VersionSourceSettings = {
  preferGitcodeDownloads: boolean;
  gitcodeAvailable: boolean;
};

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
  const [cancellingInstall, setCancellingInstall] = useState(false);

  const [versionSource, setVersionSource] = useState<VersionSourceSettings | null>(null);
  const [versionSourceSaving, setVersionSourceSaving] = useState(false);
  const [versionSourceError, setVersionSourceError] = useState('');

  const [catalogUpdating, setCatalogUpdating] = useState(false);
  const [catalogUpdateError, setCatalogUpdateError] = useState('');
  const [catalogUpdateNotice, setCatalogUpdateNotice] = useState('');

  const [toastNotice, setToastNotice] = useState<{
    message: string;
    tone: MessageType;
  } | null>(null);

  const installDialogRef = useRef<HTMLDivElement>(null);
  const latestCheckEpochRef = useRef(0);
  const toastTimerRef = useRef<number | null>(null);

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
      showToast(task.message || t('kernel.install.completed', { version: task.result.version }), 'success');
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
      applyInstallTask(task, false);
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

  const updateVersionSource = async (enabled: boolean) => {
    setVersionSourceSaving(true);
    setVersionSourceError('');
    try {
      const settings = await invoke<VersionSourceSettings>('set_prefer_gitcode_downloads', { enabled });
      setVersionSource(settings);
      cachedLatest = null;
      cachedLatestError = '';
      setLatest(null);
      showToast(t('kernel.versions.gitcodeSwitchSuccess'), 'success');
      await Promise.allSettled([checkAppUpdate(), checkLatest(true)]);
    } catch (error) {
      await loadVersionSourceSettings();
      setVersionSourceError(t('kernel.versions.gitcodeSaveFailed', { error: String(error) }));
      showToast(t('kernel.versions.gitcodeSaveFailed', { error: String(error) }), 'error');
    } finally {
      setVersionSourceSaving(false);
    }
  };

  const installVersion = async (version: string) => {
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
      showToast(t('kernel.install.completed', { version: result.version }), 'success');
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
      await refreshStatus();
    } catch (error) {
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

  const syncModelCatalog = async () => {
    setCatalogUpdating(true);
    setCatalogUpdateError('');
    setCatalogUpdateNotice('');
    try {
      const result = await invoke<CodexModelCatalogUpdateResult>('update_codex_model_catalog');
      const notice = result.outcome === 'updated'
        ? t('appUpdate.catalog.updated')
        : t('appUpdate.catalog.unchanged');
      setCatalogUpdateNotice(notice);
      showToast(notice, 'success');
    } catch (error) {
      const err = String(error);
      setCatalogUpdateError(err);
      showToast(err, 'error');
    } finally {
      setCatalogUpdating(false);
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

  const isGitcodeActive = Boolean(versionSource?.preferGitcodeDownloads);

  return (
    <section className="page management-page version-management-page">
      <section className="panel version-list">
        <div className="version-source-row" aria-label={t('kernel.versions.gitcodeSource')}>
          <div className="version-source-copy">
            <strong>{t('kernel.versions.gitcodeSource')}</strong>
            <span>
              {versionSource?.gitcodeAvailable === false
                ? t('kernel.versions.gitcodeUnavailable')
                : t('kernel.versions.gitcodeSourceHint')}
            </span>
            {versionSourceError ? (
              <span className="version-source-error" role="alert">{versionSourceError}</span>
            ) : null}
          </div>
          <div className="version-source-control">
            <label className="switch-control" title={t('kernel.versions.gitcodeSource')}>
              <input
                type="checkbox"
                role="switch"
                checked={isGitcodeActive}
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
          </div>
        </div>

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
              onClick={() => void installVersion(latestVersion)}
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

        <article className="version-list-item catalog-module-card">
          <div className="version-item-content">
            <div className="version-card-top">
              <h2>{t('kernel.versions.catalogCardTitle')}</h2>
              {catalogUpdating || catalogUpdateError ? (
                <span className={`version-row-status ${catalogUpdateError ? 'error' : 'info'}`}>
                  {catalogUpdating ? t('appUpdate.catalog.updating') : t('kernel.update.failed')}
                </span>
              ) : null}
            </div>

            <p className="version-catalog-description">
              {t('appUpdate.catalog.description')}
            </p>

            {catalogUpdateError ? (
              <div className="version-alert-banner error" role="alert">
                <AlertCircle size={14} />
                <span>{catalogUpdateError}</span>
              </div>
            ) : catalogUpdateNotice ? (
              <div className="version-alert-banner success">
                <Check size={14} />
                <span>{catalogUpdateNotice}</span>
              </div>
            ) : null}
          </div>

          <div className="version-card-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={catalogUpdating || appUpdateTask.running || busy}
              onClick={() => void syncModelCatalog()}
              title={t('appUpdate.catalog.updateHint')}
            >
              <Database size={15} className={catalogUpdating ? 'spin' : ''} aria-hidden="true" />
              <span>
                {catalogUpdating
                  ? t('appUpdate.catalog.updating')
                  : t('appUpdate.catalog.update')}
              </span>
            </button>
          </div>
        </article>
      </section>

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
