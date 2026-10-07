import { describe, expect, it } from 'bun:test';
import { recommendPlugins } from '../src/services/pluginRecommendations';
import type { PluginStoreEntry } from '../src/services/plugins';

const entry = (id: string, sourceId = 'official') => ({ id, sourceId, storeId: `${sourceId}/${id}` }) as PluginStoreEntry;

describe('recommendPlugins', () => {
  const store = ['privacyfilter', 'quota-router', 'grok-inspection', 'model-fallback-router', 'unrelated'].map(id => entry(id));

  it('matches connected providers and keeps curated order', () => {
    expect(recommendPlugins(store, ['claude'], 'en').map(item => item.entry.id))
      .toEqual(['quota-router', 'model-fallback-router', 'privacyfilter']);
  });

  it('shows only universal picks with no matching accounts', () => {
    expect(recommendPlugins(store, [], 'en').map(item => item.entry.id)).toEqual(['model-fallback-router', 'privacyfilter']);
  });

  it('ignores entries from extra store sources', () => {
    expect(recommendPlugins([entry('quota-router', 'mirror')], ['claude'], 'en')).toEqual([]);
  });

  it('localizes the summary', () => {
    const [first] = recommendPlugins(store, ['xai'], 'ja');
    expect(first.entry.id).toBe('model-fallback-router');
    expect(first.summary).toContain('モデル');
  });
});
