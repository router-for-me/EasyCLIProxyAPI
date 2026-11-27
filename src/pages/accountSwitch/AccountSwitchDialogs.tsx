import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { Tabs, type TabItem } from '../../components/Tabs';
import { Switch } from '../../components/Switch';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import { openExternalUrl } from '../../services/appSettings';
import {
  accountSwitchApi,
  type AccountGroup,
  type AccountSummary,
  type CpaImportCandidate,
  type ImportBatchResult,
  type OAuthSessionView,
  type PlatformRuntimeStatus,
  type SwitchAccountOptions,
  type SwitchPlatformId,
} from '../../services/accountSwitch';

type AddTab = 'local' | 'oauth' | 'cpa' | 'json';

export function AddAccountDialog({
  platform,
  status,
  initialTab = 'local',
  remoteCpaActive = false,
  onClose,
  onImported,
}: {
  platform: SwitchPlatformId;
  status: PlatformRuntimeStatus;
  initialTab?: AddTab;
  remoteCpaActive?: boolean;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const [tab, setTab] = useState<AddTab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // OAuth session state
  const [oauthSession, setOauthSession] = useState<OAuthSessionView | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // CPA import state
  const [cpaCandidates, setCpaCandidates] = useState<CpaImportCandidate[]>([]);
  const [cpaLoading, setCpaLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  // JSON import state
  const [jsonText, setJsonText] = useState('');

  const tabItems: TabItem<AddTab>[] = [
    {
      value: 'local',
      id: 'as-add-tab-local',
      panelId: 'as-add-panel-local',
      label: t('accountSwitch.addDialog.tab.local'),
    },
    {
      value: 'oauth',
      id: 'as-add-tab-oauth',
      panelId: 'as-add-panel-oauth',
      label: t('accountSwitch.addDialog.tab.oauth'),
    },
    {
      value: 'cpa',
      id: 'as-add-tab-cpa',
      panelId: 'as-add-panel-cpa',
      label: t('accountSwitch.addDialog.tab.cpa'),
    },
    {
      value: 'json',
      id: 'as-add-tab-json',
      panelId: 'as-add-panel-json',
      label: t('accountSwitch.addDialog.tab.json'),
    },
  ];

  const loadCpaPreview = async () => {
    setCpaLoading(true);
    setError(null);
    try {
      const items = await accountSwitchApi.previewCpaOauth(
        status.supportsCpaImport ? platform : undefined,
      );
      setCpaCandidates(items);
      setSelectedPaths(new Set(items.map((item) => item.filePath)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCpaLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'cpa') {
      void loadCpaPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, platform]);

  // Poll active OAuth session every 2s until completed/error/cancelled.
  useEffect(() => {
    if (!oauthSession || oauthSession.status !== 'pending') return undefined;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const next = await accountSwitchApi.pollOauth(oauthSession.sessionId);
        if (cancelled) return;
        setOauthSession(next);
        if (next.status === 'completed' && next.account) {
          onImported(
            t('accountSwitch.msg.importedLocal', {
              label: mask.text(next.account.label),
            }),
          );
          onClose();
        } else if (next.status === 'error') {
          setError(next.error ?? 'OAuth failed');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [oauthSession, onClose, onImported, t, mask]);

  const handleImportLocal = async () => {
    setBusy(true);
    setError(null);
    try {
      const account = await accountSwitchApi.importLocal(platform);
      onImported(
        t('accountSwitch.msg.importedLocal', { label: mask.text(account.label) }),
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStartOauth = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await accountSwitchApi.startOauth(platform);
      setOauthSession(session);
      if (session.authUrl) {
        void openExternalUrl({ url: session.authUrl }).catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCancelOauth = async () => {
    if (!oauthSession) return;
    try {
      await accountSwitchApi.cancelOauth(oauthSession.sessionId);
    } catch {
      /* ignore */
    }
    setOauthSession(null);
  };

  const handleImportCpaSelected = async () => {
    setBusy(true);
    setError(null);
    try {
      let batch: ImportBatchResult;
      if (cpaCandidates.length > 0) {
        const chosen = cpaCandidates.filter((c) => selectedPaths.has(c.filePath));
        batch = await accountSwitchApi.importCpaOauth(
          chosen.map((c) => ({
            filePath: c.filePath,
            fileName: c.fileName,
            platform: c.platform,
          })),
        );
      } else if (remoteCpaActive) {
        const remoteEntries = await accountSwitchApi.fetchRemoteCpaSelections(
          status.supportsCpaImport ? platform : undefined,
        );
        batch = await accountSwitchApi.importCpaOauth(remoteEntries);
      } else {
        setBusy(false);
        return;
      }
      onImported(
        t('accountSwitch.msg.importedBatch', {
          imported: batch.imported,
          updated: batch.updated,
        }),
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleImportJson = async () => {
    if (!jsonText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const batch = await accountSwitchApi.importJson(platform, jsonText);
      if (batch.errors.length > 0 && batch.imported === 0 && batch.updated === 0) {
        setError(batch.errors.join('; '));
      } else {
        onImported(
          t('accountSwitch.msg.importedBatch', {
            imported: batch.imported,
            updated: batch.updated,
          }),
        );
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('accountSwitch.addDialog.title', { platform: status.displayName })}
      className="config-dialog account-switch-dialog"
      onClose={() => {
        if (oauthSession?.status === 'pending') {
          void handleCancelOauth();
        }
        onClose();
      }}
      dismissOnBackdrop
    >
      <div className="as-dialog-body">
        <Tabs items={tabItems} value={tab} onChange={setTab} variant="segmented" />

        {error ? (
          <div className="as-inline-error" role="alert">
            <ShieldAlert size={15} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        {tab === 'local' ? (
          <div id="as-add-panel-local" role="tabpanel" className="as-tab-panel">
            <p className="as-dialog-hint">
              {t('accountSwitch.addDialog.localHint', { platform: status.displayName })}
            </p>
            {status.localCredential.detected ? (
              <div className="as-local-preview-box">
                <KeyRound size={16} aria-hidden="true" />
                <div>
                  <strong>
                    {mask.text(status.localCredential.label ?? status.displayName)}
                  </strong>
                  <span>
                    {status.localCredential.email
                      ? mask.text(status.localCredential.email)
                      : status.localCredential.accountId
                        ? mask.identifier(status.localCredential.accountId)
                        : status.displayName}
                  </span>
                </div>
              </div>
            ) : null}
            <div className="as-dialog-panel-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void handleImportLocal()}
              >
                {busy ? (
                  <Loader2 size={15} className="spin" aria-hidden="true" />
                ) : (
                  <Download size={15} aria-hidden="true" />
                )}
                <span>{t('accountSwitch.actions.importLocal')}</span>
              </button>
            </div>
          </div>
        ) : null}

        {tab === 'oauth' ? (
          <div id="as-add-panel-oauth" role="tabpanel" className="as-tab-panel">
            {!status.supportsOauth ? (
              <p className="as-dialog-hint">
                {t('accountSwitch.addDialog.oauthUnsupported', {
                  platform: status.displayName,
                })}
              </p>
            ) : !oauthSession ? (
              <div className="as-oauth-start-box">
                <p className="as-dialog-hint">
                  {status.displayName} · Official OAuth (Direct)
                </p>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void handleStartOauth()}
                >
                  {busy ? (
                    <Loader2 size={15} className="spin" aria-hidden="true" />
                  ) : (
                    <Sparkles size={15} aria-hidden="true" />
                  )}
                  <span>{t('accountSwitch.addDialog.oauthStart')}</span>
                </button>
              </div>
            ) : (
              <div className="as-oauth-pending-box">
                <div className="as-oauth-status-row">
                  <Loader2 size={16} className="spin" aria-hidden="true" />
                  <span>{t('accountSwitch.addDialog.oauthWaiting')}</span>
                </div>
                {oauthSession.userCode ? (
                  <div className="as-device-code-row">
                    <code>{oauthSession.userCode}</code>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        void navigator.clipboard.writeText(oauthSession.userCode ?? '');
                        setCopiedCode(true);
                        window.setTimeout(() => setCopiedCode(false), 1800);
                      }}
                    >
                      {copiedCode ? <Check size={14} /> : <Copy size={14} />}
                      <span>{t('accountSwitch.addDialog.oauthCopyCode')}</span>
                    </button>
                  </div>
                ) : null}
                <div className="as-dialog-panel-actions">
                  {oauthSession.authUrl ? (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() =>
                        void openExternalUrl({ url: oauthSession.authUrl! }).catch(() => undefined)
                      }
                    >
                      <ExternalLink size={14} aria-hidden="true" />
                      <span>{t('accountSwitch.addDialog.oauthOpenBrowser')}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleCancelOauth()}
                  >
                    {t('accountSwitch.addDialog.oauthCancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {tab === 'cpa' ? (
          <div id="as-add-panel-cpa" role="tabpanel" className="as-tab-panel">
            <div className="as-cpa-toolbar">
              <button
                type="button"
                className="secondary-button"
                disabled={cpaLoading}
                onClick={() => void loadCpaPreview()}
              >
                <RefreshCw size={14} className={cpaLoading ? 'spin' : ''} aria-hidden="true" />
                <span>{t('accountSwitch.addDialog.cpaScan')}</span>
              </button>
            </div>
            {cpaCandidates.length === 0 ? (
              <p className="as-dialog-hint">{t('accountSwitch.addDialog.cpaEmpty')}</p>
            ) : (
              <div className="as-cpa-list">
                {cpaCandidates.map((item) => {
                  const checked = selectedPaths.has(item.filePath);
                  return (
                    <label key={item.filePath} className="as-cpa-row">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedPaths((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.filePath)) next.delete(item.filePath);
                            else next.add(item.filePath);
                            return next;
                          });
                        }}
                      />
                      <div className="as-cpa-row-meta">
                        <strong>{mask.text(item.label)}</strong>
                        <span>{item.fileName}</span>
                      </div>
                      <span
                        className={`as-pill ${
                          item.action === 'update' ? 'as-pill-muted' : 'as-pill-accent'
                        }`}
                      >
                        {t(
                          item.action === 'update'
                            ? 'accountSwitch.addDialog.cpaActionUpdate'
                            : 'accountSwitch.addDialog.cpaActionImport',
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <div className="as-dialog-panel-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy || (selectedPaths.size === 0 && !remoteCpaActive)}
                onClick={() => void handleImportCpaSelected()}
              >
                {busy ? (
                  <Loader2 size={14} className="spin" aria-hidden="true" />
                ) : (
                  <Download size={14} aria-hidden="true" />
                )}
                <span>
                  {t('accountSwitch.addDialog.cpaImportSelected', {
                    count: selectedPaths.size,
                  })}
                </span>
              </button>
            </div>
          </div>
        ) : null}

        {tab === 'json' ? (
          <div id="as-add-panel-json" role="tabpanel" className="as-tab-panel">
            <textarea
              className="as-json-textarea"
              rows={8}
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              placeholder={t('accountSwitch.addDialog.jsonPlaceholder')}
            />
            <div className="as-dialog-panel-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy || !jsonText.trim()}
                onClick={() => void handleImportJson()}
              >
                {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null}
                <span>{t('accountSwitch.addDialog.jsonImport')}</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

export function SwitchAccountDialog({
  status,
  account,
  initialOptions,
  busy,
  onClose,
  onConfirm,
}: {
  status: PlatformRuntimeStatus;
  account: AccountSummary;
  initialOptions?: Partial<SwitchAccountOptions>;
  busy: boolean;
  onClose: () => void;
  onConfirm: (options: SwitchAccountOptions) => void;
}) {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const proxyActive =
    status.proxy.mode === 'cpa_proxy' || status.proxy.mode === 'custom_proxy';
  const [decoupleCpaProxy, setDecoupleCpaProxy] = useState(
    initialOptions?.decoupleCpaProxy ?? proxyActive,
  );
  const [refreshBeforeSwitch, setRefreshBeforeSwitch] = useState(
    initialOptions?.refreshBeforeSwitch ?? account.hasRefreshToken,
  );
  const [restartClient, setRestartClient] = useState(
    initialOptions?.restartClient ??
      (status.supportsClientRestart && status.running),
  );
  const [syncTargets, setSyncTargets] = useState<string[]>(() =>
    initialOptions?.syncTargets ??
    status.syncTargets.filter((item) => item.installed).map((item) => item.id),
  );

  const toggleSync = (id: string) => {
    setSyncTargets((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  return (
    <Dialog
      title={t('accountSwitch.switchDialog.title', { platform: status.displayName })}
      className="config-dialog account-switch-dialog"
      onClose={busy ? undefined : onClose}
      closeDisabled={busy}
      dismissOnBackdrop={!busy}
      actions={
        <>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() =>
              onConfirm({
                decoupleCpaProxy,
                refreshBeforeSwitch,
                syncTargets,
                restartClient,
              })
            }
          >
            {busy ? (
              <Loader2 size={14} className="spin" aria-hidden="true" />
            ) : null}
            <span>
              {t(
                busy
                  ? 'accountSwitch.actions.switching'
                  : 'accountSwitch.switchDialog.confirm',
              )}
            </span>
          </button>
        </>
      }
    >
      <div className="as-dialog-body">
        <div className="as-switch-target-box">
          <strong>
            {t('accountSwitch.switchDialog.target', {
              label: mask.text(account.label),
            })}
          </strong>
          {account.email ? <span>{mask.text(account.email)}</span> : null}
        </div>

        {proxyActive ? (
          <div className="as-option-row as-option-highlight">
            <div>
              <strong>{t('accountSwitch.switchDialog.decoupleLabel')}</strong>
              <p>{t('accountSwitch.switchDialog.decoupleHint')}</p>
            </div>
            <Switch
              checked={decoupleCpaProxy}
              onChange={(event) => setDecoupleCpaProxy(event.target.checked)}
              aria-label={t('accountSwitch.switchDialog.decoupleLabel')}
            />
          </div>
        ) : null}

        {account.hasRefreshToken ? (
          <div className="as-option-row">
            <div>
              <strong>{t('accountSwitch.switchDialog.refreshLabel')}</strong>
            </div>
            <Switch
              checked={refreshBeforeSwitch}
              onChange={(event) => setRefreshBeforeSwitch(event.target.checked)}
              aria-label={t('accountSwitch.switchDialog.refreshLabel')}
            />
          </div>
        ) : null}

        {status.syncTargets.length > 0 ? (
          <div className="as-sync-section">
            <div className="as-sync-heading">
              <Link2 size={14} aria-hidden="true" />
              <strong>{t('accountSwitch.switchDialog.syncTitle')}</strong>
            </div>
            <p className="as-dialog-hint">{t('accountSwitch.switchDialog.syncHint')}</p>
            <div className="as-sync-list">
              {status.syncTargets.map((target) => {
                const checked = syncTargets.includes(target.id);
                return (
                  <label key={target.id} className="as-sync-item">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSync(target.id)}
                    />
                    <span>{target.label}</span>
                    <em className={target.installed ? 'installed' : ''}>
                      {t(
                        target.installed
                          ? 'accountSwitch.status.installed'
                          : 'accountSwitch.status.notInstalled',
                      )}
                    </em>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        {status.supportsClientRestart ? (
          <div className="as-option-row">
            <div>
              <strong>
                {t('accountSwitch.switchDialog.restartLabel', {
                  platform: status.displayName,
                })}
              </strong>
              {status.running ? (
                <p>{t('accountSwitch.switchDialog.restartRunningHint')}</p>
              ) : null}
            </div>
            <Switch
              checked={restartClient}
              onChange={(event) => setRestartClient(event.target.checked)}
              aria-label={t('accountSwitch.switchDialog.restartLabel', {
                platform: status.displayName,
              })}
            />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

export function EditAccountMetaDialog({
  account,
  groups,
  availableTags = [],
  onClose,
  onSave,
}: {
  account: AccountSummary;
  groups: AccountGroup[];
  availableTags?: string[];
  onClose: () => void;
  onSave: (patch: {
    label: string;
    groupId: string | null;
    tags: string[];
    notes: string | null;
  }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [label, setLabel] = useState(account.label);
  const [groupId, setGroupId] = useState(account.groupId ?? '');
  const [tags, setTags] = useState<string[]>(() => [...account.tags]);
  const [tagDraft, setTagDraft] = useState('');
  const [notes, setNotes] = useState(account.notes ?? '');
  const [busy, setBusy] = useState(false);

  const suggestedTags = useMemo(
    () =>
      availableTags.filter(
        (tag) => !tags.some((tItem) => tItem.toLowerCase() === tag.toLowerCase()),
      ),
    [availableTags, tags],
  );

  const addTagsFromText = (raw: string) => {
    const pieces = raw
      .split(/[,，]/)
      .map((s) => s.trim().replace(/^#+/, ''))
      .filter(Boolean);
    if (pieces.length === 0) return;
    setTags((prev) => {
      const existing = new Set(prev.map((item) => item.toLowerCase()));
      const next = [...prev];
      for (const piece of pieces) {
        if (!existing.has(piece.toLowerCase())) {
          existing.add(piece.toLowerCase());
          next.push(piece);
        }
      }
      return next;
    });
    setTagDraft('');
  };

  const removeTag = (target: string) => {
    setTags((prev) => prev.filter((item) => item !== target));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const pending = tagDraft
        .split(/[,，]/)
        .map((s) => s.trim().replace(/^#+/, ''))
        .filter(Boolean);
      const finalTags = [...tags];
      const seen = new Set(finalTags.map((item) => item.toLowerCase()));
      for (const piece of pending) {
        if (!seen.has(piece.toLowerCase())) {
          seen.add(piece.toLowerCase());
          finalTags.push(piece);
        }
      }
      await onSave({
        label: label.trim() || account.label,
        groupId: groupId || null,
        tags: finalTags,
        notes: notes.trim() || null,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      as="form"
      title={t('accountSwitch.metaDialog.title')}
      className="config-dialog account-switch-dialog"
      onClose={onClose}
      dismissOnBackdrop
      onSubmit={(event) => void handleSubmit(event)}
      actions={
        <>
          <button type="button" className="secondary-button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="as-dialog-body as-form-grid">
        <label className="as-field">
          <span>{t('accountSwitch.metaDialog.label')}</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
          />
        </label>
        <label className="as-field">
          <span>{t('accountSwitch.metaDialog.group')}</span>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">{t('accountSwitch.filter.ungrouped')}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>

        {/* Cockpit-style interactive Tag Chip Editor */}
        <div className="as-field">
          <span>{t('accountSwitch.metaDialog.tags')}</span>
          {tags.length > 0 ? (
            <div className="as-tag-chip-list">
              {tags.map((tag) => (
                <span key={tag} className="as-tag-chip">
                  <Tag size={11} aria-hidden="true" />
                  <span>{tag}</span>
                  <button
                    type="button"
                    aria-label={`${t('accountSwitch.actions.delete')} ${tag}`}
                    onClick={() => removeTag(tag)}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="as-tag-input-row">
            <input
              type="text"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              placeholder={t('accountSwitch.metaDialog.tagPlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTagsFromText(tagDraft);
                }
              }}
            />
            <button
              type="button"
              className="secondary-button"
              disabled={!tagDraft.trim()}
              onClick={() => addTagsFromText(tagDraft)}
            >
              <Plus size={13} aria-hidden="true" />
              <span>{t('accountSwitch.metaDialog.tagAdd')}</span>
            </button>
          </div>
          {suggestedTags.length > 0 ? (
            <div className="as-tag-suggestions">
              <small>{t('accountSwitch.metaDialog.tagSuggestions')}</small>
              <div className="as-tag-suggestion-list">
                {suggestedTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="as-tag-suggest-btn"
                    onClick={() => addTagsFromText(tag)}
                  >
                    <Plus size={10} aria-hidden="true" />
                    <span>{tag}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <label className="as-field">
          <span>{t('accountSwitch.metaDialog.notes')}</span>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      </div>
    </Dialog>
  );
}

const GROUP_COLOR_PRESETS = [
  '#3b82f6',
  '#10b981',
  '#8b5cf6',
  '#f59e0b',
  '#ec4899',
  '#64748b',
];

export function ManageGroupsDialog({
  groups,
  groupCounts = {},
  onClose,
  onChanged,
}: {
  groups: AccountGroup[];
  groupCounts?: Record<string, number>;
  onClose: () => void;
  onChanged: (next: AccountGroup[]) => void;
}) {
  const { t } = useI18n();
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(GROUP_COLOR_PRESETS[0]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const next = await accountSwitchApi.manageGroups({
        action: 'create',
        name: newName.trim(),
        color: newColor,
      });
      onChanged(next);
      setNewName('');
    } finally {
      setBusy(false);
    }
  };

  const handleRenameConfirm = async (id: string) => {
    if (!renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    setBusy(true);
    try {
      const next = await accountSwitchApi.manageGroups({
        action: 'rename',
        id,
        name: renameValue.trim(),
      });
      onChanged(next);
      setRenamingId(null);
    } finally {
      setBusy(false);
    }
  };

  const handleMove = async (index: number, dir: 'up' | 'down') => {
    const targetIdx = dir === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= groups.length) return;
    const ids = groups.map((g) => g.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(targetIdx, 0, moved);
    setBusy(true);
    try {
      const next = await accountSwitchApi.manageGroups({
        action: 'reorder',
        order: ids,
      });
      onChanged(next);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    try {
      const next = await accountSwitchApi.manageGroups({
        action: 'delete',
        id,
      });
      setDeleteConfirmId(null);
      onChanged(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('accountSwitch.groupDialog.title')}
      className="config-dialog account-switch-dialog"
      onClose={onClose}
      dismissOnBackdrop
    >
      <div className="as-dialog-body">
        <form className="as-group-create-box" onSubmit={(e) => void handleAdd(e)}>
          <div className="as-group-add-row">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('accountSwitch.groupDialog.newPlaceholder')}
            />
            <button
              type="submit"
              className="primary-button"
              disabled={busy || !newName.trim()}
            >
              <Plus size={14} aria-hidden="true" />
              <span>{t('accountSwitch.groupDialog.add')}</span>
            </button>
          </div>
          <div className="as-color-swatches" role="radiogroup">
            {GROUP_COLOR_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                className={['as-color-dot', newColor === color ? 'is-selected' : '']
                  .filter(Boolean)
                  .join(' ')}
                style={{ background: color }}
                aria-label={color}
                onClick={() => setNewColor(color)}
              />
            ))}
          </div>
        </form>

        {groups.length === 0 ? (
          <p className="as-dialog-hint">{t('accountSwitch.groupDialog.empty')}</p>
        ) : (
          <ul className="as-group-list">
            {groups.map((group, index) => {
              const isRenaming = renamingId === group.id;
              const isDeleting = deleteConfirmId === group.id;
              const count = groupCounts[group.id] ?? 0;

              return (
                <li key={group.id}>
                  <i
                    className="fd-gdot"
                    style={{ background: group.color ?? '#64748b' }}
                  />
                  {isRenaming ? (
                    <div className="as-group-rename-row">
                      <input
                        type="text"
                        value={renameValue}
                        autoFocus
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleRenameConfirm(group.id);
                          } else if (e.key === 'Escape') {
                            e.stopPropagation();
                            setRenamingId(null);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="fd-card-icon"
                        disabled={busy}
                        title={t('common.save')}
                        onClick={() => void handleRenameConfirm(group.id)}
                      >
                        <Check size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="fd-card-icon"
                        disabled={busy}
                        title={t('common.cancel')}
                        onClick={() => setRenamingId(null)}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="as-group-name">
                        {group.name}
                        <em>{count}</em>
                      </span>
                      {isDeleting ? (
                        <div className="as-group-del-confirm">
                          <span>{t('accountSwitch.groupDialog.confirmDelete')}</span>
                          <button
                            type="button"
                            className="as-mini-danger"
                            disabled={busy}
                            onClick={() => void handleDelete(group.id)}
                          >
                            {t('accountSwitch.actions.delete')}
                          </button>
                          <button
                            type="button"
                            className="as-mini-cancel"
                            disabled={busy}
                            onClick={() => setDeleteConfirmId(null)}
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      ) : (
                        <div className="as-group-item-actions">
                          <button
                            type="button"
                            className="fd-card-icon"
                            disabled={busy || index === 0}
                            title={t('accountSwitch.groupDialog.moveUp')}
                            aria-label={t('accountSwitch.groupDialog.moveUp')}
                            onClick={() => void handleMove(index, 'up')}
                          >
                            <ChevronUp size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="fd-card-icon"
                            disabled={busy || index === groups.length - 1}
                            title={t('accountSwitch.groupDialog.moveDown')}
                            aria-label={t('accountSwitch.groupDialog.moveDown')}
                            onClick={() => void handleMove(index, 'down')}
                          >
                            <ChevronDown size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="fd-card-icon"
                            disabled={busy}
                            title={t('accountSwitch.groupDialog.rename')}
                            aria-label={t('accountSwitch.groupDialog.rename')}
                            onClick={() => {
                              setDeleteConfirmId(null);
                              setRenamingId(group.id);
                              setRenameValue(group.name);
                            }}
                          >
                            <Pencil size={13} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="fd-card-icon is-danger"
                            disabled={busy}
                            title={t('accountSwitch.actions.delete')}
                            aria-label={t('accountSwitch.actions.delete')}
                            onClick={() => {
                              setRenamingId(null);
                              setDeleteConfirmId(group.id);
                            }}
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

export function DeleteConfirmDialog({
  accounts,
  busy,
  onClose,
  onConfirm,
}: {
  accounts: AccountSummary[];
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const isSingle = accounts.length === 1;
  const preview = accounts.slice(0, 5);
  const extraCount = Math.max(0, accounts.length - preview.length);

  return (
    <Dialog
      title={t('accountSwitch.deleteDialog.title')}
      className="config-dialog account-switch-dialog as-confirm-dialog"
      onClose={busy ? undefined : onClose}
      closeDisabled={busy}
      dismissOnBackdrop={!busy}
      actions={
        <>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="as-danger-button"
            disabled={busy}
            autoFocus
            onClick={onConfirm}
          >
            {busy ? (
              <Loader2 size={14} className="spin" aria-hidden="true" />
            ) : (
              <Trash2 size={14} aria-hidden="true" />
            )}
            <span>{t('accountSwitch.deleteDialog.confirm')}</span>
          </button>
        </>
      }
    >
      <div className="as-dialog-body">
        <div className="as-confirm-lead">
          <AlertTriangle size={18} className="as-confirm-icon" aria-hidden="true" />
          <p className="as-dialog-hint">
            {isSingle
              ? t('accountSwitch.deleteDialog.singleDesc')
              : t('accountSwitch.deleteDialog.batchDesc', {
                  count: accounts.length,
                })}
          </p>
        </div>

        <ul className="as-confirm-list">
          {preview.map((acc) => (
            <li key={acc.id}>
              <strong>{mask.text(acc.label)}</strong>
              {acc.planType ? <span>{acc.planType}</span> : null}
            </li>
          ))}
          {extraCount > 0 ? (
            <li className="as-confirm-more">
              {t('accountSwitch.deleteDialog.more', { count: extraCount })}
            </li>
          ) : null}
        </ul>
      </div>
    </Dialog>
  );
}

export function AssignGroupDialog({
  selectedCount,
  groups,
  busy,
  onClose,
  onApply,
  onCreateAndApply,
}: {
  selectedCount: number;
  groups: AccountGroup[];
  busy: boolean;
  onClose: () => void;
  onApply: (groupId: string | null) => Promise<void>;
  onCreateAndApply: (name: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [chosenId, setChosenId] = useState<string>(groups[0]?.id ?? '');
  const [newGroupName, setNewGroupName] = useState('');

  const handleConfirm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newGroupName.trim()) {
      await onCreateAndApply(newGroupName.trim());
    } else {
      await onApply(chosenId || null);
    }
  };

  return (
    <Dialog
      as="form"
      title={t('accountSwitch.assignGroup.title', { count: selectedCount })}
      className="config-dialog account-switch-dialog"
      onClose={busy ? undefined : onClose}
      closeDisabled={busy}
      dismissOnBackdrop={!busy}
      onSubmit={(e) => void handleConfirm(e)}
      actions={
        <>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            {t('common.cancel')}
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null}
            <span>{t('accountSwitch.assignGroup.confirm')}</span>
          </button>
        </>
      }
    >
      <div className="as-dialog-body as-form-grid">
        <div className="as-field">
          <span>{t('accountSwitch.assignGroup.pickExisting')}</span>
          <div className="as-assign-radio-list">
            <label
              className={[
                'as-assign-option',
                !newGroupName.trim() && chosenId === '' ? 'is-selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <input
                type="radio"
                name="assign-group"
                checked={!newGroupName.trim() && chosenId === ''}
                onChange={() => {
                  setNewGroupName('');
                  setChosenId('');
                }}
              />
              <span>{t('accountSwitch.filter.ungrouped')}</span>
            </label>
            {groups.map((group) => (
              <label
                key={group.id}
                className={[
                  'as-assign-option',
                  !newGroupName.trim() && chosenId === group.id ? 'is-selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <input
                  type="radio"
                  name="assign-group"
                  checked={!newGroupName.trim() && chosenId === group.id}
                  onChange={() => {
                    setNewGroupName('');
                    setChosenId(group.id);
                  }}
                />
                {group.color ? (
                  <i className="fd-gdot" style={{ background: group.color }} />
                ) : null}
                <span>{group.name}</span>
              </label>
            ))}
          </div>
        </div>

        <label className="as-field">
          <span>{t('accountSwitch.assignGroup.createAndAssign')}</span>
          <input
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder={t('accountSwitch.groupDialog.newPlaceholder')}
          />
        </label>
      </div>
    </Dialog>
  );
}

function maskExportValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= 2) return '*'.repeat(value.length);
    if (value.length <= 6) return `${value[0]}***${value[value.length - 1]}`;
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  if (Array.isArray(value)) return value.map(maskExportValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        k === 'format' ||
        k === 'platform' ||
        k === 'planType' ||
        k === 'plan' ||
        k === 'source'
      ) {
        out[k] = v;
      } else {
        out[k] = maskExportValue(v);
      }
    }
    return out;
  }
  return value;
}

export function ExportJsonDialog({
  platformName,
  filePrefix,
  jsonContent,
  onClose,
}: {
  platformName: string;
  filePrefix: string;
  jsonContent: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [masked, setMasked] = useState(true);
  const [copied, setCopied] = useState(false);

  const previewText = useMemo(() => {
    if (!masked) return jsonContent;
    try {
      return JSON.stringify(maskExportValue(JSON.parse(jsonContent)), null, 2);
    } catch {
      return jsonContent.replace(/[^\s]/g, '*');
    }
  }, [jsonContent, masked]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore clipboard error */
    }
  };

  const handleDownload = () => {
    const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `${filePrefix}-accounts-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      title={t('accountSwitch.exportDialog.title', { platform: platformName })}
      className="config-dialog account-switch-dialog as-export-dialog"
      onClose={onClose}
      dismissOnBackdrop
      actions={
        <button type="button" className="secondary-button" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <div className="as-dialog-body">
        <p className="as-dialog-hint">{t('accountSwitch.exportDialog.hint')}</p>
        <div className="as-export-toolbar">
          <button
            type="button"
            className="secondary-button compact-button"
            onClick={() => setMasked((prev) => !prev)}
          >
            {masked ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
            <span>
              {t(
                masked
                  ? 'accountSwitch.exportDialog.unmask'
                  : 'accountSwitch.exportDialog.mask',
              )}
            </span>
          </button>
          <button
            type="button"
            className="secondary-button compact-button"
            onClick={() => void handleCopy()}
          >
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            <span>
              {t(
                copied
                  ? 'accountSwitch.actions.copied'
                  : 'accountSwitch.exportDialog.copy',
              )}
            </span>
          </button>
          <button
            type="button"
            className="primary-button compact-button"
            onClick={handleDownload}
          >
            <Download size={14} aria-hidden="true" />
            <span>{t('accountSwitch.exportDialog.download')}</span>
          </button>
        </div>
        <textarea
          className="as-json-textarea as-export-preview"
          rows={12}
          readOnly
          spellCheck={false}
          value={previewText}
        />
      </div>
    </Dialog>
  );
}
