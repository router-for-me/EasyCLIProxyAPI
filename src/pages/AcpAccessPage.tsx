import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, CircleCheck, Code2, Copy, ExternalLink, LoaderCircle, LockKeyhole, LogIn, LogOut, Pencil, Plus, RefreshCw, Terminal, Trash2, Unplug, Users, X, Zap } from 'lucide-react';
import antigravityIcon from '../assets/icons/antigravity.svg';
import { Dialog } from '../components/Dialog';
import { useConfirmation } from '../components/ConfirmationDialog';
import { Notice } from '../components/Notice';
import { Select } from '../components/Select';
import { Switch } from '../components/Switch';
import { useI18n } from '../i18n';
import { usePrivacyMask } from '../privacy';
import { acpApi, acpErrorMessageKey, type AcpAccount, type AcpAuthorizationLink, type AcpStatus } from '../services/acp';
import { openExternalUrl } from '../services/appSettings';
import './AcpAccessPage.css';

// Same anchored button/dropdown pattern used by MCP management. Keep it in
// the dialog DOM for its focus trap; opening it never changes the row height.
function AccountMoreActions({ current, busy, hasCli, onAction }: {
  current: boolean; busy: boolean; hasCli: boolean;
  onAction: (kind: 'remove' | 'logout') => void;
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
    setUpward(Boolean(button && dialog && dialog.bottom - button.bottom < 130));
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
      {current ? <button type="button" role="menuitem" className="acp-account-menu-item" disabled={!hasCli} onClick={() => { close(true); onAction('logout'); }}><LogOut size={14} aria-hidden="true" />{t('acp.logout')}</button> : null}
      <button type="button" role="menuitem" className="acp-account-menu-item acp-remove-action" onClick={() => { close(true); onAction('remove'); }}><Trash2 size={14} aria-hidden="true" />{t('acp.removeLocal')}</button>
    </div> : null}
  </div>;
}

