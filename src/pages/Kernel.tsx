import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AlertCircle, Check, Copy, ExternalLink, Info, RefreshCw } from 'lucide-react';
import { type CoreStatus, useCoreRuntime } from '../coreRuntime';
import openaiIcon from '../assets/icons/openai-light.svg';
import claudeIcon from '../assets/icons/claude.svg';
import geminiIcon from '../assets/icons/gemini.svg';
import { clientApiProfiles, DEFAULT_CLIENT_API_KEY } from '../services/clientAccess';
import packageMetadata from '../../package.json';

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

type MessageType = 'info' | 'success' | 'error';
type CoreProcessCommand = 'start_core_process' | 'stop_core_process' | 'restart_core_process';

type GuiSettings = {
  port: number;
  allowLan: boolean;
  runOnStartup: boolean;
};

type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
};

const APP_RELEASE_URL = 'https://github.com/lzt404/Easy_CLIProxyAPI/releases/latest';

let latestAutoCheckStarted = false;
let cachedLatest: CoreLatest | null = null;
let cachedLatestError = '';
let latestCheckPromise: Promise<CoreLatest> | null = null;
let initialAppUpdateCheck: Promise<AppUpdateInfo> | null = null;

function displayAppVersion(version: string) {
  const resolvedVersion = version.trim() || packageMetadata.version;
  return resolvedVersion.startsWith('v') ? resolvedVersion : `v${resolvedVersion}`;
}

