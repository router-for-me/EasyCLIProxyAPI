import { Notice } from '../components/Notice';
import { getOAuthStatus, startOAuthLogin, openOAuthUrl, submitOAuthCallback } from '../services/oauth';
import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, LoaderCircle, LogIn, X } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { useI18n } from '../i18n';
import { pluginOAuthText, type PluginOAuthMessage } from '../i18n/pluginOAuth';
import { managementApi } from '../services/managementApi';
import type { PluginListEntry } from '../services/plugins';
import './PluginOAuthDialog.css';

type OAuthStart = { url: string; state?: string | null; userCode?: string | null; flow?: string | null; expiresIn?: number | null };
type OAuthStatus = { status: string; error?: string | null };
type Session = { state: string; url: string; code: string; device: boolean; expires: number };
type Phase = 'starting' | 'waiting' | 'success' | 'error';
const MAX_SESSION_MS = 30 * 60 * 1000;

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function PluginOAuthDialog({ plugin, browser = 'default', onClose, onCompleted }: {
  plugin: PluginListEntry;
  browser?: string;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const { t, locale, formatDate } = useI18n();
  const text = (key: PluginOAuthMessage) => pluginOAuthText(key, locale);
  const id = useId();
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhaseState] = useState<Phase>('starting');
  const phaseRef = useRef<Phase>('starting');
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [callback, setCallback] = useState('');
  const [callbackInvalid, setCallbackInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [opening, setOpening] = useState(false);
  const callbackPending = useRef(false);
  const openPending = useRef(false);
  const generation = useRef(0);
  const dismiss = useRef<() => void>(() => {});
  const completedRef = useRef(onCompleted);
  completedRef.current = onCompleted;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const setPhase = (value: Phase) => { phaseRef.current = value; setPhaseState(value); };
  const close = () => { dismiss.current(); onClose(); };
  const provider = plugin.oauthProvider?.trim() ?? '';

  useEffect(() => {
    const currentGeneration = ++generation.current;
    let active = true;
    let terminal = false;
    let completed = false;
    let state = '';
    let pollTimer: number | undefined;
    let expiryTimer: number | undefined;
    const cancelled = new Set<string>();
    const translate = (key: PluginOAuthMessage) => pluginOAuthText(key, localeRef.current);
    const current = () => active && !terminal && generation.current === currentGeneration;
    const clearTimers = () => { window.clearTimeout(pollTimer); window.clearTimeout(expiryTimer); };
    const cancel = (value: string) => {
      if (!value || cancelled.has(value)) return;
      cancelled.add(value);
      void managementApi.delete('/oauth/session', { query: { state: value } }).catch(() => {});
    };
    const stop = () => {
      if (!active) return;
      active = false;
      generation.current += 1;
      clearTimers();
      if (!completed) cancel(state);
    };
    dismiss.current = stop;
    setPhase('starting'); setSession(null); setError(''); setNotice(''); setCallback('');
    setCallbackInvalid(false); setSubmitting(false); setOpening(false);
    callbackPending.current = false; openPending.current = false;
    const fail = (reason: string) => {
      if (!current()) return;
      terminal = true; clearTimers(); setPhase('error'); setError(reason);
      setSubmitting(false); setOpening(false); cancel(state);
    };
    if (!plugin.supportsOAuth || !plugin.effectiveEnabled || !provider) {
      fail(translate('unavailable'));
      return stop;
    }
    const poll = async () => {
      if (!current()) return;
      try {
        const result = await getOAuthStatus({ state });
        if (!current()) return;
        if (result.status === 'ok') {
          completed = true; terminal = true; clearTimers(); setPhase('success');
          setCallback(''); setNotice(''); setError(''); setSubmitting(false); setOpening(false);
          completedRef.current();
        } else if (result.status === 'error') fail(result.error || translate('failed'));
        else if (result.status === 'wait') pollTimer = window.setTimeout(() => void poll(), 3000);
        else fail(translate('failed'));
      } catch (reason) { fail(message(reason)); }
    };
    void startOAuthLogin({ provider, browser: 'none', pluginProvider: true }).then(result => {
      const returnedState = result.state?.trim() ?? '';
      if (!current()) { cancel(returnedState); return; }
      state = returnedState;
      if (!state) { fail(translate('missingState')); return; }
      try {
        const url = new URL(result.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch { fail(translate('invalidUrl')); return; }
      const duration = typeof result.expiresIn === 'number' && Number.isFinite(result.expiresIn) && result.expiresIn > 0
        ? Math.min(result.expiresIn * 1000, MAX_SESSION_MS) : MAX_SESSION_MS;
      const nextSession: Session = { state, url: result.url, code: result.userCode?.trim() ?? '', device: result.flow?.toLowerCase() === 'device' || Boolean(result.userCode), expires: Date.now() + duration };
      setSession(nextSession); setPhase('waiting');
      expiryTimer = window.setTimeout(() => fail(translate('expired')), duration);
      pollTimer = window.setTimeout(() => void poll(), 3000);
    }).catch(reason => fail(message(reason)));
    return stop;
  }, [provider, plugin.supportsOAuth, plugin.effectiveEnabled, attempt]);

  const activeSession = () => Boolean(session && phaseRef.current === 'waiting' && Date.now() < session.expires);
  const copy = async (value: string) => {
    const current = generation.current;
    try { await navigator.clipboard.writeText(value); if (generation.current === current) setNotice(text('copied')); }
    catch (reason) { if (generation.current === current) setError(message(reason)); }
  };
  const open = async () => {
    if (!session || !activeSession() || openPending.current) return;
    const current = generation.current;
    openPending.current = true; setOpening(true); setError('');
    try { await openOAuthUrl({ url: session.url, browser }); }
    catch (reason) { if (generation.current === current && phaseRef.current === 'waiting') setError(message(reason)); }
    finally { if (generation.current === current) { openPending.current = false; setOpening(false); } }
  };
  const submit = async () => {
    if (!session || !activeSession() || callbackPending.current) return;
    const redirectUrl = callback.trim();
    try {
      const url = new URL(redirectUrl);
      if (url.searchParams.get('state') !== session.state || !(url.searchParams.get('code')?.trim() || url.searchParams.get('error')?.trim() || url.searchParams.get('error_description')?.trim())) throw new Error();
    } catch { setCallbackInvalid(true); setError(text('callbackInvalid')); return; }
    const current = generation.current;
    callbackPending.current = true; setSubmitting(true); setCallbackInvalid(false); setError(''); setNotice('');
    try {
      await submitOAuthCallback({ provider, redirectUrl, pluginProvider: true });
      if (generation.current === current && phaseRef.current === 'waiting') setNotice(text('submitted'));
    } catch (reason) { if (generation.current === current && phaseRef.current === 'waiting') setError(message(reason)); }
    finally { if (generation.current === current) { callbackPending.current = false; setSubmitting(false); } }
  };

  return <Dialog className="config-dialog plugin-oauth-dialog" labelledBy={`${id}-title`} onClose={close} dismissOnBackdrop>
    <header className="config-dialog-heading"><div><h2 id={`${id}-title`}><LogIn size={20} />{text('title')}</h2><p>{plugin.metadata?.name || plugin.id}</p></div><button type="button" className="icon-button quiet" onClick={close} aria-label={t('common.close')}><X size={18} /></button></header>
    <div className="plugin-oauth-body">
      <Notice tone={phase === 'error' ? 'error' : phase === 'success' ? 'success' : 'info'} className="plugin-oauth-status" icon={phase === 'starting' || phase === 'waiting' ? <LoaderCircle size={18} className="spin" /> : phase === 'success' ? <CheckCircle2 size={18} /> : undefined}>{text(phase === 'error' ? 'failed' : phase)}</Notice>
      {session && phase === 'waiting' ? <>
        <div className="plugin-oauth-field"><label htmlFor={`${id}-link`}>{text('link')}</label><textarea id={`${id}-link`} rows={3} readOnly value={session.url} spellCheck={false} /></div>
        <div className="plugin-oauth-link-actions"><button type="button" className="primary-button compact-button" disabled={opening} onClick={() => void open()}>{opening ? <LoaderCircle className="spin" size={16} /> : <ExternalLink size={16} />}{text('open')}</button><button type="button" className="secondary-button compact-button" onClick={() => void copy(session.url)}><Copy size={16} />{text('copy')}</button></div>
        {session.code ? <div className="plugin-oauth-code surface-frame surface-muted"><span>{text('code')}</span><strong>{session.code}</strong><p>{text('deviceHint')}</p><button type="button" className="secondary-button compact-button" onClick={() => void copy(session.code)}><Copy size={16} />{text('copyCode')}</button></div> : null}
        {!session.device ? <form onSubmit={event => { event.preventDefault(); void submit(); }} noValidate>
          <div className="plugin-oauth-field"><label htmlFor={`${id}-callback`}>{text('callback')}</label><input id={`${id}-callback`} type="url" value={callback} disabled={submitting} autoComplete="off" spellCheck={false} aria-invalid={callbackInvalid} aria-describedby={`${id}-callback-hint`} onChange={event => { setCallback(event.currentTarget.value); setCallbackInvalid(false); setError(''); setNotice(''); }} /><small id={`${id}-callback-hint`}>{text('callbackHint')}</small></div>
          <button type="submit" className="secondary-button compact-button" disabled={submitting || !callback.trim()}>{submitting ? <LoaderCircle className="spin" size={16} /> : null}{text(submitting ? 'submitting' : 'submit')}</button>
        </form> : null}
        <p className="plugin-oauth-expiry">{text('expires')} {formatDate(session.expires, { hour: '2-digit', minute: '2-digit' })}</p>
      </> : null}
      {error ? <Notice tone="error" variant="text">{error}</Notice> : null}
      {notice ? <Notice tone="success" variant="text">{notice}</Notice> : null}
    </div>
    <footer className="plugin-oauth-footer"><button type="button" className="secondary-button compact-button" onClick={close}>{t(phase === 'success' ? 'common.close' : 'common.cancel')}</button>{phase === 'error' ? <button type="button" className="primary-button compact-button" onClick={() => setAttempt(value => value + 1)}>{text('retry')}</button> : null}</footer>
  </Dialog>;
}
