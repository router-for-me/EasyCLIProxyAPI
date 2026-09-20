import { describe, expect, test } from 'bun:test';
import { usageViewScopeKey, type UsageViewScope } from '../src/services/usageViewScope';

const allModelsScope: UsageViewScope = {
  tab: 'overview',
  range: '24h',
  customStart: '',
  customEnd: '',
  model: '',
  provider: '',
  source: '',
  apiKeyHash: '',
  result: 'all',
  page: 1,
  pageSize: 50,
};

describe('usage view scope', () => {
  test('invalidates a filtered snapshot when switching back to all models', () => {
    const grokScope = usageViewScopeKey({ ...allModelsScope, model: 'grok-4' });
    const currentScope = usageViewScopeKey(allModelsScope);

    expect(currentScope).not.toBe(grokScope);
  });

  test('stays stable when the represented view and filters do not change', () => {
    expect(usageViewScopeKey({ ...allModelsScope })).toBe(usageViewScopeKey({ ...allModelsScope }));
  });

  test('invalidates snapshots for pagination and tab changes', () => {
    const base = usageViewScopeKey(allModelsScope);

    expect(usageViewScopeKey({ ...allModelsScope, page: 2 })).not.toBe(base);
    expect(usageViewScopeKey({ ...allModelsScope, tab: 'events' })).not.toBe(base);
  });
});
