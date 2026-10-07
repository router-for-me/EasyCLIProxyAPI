import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Check, ChevronRight, Circle, LoaderCircle, Play, RefreshCw, Search, Square, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { useDialogFocusTrap } from '../components/useDialogFocusTrap';
import {
  checkCoreModelsHealth,
  type CoreHealthModel,
  type CoreModelHealthResult,
} from '../services/coreHealthCheck';
import './CoreHealthPanel.css';

type CheckedResult = CoreModelHealthResult & { checkedAt: number };

export type CoreHealthPanelProps = {
  coreReady: boolean;
  models: CoreHealthModel[];
  modelsLoading: boolean;
  modelsError: string;
  onRefreshModels: () => void;
  contextKey?: string;
  compact?: boolean;
};

export function CoreHealthPanel({
  coreReady, models, modelsLoading, modelsError, onRefreshModels, contextKey, compact = false,
}: CoreHealthPanelProps) {
  const { t, formatDate, formatNumber } = useI18n();
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Record<string, CheckedResult>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const modelIds = JSON.stringify(models.map((model) => model.name));
  const canCheck = coreReady && !modelsLoading && !modelsError && models.length > 0;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.abort();
    setResults({});
    setPending(new Set());
    setActive(new Set());
    setProgress({ done: 0, total: 0 });
    setStopped(false);
  }, [coreReady, contextKey, modelIds]);

  const runChecks = useCallback(async (targets: CoreHealthModel[]) => {
    if (!open || !canCheck || controllerRef.current || targets.length === 0) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setStopped(false);
    setProgress({ done: 0, total: targets.length });
    setPending(new Set(targets.map((model) => model.name)));
    setActive(new Set());
    try {
      await checkCoreModelsHealth(targets, (result) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        setResults((current) => ({ ...current, [result.model]: { ...result, checkedAt: Date.now() } }));
        setPending((current) => { const next = new Set(current); next.delete(result.model); return next; });
        setActive((current) => { const next = new Set(current); next.delete(result.model); return next; });
        setProgress((current) => ({ ...current, done: current.done + 1 }));
      }, controller.signal, (model) => {
        if (!controller.signal.aborted) setActive((current) => new Set(current).add(model.name));
      });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (mountedRef.current) {
        setRunning(false);
        setPending(new Set());
        setActive(new Set());
      }
    }
  }, [canCheck, open]);

  const stopChecks = () => {
    controllerRef.current?.abort();
    setStopped(true);
    setPending(new Set());
    setActive(new Set());
  };

  const close = () => {
    if (controllerRef.current) stopChecks();
    setOpen(false);
  };
  const dialogRef = useDialogFocusTrap<HTMLElement>({ active: open, onEscape: close });

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return models.filter((model) => `${model.name} ${model.displayName ?? ''}`.toLocaleLowerCase().includes(query));
  }, [models, search]);
  const healthy = Object.values(results).filter((result) => result.success).length;
  const failed = Object.values(results).filter((result) => !result.success).length;
  const time = (value: number) => formatDate(value, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const latency = (value?: number) => value === undefined ? '—' : `${formatNumber(value)} ms`;

  const summary = t('home.health.summary', { healthy, failed, unchecked: Math.max(0, models.length - healthy - failed) });
  const dialog = (
    <div className="config-dialog-backdrop core-health-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        event.preventDefault();
        close();
      }
    }}>
    <section ref={dialogRef} id={dialogId} className="core-health-panel core-health-dialog" role="dialog" aria-modal="true" aria-labelledby={`${dialogId}-title`} aria-describedby={`${dialogId}-description`} tabIndex={-1}>
      <button type="button" className="icon-button quiet core-health-close" onClick={close} aria-label={t('common.close')} title={t('common.close')}><X size={18} aria-hidden="true" /></button>
      <div className="core-health-heading">
        <div className="core-health-title">
          <span className="core-health-icon"><Activity size={19} aria-hidden="true" /></span>
          <div><h2 id={`${dialogId}-title`}>{t('home.health.title')}</h2><p id={`${dialogId}-description`}>{t('home.health.description')}</p></div>
        </div>
        <div className="core-health-actions">
          <button className="secondary-button" onClick={onRefreshModels} disabled={!coreReady || modelsLoading || running}>
            <RefreshCw size={14} className={modelsLoading ? 'spin' : undefined} aria-hidden="true" />{t('home.health.refresh')}
          </button>
          {running ? <button className="secondary-button" onClick={stopChecks} disabled={stopped}>
            <Square size={13} aria-hidden="true" />{t('home.health.stop')}
          </button> : <button className="primary-button" disabled={!canCheck} onClick={() => { void runChecks(models); }}>
            <Play size={13} aria-hidden="true" />{t('home.health.checkAll')}
          </button>}
        </div>
      </div>

      <div className="core-health-toolbar">
        <label className="core-health-search"><Search size={15} aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder={t('apiAccess.health.search')} aria-label={t('apiAccess.health.search')} /></label>
      </div>

      <div className="core-health-overview" aria-live="polite">
        <span className="core-health-summary"><span className="core-health-summary-dot" />{summary}</span>
        <span>{stopped ? t('home.health.stopped') : progress.total ? t('home.health.progress', progress) : t('home.health.idle')}</span>
      </div>
      {running && !stopped && <div className="core-health-progress" role="progressbar" aria-label={t('home.health.title')} aria-valuenow={progress.done} aria-valuemax={progress.total}><span style={{ width: `${progress.total ? progress.done / progress.total * 100 : 0}%` }} /></div>}

      {!coreReady ? <div className="core-health-empty"><Activity size={22} aria-hidden="true" /><p>{t('home.health.offline')}</p></div>
        : modelsLoading && models.length === 0 ? <div className="core-health-empty"><LoaderCircle size={22} className="spin" aria-hidden="true" /><p>{t('apiAccess.health.loadingModels')}</p></div>
          : modelsError ? <div className="core-health-empty core-health-error" role="alert"><p>{t('home.health.loadError', { error: modelsError })}</p></div>
            : filtered.length === 0 ? <div className="core-health-empty"><p>{t(models.length ? 'apiAccess.health.noMatch' : 'home.health.empty')}</p></div>
              : <div className="core-health-table-wrap">
                <table className="core-health-table">
                  <thead><tr><th>{t('home.health.model')}</th><th>{t('home.health.status')}</th><th>{t('home.health.latency')}</th><th>{t('home.health.checkedAt')}</th><th><span className="core-health-sr-only">{t('home.health.checkAll')}</span></th></tr></thead>
                  <tbody>{filtered.map((model) => {
                    const result = results[model.name];
                    const checking = active.has(model.name);
                    const queued = pending.has(model.name) && !checking;
                    const status = checking ? 'checking' : queued ? 'queued' : result?.status ?? 'idle';
                    const statusText = checking ? t('apiAccess.health.checking') : queued ? t('home.health.queued') : !result ? t('apiAccess.health.notChecked') : t(result.success ? 'apiAccess.health.healthy' : 'apiAccess.health.failed');
                    const error = !checking && !queued && result && !result.success ? (result.timedOut ? t('apiAccess.health.timeout') : result.error) : '';
                    return <tr key={model.name}>
                      <td><strong className="core-health-model-name" title={model.name}>{model.name}</strong>{error && <details className="core-health-model-error"><summary>{t('apiAccess.health.failed')}</summary><p>{error}</p></details>}</td>
                      <td><span className={`core-health-status ${status}`}>{checking ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : result?.success && !queued ? <Check size={12} aria-hidden="true" /> : result && !queued ? <X size={12} aria-hidden="true" /> : <Circle size={8} aria-hidden="true" />}{statusText}</span></td>
                      <td className="core-health-latency">{result?.success && !pending.has(model.name) ? <>{latency(result.firstTokenLatencyMs)}<span> / {latency(result.responseLatencyMs)}</span></> : '—'}</td>
                      <td className="core-health-time">{result ? <time dateTime={new Date(result.checkedAt).toISOString()} title={formatDate(result.checkedAt)}>{time(result.checkedAt)}</time> : '—'}</td>
                      <td><button className="core-health-row-check" disabled={!canCheck || running} onClick={() => { void runChecks([model]); }} title={t('home.health.checkOne', { model: model.name })} aria-label={t('home.health.checkOne', { model: model.name })}><Play size={13} aria-hidden="true" /></button></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>}
      <div className="core-health-footer"><span>{t('home.health.hint')}</span></div>
    </section>
    </div>
  );

  return (
    <>
      <div className={`core-health-entry${compact ? ' compact' : ''}`}>
        <button type="button" className="secondary-button core-health-open" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId} aria-describedby={`${dialogId}-entry-status`} title={summary}>
          <Activity size={16} aria-hidden="true" /><span>{t('home.health.title')}</span>{!compact && <ChevronRight size={14} aria-hidden="true" />}
        </button>
        <span id={`${dialogId}-entry-status`} className="core-health-entry-status" aria-live="polite">{!coreReady ? t('home.health.offline') : healthy + failed > 0 ? summary : t('home.health.idle')}</span>
      </div>
      {open && typeof document !== 'undefined' ? createPortal(dialog, document.body) : null}
    </>
  );
}
