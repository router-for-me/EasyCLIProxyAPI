import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, CircleCheck, Code2, Copy, ExternalLink, LoaderCircle, LockKeyhole, LogIn, LogOut, Pencil, Plus, RefreshCw, RotateCcw, ShieldCheck, SlidersHorizontal, Terminal, Trash2, Unplug, Users, X, Zap } from 'lucide-react';
import antigravityIcon from '../assets/icons/antigravity.svg';
import { Dialog } from '../components/Dialog';
import { useConfirmation } from '../components/ConfirmationDialog';
import { Notice } from '../components/Notice';
import { Select } from '../components/Select';
import { Switch } from '../components/Switch';
import { useI18n } from '../i18n';
import { usePrivacyMask } from '../privacy';
import {
  acpApi,
  acpErrorMessageKey,
  DEFAULT_ACP_POOL_SETTINGS,
  type AcpAccount,
  type AcpAuthorizationLink,
  type AcpPoolSettings,
  type AcpPromptProfile,
  type AcpRoutingStrategy,
  type AcpStatus,
} from '../services/acp';
import { openExternalUrl } from '../services/appSettings';
import { selectedRemoteEndpoint } from '../services/remoteCpa';
import './AcpAccessPage.css';

// Same anchored button/dropdown pattern used by MCP management. Keep it in
// the dialog DOM for its focus trap; opening it never changes the row height.
function AccountMoreActions({
  busy,
  hasCli,
  hasIssue,
  onAction,
}: {
  busy: boolean;
  hasCli: boolean;
  hasIssue: boolean;
  onAction: (kind: 'verify' | 'resetCooldown' | 'remove' | 'logout') => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [upward, setUpward] = useState(false);
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const show = (last = false) => {
    if (busy) return;
    focusLast.current = last;
    const button = trigger.current?.getBoundingClientRect();
    const dialog = wrap.current?.closest('[role="dialog"]')?.getBoundingClientRect();
    setUpward(Boolean(button && dialog && dialog.bottom - button.bottom < 190));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const items = menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      (focusLast.current ? items?.[items.length - 1] : items?.[0])?.focus();
    });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) setOpen(false);
    };
    // Capture at window before the shared dialog's document Escape listener:
    // one Escape dismisses only this menu, a later Escape closes the dialog.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      setOpen(false); trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  useEffect(() => { if (busy) setOpen(false); }, [busy]);
  return <div className="acp-account-more" ref={wrap} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="secondary-button acp-more-trigger" disabled={busy} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? close(false) : show()} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp'); }
      }}>{t('acp.moreActions')}<ChevronDown size={12} aria-hidden="true" /></button>
    {open ? <div ref={menu} id={menuId} className="acp-account-menu surface-panel" data-upward={upward} role="menu" aria-label={t('acp.moreActions')} onKeyDown={event => {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % items.length
        : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : -1;
      if (next >= 0 && items[next]) { event.preventDefault(); items[next].focus(); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const dialog = wrap.current?.closest('[role="dialog"]');
        const controls = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href], [tabindex="0"]') || [])
          .filter(element => !menu.current?.contains(element) && element.getClientRects().length > 0);
        const triggerIndex = controls.indexOf(trigger.current as HTMLButtonElement);
        close(false);
        (event.shiftKey ? trigger.current : controls[triggerIndex + 1] || controls[0])?.focus();
      }
    }}>
      <button type="button" role="menuitem" className="acp-account-menu-item" disabled={!hasCli} onClick={() => { close(true); onAction('verify'); }}><ShieldCheck size={14} aria-hidden="true" />{t('acp.verifyNow')}</button>
      {hasIssue ? <button type="button" role="menuitem" className="acp-account-menu-item" onClick={() => { close(true); onAction('resetCooldown'); }}><RotateCcw size={14} aria-hidden="true" />{t('acp.resetCooldown')}</button> : null}
      <button type="button" role="menuitem" className="acp-account-menu-item" disabled={!hasCli} onClick={() => { close(true); onAction('logout'); }}><LogOut size={14} aria-hidden="true" />{t('acp.logout')}</button>
      <button type="button" role="menuitem" className="acp-account-menu-item acp-remove-action" onClick={() => { close(true); onAction('remove'); }}><Trash2 size={14} aria-hidden="true" />{t('acp.removeLocal')}</button>
    </div> : null}
  </div>;
}

