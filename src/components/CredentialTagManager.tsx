import { useMemo, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { Notice } from './Notice';
import { useConfirmation } from './ConfirmationDialog';
import { useI18n } from '../i18n';
import { usePrivacyMask } from '../privacy';
import { authFileIdentities, countAuthFileTags, isRuntimeOnlyAuthFile, normalizeAuthFileTags, type AuthFileRecord } from '../services/authFiles';
import { batchRemoveCredentialTag, renameCredentialTag, type CredentialResult } from '../services/authFileOperations';
import { mergeCredentialTags } from '../services/credentialTags';

export function CredentialTagManager({ files, onClose, onChanged, onFilter }: {
  files: AuthFileRecord[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onFilter: (tag: string | null) => void;
}) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [revision, setRevision] = useState(0);
  const [results, setResults] = useState<CredentialResult[]>([]);
  const [error, setError] = useState('');
  const resolved = useMemo(() => mergeCredentialTags(files), [files, revision]);
  const counts = countAuthFileTags(resolved);
  const editable = resolved.filter(file => typeof file.name === 'string' && file.name.trim() && !isRuntimeOnlyAuthFile(file));
  const editableCounts = countAuthFileTags(editable);
  const identities = files.flatMap(authFileIdentities);
  const tags = [...counts.keys()].sort((left, right) => left.localeCompare(right))
    .filter(tag => tag.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const untagged = resolved.filter(file => !normalizeAuthFileTags(file.tags).length).length;
  const target = replacement.trim();
  const valid = Boolean(target && target !== editing && !/[,，\r\n]/.test(target));
  const finishEditing = () => {
    setEditing(null);
    searchRef.current?.focus();
  };

  const apply = async (source: string, rename: boolean) => {
    if (pending.current || (rename && !valid)) return;
    const count = editableCounts.get(source) ?? 0;
    if (!count) return;
    pending.current = true;
    try {
      const confirmed = await askConfirmation({
        title: t(rename ? 'authFiles.tags.rename' : 'authFiles.tags.removeEverywhere'),
        message: t(rename ? 'authFiles.tags.confirmRename' : 'authFiles.tags.confirmRemove', {
          tag: privacy.text(source, identities), target: privacy.text(target, identities), count,
        }),
        warning: t('authFiles.tags.safeHint'),
        variant: rename ? 'primary' : 'danger',
      });
      if (!confirmed) return;
      setBusy(true);
      setError('');
      setResults([]);
      const next = rename ? await renameCredentialTag(editable, source, target) : await batchRemoveCredentialTag(editable, source);
      setResults(next);
      setRevision(value => value + 1);
      if (next.every(result => result.success)) finishEditing();
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return <>
    <Dialog title={t('authFiles.tags.manage')} className="config-dialog credential-tag-manager"
      initialFocusRef={searchRef} onClose={onClose} closeDisabled={busy} busy={busy} inert={Boolean(confirmationDialog)} dismissOnBackdrop>
      <p>{t('authFiles.tags.safeHint')}</p>
      <input ref={searchRef} type="search" value={query} disabled={busy}
        onChange={event => setQuery(event.currentTarget.value)} aria-label={t('authFiles.tags.search')} placeholder={t('authFiles.tags.search')} />
      <button type="button" className="filter-chip" disabled={busy} onClick={() => onFilter(null)}>
        <span>{t('authFiles.tags.untagged')}</span> <span className="credential-tag-count">({untagged})</span>
      </button>
      <div className="credential-tag-manager-list" aria-label={t('authFiles.tags.poolLabel')}>
        {!tags.length ? <p role="status">{t(counts.size ? 'authFiles.tags.noMatches' : 'authFiles.tags.empty')}</p> : null}
        {tags.map(tag => <div className="credential-tag-manager-row" key={tag}>
          <button type="button" className="filter-chip credential-tag-manager-label" disabled={busy}
            title={t('authFiles.tags.filterBy', { tag: privacy.text(tag, identities) })} onClick={() => onFilter(tag)}>
            <span className="credential-tag-manager-text">{privacy.text(tag, identities)}</span> <span className="credential-tag-count">({counts.get(tag)})</span>
          </button>
          <div className="credential-tag-manager-actions">
          {editing === tag ? <form className="credential-tag-rename" onSubmit={event => { event.preventDefault(); void apply(tag, true); }}>
            <input autoFocus value={replacement} disabled={busy} aria-label={t('authFiles.tags.newName')}
              onChange={event => setReplacement(event.currentTarget.value)}
              onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }} />
            <small>{t(counts.has(target) && target !== tag ? 'authFiles.tags.mergeHint' : 'authFiles.tags.renameHint')}</small>
            <button type="submit" className="primary-button small-button" disabled={busy || !valid}>{t('common.save')}</button>
            <button type="button" className="secondary-button small-button" disabled={busy} onClick={finishEditing}>{t('common.cancel')}</button>
          </form> : <button type="button" className="secondary-button small-button" disabled={busy || !editableCounts.has(tag)}
            onClick={() => { setEditing(tag); setReplacement(tag); }}>{t('authFiles.tags.rename')}</button>}
          <button type="button" className="danger-button small-button" disabled={busy || !editableCounts.has(tag)} onClick={() => void apply(tag, false)}>{t('authFiles.tags.removeEverywhere')}</button>
          </div>
        </div>)}
      </div>
      {results.length ? <Notice tone={results.some(result => !result.success) ? 'warn' : 'success'}>
        <p role="status">{t('authFiles.operations.done', { success: results.filter(result => result.success).length, failed: results.filter(result => !result.success).length })}</p>
        {results.filter(result => !result.success).map(result => <p key={result.id}>{privacy.text(`${result.id}: ${result.error}`, identities)}</p>)}
      </Notice> : null}
      {error ? <Notice tone="error">{privacy.text(error, identities)}</Notice> : null}
    </Dialog>
    {confirmationDialog}
  </>;
}
