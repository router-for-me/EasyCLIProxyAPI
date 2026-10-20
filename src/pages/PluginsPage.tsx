import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Download, ExternalLink, Folder, LogIn, Puzzle, RefreshCw, Search, Settings2, Trash2, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { pluginText } from '../i18n/plugins';
import { FloatingNotice, useAppNotice } from '../appNotice';
import { useConfirmation } from '../components/ConfirmationDialog';
import { PluginBulkTranslationToggle } from '../components/PluginBulkTranslationToggle';
import { pluginsApi, pluginStoreApi, type PluginListEntry, type PluginListResponse, type PluginStoreEntry, type PluginStoreResponse } from '../services/plugins';
import { buildPluginResourceRoute, collectPluginResourceEntries, getPluginTitle, notifyPluginResourcesChanged, type PluginResourceEntry } from '../services/pluginResources';
import { getPluginStatus, isPluginInstalled } from '../services/pluginStatus';
import { formatPluginVersion, refreshPluginReleaseVersions } from '../services/pluginReleaseVersions';
import { waitForPluginInstall, waitForPluginToggle, type PluginActionStatus } from '../services/pluginPolling';
import type { PluginStoreInstallResult } from '../services/plugins';
import { PluginConfigDialog } from './PluginConfigDialog';
import { PluginInstallDialog } from './PluginInstallDialog';
import { PluginStoreCard } from './PluginStoreCard';
import { PluginOAuthDialog } from './PluginOAuthDialog';
import { GitHubTokenHint, isGitHubRateLimit } from './PluginRateLimitHint';
import { PluginSettingsPanel } from './PluginSettingsPanel';
import { pluginTextNeedsChinese } from '../services/pluginTranslation';
import './PluginsPage.css';

