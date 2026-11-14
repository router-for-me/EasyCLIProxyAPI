import { Notice } from '../components/Notice';
import { getPluginSupport, pluginsApi, type PluginListEntry } from '../services/plugins';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, LogIn, RefreshCw, UserRound } from 'lucide-react';
import { PluginLogo } from '../components/ProviderLogo';
import { useI18n } from '../i18n';
import { usePrivacyMask } from '../privacy';
import { pluginOAuthText } from '../i18n/pluginOAuth';
import { collectPluginOAuthProviders } from '../services/pluginOAuthProviders';
import { getPluginTitle, PLUGIN_RESOURCES_REFRESH_EVENT } from '../services/pluginResources';
import { groupOAuthAccountsByProvider, normalizeOAuthProvider, type OAuthAccountSummary } from '../services/authFiles';
import { managementApi, responseList } from '../services/managementApi';
import { PluginOAuthDialog } from './PluginOAuthDialog';
import './PluginOAuthProviders.css';

const OAUTH_ACCOUNT_PREVIEW_LIMIT = 3;

export function PluginOAuthProviders({ builtInProviderIds, browser = 'default', onOpenAuthFiles }: {
  builtInProviderIds: readonly string[];
  browser?: string;
  onOpenAuthFiles?: (provider?: string) => void;
}) {
  const { t, locale } = useI18n();
  const privacy = usePrivacyMask();
  const [plugins, setPlugins] = useState<PluginListEntry[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [completed, setCompleted] = useState<Set<string>>(() => new Set());
  const [accounts, setAccounts] = useState<Map<string, OAuthAccountSummary[]> | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(false);
  const retryTimer = useRef<number | undefined>(undefined);

  const load = useCallback(() => {
    window.clearTimeout(retryTimer.current);
    const current = ++revision.current;
    setLoading(true);
    setError(false);
    const active = () => mounted.current && current === revision.current;
    const refresh = async (attempt: number) => {
      try {
        if (attempt === 0) {
          const supported = await getPluginSupport();
          if (!active()) return;
          if (!supported) {
            setPlugins([]);
            setSelectedProvider(null);
            return;
          }
        }
        const response = await pluginsApi.list();
        if (!active()) return;
        const next = response.pluginsEnabled
          ? collectPluginOAuthProviders(response.plugins, builtInProviderIds) : [];
        setPlugins(next);
        setSelectedProvider(previous => next.some(plugin => plugin.oauthProvider === previous) ? previous : null);
        // Installation can finish before the core registers the plugin. Keep following
        // that transition even if the user has already left the plugin manager.
        if (attempt < 8 && response.pluginsEnabled
          && response.plugins.some(plugin => plugin.path && plugin.enabled && !plugin.effectiveEnabled)) {
          retryTimer.current = window.setTimeout(() => {
            if (active()) void refresh(attempt + 1);
          }, 1500);
        }
      } catch {
        if (active()) {
          setPlugins([]);
          setSelectedProvider(null);
          setError(true);
        }
      } finally {
        if (active()) setLoading(false);
      }
    };
    return refresh(0);
  }, [builtInProviderIds]);

  const loadAccounts = useCallback(async () => {
    try {
      const payload = await managementApi.get('/credentials');
      setAccounts(groupOAuthAccountsByProvider(responseList(payload, 'files')));
    } catch {
      setAccounts(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => { void load(); void loadAccounts(); };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, refresh);
    return () => {
      mounted.current = false;
      ++revision.current;
      window.clearTimeout(retryTimer.current);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, refresh);
    };
  }, [load, loadAccounts]);

  const selectedPlugin = plugins.find(plugin => plugin.oauthProvider === selectedProvider);
  return <>
    {error && <Notice tone="error" icon={false} className="plugin-oauth-provider-status" action={
      <button type="button" className="secondary-button" disabled={loading} onClick={() => void load()}>
        <RefreshCw size={16} aria-hidden="true" />{t('common.refresh')}
      </button>
    }>{pluginOAuthText('loadFailed', locale)}</Notice>}
    {plugins.map(plugin => {
      const provider = plugin.oauthProvider!;
      const authorized = completed.has(provider);
      const providerAccounts = accounts?.get(normalizeOAuthProvider(provider)) ?? [];
      const hasAccounts = providerAccounts.length > 0;
      return <section className="panel surface-panel oauth-card" key={provider}>
        <div className="provider-title-row">
          <PluginLogo src={plugin.logo || plugin.metadata?.logo} size={40} />
          <div>
            <h2>{pluginOAuthText('providerTitle', locale).replace('{name}', getPluginTitle(plugin))}</h2>
            {accounts === null ? null : hasAccounts ? (
              <button
                type="button"
                className="oauth-account-count has-accounts"
                onClick={() => onOpenAuthFiles?.(providerAccounts[0]?.provider ?? provider)}
                disabled={!onOpenAuthFiles}
                title={t('oauth.accounts.view', { provider: getPluginTitle(plugin) })}
              >
                <UserRound size={13} aria-hidden="true" />
                {providerAccounts.length === 1
                  ? t('oauth.accounts.one')
                  : t('oauth.accounts.count', { count: providerAccounts.length })}
                {onOpenAuthFiles ? <ChevronRight size={13} aria-hidden="true" /> : null}
              </button>
            ) : authorized ? (
              <span className="state-pill success">{t('oauth.status.completed')}</span>
            ) : (
              <span className="oauth-account-count">{t('oauth.accounts.none')}</span>
            )}
          </div>
        </div>
        <div className="oauth-card-body">
          {hasAccounts ? (
            <ul className="oauth-account-list" aria-label={t('oauth.accounts.listLabel', { provider: getPluginTitle(plugin) })}>
              {providerAccounts.slice(0, OAUTH_ACCOUNT_PREVIEW_LIMIT).map(account => {
                const label = privacy.text(account.label, account.identities);
                const itemClass = [
                  account.disabled ? 'disabled' : '',
                  account.tone ? `tone-${account.tone}` : '',
                ].filter(Boolean).join(' ') || undefined;
                return (
                  <li key={account.name} className={itemClass} title={account.disabled ? `${label} · ${t('oauth.accounts.disabled')}` : label}>
                    {label}
                  </li>
                );
              })}
              {providerAccounts.length > OAUTH_ACCOUNT_PREVIEW_LIMIT ? (
                <li className="more">{t('oauth.accounts.more', { count: providerAccounts.length - OAUTH_ACCOUNT_PREVIEW_LIMIT })}</li>
              ) : null}
            </ul>
          ) : null}
          <p className="oauth-hint">{pluginOAuthText('providerHint', locale)}</p>
        </div>
        <div className="button-row management-card-actions">
          <button type="button" className="primary-button" onClick={() => setSelectedProvider(provider)}>
            <LogIn size={16} aria-hidden="true" />{t(hasAccounts || authorized ? 'oauth.addAccount' : 'oauth.signIn')}
          </button>
        </div>
      </section>;
    })}
    {selectedPlugin && <PluginOAuthDialog
      key={selectedPlugin.oauthProvider}
      plugin={selectedPlugin}
      browser={browser}
      onClose={() => setSelectedProvider(null)}
      onCompleted={() => {
        setCompleted(previous => new Set(previous).add(selectedPlugin.oauthProvider!));
        void loadAccounts();
        window.setTimeout(() => { void loadAccounts(); }, 800);
      }}
    />}
  </>;
}
