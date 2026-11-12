import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Check, ChevronDown, Copy, Download, ExternalLink, KeyRound, Puzzle, RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { EmptyState } from '../components/EmptyState';
import { Notice } from '../components/Notice';
import { PluginLogo } from '../components/ProviderLogo';
import { useI18n } from '../i18n';
import { openExternalUrl } from '../services/appSettings';
import {
  buildEcpaStoreMap,
  ECPA_REGISTRY_URL,
  fetchEcpaRegistry,
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
// Chips outside this many are offered in the picker panel only, so the filter
// row stays one line at every tag count.
const TAG_ROW_LIMIT = 6;

// The registry entry may carry an auth flag even though the bundled parser does
// not surface it. Read it defensively so a synthesized store entry matches the
// fields the core listing would expose.
type InstallableEcpaPlugin = EcpaPluginEntry & { authRequired?: boolean };

// When the management store listing is unavailable, the featured registry the
// page already holds is enough to present and start an install. The entry uses
// the real listing's field names so the install dialog and store API accept it.
function synthesizeEcpaStoreEntry(plugin: InstallableEcpaPlugin): PluginStoreEntry {
  return {
    storeId: `${ECPA_REGISTRY_URL}#${plugin.id}`,
    sourceId: ECPA_REGISTRY_URL,
    sourceName: 'ECPA',
    sourceUrl: ECPA_REGISTRY_URL,
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    author: plugin.author,
    version: plugin.version,
    repository: plugin.repository,
    installType: plugin.install?.type ?? '',
    authRequired: plugin.authRequired ?? false,
    authConfigured: true,
    platforms: [],
    logo: plugin.logo,
    homepage: plugin.homepage,
    license: plugin.license,
    tags: plugin.tags,
    locales: plugin.locales,
    installed: false,
    installedVersion: '',
    installedSourceId: '',
    installSourceStatus: '',
    path: '',
    configured: false,
    registered: false,
    enabled: false,
    effectiveEnabled: false,
    updateAvailable: false,
  };
}

// Floating multi-select panel for the tag filter. It is portalled so the results
// grid can never be pushed down by it, anchored under its trigger, and it closes
// on an outside click or Escape (handled by the page).
function TagPickerPanel({
  anchorRef,
  allTags,
  selectedTags,
  onToggle,
  onClear,
  label,
  clearLabel,
  emptyLabel,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  allTags: string[];
  selectedTags: string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
  label: string;
  clearLabel: string;
  emptyLabel: string;
}) {
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The panel follows its trigger while it is open (the row gains a selection
  // badge, and cards may reflow), and it never runs past the viewport: when the
  // space below is short it opens upwards, and the option list scrolls inside the
  // panel instead of clipping its last row.
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const edgeGap = 12;
      const triggerGap = 6;
      const width = Math.min(320, Math.max(240, rect.width * 3));
      const left = Math.min(Math.max(edgeGap, rect.left - width + rect.width), window.innerWidth - edgeGap - width);
      const spaceBelow = window.innerHeight - rect.bottom - triggerGap - edgeGap;
      const spaceAbove = rect.top - triggerGap - edgeGap;
      const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(160, Math.min(420, openUp ? spaceAbove : spaceBelow));
      const top = openUp ? Math.max(edgeGap, rect.top - triggerGap - maxHeight) : rect.bottom + triggerGap;
      setPosition({ top, left, width, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef, selectedTags]);

  // Keep the focused option visible after each toggle rather than letting the
  // list jump back to the top.
  useEffect(() => {
    const active = panelRef.current?.querySelector<HTMLButtonElement>('.ecpa-tag-picker-option.selected');
    active?.scrollIntoView({ block: 'nearest' });
  }, [selectedTags]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>('.ecpa-tag-picker-option')?.focus();
  }, []);

  if (!position) return null;

  return (
    <div
      ref={panelRef}
      className="ecpa-tag-picker-panel"
      role="dialog"
      aria-label={label}
      style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
    >
      {allTags.length === 0 ? (
        <p className="ecpa-tag-picker-empty">{emptyLabel}</p>
      ) : (
        <div className="ecpa-tag-picker-options" role="group" aria-label={label}>
          {allTags.map((tag) => {
            const active = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                role="checkbox"
                aria-checked={active}
                className={`ecpa-tag-picker-option${active ? ' selected' : ''}`}
                title={tag}
                onClick={() => onToggle(tag)}
              >
                <span className="ecpa-tag-picker-check" aria-hidden="true">
                  {active ? <Check size={12} /> : null}
                </span>
                <span className="ecpa-tag-picker-label">{tag}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="ecpa-tag-picker-footer">
        <button type="button" className="link-button muted ecpa-tag-picker-clear" onClick={onClear}>{clearLabel}</button>
      </div>
    </div>
  );
}

// Shared one-line tag filter used by the featured grid and the official store
// tab. The caller owns the selected list; the row keeps to a single line and the
// picker panel floats above the results.
export function TagFilterRow({
  allTags,
  selectedTags,
  onToggle,
  onClear,
  label,
  allLabel,
  pickerLabel,
  clearLabel,
  emptyLabel,
}: {
  allTags: string[];
  selectedTags: string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
  label: string;
  allLabel: string;
  pickerLabel: string;
  clearLabel: string;
  emptyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.ecpa-tag-picker') || target?.closest('.ecpa-tag-picker-panel')) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visibleTags = useMemo(() => {
    const picked = selectedTags.filter((tag) => allTags.includes(tag));
    const rest = allTags.filter((tag) => !picked.includes(tag));
    return [...picked, ...rest].slice(0, TAG_ROW_LIMIT);
  }, [allTags, selectedTags]);

  return (
    <div className="ecpa-tag-bar" role="group" aria-label={label}>
      <button
        type="button"
        className={`filter-chip ecpa-tag-chip${selectedTags.length === 0 ? ' active' : ''}`}
        aria-pressed={selectedTags.length === 0}
        onClick={onClear}
      >
        {allLabel}
      </button>
      <div className="ecpa-tag-shortcuts">
        {visibleTags.map((tag) => {
          const active = selectedTags.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              className={`filter-chip ecpa-tag-chip${active ? ' active' : ''}`}
              aria-pressed={active}
              onClick={() => onToggle(tag)}
            >
              {active ? <Check size={12} aria-hidden="true" /> : null}
              {tag}
            </button>
          );
        })}
      </div>
      {allTags.length > 0 ? (
        <div className={`ecpa-tag-picker${open ? ' open' : ''}`}>
          <button
            ref={buttonRef}
            type="button"
            className="filter-chip ecpa-tag-picker-trigger"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={pickerLabel}
            title={pickerLabel}
            onClick={() => setOpen((value) => !value)}
          >
            <span>{pickerLabel}</span>
            {selectedTags.length > 0 ? <span className="ecpa-tag-picker-count">{selectedTags.length}</span> : null}
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          {open ? createPortal(
            <TagPickerPanel
              anchorRef={buttonRef}
              allTags={allTags}
              selectedTags={selectedTags}
              onToggle={onToggle}
              onClear={onClear}
              label={label}
              clearLabel={clearLabel}
              emptyLabel={emptyLabel}
            />,
            document.body,
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

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
  const [registryError, setRegistryError] = useState('');
  const [installEntry, setInstallEntry] = useState<PluginStoreEntry | null>(null);
  // A fallback install retried after source registration has no open dialog, so
  // its own state keeps the other cards disabled until it settles.
  const [installRetryId, setInstallRetryId] = useState('');
  // A source-conflict retry removes the previously installed copy first, so its
  // card names that step while the install runs again.
  const [sourceSwitchId, setSourceSwitchId] = useState('');
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [restartRequired, setRestartRequired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  // The dialog installs a synthesized entry when the store listing had none. A
  // source registration retry is only attempted for that fallback path.
  const installSynthesized = useRef(false);
  // A source conflict retry must repeat the requested action, so an update keeps
  // asking for the entry version instead of falling back to the latest build.
  const installAsUpdate = useRef(false);
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
      if (result.registry) {
        setPlugins(result.registry.plugins);
        setRegistryError("");
      } else {
        // A failed refresh must clear the stale list and say so, exactly like the
        // initial load; otherwise recovery keeps a false failure banner around.
        setPlugins([]);
        setRegistryError(pluginText("registryLoadFailed", locale));
      }
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
    installSynthesized.current = false;
    installAsUpdate.current = false;
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
  // A conflict means the plugin is already installed from a different store
  // source. The owner decided the existing copy is removed and the requested
  // install or update continues, without a manual step in between.
  const handleSourceConflict = async (entry: PluginStoreEntry, error: string): Promise<boolean> => {
    const surface = (message: string) => setInstallErrors(previous => ({ ...previous, [entry.id]: message }));
    if (!error.includes('plugin_store_source_conflict')) return false;
    // The dialog belongs to the failed attempt: close it and let the card carry
    // the progress through the existing retry state.
    installSynthesized.current = false;
    setInstallEntry(null);
    setInstallRetryId(entry.id);
    setSourceSwitchId(entry.id);
    surface('');
    let removedRestartRequired = false;
    try {
      const removal = await pluginsApi.deletePlugin(entry.id);
      removedRestartRequired = removal.restartRequired;
      // The listing still reports the removed copy, so re-read it before the
      // retry to keep the source switch installable.
      try {
        applyStoreResult(await pluginStoreApi.list(), storeSeq.current);
      } catch {
        // A failed refresh keeps the previous listing; the retry still decides.
      }
      const result = await pluginStoreApi.install(entry.id, {
        sourceId: entry.sourceId,
        ...(installAsUpdate.current ? { version: entry.version } : {}),
      });
      if (removedRestartRequired || result.restartRequired) {
        // One notice only, after the reinstall settled.
        if (mounted.current) setRestartRequired(true);
      }
      if (mounted.current) await installed(result);
    } catch (reason) {
      if (mounted.current) surface(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) {
        setInstallRetryId('');
        setSourceSwitchId('');
      }
    }
    return true;
  };
  // A synthesized entry can name a source identity the core has not registered
  // yet. Register it once and retry the install; a second failure is reported
  // in the card notice instead of silently doing nothing.
  const handleInstallError = async (entry: PluginStoreEntry, error: string) => {
    const surface = (message: string) => setInstallErrors(previous => ({ ...previous, [entry.id]: message }));
    // A source conflict also happens for a real store entry, so it is handled
    // before the synthesized-entry gate.
    if (error.includes('plugin_store_source_conflict')) {
      await handleSourceConflict(entry, error);
      return;
    }
    if (!installSynthesized.current
      || (!error.includes('plugin_store_registry_failed') && !error.includes('plugin_store_source'))) {
      surface(error);
      return;
    }
    // The fallback entry was rejected because its source is not registered yet.
    // Close the dialog, register the source, and retry once from the card notice.
    installSynthesized.current = false;
    setInstallEntry(null);
    setInstallRetryId(entry.id);
    surface('');
    try {
      const settings = await pluginsApi.getSettings();
      await pluginsApi.updateSettings({
        storeSources: settings.storeSources.includes(ECPA_REGISTRY_URL)
          ? settings.storeSources
          : [...settings.storeSources, ECPA_REGISTRY_URL],
      });
      if (mounted.current) setRegistered(true);
      const result = await pluginStoreApi.install(entry.id, { sourceId: entry.sourceId });
      if (mounted.current) await installed(result);
    } catch (reason) {
      if (mounted.current) surface(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setInstallRetryId('');
    }
  };
  const [plugins, setPlugins] = useState<EcpaPluginEntry[]>([]);
  // A token previously entered here still applies; new tokens are configured in
  // Settings > Server > GitHub Token (see openSettingField below).
  const token = useMemo(() => readEcpaGitHubToken(), []);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [search, setSearch] = useState('');
  // Tags are multi-select: no entry means every tag is allowed. The filter row
  // shows one line of chips and keeps the rest behind a picker panel, so a long
  // tag list never pushes the results down.
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
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
        setRegistryError('');
        return;
      }
      // A failed read must not keep a previous list on screen.
      setPlugins([]);
      setRegistryError(pluginText('registryLoadFailed', locale));
    });

    return () => {
      controller.abort();
    };
  }, [token, locale]);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const plugin of plugins) {
      for (const tag of plugin.tags) {
        if (tag) tagSet.add(tag);
      }
    }
    return Array.from(tagSet);
  }, [plugins]);

  // A tag that disappears from the registry must not keep filtering silently.
  useEffect(() => {
    setSelectedTags((current) => {
      const kept = current.filter((tag) => allTags.includes(tag));
      return kept.length === current.length ? current : kept;
    });
  }, [allTags]);


  const filteredPlugins = useMemo(() => {
    const query = search.trim().toLowerCase();
    return plugins.filter((plugin) => {
      if (selectedTags.length > 0 && !selectedTags.some((tag) => plugin.tags.includes(tag))) {
        return false;
      }
      if (!query) return true;
      const haystack = [plugin.id, plugin.name, plugin.description, getEcpaPluginDescription(plugin, locale)]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [plugins, search, selectedTags, locale]);

  const handleClearFilters = () => {
    setSearch('');
    setSelectedTags([]);
    searchRef.current?.focus();
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((current) => current.includes(tag)
      ? current.filter((value) => value !== tag)
      : [...current, tag]);
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

  const hasActiveFilter = Boolean(search.trim()) || selectedTags.length > 0;

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
      {(storeError || registryError) && <Notice tone="error">{storeError || registryError}{isGitHubRateLimit(storeError) ? <GitHubTokenHint /> : null}</Notice>}
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
        <TagFilterRow
          allTags={allTags}
          selectedTags={selectedTags}
          onToggle={toggleTag}
          onClear={() => setSelectedTags([])}
          label={t('ecpaPlugins.tagFilter')}
          allLabel={t('ecpaPlugins.tagAll')}
          pickerLabel={t('ecpaPlugins.tagPicker')}
          clearLabel={t('ecpaPlugins.tagPickerClear')}
          emptyLabel={t('ecpaPlugins.tagPickerEmpty')}
        />
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
            const listedEntry = resolveEcpaStoreEntry(storeEntries, plugin.id);
            // Once the store list has settled, an installable registry plugin may fall
            // back to an entry synthesized from the registry itself as soon as source
            // registration was at least attempted. A store listing error also enables
            // the fallback and stays visible in the notice above: the button is the
            // user's retry path that registers the source. A core without plugin
            // support keeps the card in its existing state.
            const canSynthesize = storeLoaded && supported !== false
              && (registered !== null || Boolean(storeError));
            const entry = listedEntry ?? (canSynthesize && isInstallableEcpaEntry(plugin)
              ? synthesizeEcpaStoreEntry(plugin)
              : undefined);
            const isInstalling = installEntry?.id === plugin.id || installRetryId === plugin.id;
            // A source-conflict retry removes the copy installed from the other
            // source first, so the card names that step instead of looking idle.
            const isSwitchingSource = isInstalling && sourceSwitchId === plugin.id;
            // An install confirmed in this session renders as installed even when
            // the store list still reports it as missing.
            const confirmedVersion = confirmedInstalls.current.get(plugin.id);
            const isInstalled = entry?.installed === true || confirmedVersion !== undefined;
            const installedVersion = entry?.installed ? entry.installedVersion : confirmedVersion;
            const hasUpdate = isInstalled && isStoreUpdateAvailable(installedVersion, entry?.version);
            // An installed entry from the listing or a synthesized fallback entry is
            // what gates install. Without either, the settled state names a reason
            // instead of offering a silent grey button. The operation in progress is
            // the one other reason a click is not offered right now.
            const actionBusy = installEntry !== null || Boolean(installRetryId);
            // `null` keeps the card neutral while the store list is still in
            // flight; every settled case names a reason so a button is never
            // silently grey.
            let unavailable = '';
            let waiting = '';
            if (!entry) {
              if (!isInstallableEcpaEntry(plugin)) unavailable = t('ecpaPlugins.installUnavailable.noRepository');
              else if (supported === false) unavailable = t('ecpaPlugins.installUnavailable.unsupported');
              else if (registered === false) unavailable = t('ecpaPlugins.installUnavailable.sourceNotRegistered');
              else if (!storeLoaded || registered === null) waiting = t('ecpaPlugins.loadingStore');
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
                  <span className="ecpa-plugin-action-slot">
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
                            title={isSwitchingSource ? t('ecpaPlugins.sourceSwitch') : !entry ? unavailable : undefined}
                            onClick={() => {
                              if (!entry) return;
                              installSynthesized.current = !listedEntry;
                              installAsUpdate.current = true;
                              setInstallErrors(previous => ({ ...previous, [plugin.id]: '' }));
                              setInstallEntry(entry);
                            }}>
                            {t(isSwitchingSource ? 'ecpaPlugins.sourceSwitch' : isInstalling ? 'ecpaPlugins.installing' : 'ecpaPlugins.update')}
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <button type="button" className="primary-button compact-button"
                        disabled={actionBusy || !entry}
                        title={isSwitchingSource ? t('ecpaPlugins.sourceSwitch') : entry ? undefined : waiting || unavailable}
                        aria-busy={storePending || undefined}
                        onClick={() => {
                          if (!entry) return;
                          installSynthesized.current = !listedEntry;
                          installAsUpdate.current = false;
                          setInstallErrors(previous => ({ ...previous, [plugin.id]: '' }));
                          setInstallEntry(entry);
                        }}>
                        {storePending ? <RefreshCw size={14} className="spin" aria-hidden="true" /> : null}
                        {t(storePending ? 'common.loading' : isSwitchingSource ? 'ecpaPlugins.sourceSwitch' : isInstalling ? 'ecpaPlugins.installing' : 'ecpaPlugins.install')}
                      </button>
                    )}
                  </span>
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
        onClose={() => { installSynthesized.current = false; installAsUpdate.current = false; setInstallEntry(null); }} onInstalled={installed}
        onError={error => void handleInstallError(installEntry, error)} />}
      {confirmationDialog}
    </div>
  );
}
