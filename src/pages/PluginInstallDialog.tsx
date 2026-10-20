import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { ExternalLink, FileText, LoaderCircle, X } from 'lucide-react';
import Markdown from 'react-markdown';
import { useDialogFocusTrap } from '../components/useDialogFocusTrap';
import { releaseNotesUrl } from '../components/AppReleaseNotes';
import { SelectMenu, type SelectMenuOption } from '../components/SelectMenu';
import { PluginTranslationControl } from '../components/PluginTranslationControl';
import { useI18n } from '../i18n';
import { pluginText } from '../i18n/plugins';
import { pluginStoreApi, type PluginStoreEntry, type PluginStoreInstallResult } from '../services/plugins';
import { buildRepositoryURL, getPluginConfirmToken, isOfficialPlugin, isDefaultPluginStoreSource, isOfficialRepository } from '../services/pluginResources';
import {
  buildGitHubReleasesPageURL, comparePluginReleaseVersions, formatPluginVersion, getGitHubRepositorySlug,
  isPluginReleaseDowngrade, isValidManualReleaseTag, loadPluginReleases, supportsPluginVersionSelection,
  type PluginRelease,
} from '../services/pluginReleaseVersions';
import { GitHubTokenHint, isGitHubRateLimit } from './PluginRateLimitHint';
import {
  pluginTextNeedsChinese, savedPluginTranslationModel, translatePluginText,
} from '../services/pluginTranslation';

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '');
}

