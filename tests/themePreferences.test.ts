import { expect, test } from 'bun:test';
import { ThemePreferences } from '../src/services/themePreferences';
import type { ThemePreference } from '../src/themeController';

function storage(initial?: string) {
  let value = initial ?? null;
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } } as Storage;
}

for (const preference of ['light', 'dark', 'system'] as const) {
  test(`migrates ${preference} and restores it after browser storage is lost`, async () => {
    let disk: ThemePreference | null = null;
    const backend = { load: async () => disk, save: async (next: ThemePreference) => { disk = next; } };
    const first = new ThemePreferences(() => storage(preference));
    await first.initialize(backend);
    expect(disk).toBe(preference);
    const cache = storage();
    const restarted = new ThemePreferences(() => cache);
    await restarted.initialize(backend);
    expect(restarted.get()).toBe(preference);
    expect(cache.getItem('easy-cli-proxy-api.theme')).toBe(preference);
  });
}

test('native preference wins over a stale browser preference', async () => {
  const preferences = new ThemePreferences(() => storage('light'));
  await preferences.initialize({ load: async () => 'dark', save: async () => { throw new Error('unexpected write'); } });
  expect(preferences.get()).toBe('dark');
});

test('saves with blocked browser storage and serializes rapid changes', async () => {
  const preferences = new ThemePreferences(() => { throw new Error('blocked'); });
  const writes: ThemePreference[] = [];
  await preferences.initialize({ load: async () => null, save: async (next) => { await Promise.resolve(); writes.push(next); } });
  preferences.set('dark');
  preferences.set('light');
  preferences.set('system');
  await preferences.flush();
  expect(writes).toEqual(['dark', 'light', 'system']);
  expect(preferences.get()).toBe('system');
});

test('a failed native read does not overwrite the saved file', async () => {
  const preferences = new ThemePreferences(() => storage('dark'));
  const writes: ThemePreference[] = [];
  await expect(preferences.initialize({ load: async () => { throw new Error('unreadable'); }, save: async (next) => { writes.push(next); } })).rejects.toThrow('unreadable');
  expect(preferences.get()).toBe('dark');
  preferences.set('light');
  await preferences.flush();
  expect(writes).toEqual([]);
});

test('missing preferences use system without writing a default', async () => {
  const preferences = new ThemePreferences(() => storage('invalid'));
  const writes: ThemePreference[] = [];
  await preferences.initialize({ load: async () => null, save: async (next) => { writes.push(next); } });
  expect(preferences.get()).toBe('system');
  expect(writes).toEqual([]);
});
