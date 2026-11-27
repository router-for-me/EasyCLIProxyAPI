import { useCallback, useEffect, useState } from 'react';
import { Activity, Database, RefreshCw } from 'lucide-react';
import { AgentUsageView } from './AgentUsageView';
import { useI18n, getCurrentLocale } from '../i18n';
import { Tabs } from '../components/Tabs';
import { Select } from '../components/Select';
import { useConfirmation } from '../components/ConfirmationDialog';
import { MessageNotice } from '../appNotice';
import {
  clearAgentUsageHistory,
  getAgentUsageStorage,
  syncAgentUsage,
  type AgentUsageStorage,
} from '../services/agentUsage';
import {
  AGENT_USAGE_REFRESH_INTERVALS,
  loadAgentUsageRefreshInterval,
  saveAgentUsageRefreshInterval,
  type AgentUsageRefreshInterval,
} from '../services/agentUsagePreferences';

type AgentUsagePageTab = 'overview' | 'storage';

const AGENT_INTERVAL_LABELS = {
  0: 'usage.agentUsage.refreshFrequency.off',
  300000: 'usage.agentUsage.refreshFrequency.5m',
  900000: 'usage.agentUsage.refreshFrequency.15m',
  1800000: 'usage.agentUsage.refreshFrequency.30m',
  3600000: 'usage.agentUsage.refreshFrequency.1h',
} as const;

const formatStorageBytes = (value: number) => {
  const bytes = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

export function AgentUsagePage() {
  const { t } = useI18n();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [tab, setTab] = useState<AgentUsagePageTab>('overview');
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);

  // Storage management state (moved from UsageDataManagementView for cohesive standalone page)
  const [agentStorage, setAgentStorage] = useState<AgentUsageStorage | null>(null);
  const [agentSyncing, setAgentSyncing] = useState(false);
  const [agentNotice, setAgentNotice] = useState('');
  const [storageError, setStorageError] = useState('');
  const [agentInterval, setAgentInterval] = useState<AgentUsageRefreshInterval>(
    loadAgentUsageRefreshInterval,
  );

  const loadStorage = useCallback(async () => {
    try {
      setAgentStorage(await getAgentUsageStorage());
    } catch {
      /* ignore when unavailable */
    }
  }, []);

  useEffect(() => {
    if (tab === 'storage') {
      void loadStorage();
    }
  }, [tab, loadStorage]);

  const changeInterval = (value: string) => {
    const next = Number(value) as AgentUsageRefreshInterval;
    if (!AGENT_USAGE_REFRESH_INTERVALS.includes(next)) return;
    setAgentInterval(next);
    saveAgentUsageRefreshInterval(next);
  };

  const syncHistory = async () => {
    setAgentSyncing(true);
    setStorageError('');
    setAgentNotice('');
    try {
      await syncAgentUsage();
      setAgentStorage(await getAgentUsageStorage());
      setRefreshKey((k) => k + 1);
    } catch (error) {
      setStorageError(String(error));
    } finally {
      setAgentSyncing(false);
    }
  };

  const clearHistory = async () => {
    const confirmed = await askConfirmation({
      title: t('usage.dataManagement.agentStorageClearConfirmTitle'),
      message: t('usage.dataManagement.agentStorageClearConfirm'),
    });
    if (!confirmed) return;
    setAgentSyncing(true);
    setStorageError('');
    setAgentNotice('');
    try {
      await clearAgentUsageHistory();
      setAgentStorage(await getAgentUsageStorage());
      setAgentNotice(t('usage.dataManagement.agentStorageCleared'));
      setRefreshKey((k) => k + 1);
    } catch (error) {
      setStorageError(String(error));
    } finally {
      setAgentSyncing(false);
    }
  };

  return (
    <section
      className="page management-page usage-records-page agent-usage-standalone-page"
      aria-label={t('app.nav.agentUsage')}
    >
      {confirmationDialog}
      <div className="usage-topbar">
        <div className="usage-page-navigation">
          <h1 className="sr-only">{t('app.nav.agentUsage')}</h1>
          <Tabs
            className="usage-tabs secondary-page-tabs"
            aria-label={t('app.nav.agentUsage')}
            value={tab}
            onChange={setTab}
            items={[
              {
                value: 'overview',
                id: 'agent-usage-tab-overview',
                panelId: 'agent-usage-tab-panel',
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Activity size={14} aria-hidden="true" />
                    {t('app.nav.agentUsage')}
                  </span>
                ),
              },
              {
                value: 'storage',
                id: 'agent-usage-tab-storage',
                panelId: 'agent-usage-tab-panel',
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Database size={14} aria-hidden="true" />
                    {t('usage.dataManagement.agentStorageTitle')}
                  </span>
                ),
              },
            ]}
          />
        </div>

        <div className="usage-topbar-actions">
          <button
            type="button"
            className="icon-button quiet usage-refresh-btn"
            onClick={() =>
              tab === 'overview'
                ? setRefreshKey((current) => current + 1)
                : void loadStorage()
            }
            disabled={loading || agentSyncing}
            title={t('usage.refresh')}
            aria-label={t('usage.refresh')}
          >
            <RefreshCw size={15} className={loading || agentSyncing ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <div
        className="usage-tab-panel"
        id="agent-usage-tab-panel"
        role="tabpanel"
        aria-labelledby={`agent-usage-tab-${tab}`}
      >
        {tab === 'overview' ? (
          <AgentUsageView refreshKey={refreshKey} onLoadingChange={setLoading} />
        ) : (
          <section className="panel surface-card usage-data-management-panel">
            {storageError ? (
              <MessageNotice message={storageError} onDismiss={() => setStorageError('')} />
            ) : null}
            {agentNotice ? (
              <MessageNotice
                tone="success"
                message={agentNotice}
                onDismiss={() => setAgentNotice('')}
              />
            ) : null}
            <div className="surface-card usage-data-management-action agent-usage-storage-action">
              <div>
                <strong>{t('usage.dataManagement.agentStorageTitle')}</strong>
                <span>{t('usage.dataManagement.agentStorageDescription')}</span>
                <small>
                  {[
                    agentStorage
                      ? t('usage.dataManagement.agentStorageCurrent', {
                          size: formatStorageBytes(agentStorage.databaseSizeBytes),
                          daily: agentStorage.dailyRows.toLocaleString(),
                          hourly: agentStorage.hourlyRows.toLocaleString(),
                        })
                      : '',
                    agentStorage?.lastSyncAt
                      ? t('usage.dataManagement.agentStorageLastSync', {
                          time: new Intl.DateTimeFormat(getCurrentLocale(), {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          }).format(new Date(agentStorage.lastSyncAt)),
                        })
                      : t('usage.dataManagement.agentStorageNeverSynced'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </div>
              <div className="usage-storage-limit-editor">
                <label className="agent-usage-interval-setting">
                  <span>{t('usage.dataManagement.agentStorageInterval')}</span>
                  <Select
                    value={agentInterval}
                    onChange={(event) => changeInterval(event.currentTarget.value)}
                  >
                    {AGENT_USAGE_REFRESH_INTERVALS.map((interval) => (
                      <option key={interval} value={interval}>
                        {t(AGENT_INTERVAL_LABELS[interval])}
                      </option>
                    ))}
                  </Select>
                </label>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void syncHistory()}
                  disabled={agentSyncing}
                >
                  {agentSyncing
                    ? t('usage.dataManagement.agentStorageSyncing')
                    : t('usage.dataManagement.agentStorageSync')}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void clearHistory()}
                  disabled={agentSyncing}
                >
                  {t('usage.dataManagement.agentStorageClear')}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
