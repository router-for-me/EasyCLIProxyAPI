import { onAppUpdateProgress } from './services/events';
import { checkAppUpdate, getAppUpdateTask, getUpdateChannel, setUpdateChannel, startAppUpdate, cancelAppUpdate } from './services/appUpdates';
import type { AppUpdateInfo, AppUpdateTask } from './services/appUpdates';
import { MessageNotice } from './appNotice';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { getCurrentLocale, translate, useI18n } from './i18n';
import { Dialog } from './components/Dialog';
import { Checkbox } from './components/Checkbox';

export type { AppUpdateInfo } from './services/appUpdates';

export type { AppUpdatePhase } from './services/appUpdates';

export type { AppUpdateTask } from './services/appUpdates';

type AppUpdateContextValue = {
  info: AppUpdateInfo | null;
  task: AppUpdateTask;
  error: string;
  checking: boolean;
  confirmOpen: boolean;
  hasUpdate: boolean;
  processing: boolean;
  channel: string;
  changingSelection: boolean;
  check: () => Promise<void>;
  changeChannel: (next: string) => Promise<void>;
  changeSelection: <T>(mutation: () => Promise<T>) => Promise<T>;
  requestInstall: () => void;
  dismissConfirm: () => void;
  install: (preserveCore?: boolean) => Promise<void>;
  cancel: () => Promise<void>;
};

const idleTask: AppUpdateTask = {
  running: false,
  cancellable: false,
  phase: 'idle',
  targetVersion: null,
  downloadedBytes: 0,
  totalBytes: null,
  percent: null,
  message: null,
};

const AppUpdateContext = createContext<AppUpdateContextValue | null>(null);

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [task, setTask] = useState<AppUpdateTask>(idleTask);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [channel, setChannel] = useState('');
  const [changingSelection, setChangingSelection] = useState(false);
  const selectionPending = useRef(false);
  const checkGeneration = useRef(0);
  const startupCheckStarted = useRef(false);

  const check = useCallback(async () => {
    if (selectionPending.current) return;
    const generation = ++checkGeneration.current;
    const isCurrent = () => generation === checkGeneration.current;
    setChecking(true);
    setInfo(null);
    setConfirmOpen(false);
    setError('');
    let resolved = false;
    void getUpdateChannel().then((selected) => {
      if (isCurrent() && !resolved) setChannel(selected);
    }).catch(() => undefined);
    try {
      const result = await checkAppUpdate();
      if (!isCurrent()) return;
      resolved = true;
      setChannel(result.updateChannel);
      setInfo(result);
      setTask((current) => current.running ? current : {
        ...idleTask,
        phase: result.action ? 'available' : 'idle',
        targetVersion: result.action ? result.latestVersion : null,
      });
    } catch (nextError) {
      if (isCurrent()) setError(String(nextError));
    } finally {
      if (isCurrent()) setChecking(false);
    }
  }, []);

  // Invalidate the old offer *before* saving settings. Even a response that
  // completes during the save must not resurrect the old install or badge.
  const changeSelection = useCallback(async <T,>(mutation: () => Promise<T>) => {
    if (selectionPending.current) throw new Error('Application update selection is already changing');
    selectionPending.current = true;
    ++checkGeneration.current;
    setChangingSelection(true);
    setChecking(false);
    setInfo(null);
    setError('');
    setConfirmOpen(false);
    try {
      return await mutation();
    } finally {
      selectionPending.current = false;
      setChangingSelection(false);
      void check();
    }
  }, [check]);

  const changeChannel = useCallback((next: string) => changeSelection(async () => {
    setChannel(await setUpdateChannel(next));
  }), [changeSelection]);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;

    void getAppUpdateTask()
      .then((current) => {
        if (!disposed) setTask(current);
      })
      .catch(() => undefined);

    void onAppUpdateProgress((event) => {
      if (disposed) return;
      setTask(event.payload);
      if (event.payload.phase === 'failed') {
        setError(event.payload.message || translate(getCurrentLocale(), 'appUpdate.phase.failed'));
      } else if (event.payload.phase !== 'cancelled') {
        setError('');
      }
    }).then((stop) => {
      if (disposed) stop();
      else stopListening = stop;
    });

    if (!startupCheckStarted.current) {
      startupCheckStarted.current = true;
      void check();
    }
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  const install = useCallback(async (preserveCore = false) => {
    if (!info?.action || !info.autoUpdateSupported || selectionPending.current) return;
    setConfirmOpen(false);
    setError('');
    try {
      await startAppUpdate({ ...info, action: info.action }, preserveCore);
    } catch (nextError) {
      setError(String(nextError));
    }
  }, [info]);

  const cancel = useCallback(async () => {
    setError('');
    try {
      await cancelAppUpdate();
    } catch (nextError) {
      setError(String(nextError));
    }
  }, []);

  const value = useMemo<AppUpdateContextValue>(() => ({
    info,
    task,
    error,
    checking,
    confirmOpen,
    hasUpdate: Boolean(info?.updateAvailable),
    processing: task.running,
    channel,
    changingSelection,
    check,
    changeChannel,
    changeSelection,
    requestInstall: () => {
      if (info?.action && info.autoUpdateSupported && !selectionPending.current) setConfirmOpen(true);
    },
    dismissConfirm: () => setConfirmOpen(false),
    install,
    cancel,
  }), [cancel, changeChannel, changeSelection, changingSelection, channel, check, checking, confirmOpen, error, info, install, task]);

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>;
}

