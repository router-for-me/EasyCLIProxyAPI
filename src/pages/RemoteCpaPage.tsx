import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CpaTargetSwitcher } from '../components/CpaTargetSwitcher';
import { Dialog } from '../components/Dialog';
import { requestAppNavigation } from '../navigation';
import { useI18n } from '../i18n';
import {
  forgetCpaInstance, remoteCpaErrorKey, selectCpaConnection, type CpaConnection,
} from '../services/remoteCpa';
import './RemoteCpaPage.css';

export function CpaConnectionDialog({ initialEndpoint, connection, close, onChange }: {
  initialEndpoint: string; connection: CpaConnection; close: () => void; onChange: (connection: CpaConnection) => void;
}) {
  const { t } = useI18n();
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const task = useRef(false);
  const [error, setError] = useState<string>();
  const endpointHelpId = useId();
  const managementHelpId = useId();
  const endpointRef = useRef<HTMLInputElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const changing = Boolean(initialEndpoint);
  const [confirmForget, setConfirmForget] = useState(false);
  async function forget() {
    if (!confirmForget) { setConfirmForget(true); return; }
    if (task.current) return;
    task.current = true;
    setBusy(true);
    try { onChange(await forgetCpaInstance(connection.revision, initialEndpoint)); close(); }
    catch (failure) { setError(remoteCpaErrorKey(failure)); }
    finally { task.current = false; setBusy(false); }
  }

  useEffect(() => {
    if (error) noticeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  async function submit() {
    if (task.current || !endpoint.trim()) return;
    task.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const selected = await selectCpaConnection({ revision: connection.revision, remote: true, endpoint, key });
      onChange(selected);
      close();
    } catch (failure) {
      setError(remoteCpaErrorKey(failure));
    } finally {
      task.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog as="form" onSubmit={event => { event.preventDefault(); void submit(); }}
      title={t(changing ? 'remote.changeServer' : 'remote.connect')}
      className="config-dialog cpa-connection-dialog"
      initialFocusRef={endpointRef}
      onClose={close} closeDisabled={busy} busy={busy}
      actionsClassName="cpa-connection-footer"
      actions={<>
        {changing && initialEndpoint !== connection.endpoint ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void forget()}>{t(confirmForget ? 'remote.confirmForget' : 'remote.forget')}</button> : null}
        <button type="button" className="secondary-button" disabled={busy} onClick={close}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="primary-button" disabled={busy || !endpoint.trim()}>
          {t(busy ? 'remote.verifying' : changing ? 'remote.verifySwitch' : 'remote.verifyConnect')}
        </button>
      </>}
    >
      <div className="cpa-connection-form">
        <div className="cpa-connection-field">
          <label htmlFor={`${endpointHelpId}-input`}>{t('remote.endpoint')}</label>
          <input ref={endpointRef} id={`${endpointHelpId}-input`} aria-describedby={endpointHelpId} className="config-dialog-text-input"
            value={endpoint} disabled={busy} maxLength={2048} autoComplete="off" spellCheck={false}
            placeholder="http://127.0.0.1:8317" onChange={e => { setEndpoint(e.target.value); setKey(''); setError(undefined); }} />
          <p id={endpointHelpId} className="cpa-connection-hint">{t('remote.endpointHint')}</p>
        </div>
        <div className="cpa-connection-field">
          <label htmlFor={`${managementHelpId}-input`}>{t('remote.managementKey')}</label>
          <input id={`${managementHelpId}-input`} className="config-dialog-text-input"
            type="password" value={key} disabled={busy} maxLength={1024} autoComplete="new-password"
            placeholder={connection.savedEndpoints?.includes(endpoint) ? t('remote.savedKey') : undefined}
            onChange={e => { setKey(e.target.value); setError(undefined); }} />
        </div>
        {error ? <p ref={noticeRef} role="alert" className="cpa-error">{t(error)}</p> : null}
      </div>
    </Dialog>
  );
}

function RemoteDecision({ title, confirm, cancel, onClose, onConfirm, busy, children }: {
  title: string; confirm: string; cancel?: string; onClose: () => void; onConfirm: () => void;
  busy?: boolean; children: ReactNode;
}) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog alert title={title} className="config-dialog cpa-connection-dialog" initialFocusRef={cancelRef}
      onClose={onClose} closeDisabled={busy} busy={busy} actionsClassName="cpa-connection-footer"
      actions={<>
        <button ref={cancelRef} type="button" className="secondary-button" disabled={busy} onClick={onClose}>
          {cancel ?? t('common.cancel')}
        </button>
        <button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>{confirm}</button>
      </>}>
      <div className="cpa-connection-form">{children}</div>
    </Dialog>
  );
}

export function CpaWorkspaceTarget({ connection, openConnection, onChange, children }: {
  children: (switcher: ReactNode) => ReactNode;
  connection: CpaConnection; openConnection: (endpoint?: string) => void; onChange: (connection: CpaConnection) => void;
}) {
  const { t } = useI18n();
  const [decision, setDecision] = useState<'local'>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const task = useRef(false);
  function choose(next: 'change' | 'local') {
    if (task.current) return;
    requestAppNavigation(() => { if (next === 'change') openConnection(); else setDecision('local'); });
  }

  async function selectLocal() {
    if (task.current) return;
    task.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const selected = await selectCpaConnection({ revision: connection.revision, remote: false, endpoint: '', key: '' });
      setDecision(undefined);
      onChange(selected);
    } catch (failure) {
      setError(remoteCpaErrorKey(failure));
    } finally {
      task.current = false;
      setBusy(false);
    }
  }

  const saved = { endpoints: connection.savedEndpoints ?? [], onPick: (endpoint: string) => requestAppNavigation(() => openConnection(endpoint)) };
  const close = () => { setDecision(undefined); setError(undefined); };
  return (
    <>
      {children(connection.remoteActive ? <CpaTargetSwitcher {...saved} remote endpoint={connection.endpoint} disabled={busy}
        onChangeServer={() => choose('change')} onReturnLocal={() => choose('local')} /> : <CpaTargetSwitcher {...saved} onConnect={() => requestAppNavigation(openConnection)} />)}
      {decision === 'local' ? <RemoteDecision key="return-local" title={t('remote.returnLocal')} confirm={t('remote.returnLocal')}
        onClose={close} onConfirm={() => void selectLocal()} busy={busy}>
        <p>{t('remote.returnConfirm')}</p>
        {error ? <p role="alert" className="cpa-error">{t(error)}</p> : null}
      </RemoteDecision> : null}
    </>
  );
}