type Tab = 'installed' | 'store' | 'settings';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function PluginsPage() {
  const { t, locale } = useI18n();
  const pt = (key: Parameters<typeof pluginText>[0]) => pluginText(key, locale);
  const [tab, setTab] = useState<Tab>('installed');
  const [supported, setSupported] = useState<boolean | null>(null);
  const [data, setData] = useState<PluginListResponse | null>(null);
  const [store, setStore] = useState<PluginStoreResponse | null>(null);
  const [localUpdates, setLocalUpdates] = useState<PluginStoreResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('all');
  const [configPlugin, setConfigPlugin] = useState<PluginListEntry | null>(null);
  const [installEntry, setInstallEntry] = useState<PluginStoreEntry | null>(null);
  const [bulkTranslate, setBulkTranslate] = useState(false);
  const [oauthPlugin, setOAuthPlugin] = useState<PluginListEntry | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const requests = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const notice = useAppNotice();
  const { askConfirmation, confirmationDialog } = useConfirmation();

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++requests.current; }; }, []);
  const load = useCallback(async (target: Tab = tabRef.current, refreshVersions = false) => {
    const revision = ++requests.current;
    setLoading(true); setError('');
    if (target === 'installed') setLocalUpdates(null);
    try {
      const support = await invoke<boolean>('get_plugin_support');
      if (!mounted.current || revision !== requests.current) return;
      setSupported(support);
      if (!support) { setData(null); setStore(null); setLocalUpdates(null); return; }
      const next = await pluginsApi.list();
      if (!mounted.current || revision !== requests.current) return;
      setData(next);
      notifyPluginResourcesChanged();
      if (target === 'store') {
        const nextStore = await pluginStoreApi.list();
        if (mounted.current && revision === requests.current) setStore(nextStore);
      } else if (target === 'installed' && refreshVersions) {
        const nextStore = await pluginStoreApi.list();
        if (!mounted.current || revision !== requests.current) return;
        const installedIDs = new Set(next.plugins.filter(isPluginInstalled).map(plugin => plugin.id));
        const updates = await refreshPluginReleaseVersions({ ...nextStore, plugins: nextStore.plugins.filter(entry =>
          installedIDs.has(entry.id) && entry.installed && ['matched', 'assumed'].includes(entry.installSourceStatus),
        ) });
        if (mounted.current && revision === requests.current) setLocalUpdates(updates);
      }
    } catch (reason) { if (mounted.current && revision === requests.current) setError(message(reason)); }
    finally { if (mounted.current && revision === requests.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(tab); }, [tab, load]);

  // Follow existing files for a bounded period after config writes. Missing
  // binaries cannot load by waiting, and the API does not report loading progress.
  const pendingPlugins = data?.pluginsEnabled
    ? data.plugins.filter(plugin => plugin.path && plugin.enabled && !plugin.effectiveEnabled).map(plugin => plugin.id).sort().join('|')
    : '';
  useEffect(() => {
    if (!pendingPlugins || busy || loading || restartRequired || installEntry) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const revision = requests.current;
    const poll = async () => {
      try {
        const next = await pluginsApi.list();
        if (cancelled || requests.current !== revision) return;
        setData(next);
        notifyPluginResourcesChanged();
      } catch { /* The manual refresh exposes errors without replacing action feedback. */ }
      if (!cancelled && ++attempts < 8) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pendingPlugins, busy, loading, restartRequired, installEntry]);

  const mutate = async (operation: () => Promise<unknown>, success: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    ++requests.current;
    try {
      await operation();
      if (!mounted.current) return;
      notice.showNotice(success, 'success');
      await load();
    } catch (reason) { if (mounted.current) setError(message(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const reportStatus = (status: PluginActionStatus, success: string) => {
    if (!mounted.current || status === 'cancelled') return;
    notice.showNotice(status === 'ready' ? success : pt(status === 'restart' ? 'restart' : status === 'globalDisabled' ? 'disabledHint' : 'runtimePending'), status === 'ready' ? 'success' : 'info');
  };
  const toggle = async (plugin: PluginListEntry) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    ++requests.current;
    let written = false;
    try {
      await pluginsApi.updateEnabled(plugin.id, !plugin.enabled);
      written = true;
      const status = await waitForPluginToggle(plugin.id, !plugin.enabled, () => !mounted.current);
      reportStatus(status, pt('runtimeReady'));
      if (mounted.current) await load();
    } catch (reason) {
      if (mounted.current) setError(`${written ? pt('refreshFailed') + ' ' : ''}${message(reason)}`);
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const installed = async (result: PluginStoreInstallResult) => {
    ++requests.current;
    setRestartRequired(previous => previous || result.restartRequired);
    try {
      reportStatus(await waitForPluginInstall(result, () => !mounted.current), pt('installedSuccess'));
    } catch (reason) {
      // Installation already succeeded. A failed status read must never invite a duplicate install.
      if (mounted.current) notice.showNotice(`${pt('refreshFailed')} ${message(reason)}`, 'info');
    } finally {
      if (mounted.current) { setInstallEntry(null); notifyPluginResourcesChanged(); }
    }
    if (mounted.current) await load();
  };
  const remove = async (plugin: PluginListEntry) => {
    const installed = isPluginInstalled(plugin);
    const label = pt(installed ? 'remove' : 'removeConfig');
    const accepted = await askConfirmation({ title: `${label} · ${getPluginTitle(plugin)}`, message: pt(installed ? 'removeHint' : 'removeConfigHint'), confirmText: label, variant: 'danger' });
    if (!accepted || !mounted.current) return;
    await mutate(async () => {
      const result = await pluginsApi.deletePlugin(plugin.id);
      if (mounted.current && result.restartRequired) setRestartRequired(true);
    }, pt(installed ? 'removed' : 'removedConfig'));
  };
  const installLocal = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const selected = await open({ multiple: false, directory: false, title: pt('localInstall'), filters: [{ name: pt('localBinary'), extensions: ['dll', 'so', 'dylib'] }] });
      if (!selected || !mounted.current) return;
      const filename = selected.split(/[\\/]/).pop() || selected;
      if (!await askConfirmation({ title: pt('localInstall'), message: `${filename}\n\n${pt('localTrust')}`, confirmText: pt('install') }) || !mounted.current) return;
      const path = await invoke<string>('install_local_plugin', { source: selected });
      if (!mounted.current) return;
      setRestartRequired(true);
      setSearch(''); setFilter('all'); setTab('installed');
      notice.showNotice(`${pt('localInstalled')} ${path}`, 'info');
      notifyPluginResourcesChanged();
      await load('installed');
    } catch (reason) { if (mounted.current) setError(message(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const openResource = (entry: PluginResourceEntry) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: buildPluginResourceRoute(entry.pluginID, entry.menuIndex) }));
  const matches = (values: (string | undefined)[]) => values.join(' ').toLowerCase().includes(search.trim().toLowerCase());
  const plugins = (data?.plugins ?? []).filter(plugin => matches([plugin.id, plugin.metadata?.name, plugin.metadata?.author]));
  const storePlugins = (store?.plugins ?? []).filter(plugin => matches([plugin.id, plugin.name, plugin.description, plugin.author, ...plugin.tags]) && (filter === 'all' || (filter === 'installed' && plugin.installed) || (filter === 'updates' && plugin.updateAvailable)));
  const sourceErrors = (tab === 'installed' ? localUpdates : store)?.sourceErrors ?? [];
  const translationCount = (store?.plugins ?? []).filter(entry => pluginTextNeedsChinese(entry.description, locale)).length;
  const locked = busy || loading || Boolean(configPlugin || installEntry || oauthPlugin);

  return <div className="plugins-page" role="region" aria-label={pt('title')}>
    <div className="plugin-navigation">
      {supported === true && <nav className="plugin-tabs" aria-label={pt('title')}>{(['installed', 'store', 'settings'] as const).map(value => <button key={value} className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined} disabled={busy} onClick={() => { setTab(value); setSearch(''); setFilter('all'); }}>{pt(value === 'installed' ? 'local' : value)}</button>)}</nav>}
      <div className="plugin-toolbar">
        {supported === true && tab !== 'settings' && <>
        <div className="plugin-search">
          <Search size={17} aria-hidden="true" />
          <input ref={searchRef} type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={pt('search')} aria-label={pt('search')} />
          <button type="button" className="plugin-search-clear" disabled={!search} aria-label={t('common.clear')} title={t('common.clear')}
            onClick={() => { setSearch(''); searchRef.current?.focus(); }}><X size={15} aria-hidden="true" /></button>
        </div>
        {tab === 'store' && <select aria-label={pt('store')} value={filter} onChange={e => setFilter(e.target.value)}>{['all', 'installed', 'updates'].map(value => <option key={value} value={value}>{pt(value as 'all' | 'installed' | 'updates')}</option>)}</select>}
        </>}
        {supported === true && tab === 'store' && translationCount > 0 && <PluginBulkTranslationToggle active={bulkTranslate} count={translationCount} disabled={locked || loading} onToggle={setBulkTranslate} />}
        {supported === true && <button type="button" className="secondary-button plugin-development-guide" disabled={locked} onClick={() => void installLocal()}><Download size={16} aria-hidden="true" />{pt('localInstall')}</button>}
        <button type="button" className="secondary-button plugin-development-guide" onClick={() => void invoke('open_external_url', { url: 'https://help.router-for.me/cn/plugin/development.html' }).catch(reason => { if (mounted.current) setError(message(reason)); })}><ExternalLink size={16} aria-hidden="true" />{pt('developmentGuide')}</button>
        <button className="secondary-button plugin-refresh" disabled={locked} onClick={() => void load(tabRef.current, true)}><RefreshCw size={16} aria-hidden="true" />{t('common.refresh')}</button>
      </div>
    </div>
    {error && <div className="plugin-error plugin-banner" role="alert"><span>{error}{isGitHubRateLimit(error) ? <GitHubTokenHint /> : null}</span><button className="secondary-button" disabled={busy || loading} onClick={() => void load(tabRef.current, true)}>{pt('retry')}</button></div>}
    {supported === false ? <section className="plugin-empty"><Puzzle size={36} /><p>{pt('unsupported')}</p></section> : supported === null ? <section className="plugin-empty" role="status">{loading ? t('common.loading') : pt('retry')}</section> : <>
      {data && !data.pluginsEnabled && <p className="plugin-banner">{pt('disabledHint')}</p>}
      {restartRequired && <div className="plugin-banner"><span>{pt('restart')}</span><button className="secondary-button" disabled={locked} onClick={async () => { if (await askConfirmation({ title: pt('restartButton'), message: pt('restartConfirm') })) void mutate(async () => { await invoke('restart_core_process'); if (mounted.current) setRestartRequired(false); }, pt('saved')); }}>{pt('restartButton')}</button></div>}
      <>
        {tab === 'settings' ? <PluginSettingsPanel onSaved={() => { notice.showNotice(pt('saved')); void load(); }} globalControl={<label className="plugin-global-toggle"><input type="checkbox" checked={data?.pluginsEnabled ?? false} disabled={locked || !data} onChange={e => { const enabled = e.target.checked; void mutate(() => pluginsApi.updateSettings({ enabled }), pt('saved')); }} />{pt('global')}</label>} /> : <>
          {sourceErrors.length ? <details className="plugin-source-errors"><summary>{pt('sourceErrors')}</summary>{sourceErrors.map((entry, index) => <p key={index}>{entry.sourceName || entry.sourceId || entry.sourceUrl}: {entry.message}</p>)}{sourceErrors.some(entry => isGitHubRateLimit(entry.message)) ? <GitHubTokenHint /> : null}</details> : null}
          {loading && <p className="plugin-loading" role="status">{t('common.loading')}…</p>}
          {tab === 'installed' ? <div className="plugin-grid">{plugins.map(plugin => {
            const status = getPluginStatus(plugin, data?.pluginsEnabled ?? false);
            const installed = isPluginInstalled(plugin);
            const update = localUpdates?.plugins.find(entry => entry.id === plugin.id && entry.updateAvailable);
            const versionLabel = formatPluginVersion(update?.installedVersion || plugin.metadata?.version || '');
            const updateLabel = update ? `${update.installedVersion} → ${update.version}` : '';
            const versionContent = updateLabel
              ? <span className="plugin-version-available">{updateLabel}</span>
              : versionLabel
                ? <span className="plugin-version-badge"><span>{pt('version')}</span><code>{versionLabel}</code></span>
                : null;
            const removeLabel = `${pt(installed ? 'remove' : 'removeConfig')} ${getPluginTitle(plugin)}`;
            return <article className="plugin-card plugin-local-card" key={plugin.id}>
            <div className="plugin-card-title"><span className="plugin-icon"><Puzzle size={23} /></span><div><h2>{getPluginTitle(plugin)}</h2>{getPluginTitle(plugin) !== plugin.id && <code>{plugin.id}</code>}</div><span className={`plugin-badge ${status === 'active' ? 'active' : status === 'missingFile' || status === 'notLoaded' ? 'warning' : ''}`}>{pt(status)}</span></div>
            {(versionContent || plugin.metadata?.author) && <p className="plugin-version-line">{versionContent}{plugin.metadata?.author && <span>{plugin.metadata.author}</span>}</p>}{plugin.path && <p className="plugin-path" title={plugin.path}>{plugin.path}</p>}
            {status === 'missingFile' && <p className="plugin-card-description">{pt('missingFileHint')}</p>}
            {status === 'notLoaded' && <p className="plugin-card-description">{pt('notLoadedHint')}</p>}
            {collectPluginResourceEntries([plugin]).length > 0 && <div className="plugin-menus">{collectPluginResourceEntries([plugin]).map(entry => <button key={entry.menuIndex} title={entry.description} className="secondary-button" disabled={locked} onClick={() => openResource(entry)}><ExternalLink size={14} />{entry.label}</button>)}</div>}
            <div className="plugin-card-actions">
            {plugin.effectiveEnabled && plugin.supportsOAuth && plugin.oauthProvider && <button className="secondary-button" disabled={locked} onClick={() => setOAuthPlugin(plugin)}><LogIn size={15} />{pt('oauth')}</button>}
              {installed ? <button className="secondary-button" disabled={locked} onClick={() => void toggle(plugin)}>{pt(plugin.enabled ? 'disabled' : 'enabled')}</button> : <button className="secondary-button" disabled={locked} onClick={() => { setSearch(plugin.id); setFilter('all'); setTab('store'); }}><Download size={15} />{pt('findInStore')}</button>}
              <button className="secondary-button" disabled={locked} onClick={() => setConfigPlugin(plugin)}><Settings2 size={15} />{pt('configure')}</button>
              {installed && update && <button className="primary-button plugin-update-action" disabled={locked || (update.authRequired && !update.authConfigured)} onClick={() => setInstallEntry(update)}><Download size={15} />{pt(update.authRequired && !update.authConfigured ? 'authMissing' : 'update')}</button>}
              {status === 'notLoaded' && <button className="secondary-button" disabled={locked} onClick={() => void invoke('open_core_logs_directory').catch(reason => { if (mounted.current) setError(message(reason)); })}><Folder size={15} />{pt('openLogs')}</button>}
              <button className="icon-button quiet plugin-delete" disabled={locked} aria-label={removeLabel} title={removeLabel} onClick={() => void remove(plugin)}><Trash2 size={16} /></button>
            </div>
          </article>; })}</div> : <>
            <div className="plugin-grid">{storePlugins.map(entry => <PluginStoreCard key={entry.storeId} entry={entry} locked={locked} bulkTranslate={bulkTranslate} onOpen={() => setInstallEntry(entry)} />)}</div>
          </>}
          {!loading && !error && (tab === 'installed' ? !plugins.length : !storePlugins.length) && <section className="plugin-empty"><Puzzle size={36} /><h2>{pt(search || filter !== 'all' ? 'noMatches' : 'empty')}</h2>{tab === 'installed' && !search && <><p>{pt('emptyHint')}</p><button className="primary-button" onClick={() => setTab('store')}>{pt('store')}</button></>}</section>}
        </>}
      </>
    </>}
    {configPlugin && <PluginConfigDialog plugin={configPlugin} onClose={() => setConfigPlugin(null)} onSaved={() => { notice.showNotice(pt('saved')); void load(); }} />}
    {installEntry && <PluginInstallDialog key={installEntry.storeId} entry={installEntry} autoTranslate={bulkTranslate} onClose={() => setInstallEntry(null)} onInstalled={installed} />}
    {oauthPlugin && <PluginOAuthDialog plugin={oauthPlugin} onClose={() => setOAuthPlugin(null)} onCompleted={() => { notice.showNotice(pt('authorized')); void load(); }} />}
    {confirmationDialog}<FloatingNotice notice={notice.notice} onDismiss={notice.clearNotice} />
  </div>;
}
