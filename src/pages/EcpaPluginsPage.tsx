import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, ExternalLink, KeyRound, Puzzle, RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { Notice } from '../components/Notice';
import { PluginLogo } from '../components/ProviderLogo';
import { useI18n } from '../i18n';
import { openExternalUrl } from '../services/appSettings';
import {
  buildEcpaStoreMap,
  ECPA_REGISTRY_URL,
  fetchEcpaRegistry,
  getBundledEcpaRegistry,
  getEcpaPluginDescription,
  isInstallableEcpaEntry,
  isStoreUpdateAvailable,
  resolveEcpaStoreEntry,
  readEcpaGitHubToken,
  type EcpaPluginEntry,
} from '../services/ecpaPlugins';
import { safePluginWebURL } from '../services/pluginResources';
import { refreshPluginReleaseVersions } from '../services/pluginReleaseVersions';
import { getPluginSupport, pluginsApi, pluginStoreApi, type PluginStoreEntry, type PluginStoreInstallResult, type PluginStoreResponse } from '../services/plugins';
import { openSettingField } from '../services/settingsNavigation';
import { GitHubTokenHint, isGitHubRateLimit } from './PluginRateLimitHint';
import { PluginInstallDialog } from './PluginInstallDialog';
import { pluginText } from '../i18n/plugins';
import { useConfirmation } from '../components/ConfirmationDialog';
import { restartCoreProcess } from '../services/coreLifecycle';
import './EcpaPluginsPage.css';

const COPY_FEEDBACK_MS = 1500;
const ALL_TAG = '';

