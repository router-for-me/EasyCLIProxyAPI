import { useCallback, useEffect, useState } from 'react';
import { GitBranch, RefreshCw, Save } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { useI18n } from '../../i18n';
import { APP_NAVIGATION_REQUEST_EVENT, type AppNavigationRequest } from '../../navigation';
import { applyRoutingPlan, readRoutingBoard, validateRoutingPlan, type RoutingBoard } from '../../services/routing';
import { diffPlan, draftFromBoard, resolveRoute, type RoutingDraft } from './routingPlan';
import { PolicyStrip } from './PolicyStrip';
import { TierLadder } from './TierLadder';
import './RoutingPage.css';

export function RoutingPage() {
  const { t } = useI18n();
  const [board, setBoard] = useState<RoutingBoard | null>(null);
  const [plan, setPlan] = useState<RoutingDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const diff = board && plan ? diffPlan(board, plan) : null;
  const dirty = !!diff?.changes.length;
  const accept = (value: RoutingBoard) => { setBoard(value); setPlan(draftFromBoard(value)); setNeedsRefresh(false); };
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
  let invalidReason = '';
  if (board && diff) {
    try { validateRoutingPlan(board, diff.plan); }
    catch (failure) { invalidReason = failure instanceof Error ? failure.message : String(failure); }
  }
  const apply = async () => {
    if (!diff || busy) return;
    setBusy(true); setError(''); setSaved(false);
    try { accept(await applyRoutingPlan(diff.plan)); setSaved(true); }
    catch (failure) { setError(String(failure)); setNeedsRefresh(true); }
    finally { setBusy(false); }
  };
  const disabled = busy || needsRefresh || !!board?.partial.length;
  const describeChange = (change: NonNullable<typeof diff>['changes'][number]) => {
    const member = board?.members.find(item => item.key === change.key);
      const name = change.kind === 'setting' ? t(`routing.${change.field as keyof RoutingBoard['settings']}`) : (member?.remark || member?.name);
    const field = change.kind === 'priority' ? t('routing.priority') : change.kind === 'weight' ? t('routing.weightIndex', { index: Number(change.field) + 1 }) : '';
    const display = (value: unknown) => typeof value === 'boolean' ? t(value ? 'routing.on' : 'routing.off') : value === null || value === '' ? t('routing.inherited') : value === 'round-robin' || value === 'weighted-round-robin' || value === 'fill-first' ? t(`routing.${value}`) : String(value);
    return { name, field, detail: t('routing.changeDetail', { from: display(change.from), to: display(change.to) }) };
  };
  return <section className="page routing-page" aria-busy={busy}>
    <header className="routing-heading"><div><h1><GitBranch size={24} />{t('routing.title')}</h1><p>{t('routing.description')}</p></div><div className="routing-actions">
      {diff && dirty && <details className="routing-changes"><summary className="routing-summary-pill">{t('routing.changeCount', { count: diff.changes.length })}</summary><div className="routing-change-list">{diff.changes.map((change, index) => { const described = describeChange(change); return <div key={index}><strong>{described.name}</strong><span>{described.field}</span><span>{described.detail}</span></div>; })}</div></details>}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { if (!dirty || window.confirm(t('routing.leave'))) void refresh(); }}><RefreshCw size={15} />{t('routing.refresh')}</button>
      <button type="button" className="secondary-button" disabled={!dirty || busy} onClick={() => { if (board) { setPlan(draftFromBoard(board)); setSaved(false); } }}>{t('routing.reset')}</button>
      <button type="button" className="primary-button" disabled={disabled || !dirty || !!invalidReason} onClick={() => setReviewOpen(true)}><Save size={15} />{t(busy ? 'routing.saving' : 'routing.apply')}</button>
      {dirty && invalidReason && <p className="routing-action-hint" role="status">{invalidReason}</p>}
    </div></header>
    {reviewOpen && diff && <Dialog className="routing-review-dialog" title={t('routing.reviewTitle')} onClose={() => setReviewOpen(false)} closeDisabled={busy}
      actions={<><button type="button" className="secondary-button" disabled={busy} onClick={() => setReviewOpen(false)}>{t('common.cancel')}</button><button type="button" className="primary-button" disabled={busy} onClick={() => { setReviewOpen(false); void apply(); }}><Save size={15} />{t(busy ? 'routing.saving' : 'routing.apply')}</button></>}>
      <p className="routing-review-hint">{t('routing.reviewHint', { count: diff.changes.length })}</p>
      <div className="routing-change-list">{diff.changes.map((change, index) => { const described = describeChange(change); return <div key={index}><strong>{described.name}</strong><span>{described.field}</span><span>{described.detail}</span></div>; })}</div>
    </Dialog>}
    {error && <p role="alert" className="routing-error">{error}</p>}
    {board?.partial.length ? <p role="alert" className="routing-error">{t('routing.partial')} ({board.partial.join(', ')})</p> : null}
    <div role="status" className="routing-status">{saved ? t('routing.saved') : dirty ? t('routing.dirty') : busy ? t('routing.loading') : ''}</div>
    {board && plan && diff && <div className="routing-workspace"><div className="routing-board"><TierLadder board={board} draft={plan} tierPriorities={diff.tierPriorities} preview={resolveRoute(board, plan)} disabled={disabled} onChange={next => { if (diffPlan(board, next)) { setPlan(next); setSaved(false); setError(''); } else setError(t('routing.fixedConflict')); }} /></div>
      <aside className="routing-aside"><PolicyStrip settings={plan.settings} disabled={disabled} onChange={settings => { setPlan({ ...plan, settings }); setSaved(false); }} /></aside>
    </div>}
  </section>;
}
