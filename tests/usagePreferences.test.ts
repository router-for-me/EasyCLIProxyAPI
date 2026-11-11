import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { UsagePreferences, usagePreferences } from '../src/services/usagePreferences';
import { getInitialVisibleColumns, getInitialColumnWidths, getInitialCollapseErrors } from '../src/pages/UsageEventsView';
import { getSpeedMode, EVENT_SPEED_MODE_KEY } from '../src/services/usageMetrics';

const pageSize = 'cpa-gui.usage-events-page-size.v1';
const columns = 'cpa-gui.usage-events-visible-cols.v6';
const defaultColumns = ['time', 'model', 'source', 'key', 'result', 'total', 'cache', 'latency', 'speed', 'cost'];
const withoutKey = defaultColumns.filter((key) => key !== 'key');
const oldDefaultColumns = ['time', 'model', 'provider', 'result', 'total', 'cache', 'latency', 'speed', 'cost'];

function storage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
  };
}

describe('usage preferences across updates', () => {
  let originalStorage: PropertyDescriptor | undefined;
  let browser: Storage;

  beforeEach(async () => {
    originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    browser = storage();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => browser });
    await usagePreferences.initialize({ load: async () => ({}), save: async () => {} });
  });

  afterEach(async () => {
    await usagePreferences.flush();
    browser = storage();
    await usagePreferences.initialize({ load: async () => ({}), save: async () => {} });
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('preserves older column choices and widths, including previous defaults', () => {
    browser.setItem('cpa-gui.usage-events-visible-cols.v5', JSON.stringify([...oldDefaultColumns, 'effort']));
    browser.setItem('cpa-gui.usage-events-col-widths.v3', JSON.stringify({ provider: 135, model: 150 }));
    expect(getInitialVisibleColumns()).toEqual(oldDefaultColumns);
    expect(getInitialColumnWidths().provider).toBe(135);
    browser.setItem('cpa-gui.usage-events-visible-cols.v5', JSON.stringify(['time', 'provider', 'key', 'source', 'model', 'effort', 'result', 'request', 'latency', 'speed', 'total', 'cache', 'cost']));
    expect(getInitialVisibleColumns()).toEqual(['time', 'provider', 'key', 'source', 'model', 'result', 'request', 'latency', 'speed', 'total', 'cache', 'cost']);
    browser.removeItem('cpa-gui.usage-events-visible-cols.v5');
    browser.setItem('cpa-gui.usage-events-visible-cols.v4', '["provider","model"]');
    expect(getInitialVisibleColumns()).toEqual(['provider', 'model']);
    browser.setItem('cpa-gui.usage-events-visible-cols.v3', '["source","model"]');
    expect(getInitialVisibleColumns()).toEqual(['provider', 'model']);
    browser.setItem(columns, '["time","source"]');
    expect(getInitialVisibleColumns()).toEqual(['time', 'source']);
    expect(getInitialCollapseErrors()).toBe(true);
    browser.setItem('cpa-gui.usage-events-collapse-errors.v1', '0');
    expect(getInitialCollapseErrors()).toBe(false);
    expect(getSpeedMode()).toBe('total');
    browser.setItem('cpa-gui.usage-events-speed-mode.v1', 'ttft');
    expect(getSpeedMode()).toBe('ttft');
    browser.setItem('cpa-gui.usage-events-speed-mode.v1', 'invalid');
    expect(getSpeedMode()).toBe('total');
    browser.setItem(EVENT_SPEED_MODE_KEY, 'total');
    expect(getSpeedMode()).toBe('total');
  });

  it('keeps only key hidden through repeated serialization and reader reloads', async () => {
    let disk = '{}';
    const backend = {
      load: async () => JSON.parse(disk) as Record<string, string>,
      save: async (values: Record<string, string>) => { disk = JSON.stringify(values); },
    };
    await usagePreferences.initialize(backend);
    expect(getInitialVisibleColumns()).toEqual(defaultColumns);
    usagePreferences.setItem(columns, JSON.stringify(withoutKey));
    await usagePreferences.flush();
    expect(JSON.parse(disk)).toEqual({ [columns]: JSON.stringify(withoutKey) });

    for (let restart = 0; restart < 3; restart++) {
      for (let remount = 0; remount < 3; remount++) {
        expect(getInitialVisibleColumns()).toEqual(withoutKey);
      }
      browser = storage();
      await usagePreferences.initialize(backend);
      expect(browser.getItem(columns)).toBeNull();
      expect(getInitialVisibleColumns()).toEqual(withoutKey);
      usagePreferences.setItem(columns, JSON.stringify(getInitialVisibleColumns()));
      await usagePreferences.flush();
      expect(JSON.parse(disk)).toEqual({ [columns]: JSON.stringify(withoutKey) });
    }

    usagePreferences.setItem(columns, JSON.stringify(defaultColumns));
    await usagePreferences.flush();
    browser = storage();
    await usagePreferences.initialize(backend);
    expect(getInitialVisibleColumns()).toEqual(defaultColumns);
  });

  it('restores other selections from disk over stale browser defaults', async () => {
    for (const selection of [defaultColumns, defaultColumns.filter((key) => key !== 'model'), ['cost', 'source', 'time'], ['key'], ['provider', 'request']]) {
      let disk = JSON.stringify({ [columns]: JSON.stringify(selection) });
      const backend = {
        load: async () => JSON.parse(disk) as Record<string, string>,
        save: async (values: Record<string, string>) => { disk = JSON.stringify(values); },
      };
      browser = storage({ [columns]: JSON.stringify(defaultColumns) });
      await usagePreferences.initialize(backend);
      expect(getInitialVisibleColumns()).toEqual(selection);
      usagePreferences.setItem(columns, JSON.stringify(getInitialVisibleColumns()));
      await usagePreferences.flush();
      browser = storage();
      await usagePreferences.initialize(backend);
      expect(getInitialVisibleColumns()).toEqual(selection);
    }
  });

  it('preserves ambiguous nine-column choices under every supported storage version', async () => {
    for (const version of [6, 5, 4, 3, 2]) {
      for (const selection of [withoutKey, oldDefaultColumns]) {
        const key = `cpa-gui.usage-events-visible-cols.v${version}`;
        await usagePreferences.initialize({
          load: async () => ({ [key]: JSON.stringify(selection) }),
          save: async () => {},
        });
        expect(getInitialVisibleColumns()).toEqual(selection);
      }
    }
  });

  it('uses all ten defaults only when no valid selection is saved', () => {
    expect(getInitialVisibleColumns()).toEqual(defaultColumns);
    for (const raw of ['', '{not json', 'null', '{}', '"time"', '42', '[]', '["effort","input","removedColumn"]', '[null,7,true,{}]']) {
      usagePreferences.setItem(columns, raw);
      expect(getInitialVisibleColumns()).toEqual(defaultColumns);
    }
  });

  it('drops malformed, unknown and duplicate ids while keeping valid ids in saved order', () => {
    usagePreferences.setItem(columns, JSON.stringify(['cost', 'removedColumn', 'key', 'key', 7, null, 'source', {}, 'time', 'model']));
    expect(getInitialVisibleColumns()).toEqual(['cost', 'key', 'source', 'time', 'model']);
  });

  it('migrates browser preferences and restores them with an empty WebView cache', async () => {
    let disk = '{}';
    const backend = {
      load: async () => JSON.parse(disk) as Record<string, string>,
      save: async (values: Record<string, string>) => { disk = JSON.stringify(values); },
    };
    browser = storage({ [pageSize]: '100', [columns]: '["time","provider"]', unrelated: 'private' });
    await usagePreferences.initialize(backend);
    expect(JSON.parse(disk)).toEqual({ [pageSize]: '100', [columns]: '["time","provider"]' });
    browser = storage();
    await usagePreferences.initialize(backend);
    expect(usagePreferences.getItem(pageSize)).toBe('100');
    expect(getInitialVisibleColumns()).toEqual(['time', 'provider']);
  });

  it('prefers disk over stale browser defaults and serializes rapid changes', async () => {
    let disk: Record<string, string> = { [pageSize]: '100' };
    browser.setItem(pageSize, '50');
    await usagePreferences.initialize({ load: async () => disk, save: async (values) => {
      await new Promise((resolve) => setTimeout(resolve, values[pageSize] === '200' ? 10 : 0));
      disk = values;
    } });
    expect(usagePreferences.getItem(pageSize)).toBe('100');
    usagePreferences.setItem(pageSize, '200');
    usagePreferences.setItem(pageSize, '100');
    usagePreferences.setItem(columns, '["provider"]');
    await usagePreferences.flush();
    expect(disk).toEqual({ [pageSize]: '100', [columns]: '["provider"]' });
    expect(getInitialVisibleColumns()).toEqual(['provider']);
  });

  it('does not overwrite unreadable disk preferences with defaults', async () => {
    let saves = 0;
    const preferences = new UsagePreferences(() => storage());
    await expect(preferences.initialize({ load: async () => { throw new Error('unreadable'); }, save: async () => { saves++; } })).rejects.toThrow();
    preferences.setItem(pageSize, '50');
    await preferences.flush();
    expect(saves).toBe(0);
  });

  it('retains preferences when localStorage is unavailable', async () => {
    let disk: Record<string, string> = { [pageSize]: '100' };
    const preferences = new UsagePreferences(() => { throw new Error('storage unavailable'); });
    await preferences.initialize({ load: async () => disk, save: async (values) => { disk = values; } });
    expect(preferences.getItem(pageSize)).toBe('100');
    preferences.setItem(pageSize, '200');
    await preferences.flush();
    expect(disk[pageSize]).toBe('200');
  });
});
