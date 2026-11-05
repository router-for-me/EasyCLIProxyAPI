import { describe, expect, it } from 'bun:test';
import { findPluginLogo, resolveProviderIcon, safePluginLogoUrl } from '../src/services/pluginLogos';
import type { PluginListEntry } from '../src/services/plugins';

const builtIn = { gemini: 'gemini.svg', codex: 'codex.svg' };

function plugin(id: string, overrides: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    id, path: `${id}.so`, configured: true, registered: true, enabled: true, effectiveEnabled: true,
    supportsOAuth: true, oauthProvider: id, supportsQuota: true, quotaProvider: id, logo: '',
    configFields: [], menus: [], metadata: null, ...overrides,
  };
}

describe('plugin provider logos', () => {
  it('uses the plugin logo for a plugin provider', () => {
    const plugins = [plugin('spx-cursor', { oauthProvider: 'cursor', quotaProvider: 'cursor', logo: 'https://example.com/cursor.png' })];
    const logo = findPluginLogo(plugins, 'cursor');
    expect(resolveProviderIcon('cursor', builtIn, logo)).toEqual({ kind: 'plugin', src: 'https://example.com/cursor.png' });
    expect(findPluginLogo(plugins, 'other', 'spx-cursor')).toBe('https://example.com/cursor.png');
  });

  it('falls back to metadata logo and to the generic icon without a logo', () => {
    const withMeta = plugin('a', { metadata: { name: 'A', version: '', author: '', githubRepository: '', logo: 'http://example.com/a.svg', configFields: [] } });
    expect(findPluginLogo([withMeta], 'a')).toBe('http://example.com/a.svg');
    expect(resolveProviderIcon('a', builtIn, findPluginLogo([plugin('a')], 'a'))).toEqual({ kind: 'generic' });
  });

  it('never falls back to the Gemini icon for an unknown provider', () => {
    const icon = resolveProviderIcon('cursor', builtIn);
    expect(icon).toEqual({ kind: 'generic' });
    expect(resolveProviderIcon('toString', builtIn)).toEqual({ kind: 'generic' });
    expect(resolveProviderIcon('gemini', builtIn)).toEqual({ kind: 'builtin', src: 'gemini.svg' });
  });

  it('accepts only http(s) logo URLs', () => {
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 'file:///etc/passwd', '//example.com/x.png', 'not a url', '', undefined, 3]) {
      expect(safePluginLogoUrl(bad)).toBe('');
    }
    expect(resolveProviderIcon('x', builtIn, 'javascript:alert(1)')).toEqual({ kind: 'generic' });
    expect(safePluginLogoUrl(' https://example.com/l.png ')).toBe('https://example.com/l.png');
  });
});