export function EcpaPluginsPage() {
  const { t, locale } = useI18n();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  // `null` means the check has not settled yet, so cards stay neutral instead of
  // flashing an unavailable reason while the source is verified or registered.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [storeLoaded, setStoreLoaded] = useState(false);
  const [storeEntries, setStoreEntries] = useState(new Map<string, PluginStoreEntry>());
  const [storeError, setStoreError] = useState('');
  const [installEntry, setInstallEntry] = useState<PluginStoreEntry | null>(null);
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [restartRequired, setRestartRequired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  // Installs confirmed in this session stay authoritative until the store list
  // catches up, so a stale store report cannot regress a card to install.
  const confirmedInstalls = useRef(new Map<string, string>());

  // Store results merge on a sequence number so a slow release lookup started
  // earlier cannot overwrite entries from a newer reload. -1 marks an unloaded
  // page so a load resolving after unmount writes nothing.
  const storeSeq = useRef(0);
  // The store list is the only thing an install button waits for: a card whose
  // plugin id is already in this map renders an enabled install button even
  // while the support check, source registration and release lookup still run.
  const applyStoreResult = (result: PluginStoreResponse, seq: number) => {
    if (!mounted.current || seq !== storeSeq.current) return;
    const confirmed = confirmedInstalls.current;
    const plugins: PluginStoreEntry[] = result.plugins.map((entry: PluginStoreEntry) => {
      const installedVersion = confirmed.get(entry.id);
      if (installedVersion === undefined || entry.installed) return entry;
      return { ...entry, installed: true, installedVersion };
    });
    setStoreEntries(buildEcpaStoreMap(plugins));
    setStoreError(result.sourceErrors.filter(source => source.sourceUrl === ECPA_REGISTRY_URL).map(source => source.message).join('; '));
  };

  const reloadStore = async () => {
    const seq = ++storeSeq.current;
    // Fast phase: the store list alone is enough to enable install.
    let listed: PluginStoreResponse;
    try {
      listed = await pluginStoreApi.list();
    } catch (reason) {
      if (mounted.current && seq === storeSeq.current) setStoreLoaded(true);
      throw reason;
    }
    if (!mounted.current) return;
    // The list attempt itself is done even if a newer reload supersedes it.
    setStoreLoaded(true);
    applyStoreResult(listed, seq);
    // Slow phase: latest release lookups query GitHub and must not gate the list.
    let result = listed;
    try {
      result = await refreshPluginReleaseVersions(listed);
    } catch {
      // Keep registry versions when the latest-release lookup is unavailable.
    }
    applyStoreResult(result, seq);
  };

  // The featured registry is a default plugin source: register it silently so
  // installs work on the first visit, including for upgraded installs that
  // predate the source. A write failure is terminal for this visit.
  const registerSource = async (): Promise<boolean> => {
    try {
      const settings = await pluginsApi.getSettings();
      const listed = settings.storeSources.includes(ECPA_REGISTRY_URL);
      if (mounted.current) setRegistered(true);
      if (listed) return false;
      await pluginsApi.updateSettings({ storeSources: [...settings.storeSources, ECPA_REGISTRY_URL] });
      return true;
    } catch (reason) {
      if (mounted.current) {
        setRegistered(false);
        setStoreError(String(reason));
      }
      return false;
    }
  };

  const refreshRegistry = async () => {
    setRefreshing(true);
    try {
      const result = await fetchEcpaRegistry({ token, forceRefresh: true });
      if (!mounted.current) return;
      setTokenInvalid(result.tokenInvalid);
      if (result.registry) setPlugins(result.registry.plugins);
      await reloadStore();
    } catch (reason) {
      if (mounted.current) setStoreError(String(reason));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  };

  useEffect(() => {
    let active = true;
    mounted.current = true;
    const fail = (reason: unknown) => {
      if (!active) return;
      setStoreError(String(reason));
      setStoreLoaded(true);
    };
    // The store list starts before the support probe and before any settings
    // write, so an entry listed here enables its install button right away
    // instead of queueing behind those calls.
    const listed = reloadStore().catch(fail);
    void getPluginSupport().then(async available => {
      if (!active) return;
      setSupported(available);
      if (!available) {
        setRegistered(false);
        setStoreLoaded(true);
        return;
      }
      // Registration runs alongside the store list so it never delays the
      // install buttons; only a conclusive failure reports the source as down.
      void registerSource().then(changed => {
        // A first-visit registration can land after the list ran, so list again
        // once the source is known to exist.
        if (changed && mounted.current) void reloadStore().catch(fail);
      });
      await listed;
    }).catch(fail);
    return () => {
      active = false;
      mounted.current = false;
      // Leave no result able to land after unmount.
      storeSeq.current = -1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installed = async (result: PluginStoreInstallResult) => {
    setInstallEntry(null);
    if (result.restartRequired) setRestartRequired(true);
    const installedVersion = result.version || resolveEcpaStoreEntry(storeEntries, result.id)?.installedVersion
      || resolveEcpaStoreEntry(storeEntries, result.id)?.version || '';
    confirmedInstalls.current.set(result.id, installedVersion);
    setStoreEntries(previous => buildEcpaStoreMap(Array.from(previous.values()).map(entry =>
      entry.id === result.id
        ? { ...entry, installed: true, installedVersion: installedVersion || entry.version, updateAvailable: false }
        : entry)));
    try { await reloadStore(); }
    catch (reason) { if (mounted.current) setStoreError(String(reason)); }
  };
  const [plugins, setPlugins] = useState<EcpaPluginEntry[]>(() => getBundledEcpaRegistry().plugins);
  // A token previously entered here still applies; new tokens are configured in
  // Settings > Server > GitHub Token (see openSettingField below).
  const token = useMemo(() => readEcpaGitHubToken(), []);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string>(ALL_TAG);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRef = useRef(true);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const isInitial = initialLoadRef.current;
    initialLoadRef.current = false;

    void fetchEcpaRegistry({
      token,
      forceRefresh: !isInitial,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setTokenInvalid(result.tokenInvalid);
      if (result.registry) {
        setPlugins(result.registry.plugins);
      }
    });

    return () => {
      controller.abort();
    };
  }, [token]);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const plugin of plugins) {
      for (const tag of plugin.tags) {
        if (tag) tagSet.add(tag);
      }
    }
    return Array.from(tagSet);
  }, [plugins]);

  useEffect(() => {
    if (selectedTag !== ALL_TAG && !allTags.includes(selectedTag)) {
      setSelectedTag(ALL_TAG);
    }
  }, [allTags, selectedTag]);

  const filteredPlugins = useMemo(() => {
    const query = search.trim().toLowerCase();
    return plugins.filter((plugin) => {
      if (selectedTag !== ALL_TAG && !plugin.tags.includes(selectedTag)) {
        return false;
      }
      if (!query) return true;
      const haystack = [plugin.id, plugin.name, plugin.description, getEcpaPluginDescription(plugin, locale)]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [plugins, search, selectedTag, locale]);

  const handleClearFilters = () => {
    setSearch('');
    setSelectedTag(ALL_TAG);
    searchRef.current?.focus();
  };

  const handleOpenRepository = (repositoryUrl: string) => {
    const safeUrl = safePluginWebURL(repositoryUrl);
    if (!safeUrl) return;
    void openExternalUrl({ url: safeUrl }).catch(() => undefined);
  };

  const handleCopyPluginId = async (pluginId: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(pluginId);
      }
    } catch {
      // Ignore clipboard write failure in non-secure or headless contexts.
    }
    setCopiedId(pluginId);
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = setTimeout(() => {
      setCopiedId((current) => (current === pluginId ? null : current));
      copyTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  };

  const hasActiveFilter = Boolean(search.trim()) || selectedTag !== ALL_TAG;

  const tokenSettingsLink = (muted = false) => (
    <button type="button" className={`link-button ecpa-token-settings-link${muted ? ' muted' : ''}`} onClick={() => openSettingField(['server', 'github-token'])}>
      <KeyRound size={13} aria-hidden="true" />
      {t('ecpaPlugins.tokenSettings')}
    </button>
  );

  return (
    <div className="ecpa-plugins-page" role="region" aria-label={t('ecpaPlugins.title')}>
      <header className="ecpa-plugins-header">
        <div className="ecpa-plugins-heading">
          <h1>{t('ecpaPlugins.title')}</h1>
          <span className="ecpa-plugins-total">{t('ecpaPlugins.resultCount', { count: plugins.length })}</span>
        </div>
        <p className="ecpa-plugins-subtitle">{t('ecpaPlugins.subtitle')} {tokenSettingsLink(true)}</p>
      </header>
      {storeError && <Notice tone="error">{storeError}{isGitHubRateLimit(storeError) ? <GitHubTokenHint /> : null}</Notice>}
      {restartRequired && <Notice tone="info" icon={false} className="plugin-banner" action={
        <button type="button" className="secondary-button" onClick={async () => {
          if (!await askConfirmation({ title: pluginText('restartButton', locale), message: pluginText('restartConfirm', locale) })) return;
          try { await restartCoreProcess(); if (mounted.current) setRestartRequired(false); }
          catch (reason) { if (mounted.current) setStoreError(String(reason)); }
        }}>{pluginText('restartButton', locale)}</button>
      }>{t('ecpaPlugins.restartRequired')}</Notice>}
      {tokenInvalid ? (
        <Notice tone="warn" className="ecpa-plugin-banner">
          {t('ecpaPlugins.token.invalid')} {tokenSettingsLink()}
        </Notice>
      ) : null}
      <div className="ecpa-plugins-controls">
        <div className="ecpa-plugin-search search-control" data-size="default">
          <Search size={17} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('ecpaPlugins.search')}
            aria-label={t('ecpaPlugins.search')}
            title={t('ecpaPlugins.searchHint')}
          />
          <button
            type="button"
            className="icon-button quiet ghost tiny-button ecpa-plugin-search-clear"
            disabled={!search}
            aria-label={t('common.clear')}
            title={t('common.clear')}
            onClick={() => {
              setSearch('');
              searchRef.current?.focus();
            }}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className="secondary-button compact-button ecpa-plugin-refresh"
          disabled={refreshing}
          onClick={() => void refreshRegistry()}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {t('common.refresh')}
        </button>
      </div>

      <div className="ecpa-results-bar">
        <div className="ecpa-tag-bar" role="group" aria-label={t('ecpaPlugins.tagFilter')}>
          <button
            type="button"
            className={`filter-chip ecpa-tag-chip${selectedTag === ALL_TAG ? ' active' : ''}`}
            aria-pressed={selectedTag === ALL_TAG}
            onClick={() => setSelectedTag(ALL_TAG)}
          >
            {t('ecpaPlugins.tagAll')}
          </button>
          {allTags.map((tag) => {
            const active = selectedTag === tag;
            return (
              <button
                key={tag}
                type="button"
                className={`filter-chip ecpa-tag-chip${active ? ' active' : ''}`}
                aria-pressed={active}
                onClick={() => setSelectedTag(active ? ALL_TAG : tag)}
              >
                {tag}
              </button>
            );
          })}
        </div>
        <div className="ecpa-results-meta">
          {hasActiveFilter ? (
            <button type="button" className="link-button muted ecpa-clear-filters" onClick={handleClearFilters}>
              {t('ecpaPlugins.clearFilters')}
            </button>
          ) : null}
          <span className="ecpa-results-count">{t('ecpaPlugins.resultCount', { count: filteredPlugins.length })}</span>
        </div>
      </div>

      {filteredPlugins.length > 0 ? (
        <div className="ecpa-plugin-grid">
          {filteredPlugins.map((plugin) => {
            const description = getEcpaPluginDescription(plugin, locale);
            const isCopied = copiedId === plugin.id;
            const repoUrl = safePluginWebURL(plugin.repository);
            const entry = resolveEcpaStoreEntry(storeEntries, plugin.id);
            const isInstalling = installEntry?.id === plugin.id;
            // An install confirmed in this session renders as installed even when
            // the store list still reports it as missing.
            const confirmedVersion = confirmedInstalls.current.get(plugin.id);
            const isInstalled = entry?.installed === true || confirmedVersion !== undefined;
            const installedVersion = entry?.installed ? entry.installedVersion : confirmedVersion;
            const hasUpdate = isInstalled && isStoreUpdateAvailable(installedVersion, entry?.version);
            // Only a listed entry gates install. The support check and the source
            // registration still run in the background, so a listed entry enables
            // its button as soon as the list arrives. The operation in progress is
            // the one other reason a click is not offered right now.
            const actionBusy = installEntry !== null;
            // `null` keeps the card neutral while the store list is still in
            // flight; every settled case names a reason so a button is never
            // silently grey.
            let unavailable = '';
            let waiting = '';
            if (!entry) {
              if (!isInstallableEcpaEntry(plugin)) unavailable = t('ecpaPlugins.installUnavailable.noRepository');
              else if (supported === false) unavailable = t('ecpaPlugins.installUnavailable.unsupported');
              else if (registered === false) unavailable = t('ecpaPlugins.installUnavailable.sourceNotRegistered');
              else if (!storeLoaded) waiting = t('ecpaPlugins.loadingStore');
              else if (storeError) unavailable = storeError;
              else unavailable = t('ecpaPlugins.installUnavailable.notFound');
            }
            const installBlocked = Boolean(!entry && unavailable);
            // The store list may gain this entry while it is still in flight or
            // while a first-visit source registration runs.
            const storePending = Boolean(!entry && !unavailable && (waiting || !storeLoaded || registered === null));
            return (
              <article
                key={plugin.id}
                className={`surface-card ecpa-plugin-card${unavailable ? ' is-unavailable' : ''}`}
                tabIndex={0}
              >
                <div className="ecpa-plugin-card-title">
                  <span className="ecpa-plugin-icon">
                    <PluginLogo src={plugin.logo} size={23} className="plugin-logo" />
                  </span>
                  <div>
                    <h2>{plugin.name}</h2>
                    <code>{plugin.id}</code>
                  </div>
                  {plugin.version ? (
                    hasUpdate ? (
                      <span className="ecpa-plugin-version" title={t('ecpaPlugins.updateTo', { version: entry?.version ?? plugin.version })}>
                        {installedVersion} → {entry?.version}
                      </span>
                    ) : (
                      <span className="ecpa-plugin-version">{plugin.version}</span>
                    )
                  ) : null}
                </div>

                {description ? (
                  <p className="ecpa-plugin-description">{description}</p>
                ) : null}

                {(plugin.author || plugin.license) ? (
                  <p className="ecpa-plugin-meta">
                    {plugin.author ? <span>{t('ecpaPlugins.author', { author: plugin.author })}</span> : null}
                    {plugin.license ? <span>{t('ecpaPlugins.license', { license: plugin.license })}</span> : null}
                  </p>
                ) : null}

                {plugin.tags.length > 0 ? (
                  <div className="ecpa-plugin-card-tags">
                    {plugin.tags.map((tag) => (
                      <span key={tag} className="ecpa-plugin-card-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}

                {unavailable ? (
                  <p className="ecpa-plugin-unavailable">
                    <TriangleAlert size={14} aria-hidden="true" />
                    <span>{unavailable}</span>
                  </p>
                ) : storePending ? (
                  <p className="ecpa-plugin-unavailable" aria-live="polite">
                    <RefreshCw size={14} aria-hidden="true" />
                    <span>{t('ecpaPlugins.loadingStore')}</span>
                  </p>
                ) : null}

                {installErrors[plugin.id] && <Notice tone="error" variant="text">{t('ecpaPlugins.installFailed', { error: installErrors[plugin.id] })}</Notice>}
                <div className="ecpa-plugin-card-actions">
                  <button
                    type="button"
                    className={`secondary-button compact-button${isCopied ? ' copied' : ''}`}
                    onClick={() => void handleCopyPluginId(plugin.id)}
                  >
                    {isCopied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                    {t(isCopied ? 'ecpaPlugins.copied' : 'ecpaPlugins.copyId')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button compact-button ecpa-repo-button"
                    disabled={!repoUrl}
                    title={repoUrl || t('ecpaPlugins.openRepo')}
                    onClick={() => handleOpenRepository(plugin.repository)}
                  >
                    <ExternalLink size={15} aria-hidden="true" />
                    {t('ecpaPlugins.openRepo')}
                  </button>
                  {installBlocked ? (
                    <button
                      type="button"
                      className="secondary-button compact-button ecpa-install-blocked"
                      title={unavailable}
                      disabled
                    >
                      {t('ecpaPlugins.install')}
                    </button>
                  ) : isInstalled ? (
                    <>
                      <span className={`ecpa-plugin-installed-badge${hasUpdate ? ' has-update' : ''}`}>
                        {hasUpdate ? <Download size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                        {t(hasUpdate ? 'ecpaPlugins.updateAvailable' : 'ecpaPlugins.installed')}
                      </span>
                      {hasUpdate ? (
                        <button type="button" className="primary-button compact-button" disabled={actionBusy || !entry}
                          title={!entry ? unavailable : undefined}
                          onClick={() => {
                            if (!entry) return;
                            setInstallErrors(previous => ({ ...previous, [plugin.id]: '' }));
                            setInstallEntry(entry);
                          }}>
                          {t(isInstalling ? 'ecpaPlugins.installing' : 'ecpaPlugins.update')}
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <button type="button" className="primary-button compact-button"
                      disabled={actionBusy || !entry}
                      title={entry ? undefined : waiting || unavailable}
                      onClick={() => {
                        if (!entry) return;
                        setInstallErrors(previous => ({ ...previous, [plugin.id]: '' }));
                        setInstallEntry(entry);
                      }}>
                      {t(storePending ? 'ecpaPlugins.loadingStore' : isInstalling ? 'ecpaPlugins.installing' : 'ecpaPlugins.install')}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          className="ecpa-plugin-empty"
          icon={<Puzzle size={36} />}
          title={t('ecpaPlugins.emptyFiltered')}
          action={
            hasActiveFilter ? (
              <button
                type="button"
                className="secondary-button"
                onClick={handleClearFilters}
              >
                {t('ecpaPlugins.clearFilters')}
              </button>
            ) : undefined
          }
        />
      )}
      {installEntry && <PluginInstallDialog key={installEntry.storeId} entry={installEntry}
        onClose={() => setInstallEntry(null)} onInstalled={installed}
        onError={error => setInstallErrors(previous => ({ ...previous, [installEntry.id]: error }))} />}
      {confirmationDialog}
    </div>
  );
}
