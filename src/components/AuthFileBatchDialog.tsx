import { useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { Checkbox } from './Checkbox';
import { useConfirmation } from './ConfirmationDialog';
import { useI18n } from '../i18n';
import { usePrivacyMask } from '../privacy';
import { isOAuthCredentialFile, setOAuthCredentialFileDisabled, type AuthFileRecord } from '../services/authFiles';
import { refreshAllCredentials, refreshCredential, runCredentialBatch, type CredentialResult } from '../services/authFileOperations';
import { managementApi, readString } from '../services/managementApi';
import { quotaKey } from '../services/quotaService';
import './AuthFileBatchDialog.css';

export function AuthFileBatchDialog({ files, onClose, onChanged }: {
  files: AuthFileRecord[]; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const eligible = files.filter(isOAuthCredentialFile);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [results, setResults] = useState<CredentialResult[]>([]);
  const [error, setError] = useState('');
  const excludedCount = files.length - eligible.length;
  const targets = eligible.filter(file => selected.has(quotaKey(file)));
  const run = async (operation: 'enable' | 'disable' | 'delete' | 'refresh' | 'all') => {
    if (pending.current || (operation !== 'all' && !targets.length)) return;
    pending.current = true;
    setBusy(true);
    try {
      if (operation === 'delete' || operation === 'all') {
        const confirmed = await askConfirmation({
          title: operation === 'delete'
            ? t(targets.length === 1 ? 'authFiles.operations.deleteTitleOne' : 'authFiles.operations.deleteTitle', { count: targets.length })
            : t('authFiles.operations.title'),
          message: t(operation === 'delete' ? 'authFiles.operations.confirmDelete' : 'authFiles.operations.confirmRefresh', { count: targets.length }),
          confirmText: t(operation === 'delete' ? 'common.delete' : 'authFiles.operations.refreshAll'),
          ...(operation === 'delete' ? { variant: 'danger' as const } : {}),
        });
        if (!confirmed) return;
      }
      setError('');
      setResults([]);
      const next = operation === 'all' ? await refreshAllCredentials() : await runCredentialBatch(targets, async file => {
        if (operation === 'refresh') return refreshCredential(file);
        if (operation === 'delete') return managementApi.delete('/credentials', { query: { name: readString(file, 'name') } });
        return setOAuthCredentialFileDisabled(file, operation === 'disable');
      });
      setResults(next);
      setSelected(new Set());
      await onChanged();
    } catch (reason) { setError(String(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <>
    <Dialog className="model-discovery-dialog auth-batch-dialog" title={t('authFiles.operations.title')} onClose={onClose} closeDisabled={busy}>
      <div className="model-discovery-toolbar">
        <label><Checkbox checked={eligible.length > 0 && selected.size === eligible.length} disabled={busy || !eligible.length} onChange={event => setSelected(new Set(event.currentTarget.checked ? eligible.map(quotaKey) : []))} />{t('authFiles.operations.selectAll')} ({selected.size}/{eligible.length})</label>
        {excludedCount > 0 ? <small className="auth-batch-excluded">{t(excludedCount === 1 ? 'authFiles.operations.excludedOne' : 'authFiles.operations.excluded', { count: excludedCount })}</small> : null}
      </div>
      <div className="surface-section model-discovery-content">
        <div className="model-discovery-list">
          {eligible.map(file => <label className="model-discovery-row" key={quotaKey(file)}>
            <Checkbox checked={selected.has(quotaKey(file))} disabled={busy} onChange={event => {
              const checked = event.currentTarget.checked;
              setSelected(current => { const next = new Set(current); if (checked) next.add(quotaKey(file)); else next.delete(quotaKey(file)); return next; });
            }} /><span>{privacy.credentialName(file)}</span>
          </label>)}
        </div>
        {error ? <p role="alert">{privacy.text(error, files.flatMap(file => [readString(file, 'email'), readString(file, 'name')]).filter(Boolean))}</p> : null}
        {results.length ? <div role="status">
          <p>{t('authFiles.operations.done', { success: results.filter(result => result.success).length, failed: results.filter(result => !result.success).length })}</p>
          {results.map((result, index) => <p key={index}>{privacy.text(result.id, [result.id])} · {result.success ? '✓' : '✗'}{result.error ? <small> · {privacy.text(result.error, [result.id, ...files.map(file => readString(file, 'email'))].filter(Boolean))}</small> : null}</p>)}
        </div> : null}
      </div>
      <div className="model-discovery-actions">
        <button type="button" className="secondary-button small-button" disabled={busy} onClick={() => void run('all')}>{t('authFiles.operations.refreshAll')}</button>
        <button type="button" className="secondary-button small-button" disabled={busy || !targets.length} onClick={() => void run('refresh')}>{t('authFiles.operations.refresh')}</button>
        <button type="button" className="secondary-button small-button" disabled={busy || !targets.length} onClick={() => void run('enable')}>{t('common.enable')}</button>
        <button type="button" className="secondary-button small-button" disabled={busy || !targets.length} onClick={() => void run('disable')}>{t('common.disable')}</button>
        <button type="button" className="danger-button small-button" disabled={busy || !targets.length} onClick={() => void run('delete')}>{t('common.delete')}</button>
      </div>
    </Dialog>
    {confirmationDialog}
  </>;
}