export function AcpAccessPage() {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const external = Boolean(selectedRemoteEndpoint());
  const [status, setStatus] = useState<AcpStatus | null>(null);
  const [loading, setLoading] = useState(!external);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [managingAccounts, setManagingAccounts] = useState(false);
  const [editor, setEditor] = useState<{ account?: AcpAccount; reauthorize?: AcpAccount } | null>(null);
  const [accountLabel, setAccountLabel] = useState('');
  const [accountPriority, setAccountPriority] = useState('0');
  const [accountWeight, setAccountWeight] = useState('1');
  const [accountMaxConcurrency, setAccountMaxConcurrency] = useState('1');
  const [accountProxyUrl, setAccountProxyUrl] = useState('');
  const [formError, setFormError] = useState('');
  const [manualLink, setManualLink] = useState<AcpAuthorizationLink | null>(null);
  const [manualResponse, setManualResponse] = useState('');
  const [manualError, setManualError] = useState('');
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [testAccountId, setTestAccountId] = useState('');
  const [poolDraft, setPoolDraft] = useState<AcpPoolSettings>(DEFAULT_ACP_POOL_SETTINGS);
  const [poolDirty, setPoolDirty] = useState(false);
  const [poolSavedNotice, setPoolSavedNotice] = useState(false);
  const [poolSaving, setPoolSaving] = useState(false);
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const labelInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const next = await acpApi.status();
    if (mounted.current) {
      setStatus(next);
      if (next.poolSettings) {
        setPoolDraft(current => (poolDirty ? current : next.poolSettings || current));
      }
    }
    return next;
  }, [poolDirty]);

  useEffect(() => {
    mounted.current = true;
    if (external) {
      setLoading(false);
      return () => { mounted.current = false; };
    }
    void refresh().catch(cause => { if (mounted.current) setError(String(cause)); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [external, refresh]);

  // Observe live pool concurrency, cooldowns, and external operations.
  useEffect(() => {
    if (external) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const interval = status?.busy || operation ? 1000 : status?.upstreamEnabled || status?.poolSettings?.accountPool ? 3000 : 5000;
    const poll = async () => {
      try { await refresh(); } catch { /* The action reports errors. */ }
      if (active) timer = setTimeout(() => void poll(), interval);
    };
    timer = setTimeout(() => void poll(), interval);
    return () => { active = false; clearTimeout(timer); };
  }, [external, status?.busy, status?.upstreamEnabled, status?.poolSettings?.accountPool, operation, refresh]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    if (pending.current || status?.busy) return false;
    pending.current = true;
    setOperation(name); setError('');
    let success = false;
    try { await action(); success = true; }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      try { await refresh(); } catch (cause) { if (mounted.current) setError(String(cause)); }
      pending.current = false;
      if (mounted.current) setOperation('');
    }
    return success;
  };

  const applyPoolUpdate = async (next: AcpPoolSettings, showSavedToast = false) => {
    setPoolSaving(true);
    setError('');
    setPoolSavedNotice(false);
    try {
      const updated = await acpApi.updatePoolSettings(next);
      if (mounted.current) {
        setStatus(updated);
        if (updated.poolSettings) setPoolDraft(updated.poolSettings);
        setPoolDirty(false);
        if (showSavedToast) setPoolSavedNotice(true);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setPoolSaving(false);
    }
  };

  const toggleAccountEnabled = async (account: AcpAccount, enabled: boolean) => {
    setError('');
    try {
      const updated = await acpApi.updateAccountSettings(account.id, { enabled });
      if (mounted.current) setStatus(updated);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const resetCooldown = async (accountId?: string) => {
    setError('');
    try {
      const updated = await acpApi.resetAccountCooldown(accountId);
      if (mounted.current) setStatus(updated);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const busy = Boolean(operation || status?.busy);
  const probe = busy ? null : status?.latestProbe;
  const activeOperation = operation || status?.operation;
  const busyLabel = t(activeOperation === 'login' ? 'acp.waiting'
    : activeOperation === 'test' ? 'acp.testing'
    : activeOperation === 'select' ? 'acp.savingModel'
    : activeOperation === 'upstream' ? 'acp.updatingApi'
    : activeOperation === 'request' ? 'acp.servingRequest'
    : activeOperation === 'logout' ? 'acp.signingOut'
    : activeOperation === 'verify_all' ? 'acp.verifyingAll'
    : activeOperation === 'verify' ? 'acp.verifyingAccount'
    : activeOperation === 'pool' ? 'acp.updatingPool'
    : ['rename', 'remove'].includes(activeOperation || '') ? 'acp.updatingAccount' : 'acp.refreshing');
  const connected = status?.authenticated === true;
  const hasCli = Boolean(status?.executable);
  const poolSettings = status?.poolSettings || DEFAULT_ACP_POOL_SETTINGS;
  const runtimeMap = status?.accountRuntime || {};
  const activeAccount = status?.accounts.find(account => account.id === status.activeAccount);
  const savedAccounts = status?.accounts.filter(account => account.saved) || [];
  const visibleAccounts = savedAccounts;
  const enabledSavedAccounts = savedAccounts.filter(account => account.enabled !== false);
  const readyAccountsCount = enabledSavedAccounts.filter(account => {
    const rt = runtimeMap[account.id];
    return rt?.authState === 'ready' || (account.id === status?.activeAccount && connected);
  }).length;
  const cooledAccountsCount = savedAccounts.filter(account => {
    const rt = runtimeMap[account.id];
    return Boolean(rt && (rt.cooldowns.length > 0 || rt.authState === 'auth_required' || rt.authState === 'error'));
  }).length;
  const apiEnabled = status?.upstreamEnabled === true;
  const poolHasReady = poolSettings.accountPool && readyAccountsCount > 0;
  const apiReady = apiEnabled && (connected || poolHasReady) && Boolean(status?.upstreamUrl);
  const apiSwitchOperation = activeOperation === 'upstream';
  const apiCanStart = (connected || poolHasReady) && Boolean(status?.models.length || poolHasReady);
  // The backend serializes interactive operations; an enabled API can still be stopped
  // while disconnected, but not during another in-flight interactive operation.
  const apiSwitchDisabled = busy || loading || (!apiEnabled && !apiCanStart);
  const apiSwitchHint = loading ? t('acp.apiSwitchChecking')
    : busy && !apiSwitchOperation ? t('acp.apiSwitchWaiting')
    : !apiEnabled && !apiCanStart ? t('acp.apiSwitchNeedsAccount')
    : apiEnabled && !apiReady ? t('acp.apiSwitchWaitingConnection') : '';

  const accountName = (account: AcpAccount) => !account.saved ? t('acp.noConnectedAccount') : account.id === 'default' && account.label === 'Default'
    ? privacy.text(account.email || t('acp.legacyAccount'), account.email ? [account.email] : [])
    : privacy.enabled ? privacy.identifier(account.label) : account.label;
  const shownError = error || status?.error;
  // Preserve the backend text. Only the exact cancellation outcomes receive a
  // neutral presentation; authorization/network/cleanup errors stay errors.
  const cancelled = /^(?:Account saved; connection not verified: )?ACP request cancelled$/.test(shownError || '');
  const errorMessageKey = shownError ? acpErrorMessageKey(shownError) : null;
  const actionNotice = shownError ? <Notice className="acp-action-notice" tone={cancelled ? 'info' : 'error'} title={t(cancelled ? 'acp.operationCancelled' : 'acp.operationFailed')}>
    {errorMessageKey ? <>{errorMessageKey !== 'acp.errorCancelled' ? <p>{t(errorMessageKey)}</p> : null}<details className="acp-error-detail"><summary>{t('acp.errorDetails')}</summary><p>{privacy.text(shownError)}</p></details></> : privacy.text(shownError)}
  </Notice> : null;
  const example = JSON.stringify({ model: `acp/${status?.selectedModel || 'MODEL_ID'}`, messages: [{ role: 'user', content: 'Hello' }], stream: true }, null, 2);
  useEffect(() => { setCopied(false); }, [example]);
  useEffect(() => {
    if (testAccountId && !savedAccounts.some(account => account.id === testAccountId)) {
      setTestAccountId('');
    }
  }, [savedAccounts, testAccountId]);

  const openEditor = (account?: AcpAccount) => {
    setAccountLabel(account?.label || '');
    setAccountPriority(String(account?.priority ?? 0));
    setAccountWeight(String(account?.weight ?? 1));
    setAccountMaxConcurrency(String(account?.maxConcurrency ?? 1));
    setAccountProxyUrl(account?.proxyUrl || '');
    setFormError('');
    setError('');
    setEditor({ account });
  };
  const closeEditor = () => { if (!busy) { setEditor(null); setFormError(''); } };
  const saveAccount = async () => {
    if (!editor || busy || (!editor.account && !hasCli)) return;
    const trimmed = accountLabel.trim();
    if (!trimmed || [...trimmed].length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(accountLabel)) {
      setFormError(t('acp.labelInvalid')); labelInput.current?.focus(); return;
    }
    const editing = editor.account;
    if (editing) {
      const priority = Number.parseInt(accountPriority, 10);
      const weight = Number.parseInt(accountWeight, 10);
      const maxConcurrency = Number.parseInt(accountMaxConcurrency, 10);
      if (!Number.isInteger(priority) || priority < 0 || !Number.isInteger(weight) || weight < 1 || weight > 100 || !Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) {
        setFormError(t('acp.errorInvalidAccountSettings'));
        return;
      }
      setFormError('');
      const ok = await run('rename', () => acpApi.updateAccountSettings(editing.id, {
        label: trimmed,
        priority,
        weight,
        maxConcurrency,
        proxyUrl: accountProxyUrl.trim(),
      }));
      if (mounted.current && ok) setEditor(null);
      return;
    }
    setFormError('');
    const previousIds = new Set(status?.accounts.map(account => account.id));
    const ok = await run('login', () => acpApi.addAccount(trimmed, link => {
      if (mounted.current) setManualLink(link);
    }, editor.reauthorize?.id));
    if (mounted.current) { setManualLink(null); setManualResponse(''); setManualError(''); setManualSubmitting(false); }
    if (mounted.current) {
      const current = await refresh().catch(() => null);
      // Official authorization may have committed before model verification
      // failed or was cancelled. Return to its saved row, not an "add" retry.
      if (ok || current?.accounts.some(account => !previousIds.has(account.id))) setEditor(null);
    }
  };
  const submitManualResponse = async () => {
    if (!manualLink || !manualResponse.trim() || manualSubmitting) return;
    setManualSubmitting(true); setManualError('');
    try {
      await acpApi.submitAccountAuthorization(manualLink.attempt, manualResponse.trim());
      setManualResponse(''); setManualLink(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setManualError(t(acpErrorMessageKey(message) || 'acp.errorManualFailed'));
    } finally { setManualSubmitting(false); }
  };
  const confirmAccountAction = async (kind: 'remove' | 'logout' | 'relogin', account: AcpAccount) => {
    if (busy) return;
    if (kind === 'relogin' && account.isolated) {
      setAccountLabel(account.label); setFormError(''); setError(''); setEditor({ reauthorize: account });
      return;
    }
    if (!await askConfirmation({
      title: t(kind === 'remove' ? 'acp.removeTitle' : kind === 'logout' ? 'acp.logoutTitle' : 'acp.reloginTitle'),
      message: t(kind === 'remove' ? 'acp.removeMessage' : kind === 'logout' ? 'acp.logoutMessage' : 'acp.reloginMessage'),
      warning: kind === 'remove' && account.id === status?.activeAccount ? t('acp.removeCurrentWarning') : undefined,
      details: [{ label: t('acp.accountNote'), value: accountName(account) }],
      confirmText: t(kind === 'remove' ? 'acp.removeLocal' : kind === 'logout' ? 'acp.logout' : 'acp.relogin'),
      variant: kind === 'relogin' ? 'primary' : 'danger',
    })) return;
    await run(kind === 'remove' ? 'remove' : kind === 'logout' ? 'logout' : 'login', () => kind === 'remove'
      ? acpApi.removeAccount(account.id)
      : kind === 'logout'
        ? acpApi.logoutAccount(account.id)
        : acpApi.reloginAccount(account.id));
  };
  const operationStatus = busy ? <div className="acp-operation-status" role="status" aria-live="polite"><span><LoaderCircle size={16} className="spin" aria-hidden="true" />{busyLabel}</span>
    {!['rename', 'remove', 'select', 'upstream', 'pool'].includes(activeOperation || '') ? <button type="button" className="secondary-button compact-button" onClick={() => void acpApi.cancel().catch(cause => setError(String(cause)))}><X size={14} aria-hidden="true" />{t('acp.cancel')}</button> : null}
  </div> : null;

  const effectiveTestAccountId = testAccountId || status?.activeAccount || '';
  const updateDraftNumber = (field: keyof Pick<AcpPoolSettings, 'maxGlobalConcurrency' | 'maxLiveSessions' | 'queueWaitMs' | 'maxFailoverAttempts' | 'cooldownBaseSecs' | 'cooldownMaxSecs'>, raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    setPoolDraft(prev => ({ ...prev, [field]: Number.isFinite(parsed) ? parsed : 0 }));
    setPoolDirty(true);
    setPoolSavedNotice(false);
  };

  if (external) {
    return <div className="acp-access-page" data-connected={false}>
      <header className="acp-page-heading">
        <div><h1>{t('oauth.acp.tab')}</h1><p>{t('acp.description')}</p></div>
      </header>
      <Notice tone="info">{t('acp.externalUnsupported')}</Notice>
    </div>;
  }

  return <div className="acp-access-page" aria-busy={busy || loading} data-connected={connected}>
    <header className="acp-page-heading">
      <div><h1>{t('oauth.acp.tab')}</h1><p>{t('acp.description')}</p></div>
      <button type="button" className="secondary-button" disabled={busy || loading}
        onClick={() => void run('refresh', async () => { const next = await refresh(); if (next.executable) await acpApi.connect(false); })}>
        <RefreshCw size={15} className={activeOperation === 'refresh' ? 'spin' : undefined} aria-hidden="true" />{t('acp.refresh')}
      </button>
    </header>

    {!managingAccounts && !editor && !confirmationDialog ? actionNotice : null}

    <section className="panel surface-panel acp-provider-card" aria-labelledby="acp-provider-title">
      <div className="acp-provider-heading">
        <div className="acp-provider-identity"><span className="acp-provider-mark"><img src={antigravityIcon} alt="" className="provider-logo" /></span>
          <div><h2 id="acp-provider-title">{t('acp.provider')}</h2><span className="acp-connection-status" data-connected={connected} role="status">
            {connected ? <CircleCheck size={13} aria-hidden="true" /> : <Unplug size={13} aria-hidden="true" />}
            {loading ? t('acp.checking') : connected ? t('acp.connected') : t('acp.notConnected')}
          </span></div>
        </div>
      </div>

      <div className="acp-account-section">
        <div className="acp-account-row">
          <div className="acp-current-account"><span className="acp-eyebrow">{t('acp.currentAccount')}</span>
            <strong className="acp-account-name" title={activeAccount ? accountName(activeAccount) : undefined}>{loading ? t('acp.checking') : activeAccount ? accountName(activeAccount) : t('acp.noConnectedAccount')}</strong>
            {activeAccount?.saved && activeAccount.email && !(activeAccount.id === 'default' && activeAccount.label === 'Default') ? <span className="acp-account-email" title={privacy.text(activeAccount.email, [activeAccount.email])}>{privacy.text(activeAccount.email, [activeAccount.email])}</span> : null}
            <span className="acp-account-total">{t('acp.savedCount', { count: savedAccounts.length })}</span>
          </div>
          <div className="acp-provider-actions">
            {!connected ? <button type="button" className="primary-button" disabled={!hasCli || busy || loading} onClick={() => activeAccount?.isolated ? void confirmAccountAction('relogin', activeAccount) : void run('login', () => acpApi.connect(true))}><LogIn size={16} aria-hidden="true" />{t('acp.login')}</button> : null}
            <button type="button" className="secondary-button" disabled={loading} aria-haspopup="dialog" onClick={() => setManagingAccounts(true)}><Users size={16} aria-hidden="true" />{t('acp.manageAccounts')}</button>
          </div>
        </div>
        {!hasCli && !loading ? <div className="acp-install-state"><button type="button" className="secondary-button" onClick={() => void openExternalUrl({ url: 'https://antigravity.google/docs/cli/install/' }).catch(cause => setError(String(cause)))}><ExternalLink size={14} aria-hidden="true" />{t('acp.install')}</button></div> : null}
      </div>
      <div className="acp-provider-footer"><p className="acp-cli-status"><Terminal size={13} aria-hidden="true" /><span>{t('acp.cli')}</span><span className="acp-status-dot" data-ready={hasCli} aria-hidden="true" /><span>{loading ? t('acp.checking') : hasCli ? t('acp.detected') : t('acp.missing')}</span></p></div>
    </section>

    {!managingAccounts && !editor ? operationStatus : null}

    <div className="acp-workspace-grid"><section className="panel surface-panel acp-model-card" aria-labelledby="acp-model-title">
      <div className="acp-section-heading"><div className="acp-section-identity"><span className="acp-section-icon"><Zap size={17} aria-hidden="true" /></span><div><h2 id="acp-model-title">{t('acp.stepTest')}</h2></div></div>{connected ? <span className="acp-count">{t('acp.modelCount', { count: status.models.length })}</span> : null}</div>
      {connected ? <>
      {savedAccounts.length > 1 ? <div className="acp-test-account-controls"><label><span>{t('acp.testAccount')}</span>
        <Select value={effectiveTestAccountId} disabled={busy} onChange={event => setTestAccountId(event.currentTarget.value)}>
          {savedAccounts.map(account => <option key={account.id} value={account.id}>{accountName(account)}</option>)}
        </Select>
      </label></div> : null}
      <div className="acp-model-controls acp-test-model-controls"><label><span>{t('acp.model')}</span>
        <Select value={status?.selectedModel || ''} disabled={!connected || busy || !status?.models.length}
          onChange={event => { const model = event.currentTarget.value; void run('select', () => acpApi.selectModel(model)); }}>
          {!status?.models.length ? <option value="">{t('acp.modelPlaceholder')}</option> : null}
          {status?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </Select>
      </label>
        <button type="button" className="secondary-button" disabled={!connected || busy || !status?.selectedModel}
          onClick={() => void run('test', () => acpApi.test(testAccountId || undefined, status?.selectedModel || undefined))}>
          <Zap size={16} aria-hidden="true" />{t('acp.test')}</button>
      </div>
      {probe ? <div className="acp-probe-result" role="status"><strong><CircleCheck size={16} aria-hidden="true" />{t('acp.testPassed')}</strong>
        <dl><div><dt>{t('acp.reply')}</dt><dd><code>{probe.text}</code></dd></div>
          <div><dt>{t('acp.model')}</dt><dd>{probe.model}</dd></div>
          <div><dt>{t('acp.duration')}</dt><dd>{(probe.durationMs / 1000).toFixed(2)} s</dd></div>
          <div><dt>{t('acp.firstText')}</dt><dd>{probe.firstTextMs == null ? '—' : (probe.firstTextMs / 1000).toFixed(2) + ' s'}</dd></div></dl>
      </div> : null}
      </> : <div className="acp-empty-state"><span className="acp-empty-icon"><LockKeyhole size={20} aria-hidden="true" /></span><strong>{t('acp.modelsLocked')}</strong><button type="button" className="secondary-button" disabled><Zap size={15} aria-hidden="true" />{t('acp.test')}</button></div>}
    </section>

    <section className="panel surface-panel acp-model-card acp-api-card" aria-labelledby="acp-api-title" data-enabled={apiReady}>
      <div className="acp-section-heading"><div className="acp-section-identity"><span className="acp-section-icon"><Code2 size={17} aria-hidden="true" /></span><div><h2 id="acp-api-title">{t('acp.apiTitle')}</h2></div></div></div>
      <label className="acp-api-switch">
        <Switch checked={apiEnabled} disabled={apiSwitchDisabled} aria-label={t(apiEnabled ? 'acp.apiSwitchOffLabel' : 'acp.apiSwitchOnLabel')}
          aria-describedby={apiSwitchHint ? 'acp-api-switch-hint' : undefined}
          onChange={event => { const enabled = event.currentTarget.checked; if (enabled === apiEnabled) return; void run('upstream', () => acpApi.setUpstreamEnabled(enabled)); }} />
        <span className="acp-api-switch-text"><strong>{t('acp.enableApi')}</strong>
          {apiSwitchHint ? <span className="acp-muted" id="acp-api-switch-hint">{apiSwitchHint}</span> : null}</span>
        <span className="acp-api-switch-state" role="status" data-state={apiSwitchOperation ? 'starting' : apiEnabled ? (apiReady ? 'on' : 'waiting') : 'off'}>
          {apiSwitchOperation ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : null}{t(apiSwitchOperation ? 'acp.apiStateStarting'
            : apiEnabled ? apiReady ? 'acp.apiStateOn' : 'acp.apiStateWaiting'
            : 'acp.apiStateOff')}</span>
      </label>

      <div className="acp-pool-panel">
        <div className="acp-pool-header-row">
          <label className="acp-pool-switch">
            <Switch
              checked={poolSettings.accountPool}
              disabled={loading || poolSaving}
              aria-label={t(poolSettings.accountPool ? 'acp.poolDisableLabel' : 'acp.poolEnableLabel')}
              onChange={event => {
                const accountPool = event.currentTarget.checked;
                const next = { ...poolDraft, accountPool };
                setPoolDraft(next);
                void applyPoolUpdate(next);
              }}
            />
            <span className="acp-pool-switch-label">{t('acp.poolEnable')}</span>
          </label>
          <label className="acp-pool-strategy">
            <span>{t('acp.poolRoutingStrategy')}</span>
            <Select
              value={poolDraft.routingStrategy}
              disabled={loading || poolSaving}
              onChange={event => {
                const routingStrategy = event.currentTarget.value as AcpRoutingStrategy;
                const next = { ...poolDraft, routingStrategy };
                setPoolDraft(next);
                void applyPoolUpdate(next);
              }}
            >
              <option value="round_robin">{t('acp.strategyRoundRobin')}</option>
              <option value="least_busy">{t('acp.strategyLeastBusy')}</option>
              <option value="fill_first">{t('acp.strategyFillFirst')}</option>
              <option value="weighted">{t('acp.strategyWeighted')}</option>
            </Select>
          </label>
        </div>

        {(apiEnabled || poolSettings.accountPool) ? <div className="acp-pool-telemetry" role="status">
          <span className="acp-muted">
            {t('acp.poolSummary', {
              active: status?.activeRequests ?? 0,
              max: poolSettings.maxGlobalConcurrency,
              sessions: status?.liveSessions ?? 0,
              maxSessions: poolSettings.maxLiveSessions,
              ready: readyAccountsCount,
              total: enabledSavedAccounts.length,
            })}
          </span>
          {cooledAccountsCount > 0 ? <button type="button" className="secondary-button compact-button" onClick={() => void resetCooldown()}>
            <RotateCcw size={13} aria-hidden="true" />{t('acp.resetAllCooldowns', { count: cooledAccountsCount })}
          </button> : null}
        </div> : null}

        <details className="acp-api-details acp-pool-advanced">
          <summary><span className="acp-pool-advanced-label"><SlidersHorizontal size={13} aria-hidden="true" />{t('acp.poolAdvancedTitle')}</span><ChevronDown size={14} aria-hidden="true" /></summary>
          <div className="acp-api-details-body">
            <div className="acp-pool-grid">
              <label className="acp-pool-field">
                <span>{t('acp.poolMaxGlobalConcurrency')}</span>
                <input type="number" min={1} max={128} value={poolDraft.maxGlobalConcurrency} disabled={poolSaving}
                  onChange={event => updateDraftNumber('maxGlobalConcurrency', event.currentTarget.value)} />
              </label>
              <label className="acp-pool-field">
                <span>{t('acp.poolMaxLiveSessions')}</span>
                <input type="number" min={4} max={256} value={poolDraft.maxLiveSessions} disabled={poolSaving}
                  onChange={event => updateDraftNumber('maxLiveSessions', event.currentTarget.value)} />
              </label>
              <label className="acp-pool-field">
                <span>{t('acp.poolQueueWaitMs')}</span>
                <input type="number" min={0} max={60000} step={100} value={poolDraft.queueWaitMs} disabled={poolSaving}
                  onChange={event => updateDraftNumber('queueWaitMs', event.currentTarget.value)} />
              </label>
              <label className="acp-pool-field">
                <span>{t('acp.poolMaxFailover')}</span>
                <input type="number" min={0} max={8} value={poolDraft.maxFailoverAttempts} disabled={poolSaving}
                  onChange={event => updateDraftNumber('maxFailoverAttempts', event.currentTarget.value)} />
              </label>
              <label className="acp-pool-field">
                <span>{t('acp.poolCooldownBase')}</span>
                <input type="number" min={5} max={3600} value={poolDraft.cooldownBaseSecs} disabled={poolSaving}
                  onChange={event => updateDraftNumber('cooldownBaseSecs', event.currentTarget.value)} />
              </label>
              <label className="acp-pool-field">
                <span>{t('acp.poolCooldownMax')}</span>
                <input type="number" min={10} max={86400} value={poolDraft.cooldownMaxSecs} disabled={poolSaving}
                  onChange={event => updateDraftNumber('cooldownMaxSecs', event.currentTarget.value)} />
              </label>
              <label className="acp-pool-field acp-pool-field-wide">
                <span>{t('acp.poolPromptProfile')}</span>
                <Select value={poolDraft.promptProfile} disabled={poolSaving}
                  onChange={event => {
                    const promptProfile = event.currentTarget.value as AcpPromptProfile;
                    setPoolDraft(prev => ({ ...prev, promptProfile }));
                    setPoolDirty(true);
                    setPoolSavedNotice(false);
                  }}>
                  <option value="append">{t('acp.promptProfileAppend')}</option>
                  <option value="first_turn_context">{t('acp.promptProfileFirstTurn')}</option>
                </Select>
              </label>
            </div>
            <div className="acp-pool-save-row">
              {poolSavedNotice ? <span className="acp-pool-saved" role="status"><CircleCheck size={13} aria-hidden="true" />{t('acp.poolSaved')}</span> : <span />}
              <button type="button" className="secondary-button compact-button" disabled={poolSaving || !poolDirty}
                onClick={() => void applyPoolUpdate(poolDraft, true)}>
                {t('acp.poolSave')}
              </button>
            </div>
          </div>
        </details>
      </div>

      {apiReady ? <details className="acp-api-details"><summary>{t('acp.apiUsageTitle')}<ChevronDown size={14} aria-hidden="true" /></summary><div className="acp-api-details-body">
        <p className="acp-muted">{t('acp.apiUsage')}</p>
        <div className="acp-code-example"><div className="acp-code-heading"><span><b>POST</b><code>/v1/chat/completions</code></span>
        <button type="button" className="secondary-button compact-button" onClick={() => void navigator.clipboard.writeText(example).then(() => setCopied(true)).catch(cause => setError(String(cause)))}><Copy size={14} aria-hidden="true" />{t(copied ? 'acp.exampleCopied' : 'common.copy')}</button>
        </div><pre><code>{example}</code></pre></div>
        <details className="acp-api-model-list"><summary>{t('acp.models')} · {status?.models.length || 0}</summary><ul className="acp-api-models">{status?.models.map(model => <li key={model.id}><code>{`acp/${model.id}`}</code></li>)}</ul></details>
      </div></details> : null}
    </section></div>

    {managingAccounts ? <Dialog className="config-dialog acp-account-dialog" title={t('acp.manageAccounts')} icon={<Users size={19} aria-hidden="true" />} onClose={() => setManagingAccounts(false)} inert={Boolean(editor)} actionsClassName="acp-dialog-actions"
      actions={<button type="button" className="secondary-button" onClick={() => setManagingAccounts(false)}>{t('common.close')}</button>}>
      <div className="acp-manage-toolbar">
        <span className="acp-account-total">{t('acp.savedCount', { count: savedAccounts.length })}</span>
        <div className="acp-manage-toolbar-actions">
          {cooledAccountsCount > 0 ? <button type="button" className="secondary-button compact-button" onClick={() => void resetCooldown()}>
            <RotateCcw size={13} aria-hidden="true" />{t('acp.resetAllCooldowns', { count: cooledAccountsCount })}
          </button> : null}
          {savedAccounts.length > 0 && hasCli ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void run('verify_all', () => acpApi.verifyAllAccounts())}>
            <ShieldCheck size={14} aria-hidden="true" />{t('acp.verifyAll')}
          </button> : null}
          <button type="button" className="primary-button" disabled={busy || !hasCli || savedAccounts.length >= 64} onClick={() => openEditor()}><Plus size={15} aria-hidden="true" />{t('acp.newAccount')}</button>
        </div>
      </div>
      {!hasCli ? <p className="acp-dialog-note">{t('acp.cliAccountHint')}</p> : null}
      {savedAccounts.length >= 64 ? <p className="acp-dialog-note">{t('acp.errorAccountLimit')}</p> : null}
      {!editor && !confirmationDialog ? actionNotice : null}
      {!editor ? operationStatus : null}
      {!visibleAccounts.length ? <div className="acp-account-empty"><LockKeyhole size={22} aria-hidden="true" /><strong>{t('acp.noSavedAccounts')}</strong>
        {hasCli ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void run('login', () => acpApi.connect(true))}><LogIn size={15} aria-hidden="true" />{t('acp.login')}</button> : null}
      </div> : null}
      <div className="acp-account-list" aria-label={t('acp.savedAccounts')}>
        {visibleAccounts.map(account => {
          const current = account.id === status?.activeAccount;
          const accountEnabled = account.enabled !== false;
          const rt = runtimeMap[account.id];
          const maxCooldownSecs = rt?.cooldowns.reduce((max, item) => Math.max(max, item.remainingSecs), 0) || 0;
          const hasIssue = Boolean(rt && (rt.cooldowns.length > 0 || rt.authState === 'auth_required' || rt.authState === 'error'));
          const priority = account.priority ?? 0;
          const weight = account.weight ?? 1;
          const maxConcurrency = account.maxConcurrency ?? 1;
          const hasCustomMeta = priority !== 0 || weight !== 1 || maxConcurrency !== 1 || Boolean(account.proxyUrl);
          return <article key={account.id} className="acp-managed-account" data-current={current} data-disabled={!accountEnabled}>
            <div className="acp-managed-identity"><strong className="acp-account-name" title={accountName(account)}>{accountName(account)}</strong>
              {account.email && !(account.id === 'default' && account.label === 'Default') ? <span className="acp-account-email" title={privacy.text(account.email, [account.email])}>{privacy.text(account.email, [account.email])}</span> : null}
              <div className="acp-account-badges">
                {current ? <><span>{t('acp.currentUse')}</span><span data-connected={connected}>{t(connected ? 'acp.connected' : 'acp.notVerified')}</span></>
                  : rt?.authState === 'ready' ? <span data-connected="true">{t('acp.accountReady')}</span>
                  : <span>{t('acp.saved')}</span>}
                {!accountEnabled ? <span data-warn="true">{t('acp.accountDisabled')}</span> : null}
                {rt?.authState === 'auth_required' ? <span data-warn="true">{t('acp.accountAuthRequired')}</span> : null}
                {rt?.authState === 'error' ? <span data-warn="true">{t('acp.accountError')}</span> : null}
                {maxCooldownSecs > 0 ? <span data-warn="true">{t('acp.accountCooldown', { secs: maxCooldownSecs })}</span> : null}
                {(rt?.activeRequests || 0) > 0 ? <span>{t('acp.accountInFlight', { count: rt?.activeRequests || 0 })}</span> : null}
                {(rt?.liveSessions || 0) > 0 ? <span>{t('acp.accountSessions', { count: rt?.liveSessions || 0 })}</span> : null}
                {hasCustomMeta ? <span>{t('acp.accountMetaSummary', { priority, weight, concurrency: maxConcurrency })}</span> : null}
                {account.proxyUrl ? <span>{t('acp.accountProxyTag')}</span> : null}
              </div>
            </div>
            <div className="acp-managed-actions">
              <Switch
                checked={accountEnabled}
                aria-label={t('acp.accountEnabledLabel', { label: accountName(account) })}
                onChange={event => void toggleAccountEnabled(account, event.currentTarget.checked)}
              />
              {!current ? <button type="button" className="secondary-button" disabled={busy || !hasCli} onClick={() => void run('refresh', () => acpApi.switchAccount(account.id))}>{t('acp.useAccount')}</button> : null}
              <button type="button" className="secondary-button" disabled={busy || !hasCli} onClick={() => void confirmAccountAction('relogin', account)}><LogIn size={14} aria-hidden="true" />{t('acp.relogin')}</button>
              <button type="button" className="icon-button quiet" disabled={busy} aria-label={t('acp.renameAccount', { label: accountName(account) })} title={t('acp.editNote')} onClick={() => openEditor(account)}><Pencil size={15} aria-hidden="true" /></button>
              <AccountMoreActions
                busy={busy}
                hasCli={hasCli}
                hasIssue={hasIssue}
                onAction={kind => {
                  if (kind === 'verify') {
                    void run('verify', () => acpApi.verifyAccount(account.id));
                  } else if (kind === 'resetCooldown') {
                    void resetCooldown(account.id);
                  } else {
                    void confirmAccountAction(kind, account);
                  }
                }}
              />
            </div>
          </article>;
        })}
      </div>
    </Dialog> : null}
    {editor ? <Dialog as="form" size="sm" className="config-dialog acp-account-dialog acp-account-editor" title={t(editor.account ? 'acp.accountSettings' : editor.reauthorize ? 'acp.relogin' : 'acp.newAccount')} onClose={closeEditor} closeDisabled={busy} busy={busy} initialFocusRef={labelInput}
      onSubmit={event => { event.preventDefault(); if (manualLink) void submitManualResponse(); else void saveAccount(); }} actionsClassName="acp-dialog-actions"
      actions={<><button type="button" className="secondary-button" disabled={busy} onClick={closeEditor}>{t('common.cancel')}</button><button type="submit" className="primary-button" disabled={manualLink ? manualSubmitting || !manualResponse.trim() : busy || (!editor.account && !hasCli)}>{t(manualLink ? 'acp.submitManual' : editor.account ? 'common.save' : editor.reauthorize ? 'acp.relogin' : 'acp.addAccount')}</button></>}>
      <label className="acp-note-field"><span className="acp-note-label"><span>{t('acp.accountNote')}</span><span className="acp-note-count" aria-hidden="true">{[...accountLabel.trim()].length}/80</span></span><input ref={labelInput} type="text" value={accountLabel} disabled={busy || Boolean(editor.reauthorize)} aria-invalid={Boolean(formError)} aria-describedby={formError ? 'acp-note-error' : undefined} placeholder={t('acp.accountLabelPlaceholder')} onChange={event => { setAccountLabel(event.currentTarget.value); setFormError(''); }} /></label>
      {editor.account ? <>
        <div className="acp-account-settings-grid">
          <label className="acp-note-field">
            <span>{t('acp.accountPriority')}</span>
            <input type="number" min={0} max={999} value={accountPriority} disabled={busy} onChange={event => { setAccountPriority(event.currentTarget.value); setFormError(''); }} />
          </label>
          <label className="acp-note-field">
            <span>{t('acp.accountWeight')}</span>
            <input type="number" min={1} max={100} value={accountWeight} disabled={busy} onChange={event => { setAccountWeight(event.currentTarget.value); setFormError(''); }} />
          </label>
          <label className="acp-note-field">
            <span>{t('acp.accountMaxConcurrency')}</span>
            <input type="number" min={1} max={16} value={accountMaxConcurrency} disabled={busy} onChange={event => { setAccountMaxConcurrency(event.currentTarget.value); setFormError(''); }} />
          </label>
        </div>
        <label className="acp-note-field">
          <span>{t('acp.accountProxy')}</span>
          <input type="text" value={accountProxyUrl} disabled={busy} placeholder={t('acp.accountProxyPlaceholder')} spellCheck={false} autoComplete="off"
            onChange={event => { setAccountProxyUrl(event.currentTarget.value); setFormError(''); }} />
        </label>
      </> : null}
      {manualLink ? <div className="acp-note-field">
        <p>{t('acp.manualInstructions')}</p>
        <label className="acp-note-field">{t('acp.manualLink')}
          <input type="text" readOnly value={manualLink.url} onFocus={event => event.currentTarget.select()} spellCheck={false} autoComplete="off" />
        </label>
        <label className="acp-note-field">{t('acp.manualResponse')}
          <input type="password" value={manualResponse} onChange={event => { setManualResponse(event.currentTarget.value); setManualError(''); }} disabled={manualSubmitting} maxLength={3072} autoComplete="off" spellCheck={false} />
        </label>
        {manualError ? <p className="acp-form-error" role="alert">{manualError}</p> : null}
      </div> : null}
      {formError ? <p id="acp-note-error" className="acp-form-error" role="alert">{formError}</p> : null}
      {!confirmationDialog ? actionNotice : null}
      {operationStatus}
    </Dialog> : null}
    {confirmationDialog}
  </div>;
}
