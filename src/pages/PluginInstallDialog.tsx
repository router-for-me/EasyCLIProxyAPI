import { Notice } from '../components/Notice';
import { openExternalUrl } from '../services/appSettings';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { useI18n } from '../i18n';
import { pluginText } from '../i18n/plugins';
import { pluginStoreApi, type PluginStoreEntry, type PluginStoreInstallResult } from '../services/plugins';
import { buildRepositoryURL, getPluginConfirmToken, isOfficialPlugin, isDefaultPluginStoreSource, isOfficialRepository } from '../services/pluginResources';
import { isValidManualReleaseTag, supportsPluginVersionSelection } from '../services/pluginReleaseVersions';
import { GitHubTokenHint, isGitHubRateLimit } from './PluginRateLimitHint';

export function PluginInstallDialog({ entry, onClose, onInstalled }: {
  entry: PluginStoreEntry;
  onClose: () => void;
  onInstalled: (result: PluginStoreInstallResult) => void | Promise<void>;
}) {
  const { t, locale } = useI18n();
  const pt = (key: Parameters<typeof pluginText>[0]) => pluginText(key, locale);
  const [version, setVersion] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const trusted = isOfficialPlugin(entry);
  const officialStore = isDefaultPluginStoreSource(entry);
  const externalRepository = officialStore && !isOfficialRepository(entry.repository);
  const confirmToken = getPluginConfirmToken(entry);
  const confirmed = trusted || confirmation.trim() === confirmToken;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  const cancel = () => {
    controller.current?.abort();
    onClose();
  };
  const canSelectVersion = supportsPluginVersionSelection(entry.installType);
  const validVersion = !version.trim() || isValidManualReleaseTag(version);
  const repository = buildRepositoryURL(entry.repository);
  const action = entry.installed ? pt('update') : pt('install');
  const install = async () => {
    if (pending.current || !validVersion || !confirmed) return;
    pending.current = true; setBusy(true); setError('');
    const request = new AbortController();
    controller.current = request;
    try {
      const result = await pluginStoreApi.install(entry.id, { sourceId: entry.sourceId, version: canSelectVersion ? version.trim() : undefined, signal: request.signal });
      if (mounted.current && !request.signal.aborted) await onInstalled(result);
    } catch (reason) {
      if (mounted.current && !request.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { controller.current = null; pending.current = false; if (mounted.current) setBusy(false); }
  };
  return (
    <Dialog className="config-dialog plugin-install-dialog" busy={busy} labelledBy="plugin-install-title" tabIndex={-1} onClose={cancel}>
      <div className="config-dialog-heading"><h2 id="plugin-install-title">{action} · {entry.name || entry.id}</h2><button className="icon-button quiet" aria-label={t('common.close')} onClick={cancel}><X size={18} /></button></div>
      <div className="plugin-install-body">
        <dl className="plugin-install-origin"><dt>{pt('storeSource')}</dt><dd>{officialStore ? pt('officialStore') : entry.sourceName || entry.sourceId}{entry.sourceUrl && <details className="plugin-source-address"><summary>{pt('sourceAddress')}</summary><small>{entry.sourceUrl}</small></details>}</dd><dt>{pt('repository')}</dt><dd className="plugin-install-repository"><span>{entry.repository || '—'}</span>{repository && <button className="icon-button quiet" aria-label={pt('repository')} onClick={() => void openExternalUrl({ url: repository }).catch(e => setError(String(e)))}><ExternalLink size={15} /></button>}</dd></dl>
        {canSelectVersion && <label className="plugin-field">{pt('version')}<input value={version} onChange={e => setVersion(e.target.value)} disabled={busy} placeholder={entry.version || 'v1.0.0'} aria-invalid={!validVersion} />{!validVersion && <small role="alert">{pt('invalidVersion')}</small>}</label>}
        {!trusted && <>
          <Notice tone="warn" icon={false} live={false} id="plugin-trust-warning" className="plugin-warning">{pt(externalRepository ? 'officialStoreThirdParty' : 'trustWarning')}</Notice>
          <label className="plugin-field">{pt(entry.installed ? 'trustTypeUpdate' : 'trustType')}<code>{confirmToken}</code><input value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} aria-describedby="plugin-trust-warning" /></label>
        </>}
        {error && <Notice tone="error" variant="text">{error}{isGitHubRateLimit(error) ? <GitHubTokenHint /> : null}</Notice>}
      </div>
      <div className="plugin-dialog-actions"><button className="secondary-button compact-button" onClick={cancel}>{t('common.cancel')}</button><button className="primary-button compact-button" disabled={busy || !validVersion || !confirmed} onClick={() => void install()}>{busy ? t('common.loading') : action}</button></div>
    </Dialog>
  );
}
