import { onCoreInstallProgress, onConfigFilesChanged } from '../services/events';
import { openExternalUrl } from '../services/appSettings';
import {
  getVersionSourceSettings,
  listCoreVersions,
  getCoreInstallTask,
  setDownloadSource,
  addCustomDownloadMirror,
  removeCustomDownloadMirror,
  installBundledCore,
  installCoreVersion,
  cancelCoreInstall,
  detectBundledCore,
} from '../services/coreVersions';
import type {
  VersionSourceSettings,
  VersionDownloadSource,
  CoreInstallTask,
  CoreInstallResult,
  BundledCoreInfo,
  CoreVersionOption,
} from '../services/coreVersions';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getVersion } from '../services/platform';
import { getUpdateChannel, listUpdateChannels, setUpdateChannel, type AppUpdateInfo } from '../services/appUpdates';
import {
  Download,
  Info,
  RefreshCw,
  Package,
  Trash2,
  X,
} from 'lucide-react';
import { useCoreRuntime } from '../coreRuntime';
import { useCoreUpdate } from '../coreUpdate';
import { useI18n } from '../i18n';
import { useAppUpdate } from '../appUpdate';
import { MessageNotice, FloatingNotice, useAppNotice } from '../appNotice';
import { createVersionManagementVisitTracker } from '../services/versionManagementVisits';
import { AppReleaseNotes } from '../components/AppReleaseNotes';
import { Dialog } from '../components/Dialog';
import { SelectMenu, type SelectMenuOption } from '../components/SelectMenu';

export type { CoreInstallResult } from '../services/coreVersions';

export type { CoreInstallTask } from '../services/coreVersions';

export type { VersionSourceSettings } from '../services/coreVersions';

export type { VersionDownloadSource } from '../services/coreVersions';

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
export const APP_RELEASE_URL = 'https://github.com/router-for-me/EasyCLIProxyAPI/releases/latest';
export const APP_PREVIEW_RELEASES_URL = 'https://github.com/router-for-me/EasyCLIProxyAPI/releases?q=preview-&expanded=true';
export const APP_RELEASE_TAG_BASE_URL = 'https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag';

export function getAppReleaseUrl(channel = 'stable'): string {
  const normalized = channel.trim();
  if (normalized === 'preview') {
    return APP_PREVIEW_RELEASES_URL;
  }
  if (normalized.startsWith('preview-')) {
    return `${APP_RELEASE_TAG_BASE_URL}/${normalized}`;
  }
  return APP_RELEASE_URL;
}

export function resolveAppDownloadUrl(
  info: Pick<AppUpdateInfo, 'downloadUrl' | 'releaseUrl' | 'updateChannel'> | null | undefined,
  channel = 'stable',
): string {
  return info?.downloadUrl?.trim()
    || info?.releaseUrl?.trim()
    || getAppReleaseUrl(channel || info?.updateChannel || 'stable');
}
export const DEFAULT_VERSION_DOWNLOAD_SOURCE = 'github';
const recordVersionManagementVisit = createVersionManagementVisitTracker();

export function displayAppVersion(version: string) {
  const resolvedVersion = version.trim();
  return resolvedVersion.startsWith('v') ? resolvedVersion : `v${resolvedVersion}`;
}

