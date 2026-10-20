import { useEffect, useState } from 'react';
import { Download, LoaderCircle, Puzzle } from 'lucide-react';
import { useI18n } from '../i18n';
import { pluginText } from '../i18n/plugins';
import { PluginTranslationControl } from '../components/PluginTranslationControl';
import type { PluginStoreEntry } from '../services/plugins';
import { formatPluginVersion } from '../services/pluginReleaseVersions';
import { getPluginRepositorySlug, isDefaultPluginStoreSource } from '../services/pluginResources';
import {
  pluginTextNeedsChinese, savedPluginTranslationModel, translatePluginText,
} from '../services/pluginTranslation';

export function PluginStoreCard({ entry, locked, bulkTranslate, onOpen }: {
  entry: PluginStoreEntry;
  locked: boolean;
  bulkTranslate: boolean;
  onOpen: () => void;
}) {
  const { locale } = useI18n();
  const pt = (key: Parameters<typeof pluginText>[0]) => pluginText(key, locale);
  const [translatedDescription, setTranslatedDescription] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [translationOrigin, setTranslationOrigin] = useState<'manual' | 'bulk' | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [translationError, setTranslationError] = useState('');
  const canTranslate = pluginTextNeedsChinese(entry.description, locale);
  const description = bulkTranslate && translatedDescription
    ? translatedDescription
    : !bulkTranslate && translationOrigin === 'manual' && translatedDescription && !showOriginal
      ? translatedDescription
      : entry.description;

  useEffect(() => {
    if (!bulkTranslate || !canTranslate || translatedDescription) return undefined;
    const model = savedPluginTranslationModel();
    if (!model) return undefined;
    let cancelled = false;
    setBulkLoading(true); setTranslationError('');
    void translatePluginText(entry.description, model, locale).then((value) => {
      if (cancelled) return;
      setTranslatedDescription(value);
      setTranslationOrigin('bulk');
    }).catch((reason) => {
      if (!cancelled) setTranslationError(reason instanceof Error ? reason.message : pt('translationFailed'));
    }).finally(() => {
      if (!cancelled) setBulkLoading(false);
    });
    return () => { cancelled = true; };
  }, [bulkTranslate, canTranslate, entry.description, locale, translatedDescription]);

  return <article className="plugin-card plugin-store-card" data-plugin-id={entry.storeId}>
    <div className="plugin-card-title"><span className="plugin-icon"><Puzzle size={23} /></span><div><h2>{entry.name || entry.id}</h2><code>{entry.id}</code></div><span className={`plugin-badge ${isDefaultPluginStoreSource(entry) ? 'active' : ''}`}>{pt(isDefaultPluginStoreSource(entry) ? 'officialStore' : 'additionalStore')}</span></div>
    <p className="plugin-card-description">{description}</p>
    {canTranslate && !bulkTranslate ? <div className="plugin-translation-line"><PluginTranslationControl text={entry.description} translated={translatedDescription} showingOriginal={showOriginal} onTranslated={(value) => { setTranslatedDescription(value); setTranslationOrigin('manual'); setShowOriginal(false); }} onToggleOriginal={() => setShowOriginal(value => !value)} disabled={locked} /></div> : null}
    {bulkTranslate && bulkLoading ? <div className="plugin-translation-line plugin-translation-loading"><LoaderCircle size={13} className="spin" />{pt('translationBusy')}</div> : null}
    {bulkTranslate && translationError ? <div className="plugin-translation-line plugin-translation-error" role="alert">{translationError}</div> : null}
    <p className="plugin-version-line">{entry.installed && entry.updateAvailable ? <span className="plugin-version-available">{entry.installedVersion} → {entry.version}</span> : (entry.installedVersion || entry.version) ? <span className="plugin-version-badge"><span>{pt(entry.installed ? 'version' : 'latestVersion')}</span><code>{formatPluginVersion(entry.installedVersion || entry.version)}</code></span> : null}{entry.author && <span>{entry.author}</span>}{entry.license && <><span className="meta-dot">·</span><span>{entry.license}</span></>}</p>
    {!isDefaultPluginStoreSource(entry) && <p className="plugin-meta">{pt('storeSource')}: {entry.sourceName || entry.sourceId}</p>}
    {entry.repository && <p className="plugin-meta plugin-repository" title={entry.repository}>{pt('repository')}: <span>{getPluginRepositorySlug(entry.repository) || entry.repository}</span></p>}
    {entry.platforms.length > 0 && <p className="plugin-meta">{entry.platforms.map(platform => `${platform.goos}/${platform.goarch}`).join(' · ')}</p>}
    <div className="plugin-card-actions"><button className={`primary-button${entry.updateAvailable ? ' plugin-update-action' : ''}`} disabled={locked || (entry.authRequired && !entry.authConfigured)} onClick={onOpen}><Download size={15} />{pt(entry.authRequired && !entry.authConfigured ? 'authMissing' : !entry.installed ? 'install' : entry.updateAvailable ? 'update' : 'reinstall')}</button></div>
  </article>;
}