function releaseSummary(notes: string): string {
  return notes
    .split(/\r?\n/)
    .map(line => line.replace(/^[#>*+\-\s]+/, '').replace(/[*_`]/g, '').trim())
    .find(Boolean)?.slice(0, 120) ?? '';
}

export function PluginInstallDialog({ entry, autoTranslate = false, onClose, onInstalled }: {
  entry: PluginStoreEntry;
  autoTranslate?: boolean;
  onClose: () => void;
  onInstalled: (result: PluginStoreInstallResult) => void | Promise<void>;
}) {
  const { t, locale, formatDate } = useI18n();
  const pt = (key: Parameters<typeof pluginText>[0]) => pluginText(key, locale);
  const repositorySlug = getGitHubRepositorySlug(entry.repository);
  const canSelectVersion = supportsPluginVersionSelection(entry.installType) && Boolean(repositorySlug);
  const fallbackVersion = normalizeVersion(entry.version);
  const installedVersion = normalizeVersion(entry.installedVersion);
  const [version, setVersion] = useState(fallbackVersion);
  const [releases, setReleases] = useState<PluginRelease[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState('');
  const [versionsAttempt, setVersionsAttempt] = useState(0);
  const [translatedNotes, setTranslatedNotes] = useState<string | null>(null);
  const [showOriginalNotes, setShowOriginalNotes] = useState(false);
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
  const versionTouched = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    if (!canSelectVersion) {
      setReleases([]); setVersionsError(''); setVersionsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setVersionsLoading(true); setVersionsError('');
    void loadPluginReleases(entry.repository, { refresh: versionsAttempt > 0 }).then((next) => {
      if (cancelled || !mounted.current) return;
      setReleases(next);
      if (!versionTouched.current) setVersion((next.find(release => !release.prerelease) ?? next[0])?.version || fallbackVersion);
    }).catch((reason) => {
      if (!cancelled && mounted.current) setVersionsError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (!cancelled && mounted.current) setVersionsLoading(false);
    });
    return () => { cancelled = true; };
  }, [canSelectVersion, entry.id, entry.repository, fallbackVersion, versionsAttempt]);
  useEffect(() => {
    setTranslatedNotes(null);
    setShowOriginalNotes(false);
  }, [entry.id, version]);
  const releaseByVersion = useMemo(() => new Map(releases.map(release => [release.version, release])), [releases]);
  const selectedRelease = releaseByVersion.get(version);
  const latestVersion = (releases.find(release => !release.prerelease) ?? releases[0])?.version || fallbackVersion;
  const versionEntries = useMemo(() => {
    const entries = [...releases];
    if (fallbackVersion && !entries.some(release => release.version === fallbackVersion)) {
      entries.push({ version: fallbackVersion, name: '', notes: '', publishedAt: '', prerelease: false });
    }
    return entries;
  }, [fallbackVersion, releases]);
  const versionOptions = useMemo<SelectMenuOption[]>(() => versionEntries.map((release) => {
    const latest = release.version === latestVersion;
    const current = Boolean(installedVersion && release.version === installedVersion);
    const labels = [formatPluginVersion(release.version)];
    if (latest) labels.push(pt('latestVersion'));
    if (current) labels.push(pt('currentVersion'));
    if (release.prerelease) labels.push(pt('prerelease'));
    const published = release.publishedAt && Number.isFinite(Date.parse(release.publishedAt))
      ? formatDate(release.publishedAt, { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
    const details = [published, release.name && release.name !== formatPluginVersion(release.version) ? release.name : '', release.prerelease ? pt('prerelease') : '', releaseSummary(release.notes)].filter(Boolean);
    return {
      value: release.version,
      label: labels.join(' · '),
      group: latest ? pt('latestReleases') : pt('olderReleases'),
      description: details.join(' · '),
    };
  }), [formatDate, installedVersion, latestVersion, pt, versionEntries]);
  const downgrade = Boolean(installedVersion && version && isPluginReleaseDowngrade(installedVersion, version));
  const validVersion = !canSelectVersion || (Boolean(version) && isValidManualReleaseTag(version));
  const repository = buildRepositoryURL(entry.repository);
  const releasesPage = buildGitHubReleasesPageURL(entry.repository);
  const actionPrefix = !entry.installed ? pt('install') : downgrade ? pt('downgrade') : installedVersion && comparePluginReleaseVersions(installedVersion, version) === 0 ? pt('reinstall') : pt('update');
  const action = entry.installed ? (downgrade ? pt('downgrade') : pt('update')) : pt('install');
  const selectedPublished = selectedRelease?.publishedAt && Number.isFinite(Date.parse(selectedRelease.publishedAt))
    ? formatDate(selectedRelease.publishedAt, { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  const platformLabel = entry.platforms.map(platform => `${platform.goos}/${platform.goarch}`).join(' · ');
  const notesText = translatedNotes && !showOriginalNotes ? translatedNotes : selectedRelease?.notes ?? '';
  useEffect(() => {
    if (!autoTranslate || !selectedRelease?.notes || translatedNotes || !pluginTextNeedsChinese(selectedRelease.notes, locale)) return undefined;
    const model = savedPluginTranslationModel();
    if (!model) return undefined;
    let cancelled = false;
    void translatePluginText(selectedRelease.notes, model, locale).then((value) => {
      if (!cancelled) setTranslatedNotes(value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [autoTranslate, locale, selectedRelease?.notes, selectedRelease?.version, translatedNotes]);
  const cancel = () => {
    controller.current?.abort();
    onClose();
  };
  const ref = useDialogFocusTrap<HTMLElement>({ onEscape: cancel });
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

  return createPortal(
    <div className="config-dialog-backdrop">
      <section className="config-dialog plugin-install-dialog" aria-busy={busy} role="dialog" aria-modal="true" aria-labelledby="plugin-install-title" ref={ref} tabIndex={-1}>
        <div className="config-dialog-heading">
          <h2 id="plugin-install-title">{action} · {entry.name || entry.id}</h2>
          <button className="icon-button quiet" aria-label={t('common.close')} onClick={cancel}><X size={18} /></button>
        </div>
        <div className="plugin-install-body">
          <dl className="plugin-install-origin">
            <dt>{pt('storeSource')}</dt>
            <dd>{officialStore ? pt('officialStore') : entry.sourceName || entry.sourceId}{entry.sourceUrl && <details className="plugin-source-address"><summary>{pt('sourceAddress')}</summary><small>{entry.sourceUrl}</small></details>}</dd>
            <dt>{pt('repository')}</dt>
            <dd className="plugin-install-repository"><span>{entry.repository || '—'}</span>{repository && <button className="icon-button quiet" aria-label={pt('repository')} onClick={() => void invoke('open_external_url', { url: repository }).catch(e => setError(String(e)))}><ExternalLink size={15} /></button>}</dd>
          </dl>
          {canSelectVersion ? (
            <div className="plugin-version-field">
              <div className="plugin-version-heading"><label>{pt('chooseVersion')}</label><span>{pt('latestDefault')}</span></div>
              <SelectMenu
                value={version}
                options={versionOptions}
                onChange={(next) => { versionTouched.current = true; setVersion(next); }}
                ariaLabel={pt('chooseVersion')}
                disabled={busy || !versionOptions.length}
                size="wide"
                overlay
              />
              <div className="plugin-version-meta">
                {versionsLoading
                  ? <span className="plugin-version-loading"><LoaderCircle size={13} className="spin" />{pt('versionsLoading')}</span>
                  : selectedPublished || selectedRelease?.name
                    ? <span>{[selectedPublished, selectedRelease?.name].filter(Boolean).join(' · ')}</span>
                    : <span>{pt('latestDefault')}</span>}
                {selectedRelease?.prerelease ? <span className="plugin-badge">{pt('prerelease')}</span> : null}
              </div>
              {versionsError ? (
                <div className="plugin-version-error" role="status">
                  <span title={versionsError}>{pt('versionsFailed')}</span>
                  <button type="button" className="secondary-button" disabled={versionsLoading || busy} onClick={() => setVersionsAttempt(value => value + 1)}>{pt('refreshVersions')}</button>
                </div>
              ) : null}
            </div>
          ) : normalizeVersion(entry.version) ? (
            <div className="plugin-fixed-version"><span>{pt('version')}</span><code>{formatPluginVersion(entry.version)}</code></div>
          ) : null}
          {entry.installed && version ? <div className="plugin-update-flow"><span>{pt('currentVersion')}</span><code>{formatPluginVersion(installedVersion)}</code><span aria-hidden="true">→</span><span>{pt('targetVersion')}</span><code>{formatPluginVersion(version)}</code></div> : null}
          {canSelectVersion ? (
            <section className="plugin-release-panel" aria-label={entry.installed ? pt('releaseNotes') : pt('versionNotes')}>
              <header>
                <div><FileText size={16} aria-hidden="true" /><h3>{entry.installed ? pt('releaseNotes') : pt('versionNotes')}</h3></div>
                {releasesPage ? <button type="button" className="plugin-release-link" onClick={() => void invoke('open_external_url', { url: releasesPage }).catch(e => setError(String(e)))}>{pt('fullReleaseNotes')}<ExternalLink size={13} aria-hidden="true" /></button> : null}
              </header>
              {selectedRelease ? (
                <div className="plugin-release-content">
                  <div className="plugin-release-meta">
                    <strong>{formatPluginVersion(selectedRelease.version)}</strong>
                    {selectedPublished ? <span>{selectedPublished}</span> : null}
                    {selectedRelease.prerelease ? <span className="plugin-badge">{pt('prerelease')}</span> : null}
                  </div>
                  {pluginTextNeedsChinese(selectedRelease.notes, locale) ? <div className="plugin-translation-line"><PluginTranslationControl text={selectedRelease.notes} translated={translatedNotes} showingOriginal={showOriginalNotes} onTranslated={(value) => { setTranslatedNotes(value); setShowOriginalNotes(false); }} onToggleOriginal={() => setShowOriginalNotes(value => !value)} disabled={busy} compact /></div> : null}
                  {notesText ? (
                    <div className="plugin-release-markdown" lang={locale}>
                      <Markdown
                        skipHtml
                        disallowedElements={['img']}
                        urlTransform={releaseNotesUrl}
                        components={{
                          h1: ({ children }) => <h4>{children}</h4>,
                          h2: ({ children }) => <h4 className="plugin-release-category">{children}</h4>,
                          a: ({ href, children }) => href ? (
                            <a href={href} onClick={(event) => { event.preventDefault(); void invoke('open_external_url', { url: href }).catch(e => setError(String(e))); }}>{children}</a>
                          ) : <span>{children}</span>,
                        }}
                      >
                        {notesText}
                      </Markdown>
                    </div>
                  ) : <p className="plugin-release-empty">{pt('noReleaseNotes')}</p>}
                </div>
              ) : <p className="plugin-release-empty" role="status">{versionsLoading ? pt('versionsLoading') : pt('noReleaseNotes')}</p>}
              <footer><span>{platformLabel ? `${pt('platforms')}: ${platformLabel}` : ''}</span><span>{pt('configurationPreserved')}</span></footer>
            </section>
          ) : null}
          {downgrade ? <p className="plugin-warning plugin-downgrade-warning" role="status">{pt('downgradeWarning')}</p> : null}
          {!trusted && <>
            <p className="plugin-warning" id="plugin-trust-warning">{pt(externalRepository ? 'officialStoreThirdParty' : 'trustWarning')}</p>
            <label className="plugin-field">{pt(entry.installed ? 'trustTypeUpdate' : 'trustType')}<code>{confirmToken}</code><input value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} aria-describedby="plugin-trust-warning" /></label>
          </>}
          {error && <p className="plugin-error" role="alert">{error}{isGitHubRateLimit(error) ? <GitHubTokenHint /> : null}</p>}
        </div>
        <div className="plugin-dialog-actions">
          <button className="secondary-button" onClick={cancel}>{t('common.cancel')}</button>
          <button className="primary-button" disabled={busy || !validVersion || !confirmed} onClick={() => void install()}>{busy ? t('common.loading') : `${actionPrefix}${canSelectVersion ? ` ${formatPluginVersion(version)}` : ''}`}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
