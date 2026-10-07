import { describe, expect, test } from 'bun:test';
import {
  appendProviderEntry, locateProviderEntry, providerEntries, removeProviderEntry,
  reorderProviderEntries, updateProviderEntry,
} from '../src/services/providerEntries';

type RecordValue = Record<string, unknown>;
const groups = (): RecordValue[] => [{
  name: 'gateway', 'base-url': 'https://gateway.test/v1', priority: 3,
  headers: { 'X-Shared': 'value', 'auth-index': 'a valid header' },
  models: [{ name: 'shared', custom: { retained: true } }],
  'excluded-models': ['old-*'], 'disable-cooling': true,
  'request-retry': 2, 'request-scoped-errors': [{ status: 429, action: 'continue' }],
  prefix: 'team', 'proxy-url': 'http://proxy.test:80',
  keys: [
    { 'api-key': 'key-a', priority: null, models: null, 'auth-index': 'runtime-a', vendor: { token: 'extension' } },
    { 'api-key': 'key-b', priority: 0, headers: {}, models: [], 'disable-cooling': false, 'excluded-models': [] },
  ],
}];
const keysOf = (group: RecordValue) => group.keys as RecordValue[];

describe('provider entries over native groups', () => {
  test('flattens effective keys while retaining immutable source snapshots', () => {
    const original = groups();
    const entries = providerEntries('codex-api-key', original);
    expect(entries).toHaveLength(2);
    expect(entries[0].record).toMatchObject({ priority: 3, models: original[0].models, vendor: { token: 'extension' } });
    expect(entries[0].record).not.toHaveProperty('name');
    expect(entries[0].record).not.toHaveProperty('keys');
    expect(entries[1].record).toMatchObject({ priority: 0, headers: {}, models: [], 'disable-cooling': false });
    keysOf(original[0])[0]['api-key'] = 'externally-changed';
    expect(keysOf(entries[0].source.group)[0]['api-key']).toBe('key-a');
    entries[0].record.headers = {};
    expect(entries[0].source.group.headers).toHaveProperty('X-Shared');
  });

  test('retains fields owned by a key even when they share a group field name', () => {
    const entries = providerEntries('codex-api-key', [{ name: 'group-label', keys: [{ 'api-key': 'key', name: 'key-extension' }] }]);
    expect(entries[0].record.name).toBe('key-extension');
  });

  test('keeps compatibility providers as single raw groups', () => {
    const original = groups();
    const entries = providerEntries('openai-compatibility', original);
    expect(entries).toHaveLength(1);
    expect(entries[0].record).toEqual(original[0]);
    expect(entries[0].source.keyIndex).toBeUndefined();
  });

  test('generates unique family names and stores a new endpoint at group level', () => {
    const result = appendProviderEntry([{ name: 'codex-1', keys: [] }, { name: 'codex-3', keys: [] }], 'codex-api-key', {
      'api-key': 'new-key', 'base-url': 'https://new.test', priority: 0,
      vendor: { retained: true }, 'auth-index': 'runtime', headers: { 'auth-index': 'valid' },
    });
    expect(result[2]).toEqual({ name: 'codex-2', 'base-url': 'https://new.test', keys: [{
      'api-key': 'new-key', priority: 0, vendor: { retained: true }, headers: { 'auth-index': 'valid' },
    }] });
  });

  test('single-key edits preserve inherited nulls, unknown fields and sibling policy', () => {
    const original = groups();
    const first = providerEntries('codex-api-key', original)[0];
    const result = updateProviderEntry(original, first.source, first.record, { ...first.record, 'api-key': 'rotated', priority: 4 });
    expect(result[0].priority).toBe(3);
    expect(keysOf(result[0])[0]).toEqual({ 'api-key': 'rotated', priority: 4, models: null, vendor: { token: 'extension' } });
    expect(keysOf(result[0])[1]).toEqual(keysOf(original[0])[1]);
    expect(keysOf(original[0])[0]['api-key']).toBe('key-a');
    expect((result[0].headers as RecordValue)['auth-index']).toBe('a valid header');
  });

  test('unchanged effective settings do not materialize inherited fields', () => {
    const original = groups();
    const first = providerEntries('codex-api-key', original)[0];
    const result = updateProviderEntry(original, first.source, first.record, structuredClone(first.record));
    expect(keysOf(result[0])[0]).toEqual({ 'api-key': 'key-a', priority: null, models: null, vendor: { token: 'extension' } });
    expect(keysOf(result[0])[0]).not.toHaveProperty('headers');
  });

  test('cleared shared fields become empty overrides only for the selected key', () => {
    const original = groups();
    const first = providerEntries('codex-api-key', original)[0];
    const after = { ...first.record };
    for (const field of ['headers', 'models', 'excluded-models', 'prefix', 'proxy-url', 'priority', 'request-retry', 'request-scoped-errors']) delete after[field];
    const result = updateProviderEntry(original, first.source, first.record, after);
    expect(keysOf(result[0])[0]).toMatchObject({
      headers: {}, models: [], 'excluded-models': [], prefix: '', 'proxy-url': '', priority: 0,
      'request-retry': -1, 'request-scoped-errors': [],
    });
    expect(result[0].models).toEqual(original[0].models);
    expect(keysOf(result[0])[1]).toEqual(keysOf(original[0])[1]);
  });

  test('removing a cooling override restores inheritance and explicit null remains explicit', () => {
    const original = groups();
    const second = providerEntries('codex-api-key', original)[1];
    const after = { ...second.record, priority: null };
    delete after['disable-cooling'];
    const result = updateProviderEntry(original, second.source, second.record, after);
    expect(keysOf(result[0])[1]).not.toHaveProperty('disable-cooling');
    expect(keysOf(result[0])[1].priority).toBeNull();
    expect(providerEntries('codex-api-key', result)[1].record).toMatchObject({ priority: 3, 'disable-cooling': true });
  });

  test('changing an endpoint isolates the selected key without changing shared policy', () => {
    const original = groups();
    original.push({ name: 'gateway-2', keys: [] });
    const first = providerEntries('codex-api-key', original)[0];
    const result = updateProviderEntry(original, first.source, first.record, { ...first.record, 'base-url': 'https://other.test', priority: 8 });
    expect(result).toHaveLength(3);
    expect(result[0]['base-url']).toBe('https://gateway.test/v1');
    expect(keysOf(result[0])).toEqual([keysOf(original[0])[1]]);
    expect(result[1]).toMatchObject({ name: 'gateway-3', 'base-url': 'https://other.test', priority: 3, headers: original[0].headers });
    expect(keysOf(result[1])).toEqual([{ 'api-key': 'key-a', priority: 8, models: null, vendor: { token: 'extension' } }]);
    expect(keysOf(result[1])[0]).not.toHaveProperty('base-url');
  });

  test('a single-key endpoint edit preserves the existing group identity', () => {
    const original = [{ name: 'one', 'base-url': 'https://old.test', keys: [{ 'api-key': 'key' }] }];
    const entry = providerEntries('codex-api-key', original)[0];
    const result = updateProviderEntry(original, entry.source, entry.record, { ...entry.record, 'base-url': 'https://new.test' });
    expect(result).toEqual([{ ...original[0], 'base-url': 'https://new.test' }]);
  });

  test('removing one key preserves its siblings and the final key removes its group', () => {
    const original = groups();
    const result = removeProviderEntry(original, providerEntries('codex-api-key', original)[0].source);
    expect(keysOf(result[0])).toEqual([keysOf(original[0])[1]]);
    expect(removeProviderEntry(result, providerEntries('codex-api-key', result)[0].source)).toEqual([]);
  });

  test('identical keys retain their positional identity within an unchanged group', () => {
    const original = [{ name: 'duplicates', keys: [{ 'api-key': 'same' }, { 'api-key': 'same' }] }];
    const second = providerEntries('codex-api-key', original)[1];
    const result = updateProviderEntry(original, second.source, second.record, { ...second.record, weight: 2 });
    expect(keysOf(result[0])).toEqual([{ 'api-key': 'same' }, { 'api-key': 'same', weight: 2 }]);
  });

  test('rejects stale edits when a sibling or a shared setting changed', () => {
    const original = groups();
    const first = providerEntries('codex-api-key', original)[0];
    for (const change of [(value: RecordValue[]) => { keysOf(value[0])[1].priority = 9; },
      (value: RecordValue[]) => { value[0].priority = 9; }]) {
      const changed = structuredClone(original);
      change(changed);
      expect(() => updateProviderEntry(changed, first.source, first.record, first.record)).toThrow('configuration changed');
      expect(() => removeProviderEntry(changed, first.source)).toThrow();
    }
  });

  test('can locate a uniquely unchanged group after unrelated groups were reordered', () => {
    const original = [...groups(), { name: 'other', keys: [{ 'api-key': 'other' }] }];
    const first = providerEntries('codex-api-key', original)[0];
    expect(locateProviderEntry([original[1], original[0]], first.source)).toEqual({ groupIndex: 1, keyIndex: 0 });
  });

  test('rejects ambiguous duplicate-group relocation even when only one old match remains', () => {
    const original = [groups()[0], groups()[0]];
    const entry = providerEntries('codex-api-key', original)[2];
    expect(locateProviderEntry(original, entry.source)).toEqual({ groupIndex: 1, keyIndex: 0 });
    expect(() => locateProviderEntry([original[0]], entry.source)).toThrow();
    const changed = [...original, { name: 'third', keys: [] }];
    expect(() => locateProviderEntry(changed, entry.source)).toThrow();
  });

  test('ignores transient response metadata but never header contents during stale checks', () => {
    const original = groups();
    const first = providerEntries('codex-api-key', original)[0];
    const changed = structuredClone(original);
    keysOf(changed[0])[0]['auth-index'] = 'different-runtime-index';
    expect(locateProviderEntry(changed, first.source)).toEqual({ groupIndex: 0, keyIndex: 0 });
    (changed[0].headers as RecordValue)['auth-index'] = 'different-header';
    expect(() => locateProviderEntry(changed, first.source)).toThrow();
  });

  test('reordering keys rebuilds group fragments without losing inheritance or unknown fields', () => {
    const original = [...groups(), { name: 'other', 'base-url': 'https://other.test', custom: { kept: true },
      keys: [{ 'api-key': 'key-c', weight: 5, vendor: { retained: true } }] }, { name: 'empty', keys: [] }];
    const entries = providerEntries('codex-api-key', original);
    const result = reorderProviderEntries(original, 'codex-api-key', entries[2].source, entries[1].source);
    expect(providerEntries('codex-api-key', result).map((entry) => entry.record['api-key'])).toEqual(['key-a', 'key-c', 'key-b']);
    expect(result.map((group) => group.name)).toEqual(['gateway', 'other', 'gateway-2', 'empty']);
    expect(result[0].headers).toEqual(original[0].headers);
    expect(result[2].headers).toEqual(original[0].headers);
    expect(keysOf(result[0])[0]).toMatchObject({ priority: null, models: null, vendor: { token: 'extension' } });
    expect(keysOf(result[2])[0]).toEqual(keysOf(original[0])[1]);
    expect(result[1]).toEqual(original[1]);
    expect(original).toHaveLength(3);
  });

  test('reorders within a shared group without changing group settings', () => {
    const original = groups();
    const entries = providerEntries('codex-api-key', original);
    const result = reorderProviderEntries(original, 'codex-api-key', entries[0].source, entries[1].source);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('gateway');
    expect(keysOf(result[0]).map((key) => key['api-key'])).toEqual(['key-b', 'key-a']);
    expect(result[0].models).toEqual(original[0].models);
  });

  test('filtered key reordering leaves hidden credentials in their complete-list slots', () => {
    const original = [{ name: 'all', 'base-url': 'https://gateway.test', keys: [
      { 'api-key': 'a' }, { 'api-key': 'hidden-a' }, { 'api-key': 'b' }, { 'api-key': 'hidden-b' }, { 'api-key': 'c' },
    ] }];
    const entries = providerEntries('codex-api-key', original);
    const visible = [entries[0].source, entries[2].source, entries[4].source];
    const result = reorderProviderEntries(original, 'codex-api-key', entries[0].source, entries[4].source, visible);
    expect(keysOf(result[0]).map((key) => key['api-key'])).toEqual(['b', 'hidden-a', 'c', 'hidden-b', 'a']);
    expect(result[0].name).toBe('all');
    expect(keysOf(original[0])[0]['api-key']).toBe('a');
  });

  test('filtered cross-group reordering preserves each fragment policy and hidden group position', () => {
    const original = [...groups(), { name: 'hidden-deepseek', 'base-url': 'https://api.deepseek.com',
      custom: { hidden: true }, keys: [{ 'api-key': 'hidden', weight: 7 }] },
    { name: 'other', 'base-url': 'https://other.test', headers: { 'X-Other': 'retained' },
      keys: [{ 'api-key': 'key-c', weight: 5, vendor: { retained: true } }] }, { name: 'empty', keys: [] }];
    const entries = providerEntries('codex-api-key', original);
    const visible = [entries[0].source, entries[1].source, entries[3].source];
    const result = reorderProviderEntries(original, 'codex-api-key', entries[3].source, entries[1].source, visible);
    const effective = providerEntries('codex-api-key', result);
    expect(effective.map((entry) => entry.record['api-key'])).toEqual(['key-a', 'key-c', 'hidden', 'key-b']);
    expect(result.map((group) => group.name)).toEqual(['gateway', 'other', 'hidden-deepseek', 'gateway-2', 'empty']);
    expect(result[2]).toEqual(original[1]);
    expect(result[0].headers).toEqual(original[0].headers);
    expect(result[3].headers).toEqual(original[0].headers);
    expect(result[3].models).toEqual(original[0].models);
    expect(keysOf(result[0])[0]).toMatchObject({ models: null, priority: null, vendor: { token: 'extension' } });
    expect(keysOf(result[3])[0]).toEqual(keysOf(original[0])[1]);
    expect(result[1]).toEqual(original[2]);
  });

  test('validates every visible snapshot before reordering even when source and target are unchanged', () => {
    const original = ['a', 'b', 'c'].map((key) => ({ name: key, keys: [{ 'api-key': key }] }));
    const entries = providerEntries('codex-api-key', original);
    const changed = structuredClone(original);
    keysOf(changed[1])[0].weight = 9;
    expect(() => reorderProviderEntries(changed, 'codex-api-key', entries[0].source, entries[2].source,
      entries.map((entry) => entry.source))).toThrow('configuration changed');
    expect(() => reorderProviderEntries(changed, 'codex-api-key', entries[0].source, entries[0].source,
      entries.map((entry) => entry.source))).toThrow('configuration changed');
    expect(() => reorderProviderEntries(original, 'codex-api-key', entries[0].source, entries[2].source,
      [entries[0].source, entries[1].source])).toThrow();
  });

  test('filtered compatibility reordering leaves hidden providers at their existing positions', () => {
    const original = ['a', 'hidden', 'b'].map((name) => ({ name, keys: [{ 'api-key': name }] }));
    const entries = providerEntries('openai-compatibility', original);
    const result = reorderProviderEntries(original, 'openai-compatibility', entries[0].source, entries[2].source,
      [entries[0].source, entries[2].source]);
    expect(result).toEqual([original[2], original[1], original[0]]);
  });

  test('compatibility operations preserve provider policies and move whole providers', () => {
    const original = [...groups(), { name: 'other', keys: [{ 'api-key': 'other' }], disabled: true }];
    const entries = providerEntries('openai-compatibility', original);
    const updated = updateProviderEntry(original, entries[0].source, entries[0].record, { ...entries[0].record, disabled: true });
    expect(updated[0].disabled).toBe(true);
    expect(keysOf(updated[0])[0]).not.toHaveProperty('auth-index');
    expect(updated[0].headers).toEqual(original[0].headers);
    expect(reorderProviderEntries(original, 'openai-compatibility', entries[0].source, entries[1].source)[0]).toEqual(original[1]);
    expect(removeProviderEntry(original, entries[0].source)).toEqual([original[1]]);
    expect(appendProviderEntry([], 'openai-compatibility', original[1])).toEqual([original[1]]);
  });
});
