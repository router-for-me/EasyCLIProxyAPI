import { describe, expect, it } from 'bun:test';
import bundledRegistry from '../src/data/ecpaRegistry.json';
import { buildEcpaStoreMap, ECPA_REGISTRY_URL, getBundledEcpaRegistry, getEcpaPluginDescription, isInstallableEcpaEntry, parseEcpaRegistry, resolveEcpaStoreEntry } from '../src/services/ecpaPlugins';
import { getPluginStoreLocalizedDescription, normalizePluginStore } from '../src/services/plugins';

describe('ecpaPlugins parser', () => {
  it('parses the bundled registry, rejects schema_version 2, and drops entries missing id', () => {
    const parsedBundled = parseEcpaRegistry(bundledRegistry);
    expect(parsedBundled).not.toBeNull();
    expect(parsedBundled?.schema_version).toBe(1);
    expect(parsedBundled?.plugins).toHaveLength(2);
    expect(getBundledEcpaRegistry().plugins[0].install?.type).toBe('github-release');

    expect(parseEcpaRegistry({ schema_version: 2, plugins: [] })).toBeNull();

    const withMissingId = parseEcpaRegistry({
      schema_version: 1,
      plugins: [
        { name: 'Missing ID Plugin', description: 'Should be dropped' },
        { id: 'valid-plugin', name: 'Valid Plugin', description: 'Kept' },
      ],
    });
    expect(withMissingId).not.toBeNull();
    expect(withMissingId?.plugins.map((plugin) => plugin.id)).toEqual(['valid-plugin']);
  });

  it('normalizes supported install types and ignores unknown or malformed plans', () => {
    for (const [install, expected] of [
      [{ type: ' GitHub-Release ' }, 'github-release'],
      [{ type: ' DIRECT ' }, 'direct'],
      [{ type: 'script' }, undefined],
      [{ type: 5 }, undefined],
      [null, undefined],
      ['github-release', undefined],
    ] as const) {
      const parsed = parseEcpaRegistry({ schema_version: 1, plugins: [{ id: 'demo', name: 'Demo', install }] });
      expect(parsed?.plugins[0].install?.type).toBe(expected);
    }
  });

  it('requires an id and a non-empty repository for installation', () => {
    const entry = getBundledEcpaRegistry().plugins[0];
    expect(isInstallableEcpaEntry(entry)).toBe(true);
    expect(isInstallableEcpaEntry({ ...entry, repository: '  ' })).toBe(false);
    expect(isInstallableEcpaEntry({ ...entry, id: '' })).toBe(false);
  });

  it('picks the localized description and falls back to the top-level one', () => {
    const parsed = parseEcpaRegistry({
      schema_version: 1,
      plugins: [{ id: 'demo', name: 'Demo', description: 'English', locales: { 'zh-CN': { description: ' 中文 ' }, empty: { description: '   ' } } }],
    });
    const entry = parsed!.plugins[0];
    expect(entry.locales).toEqual({ 'zh-CN': { description: '中文' } });
    expect(getEcpaPluginDescription(entry, 'zh-CN')).toBe('中文');
    expect(getEcpaPluginDescription(entry, 'en')).toBe('English');
    expect(getEcpaPluginDescription(entry, 'zh-TW')).toBe('中文');
    expect(getEcpaPluginDescription(entry, 'ja')).toBe('English');
    const store = normalizePluginStore({ plugins: [{ id: 'demo', description: 'English', locales: { 'zh-CN': { description: '中文' } } }] }).plugins[0];
    expect(getPluginStoreLocalizedDescription(store, 'zh-CN')).toBe('中文');
    expect(getPluginStoreLocalizedDescription({ ...store, locales: {} }, 'zh-CN')).toBe('English');
  });

  it('resolves the featured source by id without borrowing another source identity', () => {
    const entries = normalizePluginStore({ plugins: [
      { id: 'aistudio2api', source_url: ECPA_REGISTRY_URL, source_id: 'core-derived-identity' },
      { id: 'aistudio2api', source_url: 'https://other.test/registry.json', source_id: 'other' },
    ] }).plugins;
    const indexed = buildEcpaStoreMap(entries);
    expect(indexed.get('aistudio2api')?.sourceId).toBe('core-derived-identity');
    expect(resolveEcpaStoreEntry(indexed, 'aistudio2api')?.sourceId).toBe('core-derived-identity');
    expect(resolveEcpaStoreEntry(buildEcpaStoreMap(entries.slice(1)), 'aistudio2api')).toBeUndefined();
    expect(resolveEcpaStoreEntry(buildEcpaStoreMap([{ ...entries[0], sourceId: '' }]), 'aistudio2api')).toBeUndefined();
    expect(resolveEcpaStoreEntry(indexed, 'missing')).toBeUndefined();
    indexed.delete(`${ECPA_REGISTRY_URL}#aistudio2api`);
    expect(resolveEcpaStoreEntry(indexed, 'aistudio2api')?.sourceId).toBe('core-derived-identity');
  });
});
