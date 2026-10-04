import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { MessageNotice } from '../appNotice';
import { useDialogFocusTrap } from '../components/useDialogFocusTrap';
import { useI18n } from '../i18n';

const VISIBLE_CLIENTS_KEY = 'cpa-gui.agent-visible-clients.v1';

type Client<Id extends string> = {
  id: Id;
  name: string;
  icon: ReactNode;
  summary: string;
  installed: boolean;
  detected: boolean;
};

function readVisibleClients<Id extends string>(clients: Client<Id>[]): Id[] | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(VISIBLE_CLIENTS_KEY) ?? 'null');
    if (!Array.isArray(value)) return null;
    const known = clients.filter((client) => value.includes(client.id)).map((client) => client.id);
    return known.length ? known : null;
  } catch {
    return null;
  }
}

export function AgentClientList<Id extends string>({
  clients, selected, onSelect, onRefresh, loading, busy, error, onDismissError,
}: {
  clients: Client<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  onRefresh: () => void;
  loading: boolean;
  busy: boolean;
  error: string;
  onDismissError: () => void;
}) {
  const { t } = useI18n();
  const [visibleIds, setVisibleIds] = useState(() => readVisibleClients(clients));
  const [managing, setManaging] = useState(false);
  const [capacity, setCapacity] = useState(1);
  const [page, setPage] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => setManaging(false);
  const [draftIds, setDraftIds] = useState<Id[] | null>(null);
  const [query, setQuery] = useState('');
  // Keep the current client reachable even when detection fails or it was uninstalled.
  const automaticIds = clients.filter((client) => client.detected || client.id === selected)
    .map((client) => client.id);
  const visibleClients = clients.filter((client) => (visibleIds ?? automaticIds).includes(client.id));
  const pageCount = Math.max(1, Math.ceil(visibleClients.length / capacity));
  const currentPage = Math.min(page, pageCount - 1);
  const pageClients = visibleClients.slice(currentPage * capacity, (currentPage + 1) * capacity);
  const selectedIndex = visibleClients.findIndex((client) => client.id === selected);
  const draftSelection = draftIds ?? automaticIds;
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useDialogFocusTrap<HTMLDialogElement>({
    active: managing,
    onEscape: close,
    initialFocusRef: searchRef,
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const resize = () => setCapacity(Math.max(1, Math.floor((list.clientHeight + 4) / 60)));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  // Navigation is a contiguous page of the saved list, never a replacement of its last row.
  // Opening a client or resizing reveals its page; browsing pages does not select a client.
  useLayoutEffect(() => {
    setPage(Math.floor(Math.max(0, selectedIndex) / capacity));
  }, [capacity, selected, selectedIndex]);

  useEffect(() => {
    if (!busy && visibleIds && !visibleIds.includes(selected) && visibleIds.length) {
      onSelect(visibleIds[0]);
    }
  }, [busy, onSelect, selected, visibleIds]);

  useEffect(() => {
    if (managing) dialogRef.current?.showModal();
  }, [dialogRef, managing]);

  const save = () => {
    if (!draftSelection.length) return;
    try {
      if (draftIds === null) window.localStorage.removeItem(VISIBLE_CLIENTS_KEY);
      else window.localStorage.setItem(VISIBLE_CLIENTS_KEY, JSON.stringify(draftIds));
    } catch {
      // Still allow a session-only preference when browser storage is unavailable.
    }
    setVisibleIds(draftIds);
    if (!draftSelection.includes(selected)) {
      const first = clients.find((client) => draftSelection.includes(client.id));
      if (first) onSelect(first.id);
    }
    setManaging(false);
  };

  const matches = clients.filter((client) => client.name.toLowerCase().includes(query.trim().toLowerCase()));

  return <>
    <aside className="panel agent-client-list" aria-label={t('agents.localClients')}>
      <div className="agent-client-list-heading">
        <strong>{t('agents.localClients')}</strong>
        <button type="button" className="icon-button quiet" onClick={onRefresh}
          disabled={loading || busy} title={t('agents.redetect')} aria-label={t('agents.redetect')}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} aria-hidden="true" />
        </button>
      </div>
      {error ? <MessageNotice message={error} onDismiss={onDismissError} /> : null}
      <div className="agent-list-items" ref={listRef}>
        {pageClients.map((client) => <button type="button" key={client.id}
          className={selected === client.id ? 'active' : ''} aria-pressed={selected === client.id}
          onClick={() => onSelect(client.id)} disabled={busy}>
          <span className="agent-client-icon">{client.icon}</span>
          <span><strong title={client.name}>{client.name}</strong><small title={client.summary}>{client.summary}</small></span>
          {client.installed ? <i className="agent-installed-indicator" title={t('agents.clientDetected')} aria-hidden="true" /> : null}
        </button>)}
      </div>
      <div className="agent-client-list-footer">
        <nav className="agent-client-pagination" aria-label={t('agents.clients.pages')}>
          <button type="button" className="icon-button quiet" disabled={busy || currentPage === 0}
            aria-label={t('agents.clients.previous')} title={t('agents.clients.previous')}
            onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} aria-hidden="true" /></button>
          <span aria-live="polite">{t('agents.clients.page', { page: currentPage + 1, total: pageCount })}</span>
          <button type="button" className="icon-button quiet" disabled={busy || currentPage + 1 === pageCount}
            aria-label={t('agents.clients.next')} title={t('agents.clients.next')}
            onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} aria-hidden="true" /></button>
        </nav>
        <small>{t('agents.clients.listed', { count: visibleClients.length })}</small>
        <button type="button" className="secondary-button compact-button" disabled={busy || loading}
          onClick={() => { setDraftIds(visibleIds); setQuery(''); setManaging(true); }}>
          <SlidersHorizontal size={15} aria-hidden="true" />{t('agents.clients.manage')}
        </button>
      </div>
    </aside>
    {managing ? <dialog className="agent-client-manager" ref={dialogRef} aria-labelledby={titleId}
      aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); close(); }}>
      <header>
        <h2 id={titleId}>{t('agents.clients.manage')}</h2>
        <button type="button" className="icon-button quiet" aria-label={t('common.close')} onClick={close}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <p id={descriptionId}>{t('agents.clients.description')}</p>
      <div className="agent-client-search">
        <Search size={16} aria-hidden="true" />
        <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t('agents.clients.search')} aria-label={t('agents.clients.search')} />
      </div>
      <div className="agent-client-catalog">
        {matches.map((client) => <label key={client.id} className="agent-client-option">
          <input type="checkbox" aria-label={client.name} checked={draftSelection.includes(client.id)}
            onChange={(event) => setDraftIds(event.currentTarget.checked
              ? [...draftSelection, client.id] : draftSelection.filter((id) => id !== client.id))} />
          <span className="agent-client-icon">{client.icon}</span>
          <span className="agent-client-option-copy"><strong>{client.name}</strong><small title={client.summary}>{client.summary}</small></span>
        </label>)}
        {!matches.length ? <p role="status">{t('agents.clients.noResults')}</p> : null}
      </div>
      <div className="agent-client-manager-defaults">
        <button type="button" className="secondary-button compact-button" onClick={() => setDraftIds(null)}>
          {t('agents.clients.automatic')}
        </button>
        <small>{t('agents.clients.automaticHint')}</small>
      </div>
      <footer>
        <span role="status">{t(draftSelection.length ? 'agents.clients.selected' : 'agents.clients.minimum', { count: draftSelection.length })}</span>
        <div>
          <button type="button" className="secondary-button" onClick={() => setManaging(false)}>{t('common.cancel')}</button>
          <button type="button" className="primary-button" onClick={save} disabled={!draftSelection.length}>{t('common.save')}</button>
        </div>
      </footer>
    </dialog> : null}
  </>;
}