export function AcpAccessPage() {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const [status, setStatus] = useState<AcpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [managingAccounts, setManagingAccounts] = useState(false);
  const [editor, setEditor] = useState<{ account?: AcpAccount; reauthorize?: AcpAccount } | null>(null);
  const [accountLabel, setAccountLabel] = useState('');
  const [formError, setFormError] = useState('');
  const [manualAvailable, setManualAvailable] = useState<boolean | null>(null);
  const [manualLink, setManualLink] = useState<AcpAuthorizationLink | null>(null);
  const [manualResponse, setManualResponse] = useState('');
  const [manualError, setManualError] = useState('');
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const labelInput = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const next = await acpApi.status();
    if (mounted.current) setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(cause => { if (mounted.current) setError(String(cause)); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [refresh]);

  // Observe external API operations too, at a lower polling rate while idle.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); } catch { /* The action reports errors. */ }
      if (active) timer = setTimeout(() => void poll(), status?.busy || operation ? 1000 : 5000);
    };
    timer = setTimeout(() => void poll(), status?.busy || operation ? 1000 : 5000);
    return () => { active = false; clearTimeout(timer); };
  }, [status?.busy, operation, refresh]);

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

  const busy = Boolean(operation || status?.busy);
  const probe = busy ? null : status?.latestProbe;
  const activeOperation = operation || status?.operation;
  const busyLabel = t(activeOperation === 'login' ? 'acp.waiting'
    : activeOperation === 'test' ? 'acp.testing'
    : activeOperation === 'select' ? 'acp.savingModel'
    : activeOperation === 'upstream' ? 'acp.updatingApi'
    : activeOperation === 'request' ? 'acp.servingRequest'
    : activeOperation === 'logout' ? 'acp.signingOut'
    : ['rename', 'remove'].includes(activeOperation || '') ? 'acp.updatingAccount' : 'acp.refreshing');
  const connected = status?.authenticated === true;
  const hasCli = Boolean(status?.executable);
  const apiEnabled = status?.upstreamEnabled === true;
  const apiReady = apiEnabled && connected && Boolean(status?.upstreamUrl);
  const apiSwitchOperation = activeOperation === 'upstream';
  const apiCanStart = connected && Boolean(status?.models.length);
  // The backend serializes all operations; an enabled API can still be stopped
  // while disconnected, but not during another in-flight operation.
  const apiSwitchDisabled = busy || loading || (!apiEnabled && !apiCanStart);
  const apiSwitchHint = loading ? t('acp.apiSwitchChecking')
    : busy && !apiSwitchOperation ? t('acp.apiSwitchWaiting')
    : !apiEnabled && !apiCanStart ? t('acp.apiSwitchNeedsAccount')
    : apiEnabled && !apiReady ? t('acp.apiSwitchWaitingConnection') : '';
  const activeAccount = status?.accounts.find(account => account.id === status.activeAccount);
  const savedAccounts = status?.accounts.filter(account => account.saved) || [];
  const visibleAccounts = savedAccounts;
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
  const openEditor = (account?: AcpAccount) => {
    setAccountLabel(account?.label || ''); setFormError(''); setError(''); setEditor({ account });
  };
  useEffect(() => {
    setManualAvailable(null);
    if (!editor || editor.account || !hasCli) return;
    let active = true;
    void acpApi.manualAuthAvailable().then(available => { if (active) setManualAvailable(available); }).catch(() => { if (active) setManualAvailable(false); });
    return () => { active = false; };
  }, [editor, hasCli]);
  const closeEditor = () => { if (!busy) { setEditor(null); setFormError(''); } };
  const saveAccount = async () => {
    if (!editor || busy || (!editor.account && !manualAvailable)) return;
    const trimmed = accountLabel.trim();
    if (!trimmed || [...trimmed].length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(accountLabel)) {
      setFormError(t('acp.labelInvalid')); labelInput.current?.focus(); return;
    }
    setFormError('');
    const editing = editor.account;
    const previousIds = new Set(status?.accounts.map(account => account.id));
    const ok = await run(editing ? 'rename' : 'login', () => editing
      ? acpApi.renameAccount(editing.id, trimmed) : acpApi.addAccount(trimmed, link => {
        if (mounted.current) setManualLink(link);
      }, editor.reauthorize?.id));
    if (mounted.current) { setManualLink(null); setManualResponse(''); setManualError(''); setManualSubmitting(false); }
    if (mounted.current) {
      const current = await refresh().catch(() => null);
      // Official authorization may have committed before model verification
      // failed or was cancelled. Return to its saved row, not an "add" retry.
      if (ok || (!editing && current?.accounts.some(account => !previousIds.has(account.id)))) setEditor(null);
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
      ? acpApi.removeAccount(account.id) : kind === 'logout' ? acpApi.logoutAccount() : acpApi.reloginAccount());
  };
  const operationStatus = busy ? <div className="acp-operation-status" role="status" aria-live="polite"><span><LoaderCircle size={16} className="spin" aria-hidden="true" />{busyLabel}</span>
    {!['rename', 'remove', 'select', 'upstream'].includes(activeOperation || '') ? <button type="button" className="secondary-button compact-button" onClick={() => void acpApi.cancel().catch(cause => setError(String(cause)))}><X size={14} aria-hidden="true" />{t('acp.cancel')}</button> : null}
  </div> : null;

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
      <div className="acp-model-controls acp-test-model-controls"><label><span>{t('acp.model')}</span>
        <Select value={status?.selectedModel || ''} disabled={!connected || busy || !status?.models.length}
          onChange={event => { const model = event.currentTarget.value; void run('select', () => acpApi.selectModel(model)); }}>
          {!status?.models.length ? <option value="">{t('acp.modelPlaceholder')}</option> : null}
          {status?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </Select>
      </label>
        <button type="button" className="secondary-button" disabled={!connected || busy || !status?.selectedModel}
          onClick={() => void run('test', () => acpApi.test())}>
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
      {apiReady ? <details className="acp-api-details"><summary>{t('acp.apiUsageTitle')}<ChevronDown size={14} aria-hidden="true" /></summary><div className="acp-api-details-body">
        <p className="acp-muted">{t('acp.apiUsage')}</p>
        <div className="acp-code-example"><div className="acp-code-heading"><span><b>POST</b><code>/v1/chat/completions</code></span>
        <button type="button" className="secondary-button compact-button" onClick={() => void navigator.clipboard.writeText(example).then(() => setCopied(true)).catch(cause => setError(String(cause)))}><Copy size={14} aria-hidden="true" />{t(copied ? 'acp.exampleCopied' : 'common.copy')}</button>
        </div><pre><code>{example}</code></pre></div>
        <details className="acp-api-model-list"><summary>{t('acp.models')} · {status.models.length}</summary><ul className="acp-api-models">{status.models.map(model => <li key={model.id}><code>{`acp/${model.id}`}</code></li>)}</ul></details>
      </div></details> : null}
    </section></div>

    {managingAccounts ? <Dialog className="config-dialog acp-account-dialog" title={t('acp.manageAccounts')} icon={<Users size={19} aria-hidden="true" />} onClose={() => setManagingAccounts(false)} inert={Boolean(editor)} actionsClassName="acp-dialog-actions"
      actions={<button type="button" className="secondary-button" onClick={() => setManagingAccounts(false)}>{t('common.close')}</button>}>
      <div className="acp-manage-toolbar"><span className="acp-account-total">{t('acp.savedCount', { count: savedAccounts.length })}</span><button type="button" className="primary-button" disabled={busy || !hasCli || savedAccounts.length >= 32} onClick={() => openEditor()}><Plus size={15} aria-hidden="true" />{t('acp.newAccount')}</button></div>
      {!hasCli ? <p className="acp-dialog-note">{t('acp.cliAccountHint')}</p> : null}
      {savedAccounts.length >= 32 ? <p className="acp-dialog-note">{t('acp.errorAccountLimit')}</p> : null}
      {!editor && !confirmationDialog ? actionNotice : null}
      {!editor ? operationStatus : null}
      {!visibleAccounts.length ? <div className="acp-account-empty"><LockKeyhole size={22} aria-hidden="true" /><strong>{t('acp.noSavedAccounts')}</strong>
        {hasCli ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void run('login', () => acpApi.connect(true))}><LogIn size={15} aria-hidden="true" />{t('acp.login')}</button> : null}
      </div> : null}
      <div className="acp-account-list" aria-label={t('acp.savedAccounts')}>
        {visibleAccounts.map(account => {
          const current = account.id === status?.activeAccount;
          return <article key={account.id} className="acp-managed-account" data-current={current}>
            <div className="acp-managed-identity"><strong className="acp-account-name" title={accountName(account)}>{accountName(account)}</strong>
              {account.email && !(account.id === 'default' && account.label === 'Default') ? <span className="acp-account-email" title={privacy.text(account.email, [account.email])}>{privacy.text(account.email, [account.email])}</span> : null}
              <div className="acp-account-badges">{current ? <><span>{t('acp.currentUse')}</span><span data-connected={connected}>{t(connected ? 'acp.connected' : 'acp.notVerified')}</span></> : <span>{t('acp.saved')}</span>}</div>
            </div>
            <div className="acp-managed-actions">
              {!current ? <button type="button" className="secondary-button" disabled={busy || !hasCli} onClick={() => void run('refresh', () => acpApi.switchAccount(account.id))}>{t('acp.useAccount')}</button> : <button type="button" className="secondary-button" disabled={busy || !hasCli} onClick={() => void confirmAccountAction('relogin', account)}><LogIn size={14} aria-hidden="true" />{t('acp.relogin')}</button>}
              <button type="button" className="icon-button quiet" disabled={busy} aria-label={t('acp.renameAccount', { label: accountName(account) })} title={t('acp.editNote')} onClick={() => openEditor(account)}><Pencil size={15} aria-hidden="true" /></button>
              <AccountMoreActions current={current} busy={busy} hasCli={hasCli} onAction={kind => void confirmAccountAction(kind, account)} />
            </div>
          </article>;
        })}
      </div>
    </Dialog> : null}
    {editor ? <Dialog as="form" size="sm" className="config-dialog acp-account-dialog acp-account-editor" title={t(editor.account ? 'acp.editNote' : editor.reauthorize ? 'acp.relogin' : 'acp.newAccount')} onClose={closeEditor} closeDisabled={busy} busy={busy} initialFocusRef={labelInput}
      onSubmit={event => { event.preventDefault(); if (manualLink) void submitManualResponse(); else void saveAccount(); }} actionsClassName="acp-dialog-actions"
      actions={<><button type="button" className="secondary-button" disabled={busy} onClick={closeEditor}>{t('common.cancel')}</button><button type="submit" className="primary-button" disabled={manualLink ? manualSubmitting || !manualResponse.trim() : busy || (!editor.account && (!hasCli || manualAvailable !== true))}>{t(manualLink ? 'acp.submitManual' : editor.account ? 'common.save' : editor.reauthorize ? 'acp.relogin' : 'acp.addAccount')}</button></>}>
      <label className="acp-note-field"><span className="acp-note-label"><span>{t('acp.accountNote')}</span><span className="acp-note-count" aria-hidden="true">{[...accountLabel.trim()].length}/80</span></span><input ref={labelInput} type="text" value={accountLabel} disabled={busy || Boolean(editor.reauthorize)} aria-invalid={Boolean(formError)} aria-describedby={formError ? 'acp-note-error' : undefined} placeholder={t('acp.accountLabelPlaceholder')} onChange={event => { setAccountLabel(event.currentTarget.value); setFormError(''); }} /></label>
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
      {!editor.account && !manualLink && manualAvailable === false ? <p className="acp-form-error" role="status">{t('acp.errorManualUnsupported')}</p> : null}
      {operationStatus}
    </Dialog> : null}
    {confirmationDialog}
  </div>;
}
