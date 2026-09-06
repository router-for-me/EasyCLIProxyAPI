import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
} from 'lucide-react';
import { type CoreStatus, useCoreRuntime } from '../coreRuntime';
import openaiIcon from '../assets/icons/openai-light.svg';
import claudeIcon from '../assets/icons/claude.svg';
import geminiIcon from '../assets/icons/gemini.svg';
import { clientApiProfiles } from '../services/clientAccess';
import { useI18n } from '../i18n';
import { useAppUpdate } from '../appUpdate';
import { InlineNotice, useAppNotice } from '../appNotice';
import { VersionManagementPage, displayAppVersion } from './VersionManagementPage';

type CoreProcessCommand = 'start_core_process' | 'stop_core_process' | 'restart_core_process';

type GuiSettings = {
  host: string;
  port: number;
  runOnStartup: boolean;
};

type CoreConfigSummary = {
  apiKeys: Array<{ apiKey: string }>;
};

type CoreTlsSettings = {
  enabled: boolean;
  cert: string;
  key: string;
};

export type KernelView = 'home' | 'versions';

export function KernelPage({ view = 'home' }: { view?: KernelView }) {
  if (view === 'versions') {
    return <VersionManagementPage />;
  }

  const { t } = useI18n();
  const { info: appUpdate } = useAppUpdate();
  const {
    status: coreStatus,
    statusError,
    refreshStatus,
    publishStatus,
  } = useCoreRuntime();

  const [installedAppVersion, setInstalledAppVersion] = useState('');
  const [listenHost, setListenHost] = useState('127.0.0.1');
  const [customPort, setCustomPort] = useState('8317');
  const [processBusy, setProcessBusy] = useState(false);
  const processFeedback = useAppNotice();
  const { showNotice: showProcessNotice, clearNotice: clearProcessNotice } = processFeedback;
  const copyFeedback = useAppNotice();
  const [copiedApiField, setCopiedApiField] = useState('');
  const [homeApiKey, setHomeApiKey] = useState<string | null | undefined>(undefined);
  const [homeApiKeyError, setHomeApiKeyError] = useState(false);
  const [showHomeApiKey, setShowHomeApiKey] = useState(false);
  const [tlsEnabled, setTlsEnabled] = useState(false);

  const savedPortRef = useRef(8317);
  const copiedApiTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlistenConfig: (() => void) | null = null;

    void listen('config-files-changed', () => {
      if (disposed) return;
      void loadGuiSettings();
      void loadTlsSettings();
      void refreshStatus();
      void loadHomeApiKey();
    }).then((stop) => {
      if (disposed) stop();
      else unlistenConfig = stop;
    });

    loadGuiSettings();
    void loadTlsSettings();
    void getVersion()
      .then((version) => {
        if (!disposed) setInstalledAppVersion(version);
      })
      .catch(() => undefined);
    void loadHomeApiKey();

    return () => {
      disposed = true;
      unlistenConfig?.();
      if (copiedApiTimerRef.current !== null) {
        window.clearTimeout(copiedApiTimerRef.current);
      }
    };
  }, []);

  const runCoreProcessCommand = async (command: CoreProcessCommand) => {
    const actionLabel =
      command === 'start_core_process'
        ? t('kernel.action.start')
        : command === 'stop_core_process'
          ? t('kernel.action.stop')
          : t('kernel.action.restart');
    setProcessBusy(true);
    clearProcessNotice();

    try {
      const result = await invoke<CoreStatus>(command);
      publishStatus(result);
      if (command === 'restart_core_process') {
        showProcessNotice({ key: 'kernel.notice.restarted' }, 'success');
      }
      return true;
    } catch (error) {
      const errorMessage = String(error);
      await refreshStatus();
      showProcessNotice(
        { key: 'kernel.notice.actionFailed', variables: { action: actionLabel, error: errorMessage } },
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

  const copyApiValue = async (value: string, field: string) => {
    copyFeedback.clearNotice();
    try {
      await navigator.clipboard.writeText(value);
      setCopiedApiField(field);
      if (copiedApiTimerRef.current !== null) {
        window.clearTimeout(copiedApiTimerRef.current);
      }
      copiedApiTimerRef.current = window.setTimeout(() => {
        setCopiedApiField('');
        copiedApiTimerRef.current = null;
      }, 1800);
    } catch {
      copyFeedback.showNotice({ key: 'kernel.notice.copyFailed' }, 'error');
    }
  };

  const currentVersion = coreStatus?.currentVersion ?? '';
  const coreInstalled = Boolean(coreStatus?.installed);
  const coreRunning = Boolean(coreStatus?.running);
  const coreProcessBusy = processBusy || Boolean(coreStatus?.starting);

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
    <section className="page kernel-page home-page">
      <div className="kernel-layout home-layout">
        <div className="panel control-panel">
          <div className="panel-heading">
            <div>
              <h2>{t('kernel.control.title')}</h2>
            </div>
            <span className={`state-pill ${statusTone}`} title={statusError || undefined} role="status">
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
              disabled={!coreInstalled || coreProcessBusy}
              onClick={() =>
                void runCoreProcessCommand(
                  coreRunning ? 'stop_core_process' : 'start_core_process',
                )
              }
            >
              {coreProcessBusy ? t('common.processing') : coreRunning ? t('kernel.action.stop') : t('kernel.action.start')}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!coreInstalled || !coreRunning || coreProcessBusy}
              onClick={() =>
                void runCoreProcessCommand('restart_core_process')
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
          <InlineNotice key={processFeedback.revision} notice={processFeedback.notice} onDismiss={processFeedback.clearNotice} />
        </div>
      </div>

      <section className="panel client-api-panel">
        <div className="panel-heading client-api-heading">
          <div>
            <h2>{t('app.nav.api')}</h2>
            <div className="client-api-key-actions">
              {homeApiKeyError ? (
                <span className="client-api-meta error">{t('common.detectionFailed')}</span>
              ) : homeApiKey ? (
                <>
                  <span className="client-api-meta">{t('kernel.access.firstKey')}</span>
                  <code className="client-api-key-code">
                    {showHomeApiKey ? homeApiKey : '••••••••••••••••'}
                  </code>
                  <button
                    type="button"
                    className="icon-button quiet"
                    onClick={() => setShowHomeApiKey((current) => !current)}
                    title={showHomeApiKey ? t('config.keys.hide') : t('config.keys.show')}
                    aria-label={showHomeApiKey ? t('config.keys.hide') : t('config.keys.show')}
                  >
                    {showHomeApiKey ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="icon-button quiet"
                    onClick={() => void copyApiValue(homeApiKey, 'home:apikey')}
                    title={copiedApiField === 'home:apikey' ? t('config.notice.keyCopied') : t('config.keys.copy')}
                    aria-label={copiedApiField === 'home:apikey' ? t('config.notice.keyCopied') : t('config.keys.copy')}
                  >
                    {copiedApiField === 'home:apikey' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  </button>
                </>
              ) : homeApiKey === null ? (
                <span className="client-api-meta quiet">{t('kernel.access.noConfiguredKey')}</span>
              ) : (
                <span className="client-api-meta quiet">{t('common.loading')}</span>
              )}
            </div>
          </div>
          <span className={`state-pill ${coreRunning ? 'success' : 'neutral'}`}>
            {coreRunning ? t('kernel.access.connectable') : t('kernel.access.waiting')}
          </span>
        </div>

        <InlineNotice key={copyFeedback.revision} notice={copyFeedback.notice} onDismiss={copyFeedback.clearNotice} />
        <div className="client-api-grid">
          {apiProfiles.map((profile) => (
            <article key={profile.id} className={`client-api-card ${profile.id}`}>
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
                      )
                    }
                    title={t(copiedApiField === `${profile.id}:base` ? 'kernel.access.apiCopied' : 'kernel.access.copyApi', { name: profile.name })}
                    aria-label={t(copiedApiField === `${profile.id}:base` ? 'kernel.access.apiCopied' : 'kernel.access.copyApi', { name: profile.name })}
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

    </section>
  );
}
