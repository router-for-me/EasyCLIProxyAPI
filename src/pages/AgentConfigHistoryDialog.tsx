import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { History, LoaderCircle, X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import './AgentConfigHistoryDialog.css';

type Version = { id: string; createdAt: string; source: string; model: string | null; fileCount: number };
type Listing = { versions: Version[]; warnings: string[] };
type Preview = { revision: string; differences: { file: string; field: string; before: string; after: string }[] };
const sourceKeys: Record<string, MessageKey> = {
  'plugin-install': 'agents.pi.install', 'plugin-update': 'agents.pi.update', 'plugin-remove': 'agents.pi.uninstall',
  update: 'agents.history.source.update', default: 'agents.history.source.default',
  clear: 'agents.history.source.clear', restore: 'agents.history.source.restore',
  sync: 'agents.history.source.sync', legacy: 'agents.history.source.legacy',
};

export function AgentConfigHistoryDialog({ client, onClose, onRestored }: {
  client: string; onClose: () => void; onRestored: () => Promise<void>;
}) {
  const { t, formatDate } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [listing, setListing] = useState<Listing>({ versions: [], warnings: [] });
  const [selected, setSelected] = useState<Version | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    dialog.current?.showModal();
    void invoke<Listing>('list_agent_config_history', { client })
      .then((value) => { if (!disposed) setListing(value); })
      .catch((cause) => { if (!disposed) setError(String(cause)); })
      .finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [client]);
  const choose = async (version: Version) => {
    setBusy(true); setError(''); setSelected(version); setPreview(null);
    try { setPreview(await invoke<Preview>('preview_agent_config_history', { client, id: version.id })); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    if (!selected || !preview) return;
    setBusy(true); setError('');
    try {
      await invoke('restore_agent_config_history', { client, id: selected.id, revision: preview.revision });
      await onRestored(); onClose();
    } catch (cause) { setError(String(cause)); setPreview(null); }
    finally { setBusy(false); }
  };
  const source = (value: string) => {
    const before = value.startsWith('before-');
    const label = t(sourceKeys[before ? value.slice(7) : value] ?? 'agents.history.source.update');
    return before ? t('agents.history.before', { source: label }) : label;
  };
  return <dialog className="agent-history-modal" ref={dialog} aria-labelledby="agent-history-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id="agent-history-title"><History size={20} />{t('agents.history.button')}</h2>
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy} aria-label={t('common.cancel')}><X size={18} /></button></header>
    <p>{t('agents.history.description')}</p>
    {listing.warnings.map((warning) => <p key={warning} className="agent-inline-message warning">{warning}</p>)}
    <div className="agent-history-columns">
      <nav aria-label={t('agents.history.versions')}>
        {!listing.versions.length && !busy && <p>{t('agents.history.empty')}</p>}
        {listing.versions.map((version) => <button type="button" key={version.id} disabled={busy} className={selected?.id === version.id ? 'active' : ''} onClick={() => void choose(version)}>
          <strong>{formatDate(version.createdAt, { dateStyle: 'short', timeStyle: 'medium' })}</strong>
          <span>{source(version.source)}</span>
          <small>{version.model ?? '—'} · {t('agents.history.files', { count: version.fileCount })}</small>
        </button>)}
      </nav>
      <section className="agent-history-changes" aria-label={t('agents.history.preview')}>
        {busy ? <p role="status"><LoaderCircle size={16} className="spin" /> {t('agents.history.loading')}</p> : !preview ? <p>{t('agents.history.select')}</p> : preview.differences.length === 0 ? <p>{t('agents.history.unchanged')}</p> :
          <table><thead><tr><th>{t('agents.history.field')}</th><th>{t('agents.history.current')}</th><th>{t('agents.history.target')}</th></tr></thead>
            <tbody>{preview.differences.map((diff) => <tr key={`${diff.file}:${diff.field}`}><td><small title={diff.file}>{diff.file.split(/[\\/]/).pop()}</small><code>{diff.field}</code></td><td>{diff.before}</td><td>{diff.after}</td></tr>)}</tbody></table>}
      </section>
    </div>
    {error && <p className="agent-inline-message error" role="alert">{error}</p>}
    <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      <button type="button" className="primary-button" disabled={busy || !preview || !preview.differences.length} onClick={() => void restore()}>{t('agents.history.restore')}</button></footer>
  </dialog>;
}
