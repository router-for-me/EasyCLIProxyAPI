import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, Eye, EyeOff, KeyRound, Puzzle, Search, TriangleAlert, X } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { Notice } from '../components/Notice';
import { PluginLogo } from '../components/ProviderLogo';
import { useI18n } from '../i18n';
import { openExternalUrl } from '../services/appSettings';
import {
  clearEcpaGitHubToken,
  buildEcpaStoreMap,
  ECPA_REGISTRY_URL,
  fetchEcpaRegistry,
  getBundledEcpaRegistry,
  isInstallableEcpaEntry,
  resolveEcpaStoreEntry,
  readEcpaGitHubToken,
  writeEcpaGitHubToken,
  type EcpaPluginEntry,
} from '../services/ecpaPlugins';
import { safePluginWebURL } from '../services/pluginResources';
import { getPluginSupport, pluginsApi, pluginStoreApi, type PluginStoreEntry, type PluginStoreInstallResult } from '../services/plugins';
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
  const [supported, setSupported] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [sourceRegistered, setSourceRegistered] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [storeEntries, setStoreEntries] = useState(new Map<string, PluginStoreEntry>());
  const [storeError, setStoreError] = useState('');
  const [installEntry, setInstallEntry] = useState<PluginStoreEntry | null>(null);
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [restartRequired, setRestartRequired] = useState(false);
  const mounted = useRef(false);
  const registrationPending = useRef(false);

  const reloadStore = async () => {
    const result = await pluginStoreApi.list();
    if (!mounted.current) return;
    setStoreEntries(buildEcpaStoreMap(result.plugins));
    setStoreError(result.sourceErrors.filter(source => source.sourceUrl === ECPA_REGISTRY_URL).map(source => source.message).join('; '));
  };

  useEffect(() => {
    let active = true;
    mounted.current = true;
    void getPluginSupport().then(async available => {
      if (!active) return;
      setSupported(available);
      if (!available) return;
      await Promise.all([
        pluginsApi.getSettings().then(settings => {
          if (active) setRegistered(settings.storeSources.includes(ECPA_REGISTRY_URL));
        }),
        pluginStoreApi.list().then(result => {
          if (!active) return;
          setStoreEntries(buildEcpaStoreMap(result.plugins));
          setStoreError(result.sourceErrors.filter(source => source.sourceUrl === ECPA_REGISTRY_URL).map(source => source.message).join('; '));
        }),
      ]);
    }).catch(reason => { if (active) setStoreError(String(reason)); });
    return () => { active = false; mounted.current = false; };
  }, []);

  const registerSource = async () => {
    if (registrationPending.current) return;
    registrationPending.current = true;
    setRegistering(true); setStoreError('');
    try {
      const settings = await pluginsApi.getSettings();
      if (!settings.storeSources.includes(ECPA_REGISTRY_URL)) {
        await pluginsApi.updateSettings({ storeSources: [...settings.storeSources, ECPA_REGISTRY_URL] });
      }
      if (!mounted.current) return;
      setRegistered(true); setSourceRegistered(true);
      await reloadStore();
    } catch (reason) { if (mounted.current) setStoreError(String(reason)); }
    finally { registrationPending.current = false; if (mounted.current) setRegistering(false); }
  };

  const installed = async (result: PluginStoreInstallResult) => {
    setInstallEntry(null);
    if (result.restartRequired) setRestartRequired(true);
    setStoreEntries(previous => buildEcpaStoreMap(Array.from(previous.values()).map(entry =>
      entry.id === result.id ? { ...entry, installed: true } : entry)));
    try { await reloadStore(); }
    catch (reason) { if (mounted.current) setStoreError(String(reason)); }
  };
  const [plugins, setPlugins] = useState<EcpaPluginEntry[]>(() => getBundledEcpaRegistry().plugins);
  const [token, setToken] = useState<string>(() => readEcpaGitHubToken());
  const [showToken, setShowToken] = useState(false);
  const [tokenPanelOpen, setTokenPanelOpen] = useState(false);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [usedFallback, setUsedFallback] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string>(ALL_TAG);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);
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
        setUsedFallback(false);
      } else if (result.usedFallback) {
        setUsedFallback(true);
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
      const haystack = [plugin.id, plugin.name, plugin.description]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [plugins, search, selectedTag]);

  const handleTokenChange = (nextValue: string) => {
    setToken(nextValue);
    setTokenInvalid(false);
    writeEcpaGitHubToken(nextValue);
  };

  const handleClearToken = () => {
    setToken('');
    setTokenInvalid(false);
    clearEcpaGitHubToken();
    tokenInputRef.current?.focus();
  };

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
  const tokenConfigured = Boolean(token.trim());

  return (
    <div className="ecpa-plugins-page" role="region" aria-label={t('ecpaPlugins.title')}>
      <header className="ecpa-plugins-header">
        <div className="ecpa-plugins-heading">
          <h1>{t('ecpaPlugins.title')}</h1>
          <span className="ecpa-plugins-total">{t('ecpaPlugins.resultCount', { count: plugins.length })}</span>
        </div>
        <p className="ecpa-plugins-subtitle">{t('ecpaPlugins.subtitle')}</p>
      </header>
      {supported && !registered && <Notice tone="info" className="ecpa-plugin-banner" action={
        <button type="button" className="secondary-button compact-button" disabled={registering} onClick={() => void registerSource()}>
          {registering ? t('common.loading') : t('ecpaPlugins.registerSource')}
        </button>
      }>{t('ecpaPlugins.registerSourceHint')}</Notice>}
      {sourceRegistered && <Notice tone="info">{t('ecpaPlugins.sourceRegistered')}</Notice>}
      {storeError && <Notice tone="error">{storeError}</Notice>}
      {restartRequired && <Notice tone="info" icon={false} className="plugin-banner" action={
        <button type="button" className="secondary-button" onClick={async () => {
          if (!await askConfirmation({ title: pluginText('restartButton', locale), message: pluginText('restartConfirm', locale) })) return;
          try { await restartCoreProcess(); if (mounted.current) setRestartRequired(false); }
          catch (reason) { if (mounted.current) setStoreError(String(reason)); }
        }}>{pluginText('restartButton', locale)}</button>
      }>{t('ecpaPlugins.restartRequired')}</Notice>}
      {(tokenInvalid || usedFallback) ? (
        <div className="ecpa-plugin-banners">
          {tokenInvalid ? (
            <Notice tone="warn" className="ecpa-plugin-banner">
              {t('ecpaPlugins.token.invalid')}
            </Notice>
          ) : null}
          {usedFallback ? (
            <Notice tone="info" className="ecpa-plugin-banner">
              {t('ecpaPlugins.fallbackHint')}
            </Notice>
          ) : null}
        </div>
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
          className="secondary-button ghost compact-button ecpa-token-toggle"
          aria-expanded={tokenPanelOpen}
          aria-controls="ecpa-token-panel"
          onClick={() => setTokenPanelOpen((open) => !open)}
        >
          <KeyRound size={15} aria-hidden="true" />
          <span>{t('ecpaPlugins.token.label')}</span>
          <span className={`ecpa-token-state${tokenConfigured ? ' is-set' : ''}`}>
            {t(tokenConfigured ? 'ecpaPlugins.token.configured' : 'ecpaPlugins.token.optional')}
          </span>
          <ChevronDown size={14} className="ecpa-token-chevron" aria-hidden="true" />
        </button>
      </div>

      {tokenPanelOpen ? (
        <div className="ecpa-token-panel" id="ecpa-token-panel" role="group" aria-label={t('ecpaPlugins.storeOptions')}>
          <label className="ecpa-token-label" htmlFor="ecpa-github-token-input">
            {t('ecpaPlugins.token.label')}
          </label>
          <div className="ecpa-token-input-wrap">
            <KeyRound size={15} aria-hidden="true" />
            <input
              id="ecpa-github-token-input"
              ref={tokenInputRef}
              type={showToken ? 'text' : 'password'}
              value={token}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => handleTokenChange(event.target.value)}
              placeholder={t('ecpaPlugins.token.placeholder')}
              aria-label={t('ecpaPlugins.token.label')}
            />
            <button
              type="button"
              className="icon-button quiet ghost tiny-button"
              aria-label={t(showToken ? 'ecpaPlugins.token.hide' : 'ecpaPlugins.token.show')}
              title={t(showToken ? 'ecpaPlugins.token.hide' : 'ecpaPlugins.token.show')}
              aria-pressed={showToken}
              onClick={() => setShowToken((current) => !current)}
            >
              {showToken ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="icon-button quiet ghost tiny-button"
              disabled={!token}
              aria-label={t('ecpaPlugins.token.clear')}
              title={t('ecpaPlugins.token.clear')}
              onClick={handleClearToken}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <p className="ecpa-token-hint">{t('ecpaPlugins.token.hint')}</p>
        </div>
      ) : null}

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
            const description = plugin.description;
            const isCopied = copiedId === plugin.id;
            const repoUrl = safePluginWebURL(plugin.repository);
            const entry = resolveEcpaStoreEntry(storeEntries, plugin.id);
            const unavailable = !supported ? t('ecpaPlugins.installUnavailable.unsupported')
              : !isInstallableEcpaEntry(plugin) ? t('ecpaPlugins.installUnavailable.noRepository')
              : !registered ? t('ecpaPlugins.installUnavailable.sourceNotRegistered')
              : !entry ? t('ecpaPlugins.installUnavailable.notFound') : '';
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
                    <span className="ecpa-plugin-version">{plugin.version}</span>
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
                    className="icon-button quiet ecpa-repo-button"
                    disabled={!repoUrl}
                    aria-label={t('ecpaPlugins.openRepo')}
                    title={t('ecpaPlugins.openRepo')}
                    onClick={() => handleOpenRepository(plugin.repository)}
                  >
                    <ExternalLink size={15} aria-hidden="true" />
                  </button>
                  {unavailable ? (
                    <button
                      type="button"
                      className="secondary-button compact-button ecpa-install-blocked"
                      title={unavailable}
                      disabled
                    >
                      {t('ecpaPlugins.install')}
                    </button>
                  ) : entry?.installed === true ? (
                    <span className="ecpa-plugin-installed-badge">
                      <Check size={13} aria-hidden="true" />
                      {t('ecpaPlugins.installed')}
                    </span>
                  ) : (
                    <button type="button" className="primary-button compact-button"
                      disabled={installEntry !== null}
                      onClick={() => {
                        if (!entry) return;
                        setInstallErrors(previous => ({ ...previous, [plugin.id]: '' }));
                        setInstallEntry(entry);
                      }}>
                      {t(installEntry?.id === plugin.id ? 'ecpaPlugins.installing' : 'ecpaPlugins.install')}
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
