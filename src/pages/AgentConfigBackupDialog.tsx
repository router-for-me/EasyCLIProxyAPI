import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArchiveRestore, LoaderCircle, X } from 'lucide-react';
import { useI18n } from '../i18n';
import './AgentConfigBackupDialog.css';

type FileSummary = { path: string; exists: boolean | null; size: number | null };
type Version = { id: string; createdAt: string | null; fileCount: number; location: string; files: FileSummary[]; restorable: boolean; error: string | null };
type Listing = { versions: Version[] };
type Preview = { revision: string; files: FileSummary[]; differences: { file: string; field: string; before: string; after: string }[] };

export function AgentConfigBackupDialog({ client, onClose, onRestored }: {
  client: string; onClose: () => void; onRestored: () => Promise<void>;
}) {
  const { t, formatDate } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [listing, setListing] = useState<Listing>({ versions: [] });
  const [selected, setSelected] = useState<Version | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState<'restore' | 'delete' | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    dialog.current?.showModal();
    void invoke<Listing>('list_agent_config_backups', { client })
      .then((value) => { if (!disposed) setListing(value); })
      .catch((cause) => { if (!disposed) setError(String(cause)); })
      .finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [client]);
  const choose = async (version: Version) => {
    setBusy(true); setError(''); setSelected(version); setPreview(null); setConfirmation(null);
    try {
      if (version.restorable) setPreview(await invoke<Preview>('preview_agent_config_backup', { client, id: version.id }));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!selected || !confirmation || (confirmation === 'restore' && !preview)) return;
    setBusy(true); setError('');
    try {
      if (confirmation === 'restore') {
        await invoke('restore_agent_config_backup', { client, id: selected.id, revision: preview!.revision });
        await onRestored(); onClose();
      } else {
        await invoke('delete_agent_config_backup', { client, id: selected.id });
        setSelected(null); setPreview(null); setConfirmation(null);
        setListing(await invoke<Listing>('list_agent_config_backups', { client }));
      }
    } catch (cause) { setError(String(cause)); setPreview(null); setConfirmation(null); }
    finally { setBusy(false); }
  };
  const date = (version: Version) => version.createdAt
    ? formatDate(version.createdAt, { dateStyle: 'short', timeStyle: 'medium' }) : version.id;
  return <dialog className="agent-backup-modal" ref={dialog} aria-labelledby="agent-backup-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id="agent-backup-title"><ArchiveRestore size={20} />{t('agents.backup.button')}</h2>
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy} aria-label={t('common.cancel')}><X size={18} /></button></header>
    <p>{t('agents.backup.description')}</p>
    <div className="agent-backup-columns">
      <nav aria-label={t('agents.backup.versions')}>
        {!listing.versions.length && !busy && <p>{t('agents.backup.empty')}</p>}
        {listing.versions.map((version) => <button type="button" key={version.id} disabled={busy || !!confirmation} className={selected?.id === version.id ? 'active' : ''} onClick={() => void choose(version)}>
          <strong>{date(version)}</strong>
          <small>{t('agents.backup.files', { count: version.fileCount })}</small>
          {!version.restorable && <span>{t('agents.backup.invalid')}</span>}
        </button>)}
      </nav>
      <section className="agent-backup-changes" aria-label={t('agents.backup.preview')}>
        {busy && <p role="status"><LoaderCircle size={16} className="spin" /> {t('agents.backup.loading')}</p>}
        {!selected && !busy && <p>{t('agents.backup.select')}</p>}
        {selected && <>
          <strong>{t('agents.backup.location')}</strong><p className="agent-backup-path"><code>{selected.location}</code></p>
          {selected.error && <p className="agent-inline-message warning">{selected.error}</p>}
          <ul className="agent-backup-files">{selected.files.map((file) => <li key={file.path}>
            <code>{file.path}</code><small>{file.exists === null ? t('agents.backup.invalid') : file.exists ? `${t('agents.backup.present')} · ${file.size ?? 0} B` : t('agents.backup.missing')}</small>
          </li>)}</ul>
          {preview && <p>{t(preview.differences.length ? 'agents.backup.overwrite' : 'agents.backup.unchanged')}</p>}
          {preview?.differences.filter((diff) => diff.field.startsWith('modelMappings')).map((diff) => <p key={`${diff.file}:${diff.field}`}>{t('agents.backup.mappingRestore')} <code>{diff.field}</code></p>)}
        </>}
      </section>
    </div>
    {confirmation && selected && <div role="alert" className="agent-backup-confirmation">
      <strong>{t(confirmation === 'restore' ? 'agents.backup.restoreConfirm' : 'agents.backup.deleteConfirm', { version: date(selected) })}</strong>
      <p>{t(confirmation === 'restore' ? 'agents.backup.restoreWarning' : 'agents.backup.deleteWarning')}</p>
    </div>}
    {error && <p className="agent-inline-message error" role="alert">{error}</p>}
    <footer>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => confirmation ? setConfirmation(null) : onClose()}>{t('common.cancel')}</button>
      {confirmation ? <button type="button" className="danger-button" disabled={busy} onClick={() => void confirm()}>{t(confirmation === 'restore' ? 'agents.backup.confirmRestore' : 'agents.backup.confirmDelete')}</button> : <>
        <button type="button" className="danger-button" disabled={busy || !selected} onClick={() => setConfirmation('delete')}>{t('agents.backup.delete')}</button>
        <button type="button" className="primary-button" disabled={busy || !preview} onClick={() => setConfirmation('restore')}>{t('agents.backup.restore')}</button>
      </>}
    </footer>
  </dialog>;
}
