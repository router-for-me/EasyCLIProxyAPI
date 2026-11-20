import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { KeyRound, ServerCog } from 'lucide-react';
import appLogo from '../assets/logo.jpg';
import { CpaTargetSwitcher } from '../components/CpaTargetSwitcher';
import { Dialog } from '../components/Dialog';
import { useI18n } from '../i18n';
import {
  canManageRemoteCpa, cpaConnectionPending, getRemoteCpaKeys, parseClientKeys, remoteCpaErrorKey,
  saveRemoteCpaKeys, selectCpaConnection, type CpaConnection, type RemoteKeys,
} from '../services/remoteCpa';
import './RemoteCpaPage.css';

export function CpaConnectionDialog({ connection, close, onChange }: {
  connection: CpaConnection; close: () => void; onChange: (connection: CpaConnection) => void;
}) {
  const { t } = useI18n();
  const [endpoint, setEndpoint] = useState(connection.endpoint ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const task = useRef(false);
  const [error, setError] = useState<string>();
  const endpointHelpId = useId();
  const managementHelpId = useId();
  const endpointRef = useRef<HTMLInputElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const changing = connection.remoteActive;

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
        <button type="button" className="secondary-button" disabled={busy} onClick={() => {
          close();
          if (error === 'remote.error.localRunning') {
            requestAnimationFrame(() => document.getElementById('home-cpa-runtime')?.focus());
          }
        }}>
          {t(error === 'remote.error.localRunning' ? 'remote.backToRuntime' : 'common.cancel')}
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
          <input id={`${managementHelpId}-input`} aria-describedby={managementHelpId} className="config-dialog-text-input"
            type="password" value={key} disabled={busy} maxLength={1024} autoComplete="new-password"
            placeholder={endpoint === connection.endpoint ? t('remote.savedKey') : undefined}
            onChange={e => { setKey(e.target.value); setError(undefined); }} />
          <p id={managementHelpId} className="cpa-connection-hint">{t('remote.managementHint')}</p>
        </div>
        <p className="cpa-connection-hint">{t('remote.httpHint')}</p>
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

export function RemoteCpaPage({ connection, openConnection, onChange }: {
  connection: CpaConnection; openConnection: () => void; onChange: (connection: CpaConnection) => void;
}) {
  const { t } = useI18n();
  const pending = cpaConnectionPending(connection);
  const [editor, setEditor] = useState({ dirty: false, busy: false });
  const [discardRequest, discard] = useState(0);
  const [editFocusRequest, requestEditFocus] = useState(0);
  const [decision, setDecision] = useState<'change' | 'local' | 'discard-change' | 'discard-local'>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const task = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [pending]);

  function choose(next: 'change' | 'local') {
    if (editor.busy || task.current) return;
    if (editor.dirty) {
      setDecision(next === 'change' ? 'discard-change' : 'discard-local');
      return;
    }
    discard(value => value + 1);
    if (next === 'change') openConnection();
    else setDecision('local');
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

  const close = () => { setDecision(undefined); setError(undefined); };
  const continueEditing = () => { close(); requestEditFocus(value => value + 1); };
  return (
    <main className="cpa-remote-workspace">
      <div className="cpa-remote-brand"><img src={appLogo} alt="" />EasyCLIProxyAPI</div>
      <header className="cpa-remote-header">
        <h1 ref={heading} tabIndex={-1}>{t(pending ? 'remote.restartTitle' : 'remote.remote')}</h1>
        {!pending ? <CpaTargetSwitcher remote endpoint={connection.endpoint} disabled={editor.busy || busy}
          onChangeServer={() => choose('change')} onReturnLocal={() => choose('local')} /> : null}
      </header>
      {pending ? (
        <section className="panel surface-panel cpa-remote-panel" role="status">
          <h2><ServerCog size={18} aria-hidden="true" />{t(connection.remoteSelected ? 'remote.savedRemote' : 'remote.savedLocal')}</h2>
          {connection.endpoint ? <p className="cpa-target">{connection.endpoint}</p> : null}
          <p>{t(connection.remoteSelected ? 'remote.restartRemote' : 'remote.restartLocal')}</p>
          {connection.remoteSelected ? <div className="cpa-connection-actions">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void selectLocal()}>{t('remote.keepLocal')}</button>
          </div> : null}
          {error ? <p role="alert" className="cpa-error">{t(error)}</p> : null}
        </section>
      ) : <>
        {connection.needsRepair ? <p role="alert" className="cpa-error">{t('remote.error.profileInvalid')}</p> : null}
        {canManageRemoteCpa(connection) ? <RemoteKeySettings key={connection.revision} revision={connection.revision}
          endpoint={connection.endpoint!} setEditor={setEditor} discardRequest={discardRequest} editFocusRequest={editFocusRequest} /> : null}
        <p className="cpa-connection-hint">{t('remote.scope')}</p>
      </>}
      {decision === 'local' ? <RemoteDecision key="return-local" title={t('remote.returnLocal')} confirm={t('remote.returnLocal')}
        onClose={close} onConfirm={() => void selectLocal()} busy={busy}>
        <p>{t('remote.returnConfirm')}</p>
        {error ? <p role="alert" className="cpa-error">{t(error)}</p> : null}
      </RemoteDecision> : decision ? <RemoteDecision key="discard-draft" title={t('remote.unsavedTitle')} confirm={t('remote.discardContinue')}
        cancel={t('remote.continueEditing')} onClose={continueEditing} onConfirm={() => {
          discard(value => value + 1);
          if (decision === 'discard-change') { close(); openConnection(); }
          else setDecision('local');
        }}>
        <p>{t('remote.unsavedHint')}</p>
      </RemoteDecision> : null}
    </main>
  );
}

function RemoteKeySettings({ revision, endpoint, setEditor, discardRequest, editFocusRequest }: {
  revision: number; endpoint: string; setEditor: (editor: { dirty: boolean; busy: boolean }) => void; discardRequest: number; editFocusRequest: number;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<RemoteKeys>();
  const [draft, setDraft] = useState<string>();
  const [revealed, setRevealed] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const previousDiscard = useRef(discardRequest);
  const previousEditFocus = useRef(editFocusRequest);
  const [recovery, setRecovery] = useState<'reload' | 'review'>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ key: string; isError: boolean }>();
  const task = useRef(false);
  const alive = useRef(true);
  const loadRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const latestRef = useRef<HTMLTextAreaElement>(null);
  const reloadRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<typeof loadRef | typeof draftRef>(null);
  const editing = draft !== undefined;
  const latest = snapshot?.keys.join('\n');
  const parsed = parseClientKeys(draft ?? '');
  const dirty = editing && (Boolean(recovery) || parsed.join('\n') !== latest);
  const existingKeys = new Set(snapshot?.keys);
  const nextKeys = new Set(parsed);
  const added = [...nextKeys].filter(key => !existingKeys.has(key)).length;
  const removed = [...existingKeys].filter(key => !nextKeys.has(key)).length;
  useLayoutEffect(() => { setEditor({ dirty, busy }); }, [setEditor, dirty, busy]);
  useLayoutEffect(() => {
    if (previousDiscard.current === discardRequest) return;
    previousDiscard.current = discardRequest;
    setDraft(undefined);
    setRecovery(undefined);
    setRevealed(false);
    setNotice(undefined);
  }, [discardRequest]);
  useLayoutEffect(() => {
    if (busy) return;
    focusNext.current?.current?.focus();
    focusNext.current = null;
  });
  useEffect(() => {
    alive.current = true;
    void load(false);
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (previousEditFocus.current === editFocusRequest) return;
    previousEditFocus.current = editFocusRequest;
    draftRef.current?.focus();
  }, [editFocusRequest]);

  async function load(focus = true, recovering = recovery === 'reload') {
    if (task.current) return;
    task.current = true;
    setBusy(true);
    setNotice(undefined);
    setSnapshot(undefined);
    try {
      const next = await getRemoteCpaKeys(revision);
      if (!alive.current) return;
      setSnapshot(next);
      if (recovering) setRecovery('review');
      if (focus) focusNext.current = recovering ? latestRef : editRef;
    } catch (error) {
      if (!alive.current) return;
      setNotice({ key: remoteCpaErrorKey(error), isError: true });
      if (focus) focusNext.current = recovering ? reloadRef : loadRef;
    } finally {
      task.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function save() {
    if (task.current || !snapshot || draft === undefined || recovery) return;
    task.current = true;
    setBusy(true);
    setNotice(undefined);
    // Once an attempt starts, a rejected or ambiguous response must never
    // reuse the old token. Keep the captured draft tied to this revision.
    setSnapshot(undefined);
    try {
      await saveRemoteCpaKeys({ revision, snapshot: snapshot.snapshot, keys: parsed });
      if (!alive.current) return;
      setDraft(undefined);
      setRevealed(false);
      try {
        const current = await getRemoteCpaKeys(revision);
        if (!alive.current) return;
        setSnapshot(current);
        setNotice({ key: 'remote.keysSaved', isError: false });
        focusNext.current = editRef;
      } catch {
        if (!alive.current) return;
        setNotice({ key: 'remote.keysReadbackFailed', isError: false });
        focusNext.current = loadRef;
      }
    } catch (error) {
      if (!alive.current) return;
      setRecovery('reload');
      setNotice({ key: remoteCpaErrorKey(error), isError: true });
      focusNext.current = reloadRef;
    } finally {
      task.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function cancel() {
    focusNext.current = snapshot ? editRef : loadRef;
    setDraft(undefined);
    setRecovery(undefined);
    setRevealed(false);
    setNotice(undefined);
    if (!snapshot) void load(true, false);
  }

  function review() {
    focusNext.current = draftRef;
    setRecovery(undefined);
  }

  return (
    <section className="panel surface-panel cpa-remote-panel" aria-busy={busy}>
      <h2><KeyRound size={18} aria-hidden="true" />{t('remote.keysTitle')}</h2>
      <p>{t('remote.keysHint')}</p>
      {snapshot && !editing ? <>
        <p>{t('remote.keysCount', { count: snapshot.keys.length })}</p>
        {snapshot.keys.length ? <ul className="cpa-key-list">
          {snapshot.keys.map((clientKey, index) => <li key={index}>
            <span>{t('remote.keyNumber', { index: index + 1 })}</span>
            <code>{revealed ? clientKey : '••••••••••••'}</code>
          </li>)}
        </ul> : <p>{t('remote.keysEmpty')}</p>}
      </> : !editing && busy ? <p role="status">{t('remote.loadingKeys')}</p> : null}
      {recovery === 'review' ? (
        <label className="cpa-connection-field">
          <span>{t('remote.keysLatest')}</span>
          <textarea ref={latestRef} rows={4} readOnly spellCheck={false} value={latest ?? ''} />
        </label>
      ) : null}
      {editing ? <>
        <label className="cpa-connection-field">
          <span>{t('remote.keysLines')}</span>
          <textarea ref={draftRef} rows={6} autoComplete="off" spellCheck={false} autoCapitalize="off" value={draft} maxLength={524288}
            readOnly={busy} onChange={e => setDraft(e.target.value)} />
        </label>
        <p>{t(recovery === 'review' ? 'remote.keysReview' : recovery === 'reload' ? 'remote.keysRecovery' : 'remote.keysWarning')}</p>
      </> : null}
      {notice ? <p role={notice.isError ? 'alert' : 'status'} className={notice.isError ? 'cpa-error' : ''}>{t(notice.key)}</p> : null}
      <div className="cpa-connection-actions">
        {!editing ? <>
          {snapshot ? <>
            {snapshot.keys.length ? <button type="button" className="secondary-button" aria-pressed={revealed}
              onClick={() => setRevealed(value => !value)}>{t(revealed ? 'remote.hideKeys' : 'remote.revealKeys')}</button> : null}
            <button ref={editRef} type="button" className="primary-button" disabled={busy} onClick={() => {
              setRevealed(false);
              setNotice(undefined);
              focusNext.current = draftRef;
              setDraft(latest);
            }}>{t('remote.editKeys')}</button>
          </> : busy ? null : <button ref={loadRef} type="button" className="secondary-button" onClick={() => void load()}>
            {t('remote.retryKeys')}
          </button>}
        </> : <>
          <button type="button" className="secondary-button" disabled={busy} onClick={cancel}>{t('remote.discardKeyDraft')}</button>
          {recovery === 'reload' ? (
            <button ref={reloadRef} type="button" className="primary-button" disabled={busy} onClick={() => void load()}>{t(busy ? 'remote.working' : 'remote.reloadKeys')}</button>
          ) : recovery === 'review' ? (
            <button type="button" className="primary-button" onClick={review}>{t('remote.reviewedKeys')}</button>
          ) : (
            <button type="button" className="primary-button" disabled={busy || !snapshot || !parsed.length || !dirty}
              onClick={() => { if (removed) setConfirmRemoval(true); else void save(); }}>{t(busy ? 'remote.working' : 'remote.saveKeys')}</button>
          )}
        </>}
      </div>
      {confirmRemoval ? <RemoteDecision title={t('remote.removeTitle')} confirm={t('remote.saveKeys')}
        onClose={() => setConfirmRemoval(false)} onConfirm={() => { setConfirmRemoval(false); void save(); }}>
        <p className="cpa-target">{endpoint}</p>
        <p>{t('remote.removeCounts', { added, removed })}</p>
      </RemoteDecision> : null}
    </section>
  );
}
