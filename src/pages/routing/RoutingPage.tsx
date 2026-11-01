import { useCallback, useEffect, useState } from 'react';
import { GitBranch, RefreshCw, Save } from 'lucide-react';
import { useI18n } from '../../i18n';
import { APP_NAVIGATION_REQUEST_EVENT, type AppNavigationRequest } from '../../navigation';
import { applyRoutingPlan, readRoutingBoard, validateRoutingPlan, type RoutingBoard, type RoutingPlan } from '../../services/routing';
import { PolicyStrip } from './PolicyStrip';
import { TierLadder } from './TierLadder';
import './RoutingPage.css';

export function RoutingPage() {
  const { t } = useI18n();
  const [board, setBoard] = useState<RoutingBoard | null>(null);
  const [plan, setPlan] = useState<RoutingPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const dirty = !!board && !!plan && (JSON.stringify(board.settings) !== JSON.stringify(plan.settings) || JSON.stringify(board.members) !== JSON.stringify(plan.members));
  const accept = (value: RoutingBoard) => { setBoard(value); setPlan(structuredClone(value)); setNeedsRefresh(false); };
  const refresh = useCallback(async () => {
    setBusy(true); setError(''); setSaved(false);
    try { accept(await readRoutingBoard()); } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const navigate = (event: Event) => {
      if (busy || (dirty && !window.confirm(t('routing.leave')))) (event as AppNavigationRequest).preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener(APP_NAVIGATION_REQUEST_EVENT, navigate);
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener(APP_NAVIGATION_REQUEST_EVENT, navigate); window.removeEventListener('beforeunload', unload); };
  }, [busy, dirty, t]);
  let valid = false;
  if (board && plan) { try { validateRoutingPlan(board, plan); valid = true; } catch { valid = false; } }
  const apply = async () => {
    if (!plan || busy) return;
    setBusy(true); setError(''); setSaved(false);
    try { accept(await applyRoutingPlan(plan)); setSaved(true); }
    catch (failure) { setError(String(failure)); setNeedsRefresh(true); }
    finally { setBusy(false); }
  };
  const disabled = busy || needsRefresh || !!board?.partial.length;
  return <section className="page routing-page" aria-busy={busy}>
    <header className="routing-heading"><div><h1><GitBranch size={24} />{t('routing.title')}</h1><p>{t('routing.description')}</p></div><div className="routing-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={() => { if (!dirty || window.confirm(t('routing.leave'))) void refresh(); }}><RefreshCw size={15} />{t('routing.refresh')}</button>
      <button type="button" className="button secondary" disabled={!dirty || busy} onClick={() => { if (board) { setPlan(structuredClone(board)); setSaved(false); } }}>{t('routing.reset')}</button>
      <button type="button" className="button primary" disabled={disabled || !dirty || !valid} onClick={() => void apply()}><Save size={15} />{t(busy ? 'routing.saving' : 'routing.apply')}</button>
    </div></header>
    {error && <p role="alert" className="routing-error">{error}</p>}
    {board?.partial.length ? <p role="alert" className="routing-error">{t('routing.partial')} ({board.partial.join(', ')})</p> : null}
    <div role="status" className="routing-status">{saved ? t('routing.saved') : dirty ? t('routing.dirty') : busy ? t('routing.loading') : ''}</div>
    {plan && <><PolicyStrip settings={plan.settings} disabled={disabled} onChange={settings => { setPlan({ ...plan, settings }); setSaved(false); }} />
      <TierLadder members={plan.members} disabled={disabled} weighted={plan.settings.strategy === 'weighted-round-robin'} onChange={members => { setPlan({ ...plan, members }); setSaved(false); }} /></>}
  </section>;
}
