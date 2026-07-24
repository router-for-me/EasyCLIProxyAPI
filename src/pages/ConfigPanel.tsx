import { FormEvent, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertCircle,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  Plug,
  RefreshCw,
  Route,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n';

type CoreConfigSettings = {
  apiKeys: CoreApiKey[];
  pluginsEnabled: boolean;
  routingStrategy: string;
};

type CoreApiKey = {
  apiKey: string;
  remark: string;
};

type ConfigAction = 'add-key' | 'update-key' | 'delete-key' | 'plugins' | 'routing' | null;
type NoticeTone = 'success' | 'error';

const ROUTING_OPTIONS = [
  { value: 'round-robin', labelKey: 'config.routing.roundRobin' },
  { value: 'fill-first', labelKey: 'config.routing.fillFirst' },
] as const;

export function ConfigPanelPage() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<CoreConfigSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyAction, setBusyAction] = useState<ConfigAction>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingApiKey, setEditingApiKey] = useState<string | null>(null);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [newApiKey, setNewApiKey] = useState('');
  const [newApiKeyRemark, setNewApiKeyRemark] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [formError, setFormError] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ message: string; tone: NoticeTone } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void loadSettings();
    return () => {
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const showNotice = (message: string, tone: NoticeTone) => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    setNotice({ message, tone });
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 3200);
  };

  async function loadSettings() {
    setLoading(true);
    setLoadError('');
    try {
      const result = await invoke<CoreConfigSettings>('get_core_config_settings');
      setSettings(result);
    } catch (error) {
      setSettings(null);
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  }

  const runMutation = async (
    action: Exclude<ConfigAction, null>,
    command: string,
    args: Record<string, unknown>,
    successMessage: string,
  ) => {
    setBusyAction(action);
    try {
      const result = await invoke<CoreConfigSettings>(command, args);
      setSettings(result);
      setLoadError('');
      showNotice(successMessage, 'success');
      return true;
    } catch (error) {
      showNotice(String(error), 'error');
      void loadSettings();
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const openAddDialog = () => {
    setEditingApiKey(null);
    setNewApiKey('');
    setNewApiKeyRemark('');
    setShowApiKey(false);
    setFormError('');
    setAddDialogOpen(true);
  };

  const openEditDialog = (entry: CoreApiKey) => {
    setEditingApiKey(entry.apiKey);
    setNewApiKey(entry.apiKey);
    setNewApiKeyRemark(entry.remark);
    setShowApiKey(false);
    setFormError('');
    setAddDialogOpen(true);
  };

  const closeAddDialog = () => {
    if (busyAction === 'add-key' || busyAction === 'update-key') {
      return;
    }
    setAddDialogOpen(false);
    setEditingApiKey(null);
    setFormError('');
  };

  const generateApiKey = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    setNewApiKey(`sk-${value}`);
    setShowApiKey(true);
    setFormError('');
  };

  const submitApiKey = async (event: FormEvent) => {
    event.preventDefault();
    const apiKey = newApiKey.trim();
    if (!apiKey) {
      setFormError(t('config.error.emptyKey'));
      return;
    }
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      setFormError(t('config.error.invalidKey'));
      return;
    }
    if (settings?.apiKeys.some((entry) => entry.apiKey === apiKey && entry.apiKey !== editingApiKey)) {
      setFormError(t('config.error.duplicateKey'));
      return;
    }
    const remark = newApiKeyRemark.trim();
    if (remark.length > 80) {
      setFormError(t('config.error.remarkTooLong'));
      return;
    }

    const editing = editingApiKey !== null;
    const saved = await runMutation(
      editing ? 'update-key' : 'add-key',
      editing ? 'update_core_api_key' : 'add_core_api_key',
      editing ? { originalApiKey: editingApiKey, apiKey, remark } : { apiKey, remark },
      editing ? t('config.notice.keyUpdated') : t('config.notice.keyAdded'),
    );
    if (saved) {
      setAddDialogOpen(false);
      setEditingApiKey(null);
      setNewApiKey('');
      setNewApiKeyRemark('');
    }
  };

  const confirmDelete = async () => {
    if (deleteIndex === null) {
      return;
    }
    const deleted = await runMutation(
      'delete-key',
      'delete_core_api_key',
      { apiKey: selectedDeleteKey },
      t('config.notice.keyDeleted'),
    );
    if (deleted) {
      setDeleteIndex(null);
    }
  };

  const copyApiKey = async (apiKey: string, index: number) => {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopiedIndex(index);
      showNotice(t('config.notice.keyCopied'), 'success');
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedIndex(null);
        copyTimerRef.current = null;
      }, 1800);
    } catch {
      showNotice(t('config.notice.keyCopyFailed'), 'error');
    }
  };

  const togglePlugins = async (enabled: boolean) => {
    await runMutation(
      'plugins',
      'set_core_plugins_enabled',
      { enabled },
      enabled ? t('config.notice.pluginsEnabled') : t('config.notice.pluginsDisabled'),
    );
  };

  const changeRoutingStrategy = async (strategy: string) => {
    if (strategy === settings?.routingStrategy) {
      return;
    }
    await runMutation(
      'routing',
      'set_core_routing_strategy',
      { strategy },
      t('config.notice.routingUpdated'),
    );
  };

  const controlsDisabled = loading || settings === null || busyAction !== null;
  const selectedDeleteKey =
    deleteIndex === null ? '' : settings?.apiKeys[deleteIndex]?.apiKey || '';
  const deletingLastKey = deleteIndex !== null && settings?.apiKeys.length === 1;
  const keyMutationBusy = busyAction === 'add-key' || busyAction === 'update-key';

  return (
    <section className="page config-page">
      <div className="config-workspace-grid">
        <section className="panel config-keys-panel">
          <div className="config-panel-heading">
            <div className="config-heading-title">
              <KeyRound size={18} aria-hidden="true" />
              <h2>{t('config.keys.title')}</h2>
            </div>
            <div className="config-heading-actions">
              <span className="config-count" aria-label={t('config.keys.count')}>
                {settings?.apiKeys.length ?? 0}
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={openAddDialog}
                disabled={controlsDisabled}
                title={t('config.keys.add')}
                aria-label={t('config.keys.add')}
              >
                <Plus size={18} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="config-key-list" aria-busy={loading || undefined}>
            {loading ? (
              Array.from({ length: 5 }, (_, index) => (
                <div className="config-key-row skeleton" key={index} aria-hidden="true">
                  <span />
                  <span />
                </div>
              ))
            ) : loadError ? (
              <div className="config-unavailable">
                <AlertCircle size={24} aria-hidden="true" />
                <strong>{t('config.unavailable')}</strong>
                <span title={loadError}>{loadError}</span>
                <button type="button" className="secondary-button compact-button" onClick={loadSettings}>
                  <RefreshCw size={16} aria-hidden="true" />
                  {t('common.retry')}
                </button>
              </div>
            ) : settings && settings.apiKeys.length > 0 ? (
              settings.apiKeys.map((entry, index) => (
                <div className="config-key-row" key={`${index}-${entry.apiKey}`}>
                  <div className="config-key-identity">
                    <span className="config-key-index">{String(index + 1).padStart(2, '0')}</span>
                    <div className="config-key-details">
                      <div className="config-key-label-line">
                        <strong title={entry.remark || t('config.keys.noRemark')}>
                          {entry.remark || t('config.keys.noRemark')}
                        </strong>
                      </div>
                      <code title={maskApiKey(entry.apiKey)}>{maskApiKey(entry.apiKey)}</code>
                    </div>
                  </div>
                  <div className="config-key-actions">
                    <button
                      type="button"
                      className="icon-button quiet"
                      onClick={() => void copyApiKey(entry.apiKey, index)}
                      disabled={controlsDisabled}
                      title={t('config.keys.copy')}
                      aria-label={t('config.keys.copyNth', { number: index + 1 })}
                    >
                      {copiedIndex === index ? (
                        <Check size={16} aria-hidden="true" />
                      ) : (
                        <Copy size={16} aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="icon-button quiet"
                      onClick={() => openEditDialog(entry)}
                      disabled={controlsDisabled}
                      title={t('config.keys.edit')}
                      aria-label={t('config.keys.editNth', { number: index + 1 })}
                    >
                      <Pencil size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      onClick={() => setDeleteIndex(index)}
                      disabled={controlsDisabled}
                      title={t('config.keys.delete')}
                      aria-label={t('config.keys.deleteNth', { number: index + 1 })}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="config-empty-list">
                <KeyRound size={26} aria-hidden="true" />
                <strong>{t('config.keys.empty')}</strong>
              </div>
            )}
          </div>
        </section>

        <div className="config-side-stack">
          <section className="panel config-setting-panel">
            <div className="config-panel-heading">
              <div className="config-heading-title">
                <Plug size={18} aria-hidden="true" />
                <h2>{t('config.plugins.title')}</h2>
              </div>
              <span className={`state-pill ${settings?.pluginsEnabled ? 'success' : ''}`}>
                {loading
                  ? t('common.loading')
                  : settings === null
                    ? t('common.unavailable')
                    : settings.pluginsEnabled
                      ? t('common.enabled')
                      : t('common.disabled')}
              </span>
            </div>
            <div className="config-single-control">
              <span>{t('config.plugins.enable')}</span>
              <label className="switch-control" title={t('config.plugins.enable')}>
                <input
                  type="checkbox"
                  aria-label={t('config.plugins.enable')}
                  checked={Boolean(settings?.pluginsEnabled)}
                  disabled={controlsDisabled}
                  onChange={(event) => void togglePlugins(event.currentTarget.checked)}
                />
                <span className="switch-track" />
              </label>
            </div>
          </section>

          <section className="panel config-setting-panel">
            <div className="config-panel-heading">
              <div className="config-heading-title">
                <Route size={18} aria-hidden="true" />
                <h2>{t('config.routing.title')}</h2>
              </div>
              <span className="state-pill" title={settings?.routingStrategy || undefined}>
                {loading
                  ? t('common.loading')
                  : settings === null
                    ? t('common.unavailable')
                    : routingStrategyLabel(settings.routingStrategy, t)}
              </span>
            </div>
            <div className="routing-segmented" role="group" aria-label={t('config.routing.title')}>
              {ROUTING_OPTIONS.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={settings?.routingStrategy === option.value ? 'active' : ''}
                  aria-pressed={settings?.routingStrategy === option.value}
                  disabled={controlsDisabled}
                  onClick={() => void changeRoutingStrategy(option.value)}
                  title={option.value}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>

      {addDialogOpen ? (
        <div className="config-dialog-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeAddDialog();
        }}>
          <form
            className="config-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-api-key-title"
            onSubmit={(event) => void submitApiKey(event)}
          >
            <div className="config-dialog-heading">
              <div>
                <KeyRound size={19} aria-hidden="true" />
                <h2 id="add-api-key-title">
                  {editingApiKey === null ? t('config.keys.addTitle') : t('config.keys.editTitle')}
                </h2>
              </div>
              <button
                type="button"
                className="icon-button quiet"
                onClick={closeAddDialog}
                disabled={keyMutationBusy}
                title={t('common.close')}
                aria-label={t('common.close')}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <label className="config-dialog-field">
              <span>{t('config.keys.label')}</span>
              <div className="config-secret-input">
                <input
                  autoFocus
                  type={showApiKey ? 'text' : 'password'}
                  value={newApiKey}
                  onChange={(event) => {
                    setNewApiKey(event.currentTarget.value);
                    setFormError('');
                  }}
                  disabled={keyMutationBusy}
                  aria-invalid={Boolean(formError)}
                  placeholder="sk-..."
                />
                <button
                  type="button"
                  className="icon-button quiet"
                  onClick={() => setShowApiKey((visible) => !visible)}
                  disabled={keyMutationBusy}
                  title={showApiKey ? t('config.keys.hide') : t('config.keys.show')}
                  aria-label={showApiKey ? t('config.keys.hide') : t('config.keys.show')}
                >
                  {showApiKey ? (
                    <EyeOff size={17} aria-hidden="true" />
                  ) : (
                    <Eye size={17} aria-hidden="true" />
                  )}
                </button>
              </div>
            </label>

            <label className="config-dialog-field">
              <span>{t('config.keys.remark')}</span>
              <input
                className="config-dialog-text-input"
                type="text"
                value={newApiKeyRemark}
                maxLength={80}
                onChange={(event) => {
                  setNewApiKeyRemark(event.currentTarget.value);
                  setFormError('');
                }}
                disabled={keyMutationBusy}
                placeholder={t('config.keys.remarkPlaceholder')}
              />
            </label>

            <div className={`config-form-message ${formError ? 'error' : ''}`}>
              {formError || ' '}
            </div>

            <div className="config-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={generateApiKey}
                disabled={keyMutationBusy}
              >
                <Sparkles size={16} aria-hidden="true" />
                {t('config.keys.generate')}
              </button>
              <button type="submit" className="primary-button" disabled={keyMutationBusy}>
                {editingApiKey === null ? <Plus size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                {keyMutationBusy
                  ? editingApiKey === null ? t('config.keys.adding') : t('common.saving')
                  : editingApiKey === null ? t('common.add') : t('common.save')}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {deleteIndex !== null ? (
        <div className="config-dialog-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target && busyAction !== 'delete-key') {
            setDeleteIndex(null);
          }
        }}>
          <div
            className={`config-dialog config-delete-dialog ${deletingLastKey ? 'has-warning' : ''}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-api-key-title"
          >
            <div className="config-dialog-heading">
              <div>
                <Trash2 size={19} aria-hidden="true" />
                <h2 id="delete-api-key-title">{t('config.keys.deleteTitle')}</h2>
              </div>
            </div>
            <code className="config-delete-key">{maskApiKey(selectedDeleteKey)}</code>
            {deletingLastKey ? (
              <div className="config-delete-warning">
                <AlertCircle size={17} aria-hidden="true" />
                <span>{t('config.keys.deleteAllWarning')}</span>
              </div>
            ) : null}
            <div className="config-dialog-actions two-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setDeleteIndex(null)}
                disabled={busyAction === 'delete-key'}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void confirmDelete()}
                disabled={busyAction === 'delete-key'}
              >
                <Trash2 size={16} aria-hidden="true" />
                {busyAction === 'delete-key' ? t('common.deleting') : t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className={`config-toast ${notice.tone}`} role="status" title={notice.message}>
          {notice.tone === 'success' ? (
            <Check size={17} aria-hidden="true" />
          ) : (
            <AlertCircle size={17} aria-hidden="true" />
          )}
          <span>{notice.message}</span>
        </div>
      ) : null}
    </section>
  );
}

function maskApiKey(apiKey: string) {
  const value = apiKey.trim();
  if (!value) {
    return '';
  }
  const visible = value.length < 4 ? 1 : 2;
  return `${value.slice(0, visible)}${'*'.repeat(Math.max(6, 10 - visible * 2))}${value.slice(-visible)}`;
}

function routingStrategyLabel(strategy: string | undefined, t: ReturnType<typeof useI18n>['t']) {
  if (!strategy) {
    return t('common.loading');
  }
  const option = ROUTING_OPTIONS.find((item) => item.value === strategy);
  return option ? t(option.labelKey) : strategy;
}