export function useAppUpdate() {
  const context = useContext(AppUpdateContext);
  if (!context) throw new Error('useAppUpdate must be used inside AppUpdateProvider');
  return context;
}

export function AppUpdateDialog() {
  const { t } = useI18n();
  const {
    info,
    task,
    error,
    confirmOpen,
    dismissConfirm,
    install,
    cancel,
  } = useAppUpdate();
  const [restartCore, setRestartCore] = useState(true);
  useLayoutEffect(() => {
    if (confirmOpen) setRestartCore(true);
  }, [confirmOpen]);
  const preserveCore = info?.preserveCoreSupported === true && !restartCore;
  const switching = info?.action === 'switchChannel';
  if (!confirmOpen && !task.running) return null;

  const percent = task.percent ?? (
    task.totalBytes && task.totalBytes > 0
      ? (task.downloadedBytes / task.totalBytes) * 100
      : null
  );
  const phaseLabel = t(`appUpdate.phase.${task.phase}` as Parameters<typeof t>[0]);

  return (
    <Dialog
      className="install-dialog app-update-dialog"
      backdropClassName="install-dialog-backdrop app-update-dialog-backdrop"
      labelledBy="app-update-dialog-title"
      onClose={confirmOpen ? dismissConfirm : undefined}
      closeDisabled={task.running}
    >
      <div className="install-dialog-heading">
        <span>{t('appUpdate.eyebrow')}</span>
        <h2 id="app-update-dialog-title">
          {confirmOpen ? t(switching ? 'appUpdate.installSelected' : 'appUpdate.confirmTitle') : t('appUpdate.progressTitle')}
        </h2>
      </div>

      {confirmOpen ? (
        <>
          <p className="app-update-confirm-copy">
            {switching
              ? t('appUpdate.confirmSwitch', {
                current: info?.currentVersion ?? '', version: info?.latestVersion ?? '',
              })
              : t('appUpdate.confirmDescription', { version: info?.latestVersion ?? '' })}
          </p>
          <Checkbox checked={!preserveCore} onChange={event => setRestartCore(event.target.checked)}
            disabled={!info?.preserveCoreSupported} label={t('appUpdate.restartCore')} aria-describedby="app-update-core-hint" />
          <p id="app-update-core-hint" className="app-update-confirm-copy">
            {t(!info?.preserveCoreSupported ? 'appUpdate.restartRequired' : preserveCore ? 'appUpdate.preserveCoreHint' : 'appUpdate.restartCoreHint')}
          </p>
          <div className="app-update-dialog-actions">
            <button type="button" className="secondary-button" onClick={dismissConfirm}>
              {t('common.cancel')}
            </button>
            <button type="button" className="primary-button" onClick={() => void install(preserveCore)}>
              <Download size={15} aria-hidden="true" />
              {t(switching ? 'appUpdate.installSelected' : preserveCore ? 'appUpdate.installOnly' : 'appUpdate.installNow')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="app-update-confirm-copy">{t(task.preserveCore ? 'appUpdate.preserveCoreHint' : 'appUpdate.restartCoreHint')}</p>
          <div className="install-dialog-phase">
            <span>{t('kernel.dialog.phase')}</span>
            <strong>{phaseLabel}</strong>
          </div>
          <div className={`install-progress-track ${percent === null ? 'unknown is-running' : ''}`}>
            <span
              className="install-progress-fill"
              style={percent === null ? undefined : { width: `${Math.max(0, Math.min(100, percent))}%` }}
            />
          </div>
          <div className="install-progress-meta">
            <strong>{percent === null ? t('kernel.dialog.unknownProgress') : `${percent.toFixed(1)}%`}</strong>
            {task.message ? <span>{task.message}</span> : null}
          </div>
          {error ? (
            <MessageNotice message={error} />
          ) : null}
          <button
            type="button"
            className="danger-button"
            disabled={!task.cancellable}
            onClick={() => void cancel()}
          >
            {task.cancellable ? t('appUpdate.cancelDownload') : (
              <><RefreshCw size={15} className="spin" aria-hidden="true" /> {phaseLabel}</>
            )}
          </button>
        </>
      )}
    </Dialog>
  );
}
