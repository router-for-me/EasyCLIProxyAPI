import { PERSONAL_APP_NAME } from '../personalEdition';
import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Download,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useCoreRuntime } from '../coreRuntime';
import { useCoreUpdate } from '../coreUpdate';
import { useI18n } from '../i18n';
import { MessageNotice, FloatingNotice, useAppNotice } from '../appNotice';
import { createVersionManagementVisitTracker } from '../services/versionManagementVisits';
import { useDialogFocusTrap } from '../components/useDialogFocusTrap';

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
export const DEFAULT_VERSION_DOWNLOAD_SOURCE = 'github';
const recordVersionManagementVisit = createVersionManagementVisitTracker();

export function displayAppVersion(version: string) {
  const resolvedVersion = version.trim();
  return resolvedVersion.startsWith('v') ? resolvedVersion : `v${resolvedVersion}`;
}

export function VersionManagementPage() {
  const { t } = useI18n();
  const {
    status: coreStatus,
    refreshStatus,
  } = useCoreRuntime();
  const {
    latest,
    error: latestError,
    checking: checkingLatest,
    hasUpdate: coreHasUpdate,
    check: checkLatest,
    reset: resetLatest,
  } = useCoreUpdate();

  const [installedAppVersion, setInstalledAppVersion] = useState('');

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

  const feedback = useAppNotice();
  const { showNotice } = feedback;

  const customMirrorInputRef = useRef<HTMLInputElement>(null);
  const completedInstallKeyRef = useRef('');
  const manualInstallInProgressRef = useRef(false);
  const pageVisitRef = useRef({});

  const showInstallCompletedNotice = (result: CoreInstallResult, message?: string | null) => {
    const key = `${result.version}\u0000${result.assetName}\u0000${result.binaryPath ?? ''}`;
    if (completedInstallKeyRef.current === key) return;
    completedInstallKeyRef.current = key;
    showNotice(message || t('kernel.install.completed', { version: result.version }), 'success');
  };

  const applyInstallTask = (
    task: CoreInstallTask,
    showFinishedDialog = true,
    showCompletionNotice = true,
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

    if (showCompletionNotice && (task.running || showFinishedDialog)) {
      setProgress(task);
      setInstallDialogOpen(true);
    } else {
      setProgress(null);
      setInstallDialogOpen(false);
    }

    if (task.result) {
      if (showCompletionNotice) {
        showInstallCompletedNotice(task.result, task.message);
      }
      setInstallDialogOpen(false);
      setProgress(null);
      setCancellingInstall(false);
      void refreshStatus();
      return;
    }

    if (task.message && !task.running) {
      showNotice(task.message, task.phase === 'Installation failed' ? 'error' : 'info');
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

  const updateVersionSource = async (source: VersionDownloadSource) => {
    setVersionSourceSaving(true);
    setVersionSourceError('');
    try {
      const settings = await invoke<VersionSourceSettings>('set_download_source', { source });
      setVersionSource(settings);
      resetLatest();
      showNotice({ key: 'kernel.versions.sourceSwitched', variables: {
        source: downloadSourceLabel(settings.source, t),
      } }, 'info');
    } catch (error) {
      await loadVersionSourceSettings();
      setVersionSourceError(t('kernel.versions.gitcodeSaveFailed', { error: String(error) }));
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
      resetLatest();
      showNotice({ key: 'kernel.versions.customMirrorAdded' }, 'success');
    } catch (error) {
      const message = t('kernel.versions.customMirrorAddFailed', { error: String(error) });
      setVersionSourceError(message);
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
      showNotice({ key: 'kernel.versions.customMirrorRemoved' }, 'success');
      if (wasSelected) {
        resetLatest();
      }
    } catch (error) {
      const message = t('kernel.versions.customMirrorRemoveFailed', { error: String(error) });
      setVersionSourceError(message);
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
      phase: 'Preparing download',
      downloaded: 0,
      total: null,
      percent: null,
      message: null,
      result: null,
    });

    try {
      const result = await invoke<CoreInstallResult>('install_core_version', { version });
      showInstallCompletedNotice(result, t('kernel.install.completed', { version: result.version }));
      manualInstallInProgressRef.current = false;
      setProgress({
        running: false,
        cancellable: false,
        phase: 'Installation complete',
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
      const cancelled = /cancel/i.test(errorMessage);
      showNotice(errorMessage, cancelled ? 'info' : 'error');
      setProgress((current) => ({
        running: false,
        cancellable: false,
        phase: cancelled ? 'Canceled' : 'Installation failed',
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
      showNotice(String(error), 'error');
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

  useEffect(() => {
    if (!recordVersionManagementVisit(pageVisitRef.current)) return;
    if (!checkingLatest) void checkLatest();
  }, [checkLatest, checkingLatest]);

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
      showNotice({ key: 'kernel.versions.sourceAutoSwitched', variables: {
        source: downloadSourceLabel(event.payload.source, t),
      } }, 'info');
    }).then((stop) => {
      if (disposed) stop();
      else unlistenVersionSource = stop;
    });

    loadInstallTask();
    void loadVersionSourceSettings();

    void getVersion()
      .then((version) => {
        if (!disposed) setInstalledAppVersion(version);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
      unlistenConfig?.();
      unlistenVersionSource?.();
    };
  }, []);

  const latestVersion = latest?.version ?? '';
  const currentVersion = coreStatus?.currentVersion ?? '';
  const coreInstalled = Boolean(coreStatus?.installed);
  const coreProcessBusy = Boolean(coreStatus?.starting);
  const busy = checkingLatest || installing || coreProcessBusy;
  const installDisabled = busy || installing;

  const currentAppVersion = installedAppVersion ? displayAppVersion(installedAppVersion) : t('common.detecting');

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

  const computedPercent = progress?.percent ?? (progress?.total && progress.total > 0 ? (progress.downloaded / progress.total) * 100 : null);
  const progressKnown = computedPercent !== null;
  const progressPercent = clampPercent(computedPercent ?? 0);
  const progressText = progress
    ? progress.phase === 'Installation complete'
      ? t('kernel.progress.completed')
      : progress.phase === 'Extracting'
        ? t('kernel.progress.extracting')
        : progress.total
          ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
          : progress.downloaded > 0
            ? formatBytes(progress.downloaded)
            : t('kernel.progress.waiting')
    : '';

  const installDialogTone: MessageType = progress?.result
    ? 'success'
    : progress?.phase === 'Installation failed'
      ? 'error'
      : 'info';

  const installDialogTitle = progress?.running || installing
    ? cancellingInstall
      ? t('kernel.install.titleCancelling')
      : t('kernel.install.titleInstalling')
    : progress?.result
      ? t('kernel.install.titleCompleted')
      : progress?.phase === 'Canceled'
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
  const customMirrorDialogRef = useDialogFocusTrap<HTMLFormElement>({
    active: customMirrorDialogOpen,
    initialFocusRef: customMirrorInputRef,
    onEscape: versionSourceSaving
      ? undefined
      : () => {
          setCustomMirrorDialogOpen(false);
          setCustomMirrorDraft('');
          setVersionSourceError('');
        },
    preventEscape: versionSourceSaving,
  });
  const confirmUpdateDialogRef = useDialogFocusTrap<HTMLElement>({
    active: confirmUpdateOpen,
    onEscape: () => setConfirmUpdateOpen(false),
  });
  const installDialogRef = useDialogFocusTrap<HTMLDivElement>({
    active: installDialogOpen && Boolean(progress),
    onEscape: installing || progress?.running ? undefined : closeInstallDialog,
    preventEscape: Boolean(installing || progress?.running),
  });

  return (
    <section className="page management-page version-management-page">
      <header className="management-header version-page-header">
        <div><h1>{t('app.nav.versions')}</h1></div>
      </header>
      <MessageNotice message={versionSourceError} onDismiss={() => setVersionSourceError('')} />
      <section className="panel version-list">
        <FloatingNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
        <div className="version-card-grid">
        <article className="version-list-item app-module-card">
          <div className="version-item-content">
            <div className="version-card-top"><h2>{PERSONAL_APP_NAME}</h2><span className="version-row-status neutral">{t('personal.edition')}</span></div>
            <dl className="version-metrics-comparison"><div className="version-metric-tile"><dt className="version-metric-label">{t('appUpdate.current')}</dt><dd className="version-metric-value">{currentAppVersion}</dd></div></dl>
            <p className="personal-context">{t('personal.updateNotice')}</p>
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
              <MessageNotice message={latestError} />
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
              className={latestVersion && (!coreInstalled || coreHasUpdate) ? 'primary-button' : 'secondary-button'}
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
        <details className="personal-disclosure maintenance-downloads"><summary>{t('kernel.versions.downloadSource')}</summary>
        <div className="version-source-row" aria-label={t('kernel.versions.downloadSource')}>
          <div className="version-source-copy">
            <strong>{t('kernel.versions.downloadSource')}</strong>
            <span>{t('kernel.versions.downloadSourceHint')}</span>
            {versionSource?.gitcodeAvailable === false ? (
              <span>{t('kernel.versions.gitcodeUnavailable')}</span>
            ) : null}
          </div>
          <div className="version-source-control">
            <label>
              <span className="sr-only">{t('kernel.versions.downloadSource')}</span>
              <select
                value={versionSource?.source ?? DEFAULT_VERSION_DOWNLOAD_SOURCE}
                disabled={
                  !versionSource
                  || versionSourceSaving
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
              disabled={versionSourceSaving || installing}
              onClick={() => {
                setVersionSourceError('');
                setCustomMirrorDialogOpen(true);
              }}
            >
              <span>{t('kernel.versions.customMirrorAdd')}</span>
            </button>
          </div>
        </div>

        </details>
      </section>

      {customMirrorDialogOpen ? (
        <div className="install-dialog-backdrop custom-mirror-dialog-backdrop">
          <form
            ref={customMirrorDialogRef}
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

      {confirmUpdateOpen ? (
        <div className="install-dialog-backdrop app-update-dialog-backdrop">
          <section
            ref={confirmUpdateDialogRef}
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

    </section>
  );
}

function localizeInstallPhase(
  phase: string,
  t: ReturnType<typeof useI18n>['t'],
) {
  const keys = {
    'Preparing download': 'kernel.phase.preparingDownload',
    Downloading: 'kernel.phase.downloading',
    Extracting: 'kernel.phase.extracting',
    'Extract bundled kernel': 'kernel.phase.preparingBundled',
    'Installation complete': 'kernel.phase.completed',
    'Installation failed': 'kernel.phase.failed',
    Canceled: 'kernel.phase.cancelled',
  } as const;
  const key = keys[phase as keyof typeof keys];
  if (key) return t(key);
  if (phase === 'Preparing to install the latest version') {
    return t('kernel.install.installingLatest');
  }
  const version = phase.match(/^Preparing to install (.+)$/)?.[1];
  return version ? t('kernel.install.installingVersion', { version }) : phase;
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
