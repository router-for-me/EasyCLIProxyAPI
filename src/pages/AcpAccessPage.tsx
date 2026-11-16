import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, CircleCheck, Code2, Copy, ExternalLink, KeyRound, LoaderCircle, LockKeyhole, LogIn, Plus, RefreshCw, Settings2, Terminal, Unplug, X, Zap } from 'lucide-react';
import antigravityIcon from '../assets/icons/antigravity.svg';
import { Notice } from '../components/Notice';
import { Select } from '../components/Select';
import { useI18n } from '../i18n';
import { usePrivacyMask } from '../privacy';
import { acpApi, type AcpStatus } from '../services/acp';
import { openExternalUrl } from '../services/appSettings';
import './AcpAccessPage.css';

export function AcpAccessPage() {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const [status, setStatus] = useState<AcpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [accountLabel, setAccountLabel] = useState('');
  const [addingAccount, setAddingAccount] = useState(false);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const addAccountButton = useRef<HTMLButtonElement>(null);
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
    if (pending.current || status?.busy) return;
    pending.current = true;
    setOperation(name); setError('');
    try { await action(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      try { await refresh(); } catch (cause) { if (mounted.current) setError(String(cause)); }
      pending.current = false;
      if (mounted.current) setOperation('');
    }
  };

  const busy = Boolean(operation || status?.busy);
  const probe = busy ? null : status?.latestProbe;
  const activeOperation = operation || status?.operation;
  const busyLabel = t(activeOperation === 'login' ? 'acp.waiting'
    : activeOperation === 'test' ? 'acp.testing'
    : activeOperation === 'select' ? 'acp.savingModel'
    : activeOperation === 'upstream' ? 'acp.updatingApi'
    : activeOperation === 'request' ? 'acp.servingRequest' : 'acp.refreshing');
  const connected = status?.authenticated === true;
  const hasCli = Boolean(status?.executable);
  const apiEnabled = status?.upstreamEnabled === true;
  const awaitingFirstConnection = !connected && status?.activeAccount === 'default'
    && status.accounts.length === 1 && status.accounts[0].label === 'Default' && !status.accounts[0].email;
  const shownError = error || status?.error;
  const example = JSON.stringify({ model: `acp/${status?.selectedModel || 'MODEL_ID'}`, messages: [{ role: 'user', content: 'Hello' }], stream: true }, null, 2);
  useEffect(() => { setCopied(false); }, [example]);
  const closeAccountForm = () => {
    setAddingAccount(false);
    setAccountLabel('');
    addAccountButton.current?.focus();
  };

  return <div className="acp-access-page" aria-busy={busy || loading} data-connected={connected}>
    <header className="acp-page-heading">
      <div><h1>{t('oauth.acp.tab')}</h1><p>{t('acp.description')}</p></div>
      <button type="button" className="secondary-button" disabled={busy || loading} title={t('acp.refreshHint')}
        onClick={() => void run('refresh', async () => { const next = await refresh(); if (next.executable) await acpApi.connect(false); })}>
        <RefreshCw size={15} className={activeOperation === 'refresh' ? 'spin' : undefined} aria-hidden="true" />{t('acp.refresh')}
      </button>
    </header>

    {shownError ? <Notice tone="error" title={t('acp.operationFailed')}>{privacy.text(shownError)}</Notice> : null}

    <section className="panel surface-panel acp-provider-card" aria-labelledby="acp-provider-title">
      <div className="acp-provider-heading">
        <div className="acp-provider-identity"><span className="acp-provider-mark"><img src={antigravityIcon} alt="" className="provider-logo" /></span>
          <div><h2 id="acp-provider-title">{t('acp.provider')}</h2><span className="acp-connection-status" data-connected={connected} role="status">
            {connected ? <CircleCheck size={13} aria-hidden="true" /> : <Unplug size={13} aria-hidden="true" />}
            {loading ? t('acp.checking') : connected ? t('acp.connected') : t('acp.notConnected')}
          </span></div>
        </div>
      </div>

      {!hasCli && !loading ? <div className="acp-install-state"><p className="acp-muted">{t('acp.installHint')}</p><button type="button" className="primary-button" onClick={() => void openExternalUrl({ url: 'https://antigravity.google/docs/cli/install/' }).catch(cause => setError(String(cause)))}><ExternalLink size={15} aria-hidden="true" />{t('acp.install')}</button></div> : <div className="acp-account-section">
      <div className="acp-account-row"><div className="acp-model-controls acp-account-controls"><label><span>{t('acp.currentAccount')}</span>
        <Select value={status?.activeAccount || 'default'} disabled={busy || loading || !hasCli || awaitingFirstConnection}
          aria-describedby="acp-account-help"
          onChange={event => { const id = event.currentTarget.value; void run('refresh', () => acpApi.switchAccount(id)); }}>
          {!status?.accounts.length ? <option value="default">{t(loading ? 'acp.checking' : 'acp.noConnectedAccount')}</option> : null}
          {status?.accounts.map((account, index) => <option key={account.id} value={account.id}>{account.email
            ? privacy.text(account.id === 'default' && account.label === 'Default' ? account.email : `${account.email} · ${account.label}`, [account.email])
            : account.id === 'default' && account.label === 'Default'
            ? t(awaitingFirstConnection ? 'acp.noConnectedAccount' : 'acp.unnamedAccount', { number: index + 1 })
            : privacy.text(account.label)}</option>)}
        </Select>
      </label></div>
      <div className="acp-provider-actions">
        {!connected ? <button type="button" className="primary-button" disabled={!hasCli || busy || loading || addingAccount}
          onClick={() => void run('login', () => acpApi.connect(true))}>
          <LogIn size={16} aria-hidden="true" />{t('acp.login')}
        </button> : null}
        <button ref={addAccountButton} type="button" className="secondary-button" disabled={busy || loading || !hasCli} aria-expanded={addingAccount} aria-controls="acp-add-account-form" onClick={() => addingAccount ? closeAccountForm() : setAddingAccount(true)}><Plus size={16} aria-hidden="true" />{t('acp.newAccount')}</button>
      </div></div>
      <p className="acp-muted" id="acp-account-help">{t(connected ? 'acp.accountConnectedHint' : 'acp.accountLoginHint')}</p>

      {addingAccount ? <form id="acp-add-account-form" className="acp-add-account" onSubmit={event => { event.preventDefault(); if (!accountLabel.trim() || busy || loading || !hasCli) return; void run('login', async () => { await acpApi.addAccount(accountLabel.trim()); if (mounted.current) closeAccountForm(); }); }}>
        <div className="acp-add-account-heading"><strong>{t('acp.newAccount')}</strong><p className="acp-muted">{t('acp.newAccountHint')}</p></div>
        <div className="acp-add-account-fields"><label><span>{t('acp.accountLabel')}</span><input autoFocus type="text" value={accountLabel} maxLength={80} disabled={busy || loading || !hasCli} placeholder={t('acp.accountLabelPlaceholder')} onChange={event => setAccountLabel(event.currentTarget.value)} /></label>
        <button type="submit" className="primary-button" disabled={busy || loading || !hasCli || !accountLabel.trim()}><LogIn size={15} aria-hidden="true" />{t('acp.addAccount')}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={closeAccountForm}>{t('common.cancel')}</button></div>
      </form> : null}
      </div>}
      <div className="acp-provider-footer"><p className="acp-cli-status"><Terminal size={13} aria-hidden="true" /><span>{t('acp.cli')}</span><span className="acp-status-dot" data-ready={hasCli} aria-hidden="true" /><span>{loading ? t('acp.checking') : hasCli ? t('acp.detected') : t('acp.missing')}</span></p><span>{t('acp.sharedCli')}</span></div>
    </section>

      {busy ? <div className="acp-operation-status" role="status" aria-live="polite"><span><LoaderCircle size={16} className="spin" aria-hidden="true" />{busyLabel}</span>
        <button type="button" className="secondary-button compact-button" onClick={() => void acpApi.cancel().catch(cause => setError(String(cause)))}>
          <X size={14} aria-hidden="true" />{t('acp.cancel')}</button>
      </div> : null}

    <div className="acp-workspace-grid"><section className="panel surface-panel acp-model-card" aria-labelledby="acp-model-title">
      <div className="acp-section-heading"><div className="acp-section-identity"><span className="acp-section-icon"><Zap size={17} aria-hidden="true" /></span><div><h2 id="acp-model-title">{t('acp.stepTest')}</h2><p className="acp-muted">{t('acp.testDescription')}</p></div></div><span className="acp-count">{t('acp.optional')}</span></div>
      {connected ? <>
      <p className="acp-model-availability"><span className="acp-status-dot" data-ready="true" aria-hidden="true" />{t('acp.modelCount', { count: status.models.length })}</p>
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
      <p className="acp-muted">{t('acp.modelHint')}</p>
      {probe ? <div className="acp-probe-result" role="status"><strong><CircleCheck size={16} aria-hidden="true" />{t('acp.testPassed')}</strong>
        <dl><div><dt>{t('acp.reply')}</dt><dd><code>{probe.text}</code></dd></div>
          <div><dt>{t('acp.model')}</dt><dd>{probe.model}</dd></div>
          <div><dt>{t('acp.duration')}</dt><dd>{(probe.durationMs / 1000).toFixed(2)} s</dd></div>
          <div><dt>{t('acp.firstText')}</dt><dd>{probe.firstTextMs == null ? '—' : (probe.firstTextMs / 1000).toFixed(2) + ' s'}</dd></div></dl>
      </div> : null}
      </> : <div className="acp-empty-state"><span className="acp-empty-icon"><LockKeyhole size={20} aria-hidden="true" /></span><strong>{t('acp.modelsLocked')}</strong><p>{t('acp.emptyModels')}</p><button type="button" className="secondary-button" disabled><Zap size={15} aria-hidden="true" />{t('acp.test')}</button></div>}
    </section>

    <section className="panel surface-panel acp-model-card acp-api-card" aria-labelledby="acp-api-title">
      <div className="acp-section-heading"><div className="acp-section-identity"><span className="acp-section-icon"><Code2 size={17} aria-hidden="true" /></span><div><h2 id="acp-api-title">{t('acp.apiTitle')}</h2><p className="acp-muted">{t('acp.apiDescription')}</p></div></div><span className="acp-connection-status" role="status" data-connected={apiEnabled && connected}><span className="acp-status-dot" data-ready={apiEnabled && connected} aria-hidden="true" />{t(apiEnabled ? connected ? 'acp.apiEnabled' : 'acp.apiWaiting' : 'acp.apiDisabled')}</span></div>
      {connected || apiEnabled ? <><p className="acp-muted">{t(apiEnabled && !connected ? 'acp.apiReconnectHint' : 'acp.apiHint')}</p>
      <div className="acp-api-enable-row">{connected ? <div className="acp-api-summary"><span className="acp-model-total">{status.models.length}</span><div><strong>{t('acp.apiModelsTitle')}</strong><span>{t('acp.apiModelsHint')}</span></div></div> : null}
      <div className="acp-provider-actions"><button type="button" className={apiEnabled ? 'secondary-button' : 'primary-button'}
        disabled={busy || loading || (!status?.upstreamEnabled && !connected)}
        onClick={() => void run('upstream', () => acpApi.setUpstreamEnabled(!status?.upstreamEnabled))}>
        {apiEnabled ? <Unplug size={15} aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}{t(status?.upstreamEnabled ? 'acp.disableApi' : 'acp.enableApi')}
      </button></div></div>
      </> : <div className="acp-empty-state"><span className="acp-empty-icon"><Code2 size={20} aria-hidden="true" /></span><strong>{t('acp.apiLocked')}</strong><p>{t('acp.apiLockedHint')}</p><button type="button" className="secondary-button" disabled><ArrowRight size={15} aria-hidden="true" />{t('acp.enableApi')}</button></div>}
      {apiEnabled && connected ? <details className="acp-api-details"><summary>{t('acp.apiUsageTitle')}<ChevronDown size={14} aria-hidden="true" /></summary><div className="acp-api-details-body">
        <p className="acp-muted">{t('acp.apiUsage')}</p>
        <div className="acp-code-example"><div className="acp-code-heading"><span><b>POST</b><code>/v1/chat/completions</code></span>
        <button type="button" className="secondary-button compact-button" onClick={() => void navigator.clipboard.writeText(example).then(() => setCopied(true)).catch(cause => setError(String(cause)))}><Copy size={14} aria-hidden="true" />{t(copied ? 'acp.exampleCopied' : 'common.copy')}</button>
        </div><pre><code>{example}</code></pre></div>
        <details className="acp-api-model-list"><summary>{t('acp.models')} · {status.models.length}</summary><ul className="acp-api-models">{status.models.map(model => <li key={model.id}><code>{`acp/${model.id}`}</code></li>)}</ul></details>
      </div></details> : null}
      <p className="acp-api-limits">{t('acp.apiLimitsShort')}</p>
    </section></div>

    <details className="acp-footnote"><summary><span><Settings2 size={15} aria-hidden="true" />{t('acp.connectionDetails')}</span><ChevronDown size={15} aria-hidden="true" /></summary><div className="acp-footnote-body">
      <h3>{t('acp.connectionFlow')}</h3><div className="acp-flow"><span><KeyRound size={14} aria-hidden="true" />{t('acp.flowAccount')}</span><ArrowRight size={13} aria-hidden="true" /><span>Antigravity CLI</span><ArrowRight size={13} aria-hidden="true" /><span>CPA API</span></div>
      <h3>{t('acp.cli')}</h3><code>{status?.executable ? privacy.text(status.executable) : t('acp.missing')}</code>
      <h3>{t('acp.currentAccount')}</h3><p>{t('acp.switchHint')}</p>
      {connected ? <div className="acp-relogin"><p>{t('acp.reloginHint')}</p><button type="button" className="secondary-button" disabled={busy || loading} onClick={() => void run('login', () => acpApi.reloginAccount())}><LogIn size={15} aria-hidden="true" />{t('acp.relogin')}</button></div> : null}
      <h3>{t('acp.profile')}</h3><p>{t('acp.profileHint')}</p>
      {status?.profile ? <code>{privacy.text(status.profile)}</code> : null}
      <h3>{t('acp.capabilities')}</h3><p>{t('acp.capabilitiesHint')}</p>
    </div></details>
  </div>;
}
