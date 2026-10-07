import { describe, expect, it } from 'bun:test';
import { collectPluginOAuthProviders } from '../src/services/pluginOAuthProviders';
import { getPluginTitle } from '../src/services/pluginResources';
import { normalizePluginList, type PluginListEntry } from '../src/services/plugins';

function rawPlugin(id: string, provider: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    path: `plugins/windows/amd64/${id}.dll`,
    configured: true,
    registered: true,
    enabled: true,
    effective_enabled: true,
    supports_oauth: true,
    oauth_provider: provider,
    supports_quota: false,
    quota_provider: '',
    logo: '',
    config_fields: [],
    menus: [],
    metadata: null,
    ...overrides,
  };
}

function normalize(plugins: unknown[]): PluginListEntry[] {
  return normalizePluginList({
    plugins_enabled: true,
    plugins_dir: 'plugins',
    plugins,
  }).plugins;
}

describe('plugin OAuth provider discovery', () => {
  it('shows ZCode and CodeBuddy from the backend capabilities without menus or quota support', () => {
    const plugins = normalize([
      rawPlugin('zcode', 'zcode', { metadata: { name: 'ZCode', version: '1.0.0' } }),
      rawPlugin('codebuddy', 'codebuddy', { metadata: { name: 'CodeBuddy', version: '1.0.0' } }),
    ]);

    const providers = collectPluginOAuthProviders(plugins);

    expect(providers.map(plugin => plugin.oauthProvider)).toEqual(['zcode', 'codebuddy']);
    expect(providers.map(getPluginTitle)).toEqual(['ZCode', 'CodeBuddy']);
    expect(providers.every(plugin => plugin.menus.length === 0 && !plugin.supportsQuota)).toBe(true);
    expect(providers[0]).toBe(plugins[0]);
    expect(providers[1]).toBe(plugins[1]);
  });

  it('only includes effective plugins that declare OAuth and a valid provider key', () => {
    const plugins = normalize([
      rawPlugin('active', 'zcode'),
      rawPlugin('disabled', 'disabled', { enabled: false, effective_enabled: false }),
      rawPlugin('not-loaded', 'not-loaded', { registered: false, effective_enabled: false }),
      rawPlugin('no-oauth', 'no-oauth', { supports_oauth: false }),
      rawPlugin('missing-provider', ''),
      rawPlugin('invalid-provider', '../config'),
    ]);

    expect(collectPluginOAuthProviders(plugins).map(plugin => plugin.id)).toEqual(['active']);
  });

  it('rejects invalid provider keys even if an entry reaches the helper without normalization', () => {
    const [plugin] = normalize([rawPlugin('active', 'zcode')]);
    const invalidProviders = [undefined, '', ' ', '../config', 'a/b', 'a?b', 'https://provider.test'];

    expect(collectPluginOAuthProviders(invalidProviders.map(oauthProvider => ({
      ...plugin, oauthProvider,
    })))).toEqual([]);
  });

  it('deduplicates by OAuth provider and excludes built-ins rather than using plugin registration IDs', () => {
    const plugins = normalize([
      rawPlugin('disabled-copy', 'zcode', { effective_enabled: false }),
      rawPlugin('zcode-auth-extension', 'zcode'),
      rawPlugin('another-zcode-extension', 'zcode'),
      rawPlugin('codex-auth-extension', 'codex'),
      rawPlugin('claude-auth-extension', 'claude'),
      rawPlugin('codebuddy-auth-extension', 'codebuddy'),
    ]);

    expect(collectPluginOAuthProviders(plugins, ['codex', 'claude']).map(plugin => ({
      id: plugin.id, provider: plugin.oauthProvider,
    }))).toEqual([
      { id: 'zcode-auth-extension', provider: 'zcode' },
      { id: 'codebuddy-auth-extension', provider: 'codebuddy' },
    ]);
  });

  it('accepts future backend-declared providers without a provider name allowlist', () => {
    const plugins = normalize([
      rawPlugin('custom-auth-extension', ' Future-Provider-42 ', {
        metadata: { name: 'Future Provider' },
      }),
    ]);

    const providers = collectPluginOAuthProviders(plugins, ['codex', 'claude']);

    expect(providers).toHaveLength(1);
    expect(providers[0].oauthProvider).toBe('future-provider-42');
    expect(getPluginTitle(providers[0])).toBe('Future Provider');
  });

  it('keeps a usable plugin title when metadata is absent or its name is blank', () => {
    const providers = collectPluginOAuthProviders(normalize([
      rawPlugin('zcode', 'zcode'),
      rawPlugin('codebuddy', 'codebuddy', { metadata: { name: '   ' } }),
    ]));

    expect(providers.map(getPluginTitle)).toEqual(['zcode', 'codebuddy']);
  });
});
