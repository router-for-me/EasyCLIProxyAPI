import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AlertCircle, Download, RefreshCw } from 'lucide-react';
import { useI18n } from './i18n';

export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  autoUpdateSupported: boolean;
  downloadSizeBytes: number | null;
  unsupportedReason: string | null;
};

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'staging'
  | 'waitingForExit'
  | 'restarting'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type AppUpdateTask = {
  running: boolean;
  cancellable: boolean;
  phase: AppUpdatePhase;
  targetVersion: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  message: string | null;
};

type AppUpdateContextValue = {
  info: AppUpdateInfo | null;
  task: AppUpdateTask;
  error: string;
  checking: boolean;
  confirmOpen: boolean;
  hasUpdate: boolean;
  processing: boolean;
  check: () => Promise<void>;
  requestInstall: () => void;
  dismissConfirm: () => void;
  install: () => Promise<void>;
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
  const startupCheckStarted = useRef(false);

  const check = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      const result = await invoke<AppUpdateInfo>('check_app_update');
      setInfo(result);
      setTask((current) => (
        current.running
          ? current
          : {
              ...current,
              phase: result.updateAvailable ? 'available' : 'idle',
              targetVersion: result.updateAvailable ? result.latestVersion : null,
              message: null,
            }
      ));
    } catch (nextError) {
      setInfo(null);
      setError(String(nextError));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;

    void invoke<AppUpdateTask>('get_app_update_task')
      .then((current) => {
        if (!disposed) setTask(current);
      })
      .catch(() => undefined);

    void listen<AppUpdateTask>('app-update-progress', (event) => {
      if (disposed) return;
      setTask(event.payload);
      if (event.payload.phase === 'failed') {
        setError(event.payload.message || 'Application update failed');
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

  const install = useCallback(async () => {
    setConfirmOpen(false);
    setError('');
    try {
      await invoke('start_app_update');
    } catch (nextError) {
      setError(String(nextError));
    }
  }, []);

  const cancel = useCallback(async () => {
    try {
      await invoke('cancel_app_update');
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
    check,
    requestInstall: () => setConfirmOpen(true),
    dismissConfirm: () => setConfirmOpen(false),
    install,
    cancel,
  }), [cancel, check, checking, confirmOpen, error, info, install, task]);

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

  if (!confirmOpen && !task.running) return null;

  const percent = task.percent ?? (
    task.totalBytes && task.totalBytes > 0
      ? (task.downloadedBytes / task.totalBytes) * 100
      : null
  );
  const phaseLabel = t(`appUpdate.phase.${task.phase}` as Parameters<typeof t>[0]);

  return (
    <div className="install-dialog-backdrop app-update-dialog-backdrop">
      <section
        className="install-dialog app-update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-dialog-title"
      >
        <div className="install-dialog-heading">
          <span>{t('appUpdate.eyebrow')}</span>
          <h2 id="app-update-dialog-title">
            {confirmOpen ? t('appUpdate.confirmTitle') : t('appUpdate.progressTitle')}
          </h2>
        </div>

        {confirmOpen ? (
          <>
            <p className="app-update-confirm-copy">
              {t('appUpdate.confirmDescription', { version: info?.latestVersion ?? '' })}
            </p>
            <div className="app-update-dialog-actions">
              <button type="button" className="secondary-button" onClick={dismissConfirm}>
                {t('common.cancel')}
              </button>
              <button type="button" className="primary-button" onClick={() => void install()}>
                <Download size={15} aria-hidden="true" />
                {t('appUpdate.installNow')}
              </button>
            </div>
          </>
        ) : (
          <>
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
              <span>{task.message || phaseLabel}</span>
            </div>
            {error ? (
              <div className="install-dialog-message error" role="alert">
                <AlertCircle size={15} aria-hidden="true" /> {error}
              </div>
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
      </section>
    </div>
  );
}