export function VersionManagementPage() {
  const { t, formatDate } = useI18n();
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
  const [bundledCore, setBundledCore] = useState<BundledCoreInfo | null>(null);
  const [bundledCoreError, setBundledCoreError] = useState('');
  const [coreVersions, setCoreVersions] = useState<CoreVersionOption[]>([]);
  const [coreVersionsLoading, setCoreVersionsLoading] = useState(false);
  const [coreVersionsError, setCoreVersionsError] = useState('');
  const [selectedCoreVersion, setSelectedCoreVersion] = useState('');

  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<CoreInstallTask | null>(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [confirmUpdateOpen, setConfirmUpdateOpen] = useState(false);
  const [confirmInstallVersion, setConfirmInstallVersion] = useState('');
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
      const settings = await getVersionSourceSettings();
      setVersionSource(settings);
      setVersionSourceError('');
    } catch (error) {
      setVersionSourceError(String(error));
    }
  };

  const loadInstallTask = async () => {
    try {
      const task = await getCoreInstallTask();
      applyInstallTask(task, false, false);
    } catch {}
  };

  const loadCoreVersions = async () => {
    setCoreVersionsLoading(true);
    try {
      const versions = await listCoreVersions();
      setCoreVersions(versions);
      setCoreVersionsError('');
      setSelectedCoreVersion((current) => current || versions[0]?.version || '');
    } catch (error) {
      setCoreVersionsError(String(error));
    } finally {
      setCoreVersionsLoading(false);
    }
  };

  const updateVersionSource = async (source: VersionDownloadSource) => {
    setVersionSourceSaving(true);
    setVersionSourceError('');
    try {
      const settings = await setDownloadSource({ source });
      setVersionSource(settings);
      resetLatest();
      void loadCoreVersions();
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
      const settings = await addCustomDownloadMirror({ url });
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
      const settings = await removeCustomDownloadMirror({
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

  const installCore = async (target: { kind: 'bundled' } | { kind: 'release'; version: string }) => {
    completedInstallKeyRef.current = '';
    manualInstallInProgressRef.current = true;
    setInstalling(true);
    setCancellingInstall(false);
    setInstallDialogOpen(true);
    setProgress({
      running: true,
      cancellable: target.kind === 'release',
      phase: target.kind === 'bundled' ? 'Preparing bundled kernel' : 'Preparing download',
      downloaded: 0,
      total: null,
      percent: null,
      message: null,
      result: null,
    });

    try {
      const result = target.kind === 'bundled'
        ? await installBundledCore()
        : await installCoreVersion({ version: target.version });
      const message = t(target.kind === 'bundled' ? 'kernel.install.bundledCompleted' : 'kernel.install.completed', { version: result.version });
      showInstallCompletedNotice(result, message);
      manualInstallInProgressRef.current = false;
      setProgress({
        running: false,
        cancellable: false,
        phase: 'Installation complete',
        downloaded: 1,
        total: 1,
        percent: 100,
        message,
        result,
      });
      setInstallDialogOpen(false);
      setProgress(null);
      setCancellingInstall(false);
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
      await refreshStatus();
    }
  };

  const cancelInstall = async () => {
    if (cancellingInstall || !progress?.running || !progress.cancellable) {
      return;
    }

    setCancellingInstall(true);
    try {
      await cancelCoreInstall();
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

  const openAppRelease = async (url?: string) => {
    const targetUrl = url || appUpdate?.releaseUrl || getAppReleaseUrl(activeChannel);
    try {
      await openExternalUrl({ url: targetUrl });
    } catch (error) {
      showNotice({ key: 'kernel.error.openUpdate', variables: { error: String(error) } }, 'error');
    }
  };

  useEffect(() => {
    if (!recordVersionManagementVisit(pageVisitRef.current)) return;
    if (!checkingAppUpdate && !appUpdateTask.running) {
      void checkAppUpdate();
    }
    if (!checkingLatest) {
      void checkLatest();
    }
  }, [appUpdateTask.running, checkAppUpdate, checkLatest, checkingAppUpdate, checkingLatest]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let unlistenConfig: (() => void) | null = null;

    onCoreInstallProgress((event) => {
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

    void onConfigFilesChanged(() => {
      if (disposed) return;
      void loadVersionSourceSettings();
      void refreshStatus();
    }).then((stop) => {
      if (disposed) stop();
      else unlistenConfig = stop;
    });

    loadInstallTask();
    void loadCoreVersions();
    void loadVersionSourceSettings();
    void detectBundledCore()
      .then((info) => {
        if (!disposed) setBundledCore(info);
      })
      .catch((error) => {
        if (!disposed) setBundledCoreError(String(error));
      });

    void getVersion()
      .then((version) => {
        if (!disposed) setInstalledAppVersion(version);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
      unlistenConfig?.();
    };
  }, []);

  const latestVersion = latest?.version ?? '';
  const currentVersion = coreStatus?.currentVersion ?? '';
  const coreInstalled = Boolean(coreStatus?.installed);
  const coreProcessBusy = Boolean(coreStatus?.starting);
  const busy = checkingLatest || installing || coreProcessBusy;
  const installDisabled = installing || coreProcessBusy;

  const resolvedAppVersion = appUpdate?.currentVersion || installedAppVersion;
  const currentAppVersion = resolvedAppVersion ? displayAppVersion(resolvedAppVersion) : t('common.detecting');
  const latestAppVersion = appUpdate?.latestVersion ? displayAppVersion(appUpdate.latestVersion) : '';
  const latestAppPublishedAt = appUpdate?.publishedAt && Number.isFinite(Date.parse(appUpdate.publishedAt))
    ? formatDate(appUpdate.publishedAt, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : null;
  const [updateChannel, setUpdateChannelState] = useState('');
  const [channelDraft, setChannelDraft] = useState('');
  const [availableChannels, setAvailableChannels] = useState<string[]>(['stable', 'preview']);
  const [channelListLoading, setChannelListLoading] = useState(true);
  const [channelError, setChannelError] = useState('');
  const activeChannel = appUpdate?.updateChannel || updateChannel || '';
  const currentAppBuiltAt = appUpdate?.currentBuildAt && Number.isFinite(Date.parse(appUpdate.currentBuildAt))
    ? formatDate(appUpdate.currentBuildAt, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : null;
  const appIsPreview = /preview/i.test(resolvedAppVersion || '') || /preview/i.test(appUpdate?.latestVersion || '');

  useEffect(() => {
    let cancelled = false;
    setChannelListLoading(true);
    void getUpdateChannel()
      .then((channel) => {
        if (!cancelled && channel) {
          setUpdateChannelState(channel);
        }
      })
      .catch(() => {});
    void listUpdateChannels()
      .then((channels) => {
        if (!cancelled && Array.isArray(channels) && channels.length > 0) {
          setAvailableChannels(channels);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChannelListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeChannel) setChannelDraft(activeChannel);
  }, [activeChannel]);

  const channelOptions: SelectMenuOption[] = useMemo(
    () => [
      { value: 'stable', label: t('appUpdate.channel.stable') },
      { value: 'preview', label: t('appUpdate.channel.preview') },
      ...availableChannels
        .filter((channel) => channel !== 'stable' && channel !== 'preview')
        .map((channel) => ({ value: channel, label: channel })),
    ],
    [availableChannels, t],
  );

  const appHasUpdate = Boolean(appUpdate?.updateAvailable);
  const showInstallNow = Boolean(appHasUpdate && appUpdate?.autoUpdateSupported);
  const appActionCount = showInstallNow ? 3 : 2;
  const appDownloadLabel = t(activeChannel.startsWith('preview') ? 'appUpdate.downloadPreview' : 'appUpdate.downloadStable');
  const appDownloadTitle = latestAppVersion
    ? [
        t('appUpdate.downloadTitle', { version: latestAppVersion }),
        appUpdate?.downloadFileName,
      ].filter(Boolean).join(' · ')
    : appDownloadLabel;
  const appUnsupportedReason = localizeAppUpdateUnsupportedReason(appUpdate?.unsupportedReason, t);
  const appVersionStatusLabel: string | null = appUpdateTask.running
    ? t(`appUpdate.phase.${appUpdateTask.phase}` as Parameters<typeof t>[0])
    : appUpdateError
      ? t('kernel.update.failed')
      : appHasUpdate
        ? t('appUpdate.available', { version: latestAppVersion })
        : checkingAppUpdate || !appUpdate
          ? t('appUpdate.phase.checking')
          : null;
  const resolvedAppVersionStatusLabel = appIsPreview && appHasUpdate && latestAppPublishedAt
    ? t('appUpdate.buildTime')
    : appVersionStatusLabel;
  const appVersionStatusTone = appUpdateError
    ? 'error'
    : appUpdateTask.running || checkingAppUpdate || !appUpdate
      ? 'info'
      : 'update';

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
  const closeCustomMirrorDialog = () => {
    setCustomMirrorDialogOpen(false);
    setCustomMirrorDraft('');
    setVersionSourceError('');
  };

  const applyChannel = async (next: string) => {
    const value = next.trim();
    if (!value) return;
    setChannelError('');
    try {
      const applied = await setUpdateChannel(value);
      setUpdateChannelState(applied);
      await (checkAppUpdate)();
    } catch (error) {
      setChannelError(String(error));
    }
  };

  const downloadSourceOptions: SelectMenuOption[] = [
    { value: 'github', label: t('kernel.versions.source.github') },
    ...(versionSource?.gitcodeAvailable !== false
      ? [{ value: 'gitcode', label: t('kernel.versions.source.gitcode') }]
      : [{ value: 'gitcode', label: t('kernel.versions.source.gitcode'), disabled: true }]),
    { value: 'gh-proxy', label: t('kernel.versions.source.ghProxy') },
    { value: 'gh-fast', label: t('kernel.versions.source.ghFast') },
    ...(versionSource?.customMirrors.map((url) => ({
      value: `custom:${url}`,
      label: downloadSourceLabel(`custom:${url}`, t),
    })) ?? []),
  ];

  const coreVersionOptions: SelectMenuOption[] = coreVersions.length === 0
    ? [
        {
          value: '',
          label: coreVersionsLoading
            ? t('kernel.versions.loadingVersions')
            : t('kernel.versions.noVersions'),
          disabled: true,
        },
      ]
    : coreVersions.map((version) => ({
        value: version.version,
        label: `${version.version}${version.prerelease ? ` · ${t('kernel.versions.prerelease')}` : ''}`,
      }));

  return (
    <section className="page management-page version-management-page">
      <MessageNotice message={versionSourceError} onDismiss={() => setVersionSourceError('')} />
      <section className="surface-bare version-list">
        <div className="version-source-row surface-panel" aria-label={t('kernel.versions.downloadSource')}>
          <div className="version-source-copy">
            <strong>{t('kernel.versions.downloadSource')}</strong>
            <span>{t('kernel.versions.downloadSourceHint')}</span>
            {versionSource?.gitcodeAvailable === false ? (
              <span>{t('kernel.versions.gitcodeUnavailable')}</span>
            ) : null}
          </div>
          <div className="version-source-control">
            <SelectMenu
              className="version-source-select"
              value={versionSource?.source ?? DEFAULT_VERSION_DOWNLOAD_SOURCE}
              disabled={
                !versionSource
                || versionSourceSaving
                || appUpdateTask.running
                || installing
              }
              ariaLabel={t('kernel.versions.downloadSource')}
              onChange={(value) => void updateVersionSource(value as VersionDownloadSource)}
              options={downloadSourceOptions}
            />
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

        <FloatingNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
        <div className="version-card-grid">
        <article className="version-list-item app-module-card surface-panel">
          <div className="version-item-content">
            <div className="version-card-top">
              <h2>{t('kernel.versions.appCardTitle')}</h2>
              {resolvedAppVersionStatusLabel ? (
                <span className={`version-row-status ${appVersionStatusTone}`} title={appUpdateError || resolvedAppVersionStatusLabel}>
                  {resolvedAppVersionStatusLabel}
                </span>
              ) : null}
            </div>

            {appIsPreview ? (
              <dl className="version-metrics-comparison">
                <div className="surface-section surface-muted version-metric-tile">
                  <dt className="version-metric-label">{t('appUpdate.currentBuild')}</dt>
                  <dd className="version-metric-value" title={currentAppBuiltAt || ''}>
                    {currentAppBuiltAt ?? t('common.detecting')}
                  </dd>
                  <span className="version-metric-sub">{currentAppVersion}</span>
                </div>
                <div className={`surface-section surface-muted version-metric-tile ${appHasUpdate ? 'has-update' : ''}`}>
                  <dt className="version-metric-label">{t('appUpdate.buildTime')}</dt>
                  <dd className="version-metric-value" title={latestAppPublishedAt || ''}>
                    {latestAppPublishedAt ??
                      (checkingAppUpdate
                        ? t('appUpdate.checking')
                        : appUpdateError
                          ? t('kernel.update.failed')
                          : t('common.detecting'))}
                  </dd>
                  <span className="version-metric-sub">{latestAppVersion || currentAppVersion}</span>
                </div>
              </dl>
            ) : (
              <dl className="version-metrics-comparison">
                <div className="surface-section surface-muted version-metric-tile">
                  <dt className="version-metric-label">{t('appUpdate.current')}</dt>
                  <dd className="version-metric-value">{currentAppVersion}</dd>
                </div>
                <div className={`surface-section surface-muted version-metric-tile ${appHasUpdate ? 'has-update' : ''}`}>
                  <dt className="version-metric-label">{t('appUpdate.latest')}</dt>
                  <dd className="version-metric-value">
                    {appUpdate
                      ? (latestAppVersion || currentAppVersion)
                      : checkingAppUpdate
                        ? t('appUpdate.checking')
                        : appUpdateError
                          ? t('kernel.update.failed')
                          : t('common.detecting')}
                  </dd>
                </div>
              </dl>
            )}

            <div className="app-version-info-section">
              <MessageNotice message={appUpdateError} />
              <div className="version-alert-banner neutral">
                <Info size={14} aria-hidden="true" />
                <span>
                  {appUpdate?.autoUpdateSupported
                    ? t('kernel.versions.autoUpdateSupported')
                    : t('appUpdate.manualFallback')}
                  {appIsPreview && latestAppPublishedAt
                    ? ` · ${t('appUpdate.publishedAt', { date: latestAppPublishedAt })}`
                    : ''}
                </span>
              </div>
              {appUpdate && !appUpdate.autoUpdateSupported && appUnsupportedReason ? (
                <div className="version-alert-banner neutral version-unsupported-reason">
                  <Info size={14} aria-hidden="true" />
                  <span title={appUpdate.unsupportedReason ?? undefined}>{appUnsupportedReason}</span>
                </div>
              ) : null}
              {activeChannel.startsWith('preview') ? (
                <>
                  <div className="version-alert-banner neutral version-channel-row">
                    <Info size={14} aria-hidden="true" />
                    <span>{t('appUpdate.previewChannel', { channel: activeChannel })}</span>
                    <SelectMenu
                      className="version-channel-select"
                      value={channelDraft}
                      disabled={channelListLoading}
                      ariaLabel={t('appUpdate.previewChannelSwitch')}
                      onChange={setChannelDraft}
                      options={channelOptions}
                      maxDropdownHeight={260}
                    />
                    <button
                      type="button"
                      className="link-button muted"
                      disabled={!channelDraft || channelDraft === activeChannel || channelListLoading}
                      onClick={() => void applyChannel(channelDraft)}
                    >
                      {t('appUpdate.previewChannelSwitch')}
                    </button>
                  </div>
                  <div
                    className="version-channel-hint"
                    style={{
                      fontSize: 'var(--font-size-meta)',
                      color: 'var(--color-text-tertiary)',
                      lineHeight: 'var(--line-height-body)',
                      paddingLeft: '4px',
                    }}
                  >
                    {t((channelDraft || activeChannel) === 'stable' ? 'appUpdate.channelHint.stable' : 'appUpdate.channelHint.preview')}
                  </div>
                </>
              ) : null}
              {channelError ? <MessageNotice message={channelError} /> : null}
            </div>
          </div>

          <div className={`version-card-actions app-actions actions-count-${appActionCount}${showInstallNow ? ' has-install-now' : ''}`}>
            <button
              type="button"
              className="secondary-button"
              disabled={checkingAppUpdate || appUpdateTask.running}
              onClick={() => void checkAppUpdate()}
            >
              <RefreshCw size={15} className={checkingAppUpdate ? 'spin' : ''} aria-hidden="true" />
              <span>{checkingAppUpdate ? t('appUpdate.checking') : t('appUpdate.check')}</span>
            </button>

            {showInstallNow ? (
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
              className={appUpdate?.autoUpdateSupported ? 'secondary-button' : 'primary-button'}
              title={appDownloadTitle}
              onClick={() => void openAppRelease(resolveAppDownloadUrl(appUpdate, activeChannel))}
            >
              <Download size={15} aria-hidden="true" />
              <span>{appDownloadLabel}</span>
            </button>
          </div>
        </article>

        <article className="version-list-item core-module-card surface-panel">
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
              <div className="surface-section surface-muted version-metric-tile">
                <dt className="version-metric-label">{t('kernel.versions.current')}</dt>
                <dd className="version-metric-value" title={currentVersion || t('kernel.status.notInstalled')}>
                  {currentVersion || t('kernel.status.notInstalled')}
                </dd>
              </div>
              <div className={`surface-section surface-muted version-metric-tile ${coreHasUpdate ? 'has-update' : ''}`}>
                <dt className="version-metric-label">{t('kernel.versions.latest')}</dt>
                <dd className="version-metric-value" title={latestVersion || latestError || t('kernel.update.notChecked')}>
                  {checkingLatest ? t('kernel.update.checking') : (latestVersion || (latestError ? t('common.detectionFailed') : t('kernel.update.notChecked')))}
                </dd>
              </div>
            </dl>

            <div className="core-version-picker">
              {latestError ? <MessageNotice message={latestError} /> : null}
              <div className="core-version-picker-label">
                <span>{t('kernel.versions.chooseVersion')}</span>
              </div>
              <div className="core-version-picker-row">
                <div className="core-version-select-wrap">
                  <SelectMenu
                    className="core-version-select"
                    value={selectedCoreVersion}
                    disabled={coreVersionsLoading || busy || coreVersions.length === 0}
                    ariaLabel={t('kernel.versions.chooseVersion')}
                    onChange={setSelectedCoreVersion}
                    options={coreVersionOptions}
                    maxDropdownHeight={280}
                  />
                </div>
                <button
                  type="button"
                  className="secondary-button core-version-install-btn"
                  disabled={!selectedCoreVersion || busy}
                  onClick={() => {
                    setConfirmInstallVersion(selectedCoreVersion);
                    setConfirmUpdateOpen(false);
                  }}
                >
                  <Download size={15} aria-hidden="true" />
                  <span>{t('kernel.versions.installSelected')}</span>
                </button>
              </div>
              {coreVersionsError ? <MessageNotice message={coreVersionsError} /> : null}
            </div>
          </div>

          <div className="version-card-actions core-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                void checkLatest(true);
                void loadCoreVersions();
              }}
            >
              <RefreshCw size={15} className={checkingLatest ? 'spin' : ''} aria-hidden="true" />
              <span>{checkingLatest ? t('kernel.update.checking') : t('kernel.versions.check')}</span>
            </button>

            <button
              type="button"
              className={latestVersion && (!coreInstalled || coreHasUpdate) ? 'primary-button' : 'secondary-button'}
              title={latestVersion ? t('kernel.versions.stopAndUpdateVersion', { version: latestVersion }) : t('kernel.versions.installLatest')}
              disabled={!latestVersion || busy}
              onClick={() => {
                setConfirmInstallVersion(latestVersion);
                setConfirmUpdateOpen(true);
              }}
            >
              <Download size={15} aria-hidden="true" />
              <span>{!coreInstalled ? t('kernel.versions.installLatestMissing') : t('kernel.versions.installLatest')}</span>
            </button>

            <button
              type="button"
              className="secondary-button"
              title={bundledCoreError || (bundledCore ? t('kernel.versions.installBundledTitle', { version: bundledCore.version }) : t('kernel.versions.noBundled'))}
              disabled={!bundledCore || installDisabled}
              onClick={() => void installCore({ kind: 'bundled' })}
            >
              <Package size={15} aria-hidden="true" />
              <span>{t('kernel.versions.installBundled')}</span>
            </button>
          </div>
        </article>
        </div>
        <AppReleaseNotes
          key={appUpdate?.latestVersion ?? 'pending'}
          info={appUpdate}
          checking={checkingAppUpdate}
          failed={Boolean(appUpdateError)}
          onOpenUrl={openAppRelease}
        />
      </section>

      {customMirrorDialogOpen ? (
        <Dialog
          as="form"
          className="install-dialog app-update-dialog custom-mirror-dialog"
          backdropClassName="install-dialog-backdrop custom-mirror-dialog-backdrop"
          labelledBy="custom-mirror-dialog-title"
          initialFocusRef={customMirrorInputRef}
          onClose={closeCustomMirrorDialog}
          closeDisabled={versionSourceSaving}
          onSubmit={(event) => {
            event.preventDefault();
            void addCustomMirror();
          }}
        >
          <div className="install-dialog-heading">
            <div>
              <span>{t('kernel.versions.downloadSource')}</span>
              <h2 id="custom-mirror-dialog-title">{t('kernel.versions.customMirrorDialogTitle')}</h2>
            </div>
            <button
              type="button"
              className="icon-button quiet"
              onClick={closeCustomMirrorDialog}
              disabled={versionSourceSaving}
              title={t('common.close')}
              aria-label={t('common.close')}
            >
              <X size={18} aria-hidden="true" />
            </button>
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
                    className="icon-button danger ghost small-button"
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
              onClick={closeCustomMirrorDialog}
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
        </Dialog>
      ) : null}

      {confirmUpdateOpen || confirmInstallVersion ? (
        <Dialog
          className="install-dialog app-update-dialog"
          backdropClassName="install-dialog-backdrop app-update-dialog-backdrop"
          labelledBy="core-update-confirm-title"
          onClose={() => {
            setConfirmUpdateOpen(false);
            setConfirmInstallVersion('');
          }}
        >
          <div className="install-dialog-heading">
            <span className="install-dialog-eyebrow">{t('kernel.dialog.install')}</span>
            <h2 id="core-update-confirm-title">
              {t('kernel.versions.confirmUpdateTitle')}
            </h2>
          </div>

          <p className="app-update-confirm-copy">
            {t('kernel.versions.stopAndConfirmDescription', { version: confirmInstallVersion })}
          </p>

          <div className="app-update-dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setConfirmUpdateOpen(false);
                setConfirmInstallVersion('');
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                const version = confirmInstallVersion;
                setConfirmUpdateOpen(false);
                setConfirmInstallVersion('');
                void installCore({ kind: 'release', version });
              }}
            >
              <Download size={15} aria-hidden="true" />
              <span>{t('kernel.versions.installLatest')}</span>
            </button>
          </div>
        </Dialog>
      ) : null}

      {installDialogOpen && progress ? (
        <Dialog
          as="div"
          className={`install-dialog ${installDialogTone}`}
          backdropClassName="install-dialog-backdrop"
          labelledBy="install-dialog-title"
          describedBy="install-dialog-message"
          busy={installing || progress?.running}
          tabIndex={-1}
          onClose={closeInstallDialog}
          closeDisabled={Boolean(installing || progress?.running)}
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
        </Dialog>
      ) : null}

    </section>
  );
}

function localizeAppUpdateUnsupportedReason(
  reason: string | null | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string | null {
  const trimmed = reason?.trim();
  if (!trimmed) return null;
  if (trimmed === 'This application is not a portable version that supports automatic upgrades. Manually download the first supported version') {
    return t('appUpdate.unsupported.notPortable');
  }
  if (trimmed === 'The update manifest does not include the current platform or architecture') {
    return t('appUpdate.unsupported.platformArch');
  }
  return trimmed;
}

function localizeInstallPhase(
  phase: string,
  t: ReturnType<typeof useI18n>['t'],
) {
  const keys = {
    'Preparing download': 'kernel.phase.preparingDownload',
    Downloading: 'kernel.phase.downloading',
    Extracting: 'kernel.phase.extracting',
    'Preparing bundled kernel': 'kernel.phase.preparingBundled',
    'Verify bundled kernel': 'kernel.phase.preparingBundled',
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