function requestInitialAppUpdate() {
  initialAppUpdateCheck ??= invoke<AppUpdateInfo>('check_app_update');
  return initialAppUpdateCheck;
}

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
  const {
    status: coreStatus,
    statusError,
    refreshStatus,
    publishStatus,
  } = useCoreRuntime();
  const [platform, setPlatform] = useState<CorePlatform | null>(null);
  const [currentAppVersion, setCurrentAppVersion] = useState(() => displayAppVersion(packageMetadata.version));
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [appUpdateError, setAppUpdateError] = useState('');
  const [checkingAppUpdate, setCheckingAppUpdate] = useState(true);
  const [platformError, setPlatformError] = useState('');
  const [latest, setLatest] = useState<CoreLatest | null>(cachedLatest);
  const [latestError, setLatestError] = useState(cachedLatestError);
  const [bundledCore, setBundledCore] = useState<BundledCoreInfo | null>(null);
  const [bundledCoreError, setBundledCoreError] = useState('');
  const [checkingLatest, setCheckingLatest] = useState(Boolean(latestCheckPromise));
  const [allowLanAccess, setAllowLanAccess] = useState(false);
  const [customPort, setCustomPort] = useState('8317');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [processBusy, setProcessBusy] = useState(false);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [processNotice, setProcessNotice] = useState<{
    message: string;
    tone: MessageType;
  } | null>(null);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<MessageType>('info');
  const [progress, setProgress] = useState<CoreInstallTask | null>(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [cancellingInstall, setCancellingInstall] = useState(false);
  const [copiedApiField, setCopiedApiField] = useState('');
  const [lanIpv4, setLanIpv4] = useState<string | null>(null);
  const [lanIpChecked, setLanIpChecked] = useState(false);
  const installDialogRef = useRef<HTMLDivElement>(null);
  const savedPortRef = useRef(8317);
  const savedAllowLanRef = useRef(false);
  const settingsSaveRequestRef = useRef(0);
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
      setMessage(task.message || `${task.result.version} 安装完成`);
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

    loadPlatform();
    loadBundledCore();
    loadInstallTask();
    loadGuiSettings();

    if (!latestAutoCheckStarted) {
      latestAutoCheckStarted = true;
      void checkLatest();
    } else if (latestCheckPromise) {
      void checkLatest();
    }

    return () => {
      disposed = true;
      unlisten?.();
      if (processNoticeTimerRef.current !== null) {
        window.clearTimeout(processNoticeTimerRef.current);
      }
      if (copiedApiTimerRef.current !== null) {
        window.clearTimeout(copiedApiTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    void getVersion()
      .then((version) => {
        if (!disposed) setCurrentAppVersion(displayAppVersion(version));
      })
      .catch((error) => console.warn('读取当前软件版本失败', error));

    void requestInitialAppUpdate()
      .then((info) => {
        if (disposed) return;
        setCurrentAppVersion(displayAppVersion(info.currentVersion));
        setAppUpdate(info);
        setAppUpdateError('');
      })
      .catch((error) => {
        if (disposed) return;
        console.warn('自动检查软件更新失败', error);
        setAppUpdateError(String(error));
      })
      .finally(() => {
        if (!disposed) setCheckingAppUpdate(false);
      });

    return () => {
      disposed = true;
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

  useEffect(() => {
    let disposed = false;
    if (!allowLanAccess) {
      setLanIpv4(null);
      setLanIpChecked(false);
      return;
    }

    setLanIpChecked(false);
    invoke<string | null>('get_lan_ipv4')
      .then((address) => {
        if (!disposed) {
          setLanIpv4(address || null);
        }
      })
      .catch(() => {
        if (!disposed) {
          setLanIpv4(null);
        }
      })
      .finally(() => {
        if (!disposed) {
          setLanIpChecked(true);
        }
      });

    return () => {
      disposed = true;
    };
  }, [allowLanAccess]);

  const runCoreProcessCommand = async (
    command: CoreProcessCommand,
    messages?: { success?: string; failure?: string },
  ) => {
    const actionLabel =
      command === 'start_core_process'
        ? '启动'
        : command === 'stop_core_process'
          ? '关闭'
          : '重启';
    setProcessBusy(true);

    try {
      const result = await invoke<CoreStatus>(command);
      publishStatus(result);
      showProcessNotice(messages?.success ?? `内核${actionLabel}成功`, 'success');
      return true;
    } catch (error) {
      const errorMessage = String(error);
      await refreshStatus();
      showProcessNotice(
        `${messages?.failure ?? `内核${actionLabel}失败`}：${errorMessage}`,
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
      setAllowLanAccess(settings.allowLan);
      setCustomPort(String(settings.port));
      savedPortRef.current = settings.port;
      savedAllowLanRef.current = settings.allowLan;
      setSettingsError('');
    } catch (error) {
      setSettingsError(String(error));
    } finally {
      setSettingsLoaded(true);
    }
  };

  const saveNetworkSettings = async (
    allowLan: boolean,
    port: number,
    restartAfterSave = false,
  ) => {
    const requestId = ++settingsSaveRequestRef.current;

    try {
      const settings = await invoke<GuiSettings>('save_gui_settings', {
        settings: { allowLan, port },
      });
      if (requestId !== settingsSaveRequestRef.current) {
        return;
      }
      setAllowLanAccess(settings.allowLan);
      setCustomPort(String(settings.port));
      savedPortRef.current = settings.port;
      savedAllowLanRef.current = settings.allowLan;
      setSettingsError('');

      if (restartAfterSave) {
        if (coreStatus?.running) {
          await runCoreProcessCommand('restart_core_process', {
            success: '网络设置已保存，内核已重启',
            failure: '网络设置已保存，但内核重启失败',
          });
        } else {
          showProcessNotice('网络设置已保存，下次启动内核时生效', 'info');
        }
      }
    } catch (error) {
      if (requestId !== settingsSaveRequestRef.current) {
        return;
      }
      setAllowLanAccess(savedAllowLanRef.current);
      setCustomPort(String(savedPortRef.current));
      setSettingsError(String(error));
      if (restartAfterSave) {
        showProcessNotice(`保存网络设置失败：${String(error)}`, 'error');
      }
    }
  };

  const updateAllowLanAccess = (allowLan: boolean) => {
    const editedPort = Number(customPort);
    const port =
      Number.isInteger(editedPort) && editedPort >= 1 && editedPort <= 65535
        ? editedPort
        : savedPortRef.current;
    setAllowLanAccess(allowLan);
    setNetworkBusy(true);
    void saveNetworkSettings(allowLan, port, true).finally(() => setNetworkBusy(false));
  };

  const commitCustomPort = () => {
    const port = Number(customPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setCustomPort(String(savedPortRef.current));
      setSettingsError('端口必须在 1 到 65535 之间');
      return;
    }

    setNetworkBusy(true);
    void saveNetworkSettings(allowLanAccess, port, port !== savedPortRef.current)
      .finally(() => setNetworkBusy(false));
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
    setMessage(`正在安装内置内核 ${bundledCore.version}`);
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
      setMessage(`${result.version} 内置内核安装完成`);
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
      showProcessNotice('复制接入信息失败', 'error');
    }
  };

  const checkAppUpdate = async () => {
    setCheckingAppUpdate(true);
    setAppUpdateError('');
    try {
      const info = await invoke<AppUpdateInfo>('check_app_update');
      setCurrentAppVersion(displayAppVersion(info.currentVersion));
      setAppUpdate(info);
    } catch (error) {
      setAppUpdateError(String(error));
    } finally {
      setCheckingAppUpdate(false);
    }
  };

  const openAppUpdate = async () => {
    try {
      await invoke('open_external_url', { url: appUpdate?.releaseUrl || APP_RELEASE_URL });
    } catch (error) {
      setAppUpdateError(`打开更新页面失败：${String(error)}`);
    }
  };

  const latestVersion = latest?.version ?? '';
  const currentVersion = coreStatus?.currentVersion ?? '';
  const coreInstalled = Boolean(coreStatus?.installed);
  const coreRunning = Boolean(coreStatus?.running);
  const busy = checkingLatest || installing || processBusy;
  const installDisabled = busy || Boolean(coreStatus?.running);
  const offlineInstallDisabled = installing || processBusy || coreRunning;
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
  const appUpdateLabel = appUpdateError
    ? '检查失败，重试'
    : appUpdate?.updateAvailable
      ? `更新至 ${displayAppVersion(appUpdate.latestVersion)}`
      : '';
  const appUpdateTone = appUpdateError ? 'error' : 'update';
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
  const platformOsLabel = platform?.os || (platformError ? '检测失败' : '检测中');
  const platformArchLabel = platform?.arch || (platformError ? '检测失败' : '检测中');
  const installTaskRunning = Boolean(installing || progress?.running);
  const offlineInstallRequired = Boolean(coreStatus && !coreInstalled && latestError);
  const versionStatusLabel = installTaskRunning
    ? cancellingInstall
      ? '正在取消下载'
      : progress?.phase || '正在安装'
    : offlineInstallRequired
      ? 'Github连接失败，请使用“离线安装”'
      : message || updateStateLabel;
  const versionStatusTone: MessageType = installTaskRunning
    ? 'info'
    : offlineInstallRequired
      ? 'error'
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
  const apiPort = Number(customPort);
  const apiProfiles = clientApiProfiles(
    Number.isInteger(apiPort) && apiPort >= 1 && apiPort <= 65535
      ? apiPort
      : savedPortRef.current,
    allowLanAccess ? lanIpv4 : null,
  );
  const apiProfileIcons = {
    openai: openaiIcon,
    claude: claudeIcon,
    gemini: geminiIcon,
  } as const;

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
          <span>软件版本</span>
          <div className="software-version-line">
            <strong>{currentAppVersion}</strong>
            {appUpdateLabel ? (
              <button
                type="button"
                className={`software-version-action ${appUpdateTone}`}
                title={appUpdateError || '打开 GitHub 最新版本页面'}
                disabled={checkingAppUpdate}
                onClick={() => void (appUpdateError ? checkAppUpdate() : openAppUpdate())}
              >
                {appUpdateError ? <RefreshCw size={11} aria-hidden="true" /> : null}
                <span>{appUpdateLabel}</span>
                {appUpdate?.updateAvailable && !appUpdateError ? <ExternalLink size={11} aria-hidden="true" /> : null}
              </button>
            ) : null}
          </div>
        </div>
        <div className="status-card">
          <span>内核版本</span>
          <strong>{currentVersion || '未安装'}</strong>
        </div>
      </div>

      <div className="kernel-layout">
        <div className="panel control-panel">
          <div className="panel-heading">
            <div>
              <h2>运行控制</h2>
            </div>
            <span className={`state-pill ${statusTone}`} title={statusError || undefined}>
              {processBusy || networkBusy ? '处理中' : statusLabel}
            </span>
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
              <dt>允许局域网</dt>
              <dd className="detail-control-cell">
                <span className="switch-control" title="切换后会自动重启正在运行的内核">
                  <input
                    type="checkbox"
                    aria-label="允许局域网访问"
                    disabled={!settingsLoaded || networkBusy || processBusy}
                    checked={allowLanAccess}
                    onChange={(event) => updateAllowLanAccess(event.currentTarget.checked)}
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
                  className={`compact-text-input ${settingsError ? 'error' : ''}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={5}
                  placeholder="端口号"
                  title={settingsError || '端口范围 1-65535'}
                  aria-invalid={Boolean(settingsError)}
                  disabled={!settingsLoaded || networkBusy || processBusy}
                  value={customPort}
                  onChange={(event) =>
                    setCustomPort(event.currentTarget.value.replace(/\D/g, '').slice(0, 5))
                  }
                  onBlur={commitCustomPort}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur();
                    }
                  }}
                />
              </dd>
            </div>
          </dl>

          <div className="button-row panel-action-row control-action-row">
            <button
              type="button"
              className={coreRunning ? 'danger-button' : 'primary-button'}
              disabled={!coreInstalled || installing || processBusy || networkBusy}
              onClick={() =>
                void runCoreProcessCommand(
                  coreRunning ? 'stop_core_process' : 'start_core_process',
                  { success: coreRunning ? '内核已关闭' : '内核已启动' },
                )
              }
            >
              {processBusy ? '处理中' : coreRunning ? '关闭' : '启动'}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!coreInstalled || !coreRunning || installing || processBusy || networkBusy}
              onClick={() =>
                void runCoreProcessCommand('restart_core_process', { success: '内核已重启' })
              }
            >
              重启
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={processBusy || networkBusy}
              onClick={() => void refreshStatus()}
            >
              刷新状态
            </button>
          </div>

        </div>

        <div className="panel version-panel">
          <div className="panel-heading">
            <div className="version-heading-inline">
              <h2>内核版本管理</h2>
              <span className="version-offline-hint">
                GitHub 无法连接时，可使用离线安装使用内置内核。
              </span>
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
              <dt>内置版本</dt>
              <dd title={bundledCoreError || bundledCore?.assetName}>
                {bundledCore?.version ?? (bundledCoreError ? '检测失败' : '未包含')}
              </dd>
            </div>
            <div className="panel-detail-row">
              <dt>运行平台</dt>
              <dd title={platformError || undefined}>{platformOsLabel} / {platformArchLabel}</dd>
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
              className="secondary-button"
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
            <button
              type="button"
              className="primary-button"
              title={(bundledCore?.assetName ?? bundledCoreError) || '当前发行包未包含内置内核'}
              disabled={!bundledCore || offlineInstallDisabled}
              onClick={() => void installBundledCore()}
            >
              离线安装
            </button>
          </div>

        </div>
      </div>

      <section className="panel client-api-panel">
        <div className="panel-heading client-api-heading">
          <div>
            <h2>API URL</h2>
            <p>默认密钥：{DEFAULT_CLIENT_API_KEY}</p>
          </div>
          <span className={`state-pill ${coreRunning ? 'success' : ''}`}>
            {coreRunning ? '可连接' : '等待内核启动'}
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
                  <span>本机 URL</span>
                  <code title={profile.baseUrl}>{profile.baseUrl}</code>
                  <button
                    type="button"
                    className="icon-button quiet"
                    onClick={() =>
                      void copyApiValue(
                        profile.baseUrl,
                        `${profile.id}:base`,
                        `${profile.name} 本机 URL 已复制`,
                      )
                    }
                    title={`复制 ${profile.name} 本机 URL`}
                    aria-label={`复制 ${profile.name} 本机 URL`}
                  >
                    {copiedApiField === `${profile.id}:base` ? (
                      <Check size={15} aria-hidden="true" />
                    ) : (
                      <Copy size={15} aria-hidden="true" />
                    )}
                  </button>
                </div>
                {allowLanAccess ? (
                  <div className="client-api-value-row">
                    <span>局域网 URL</span>
                    <code title={profile.lanUrl || undefined}>
                      {!lanIpChecked
                        ? '正在检测局域网 IP'
                        : profile.lanUrl || '未检测到局域网 IP'}
                    </code>
                    {profile.lanUrl ? (
                      <button
                        type="button"
                        className="icon-button quiet"
                        onClick={() =>
                          void copyApiValue(
                            profile.lanUrl!,
                            `${profile.id}:lan`,
                            `${profile.name} 局域网 URL 已复制`,
                          )
                        }
                        title={`复制 ${profile.name} 局域网 URL`}
                        aria-label={`复制 ${profile.name} 局域网 URL`}
                      >
                        {copiedApiField === `${profile.id}:lan` ? (
                          <Check size={15} aria-hidden="true" />
                        ) : (
                          <Copy size={15} aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      <span className="client-api-copy-placeholder" aria-hidden="true" />
                    )}
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>

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
