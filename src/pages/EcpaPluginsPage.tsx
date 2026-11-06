import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Eye, EyeOff, KeyRound, Puzzle, Search, X } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { Notice } from '../components/Notice';
import { PluginLogo } from '../components/ProviderLogo';
import { useI18n } from '../i18n';
import { openExternalUrl } from '../services/appSettings';
import {
  clearEcpaGitHubToken,
  fetchEcpaRegistry,
  getBundledEcpaRegistry,
  readEcpaGitHubToken,
  writeEcpaGitHubToken,
  type EcpaPluginEntry,
} from '../services/ecpaPlugins';
import { safePluginWebURL } from '../services/pluginResources';
import './EcpaPluginsPage.css';

const COPY_FEEDBACK_MS = 1500;
const ALL_TAG = '';

export function EcpaPluginsPage() {
  const { t } = useI18n();
  const [plugins, setPlugins] = useState<EcpaPluginEntry[]>(() => getBundledEcpaRegistry().plugins);
  const [token, setToken] = useState<string>(() => readEcpaGitHubToken());
  const [showToken, setShowToken] = useState(false);
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

  return (
    <div className="ecpa-plugins-page" role="region" aria-label={t('ecpaPlugins.title')}>
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

        <div className="ecpa-token-field">
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
        </div>
      </div>

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

      {filteredPlugins.length > 0 ? (
        <div className="ecpa-plugin-grid">
          {filteredPlugins.map((plugin) => {
            const description = plugin.description;
            const isCopied = copiedId === plugin.id;
            const repoUrl = safePluginWebURL(plugin.repository);
            return (
              <article
                key={plugin.id}
                className="surface-card ecpa-plugin-card"
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
                    className="primary-button compact-button"
                    disabled={!repoUrl}
                    onClick={() => handleOpenRepository(plugin.repository)}
                  >
                    <ExternalLink size={15} aria-hidden="true" />
                    {t('ecpaPlugins.openRepo')}
                  </button>
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
    </div>
  );
}
