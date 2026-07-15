import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type CorePlatform = {
  os: string;
  arch: string;
  assetOs: string;
  assetArch: string;
  archiveKind: 'tar.gz' | 'zip';
};

type CoreStatus = {
  installed: boolean;
  running: boolean;
  managed: boolean;
  processId: number | null;
  currentVersion: string | null;
  installDir: string;
  binaryPath: string | null;
  message: string;
};

type CoreLatest = {
  version: string;
  assetName: string;
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

type MessageType = 'info' | 'success' | 'error';

let latestAutoCheckStarted = false;
let cachedLatest: CoreLatest | null = null;
let cachedLatestError = '';
let latestCheckPromise: Promise<CoreLatest> | null = null;

function requestLatestCore() {
  if (latestCheckPromise) {
    return latestCheckPromise;
  }

  latestCheckPromise = invoke<CoreLatest>('check_latest_core')
    .then((result) => {
      cachedLatest = result;
      cachedLatestError = '';
      return result;
    })
    .catch((error) => {
      cachedLatest = null;
      cachedLatestError = String(error);
      throw error;
    })
    .finally(() => {
      latestCheckPromise = null;
    });

  return latestCheckPromise;
}

export function KernelPage() {
  const [coreStatus, setCoreStatus] = useState<CoreStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [platform, setPlatform] = useState<CorePlatform | null>(null);
  const [platformError, setPlatformError] = useState('');
  const [latest, setLatest] = useState<CoreLatest | null>(cachedLatest);
  const [latestError, setLatestError] = useState(cachedLatestError);
  const [checkingLatest, setCheckingLatest] = useState(Boolean(latestCheckPromise));
  const [allowLanAccess, setAllowLanAccess] = useState(false);
  const [customPort, setCustomPort] = useState('');
  const [installing, setInstalling] = useState(false);
  const [processBusy, setProcessBusy] = useState(false);
  const [processMessage, setProcessMessage] = useState('');
  const [processMessageType, setProcessMessageType] = useState<MessageType>('info');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<MessageType>('info');
  const [progress, setProgress] = useState<CoreInstallTask | null>(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [cancellingInstall, setCancellingInstall] = useState(false);
  const installDialogRef = useRef<HTMLDivElement>(null);

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
      setMessage(task.message || `${task.result.version} 安装完成`);
      setMessageType('success');
      void loadCoreStatus();
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
          setMessage(`监听下载进度失败: ${String(error)}`);
          setMessageType('error');
        }
      });

    loadCoreStatus();
    loadPlatform();
    loadInstallTask();

    if (!latestAutoCheckStarted) {
      latestAutoCheckStarted = true;
      void checkLatest();
    } else if (latestCheckPromise) {
      void checkLatest();
    }

    return () => {
      disposed = true;
      unlisten?.();
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

  const loadCoreStatus = async () => {
    try {
      const result = await invoke<CoreStatus>('get_core_status');
      setCoreStatus(result);
      setStatusError('');
    } catch (error) {
      setCoreStatus(null);
      setStatusError(String(error));
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

  const checkLatest = async () => {
    setCheckingLatest(true);
    setLatestError('');
    setMessage('');
    setMessageType('info');

    try {
      const result = await requestLatestCore();
      setLatest(result);
    } catch (error) {
      setLatest(null);
      setLatestError(String(error));
    } finally {
      setCheckingLatest(false);
    }
  };

  const loadInstallTask = async () => {
    try {
      const task = await invoke<CoreInstallTask>('get_core_install_task');
      applyInstallTask(task, false);
    } catch (error) {
      setMessage(`读取安装任务失败: ${String(error)}`);
      setMessageType('error');
    }
  };

  const installVersion = async (version: string) => {
    setInstalling(true);
    setMessage(`正在安装 ${version}`);
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
      setMessage(`${result.version} 安装完成`);
      setMessageType('success');
      setProgress({
        running: false,
        cancellable: false,
        phase: '安装完成',
        downloaded: 1,
        total: 1,
        percent: 100,
        message: `${result.version} 安装完成`,
        result,
      });
      await loadCoreStatus();
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

  const cancelInstall = async () => {
    if (cancellingInstall || !progress?.running || !progress.cancellable) {
      return;
    }

    setCancellingInstall(true);
    setMessage('正在取消下载');
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

  const runCoreProcessCommand = async (command: string, doing: string, done: string) => {
    setProcessBusy(true);
    setProcessMessage(doing);
    setProcessMessageType('info');

    try {
      const result = await invoke<CoreStatus>(command);
      setCoreStatus(result);
      setStatusError('');
      setProcessMessage(done);
      setProcessMessageType('success');
    } catch (error) {
      setProcessMessage(String(error));
      setProcessMessageType('error');
      await loadCoreStatus();
    } finally {
      setProcessBusy(false);
    }
  };

  const latestVersion = latest?.version ?? '';
  const currentVersion = coreStatus?.currentVersion ?? '';
  const coreInstalled = Boolean(coreStatus?.installed);
  const coreRunning = Boolean(coreStatus?.running);
  const busy = checkingLatest || installing || processBusy;
  const installDisabled = busy || Boolean(coreStatus?.running);
  const computedPercent =
    progress?.percent ??
    (progress?.total && progress.total > 0 ? (progress.downloaded / progress.total) * 100 : null);
  const progressKnown = computedPercent !== null;
  const progressPercent = clampPercent(computedPercent ?? 0);
  const progressText = progress
    ? progress.phase === '安装完成'
      ? '已完成'
      : progress.phase === '解压中'
        ? '正在解压文件'
        : progress.total
          ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
          : progress.downloaded > 0
            ? formatBytes(progress.downloaded)
            : '等待进度信息'
    : '';
  const statusTone = statusError ? 'error' : coreRunning ? 'success' : 'neutral';
  const statusLabel = coreStatus
    ? coreRunning
      ? '运行中'
      : coreInstalled
        ? '已停止'
        : '未安装'
    : statusError
      ? '检测失败'
      : '检测中';
  const statusMessage = coreStatus?.message || statusError || '正在检测 CPA 内核';
  const latestLabel = checkingLatest
    ? '检查中'
    : latestVersion || (latestError ? '检查失败' : '未检查');
  const updateStateLabel = checkingLatest
    ? '正在检查'
    : latestError
      ? '检查失败'
      : !latestVersion
        ? '尚未检查'
        : currentVersion === latestVersion
          ? '已是最新版本'
          : '可安装新版本';
  const platformLabel = platform ? `${platform.os} / ${platform.arch}` : platformError || '检测中';
  const platformOsLabel = platform?.os || (platformError ? '检测失败' : '检测中');
  const platformArchLabel = platform?.arch || (platformError ? '检测失败' : '检测中');
  const installTaskRunning = Boolean(installing || progress?.running);
  const controlSubtitle = processMessage || statusMessage;
  const controlSubtitleTone: MessageType = processMessage
    ? processMessageType
    : statusError
      ? 'error'
      : 'info';
  const versionStatusLabel = installTaskRunning
    ? cancellingInstall
      ? '正在取消下载'
      : progress?.phase || '正在安装'
    : message || updateStateLabel;
  const versionStatusTone: MessageType = installTaskRunning
    ? 'info'
    : message
      ? messageType
      : latestError
        ? 'error'
        : currentVersion && currentVersion === latestVersion
          ? 'success'
          : 'info';
  const installDialogTone: MessageType = progress?.result
    ? 'success'
    : progress?.phase === '安装失败'
      ? 'error'
      : 'info';
  const installDialogTitle = installTaskRunning
    ? cancellingInstall
      ? '正在取消下载'
      : '正在安装内核'
    : progress?.result
      ? '安装完成'
      : progress?.phase === '已取消'
        ? '下载已取消'
        : '安装失败';
  const installDialogMessage = cancellingInstall
    ? '正在等待下载任务停止'
    : progress?.message || (installTaskRunning ? message || '安装任务正在进行' : '');
  const installDialogAction = installTaskRunning
    ? cancellingInstall
      ? '正在取消'
      : progress?.cancellable
        ? '取消下载'
        : '处理中'
    : '关闭';
  const installDialogActionDisabled =
    installTaskRunning && (cancellingInstall || !progress?.cancellable);

  return (
    <section className="page kernel-page">
      <div className="status-strip">
        <div className="status-card status-card-primary">
          <span className={`status-dot ${statusTone}`} />
          <div>
            <span>内核状态</span>
            <strong>{statusLabel}</strong>
          </div>
        </div>
        <div className="status-card">
          <span>当前版本</span>
          <strong>{currentVersion || '未安装'}</strong>
        </div>
        <div className="status-card">
          <span>最新版本</span>
          <strong>{latestLabel}</strong>
        </div>
        <div className="status-card">
          <span>运行平台</span>
          <strong>{platformLabel}</strong>
        </div>
      </div>

      <div className="kernel-layout">
        <div className="panel control-panel">
          <div className="panel-heading">
            <div>
              <h2>运行控制</h2>
              <p className={controlSubtitleTone} title={controlSubtitle}>
                {controlSubtitle}
              </p>
            </div>
            <span className={`state-pill ${statusTone}`}>{statusLabel}</span>
          </div>

          <dl className="panel-detail-grid">
            <div className="panel-detail-row">
              <dt>安装状态</dt>
              <dd>{coreStatus ? (coreInstalled ? '已安装' : '未安装') : '检测中'}</dd>
            </div>
            <div className="panel-detail-row">
              <dt>运行状态</dt>
              <dd>{coreStatus ? (coreRunning ? '运行中' : '未运行') : '检测中'}</dd>
            </div>
            <div className="panel-detail-row">
              <dt>进程 PID</dt>
              <dd>{coreStatus?.processId || '无'}</dd>
            </div>
            <div className="panel-detail-row">
              <dt>局域网</dt>
              <dd className="detail-control-cell">
                <span className="switch-control" title="允许局域网访问">
                  <input
                    type="checkbox"
                    aria-label="允许局域网访问"
                    checked={allowLanAccess}
                    onChange={(event) => setAllowLanAccess(event.currentTarget.checked)}
                  />
                  <span className="switch-track" />
                </span>
              </dd>
            </div>
            <div className="panel-detail-row">
              <dt>
                <label htmlFor="custom-port">端口</label>
              </dt>
              <dd className="detail-control-cell">
                <input
                  id="custom-port"
                  className="compact-text-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={5}
                  placeholder="端口号"
                  value={customPort}
                  onChange={(event) =>
                    setCustomPort(event.currentTarget.value.replace(/\D/g, '').slice(0, 5))
                  }
                />
              </dd>
            </div>
          </dl>

          <div className="button-row panel-action-row control-action-row">
            <button
              type="button"
              className="primary-button"
              disabled={!coreInstalled || coreRunning || installing || processBusy}
              onClick={() =>
                runCoreProcessCommand('start_core_process', '正在启动 CPA 内核', 'CPA 内核已启动')
              }
            >
              {processBusy ? '处理中' : '启动'}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={!coreInstalled || !coreRunning || installing || processBusy}
              onClick={() =>
                runCoreProcessCommand('stop_core_process', '正在关闭 CPA 内核', 'CPA 内核已关闭')
              }
            >
              关闭
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!coreInstalled || !coreRunning || installing || processBusy}
              onClick={() =>
                runCoreProcessCommand(
                  'restart_core_process',
                  '正在重启 CPA 内核',
                  'CPA 内核已重启',
                )
              }
            >
              重启
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={processBusy}
              onClick={loadCoreStatus}
            >
              刷新状态
            </button>
          </div>

        </div>

        <div className="panel version-panel">
          <div className="panel-heading">
            <div>
              <h2>版本管理</h2>
              <p>检查和安装 CPA 内核版本</p>
            </div>
          </div>

          <dl className="panel-detail-grid">
            <div className="panel-detail-row">
              <dt>当前版本</dt>
              <dd>{currentVersion || '未安装'}</dd>
            </div>
            <div className="panel-detail-row">
              <dt>最新版本</dt>
              <dd>{latestLabel}</dd>
            </div>
            <div className="panel-detail-row">
              <dt>操作系统</dt>
              <dd title={platformError || undefined}>{platformOsLabel}</dd>
            </div>
            <div className="panel-detail-row">
              <dt>系统架构</dt>
              <dd title={platformError || undefined}>{platformArchLabel}</dd>
            </div>
            <div className="panel-detail-row">
              <dt>更新状态</dt>
              <dd className={versionStatusTone} title={versionStatusLabel}>
                {versionStatusLabel}
              </dd>
            </div>
          </dl>

          <div className="button-row panel-action-row version-action-row">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={checkLatest}
            >
              {checkingLatest ? '检查中' : '检查更新'}
            </button>
            <button
              type="button"
              className="primary-button"
              title={latestVersion ? `安装 ${latestVersion}` : '安装最新版'}
              disabled={!latestVersion || installDisabled}
              onClick={() => installVersion(latestVersion)}
            >
              安装最新
            </button>
            <button
              type="button"
              className="secondary-button"
              title="重新安装当前版本"
              disabled={!currentVersion || installDisabled}
              onClick={() => installVersion(currentVersion)}
            >
              重新安装
            </button>
          </div>

        </div>
      </div>

      {installDialogOpen && progress ? (
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
              <span>内核安装</span>
              <h2 id="install-dialog-title">{installDialogTitle}</h2>
            </div>

            <div className="install-dialog-phase">
              <span>当前阶段</span>
              <strong>{cancellingInstall ? '正在取消' : progress.phase}</strong>
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
              <strong>{progressKnown ? `${progressPercent.toFixed(1)}%` : '进度未知'}</strong>
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
    </section>
  );
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
