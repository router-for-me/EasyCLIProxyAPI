import { describe, expect, it } from 'bun:test';
import bundledRegistry from '../src/data/ecpaRegistry.json';
import { getBundledEcpaRegistry, parseEcpaRegistry } from '../src/services/ecpaPlugins';

describe('ecpaPlugins parser', () => {
  it('parses the bundled registry, rejects schema_version 2, and drops entries missing id', () => {
    const parsedBundled = parseEcpaRegistry(bundledRegistry);
    expect(parsedBundled).not.toBeNull();
    expect(parsedBundled?.schema_version).toBe(1);
    expect(parsedBundled?.plugins).toHaveLength(0);
    expect(getBundledEcpaRegistry().plugins).toHaveLength(0);

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
});
