import { describe, expect, it } from 'bun:test';
import { buildEcpaStoreMap, ECPA_REGISTRY_URL, fetchEcpaRegistry, getEcpaPluginDescription, isInstallableEcpaEntry, parseEcpaRegistry, resolveEcpaStoreEntry } from '../src/services/ecpaPlugins';
import { getPluginStoreLocalizedDescription, normalizePluginStore } from '../src/services/plugins';

const registryPayload = {
  schema_version: 1,
  plugins: [
    { id: 'demo', name: 'Demo', description: 'Demo plugin', repository: 'https://example.test/demo', install: { type: 'github-release' } },
  ],
};

const okFetch = (async () => new Response(JSON.stringify(registryPayload), { status: 200 })) as unknown as typeof fetch;
const failingFetch = (async () => {
  throw new Error('network down');
}) as unknown as typeof fetch;

describe('ecpaPlugins parser', () => {
  it('parses a registry payload, accepts schema_version 2, and drops entries missing id', () => {
    const parsed = parseEcpaRegistry(registryPayload);
    expect(parsed).not.toBeNull();
    expect(parsed?.schema_version).toBe(1);
    expect(parsed?.plugins).toHaveLength(1);
    expect(parsed?.plugins[0].install?.type).toBe('github-release');

    // v2 is the current upstream generation: it must parse, not be rejected.
    expect(parseEcpaRegistry({ schema_version: 2, plugins: [] })).toEqual({ schema_version: 2, plugins: [] });
    expect(parseEcpaRegistry({ schema_version: 3, plugins: [] })).toBeNull();

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
    const entry = parseEcpaRegistry(registryPayload)!.plugins[0];
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

describe('fetchEcpaRegistry', () => {
  it('returns the remote registry when the fetch succeeds', async () => {
    const result = await fetchEcpaRegistry({ fetchImpl: okFetch, forceRefresh: true });
    expect(result.registry?.plugins.map((plugin) => plugin.id)).toEqual(['demo']);
    expect(result.source).toBe('remote');
    expect(result.usedFallback).toBe(false);
  });

  it('reports a failed fetch instead of serving a built-in plugin list', async () => {
    const result = await fetchEcpaRegistry({ fetchImpl: failingFetch, forceRefresh: true });
    expect(result.registry).toBeNull();
    expect(result.usedFallback).toBe(true);
    expect(result.source).toBe('bundled');
    expect(result.tokenInvalid).toBe(false);
  });
});