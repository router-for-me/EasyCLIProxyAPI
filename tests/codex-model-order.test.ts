import { describe, expect, test } from 'bun:test';
import { hasCodexModelOrderChanged, moveCodexModel, orderCodexModelsBySlugs } from '../src/services/codexModelCatalog';

const models = [{ slug: 'alpha' }, { slug: 'beta' }, { slug: 'gamma' }];

describe('codex model ordering', () => {
  test('moves a model up and down', () => {
    expect(moveCodexModel(models, 1, 0).map((model) => model.slug)).toEqual(['beta', 'alpha', 'gamma']);
    expect(moveCodexModel(models, 0, 2).map((model) => model.slug)).toEqual(['beta', 'gamma', 'alpha']);
  });

  test('ignores out of range and no-op moves', () => {
    expect(moveCodexModel(models, 0, 0)).toBe(models);
    expect(moveCodexModel(models, -1, 0)).toBe(models);
    expect(moveCodexModel(models, 0, 5)).toBe(models);
  });

  test('detects order changes', () => {
    expect(hasCodexModelOrderChanged(models, models)).toBe(false);
    expect(hasCodexModelOrderChanged(moveCodexModel(models, 2, 0), models)).toBe(true);
    expect(hasCodexModelOrderChanged(models.slice(0, 2), models)).toBe(true);
  });

  test('restores the default order while keeping unknown slugs last', () => {
    const shuffled = [{ slug: 'gamma' }, { slug: 'custom' }, { slug: 'alpha' }, { slug: 'beta' }];
    expect(orderCodexModelsBySlugs(shuffled, ['alpha', 'beta', 'gamma']).map((model) => model.slug))
      .toEqual(['alpha', 'beta', 'gamma', 'custom']);
    expect(orderCodexModelsBySlugs(shuffled, [])).toBe(shuffled);
  });
});
