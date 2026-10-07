import { MessageNotice } from './appNotice';
import {
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { useI18n, type AppLocale } from './i18n';
import { useDialogFocusTrap } from './components/useDialogFocusTrap';

export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  releaseNotes: Partial<Record<AppLocale, string>> | null;
  publishedAt: string;
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
  // Personal builds have no upstream binary update channel. Never compare or
  // replace this executable with the original application's release.
  const value: AppUpdateContextValue = {
    info: null, task: idleTask, error: '', checking: false,
    confirmOpen: false, hasUpdate: false, processing: false,
    check: async () => {}, requestInstall: () => {}, dismissConfirm: () => {},
    install: async () => {}, cancel: async () => {},
  };
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
  const dialogRef = useDialogFocusTrap<HTMLElement>({
    active: confirmOpen || task.running,
    onEscape: confirmOpen ? dismissConfirm : undefined,
    preventEscape: task.running,
  });

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
        ref={dialogRef}
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
      </section>
    </div>
  );
}
