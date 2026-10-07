import { describe, expect, test } from 'bun:test';
import {
  buildProviderKeyRecord, providerDraftFromRecord, type ProviderDraft, type ProviderSection,
} from '../src/pages/ApiAccessPage';
import { providerEntries, updateProviderEntry } from '../src/services/providerEntries';
import { cleanProviderGroup } from '../src/services/providerGroups';

type Value = Record<string, unknown>;
const keys = (group: Value) => group.keys as Value[];
const fixture = (): Value[] => [{
  name: 'shared', 'base-url': 'https://gateway.test/v1', priority: 3,
  headers: { 'X-Shared': 'group', 'auth-index': 'literal header' }, 'excluded-models': ['old-*'],
  models: [
    { name: 'same-upstream', alias: 'regular', vendor: { index: 1 }, thinking: { levels: ['low'], 'zero-allowed': false } },
    { name: 'same-upstream', alias: 'fast', vendor: { index: 2 }, thinking: { levels: ['high'] } },
    { name: 'same-upstream', alias: 'careful', vendor: { index: 3 }, 'max-context-length': 128000 },
  ],
  'request-retry': 2, 'request-scoped-errors': [{ status: 429, action: 'continue', match: ['quota'] }],
  keys: [
    { 'api-key': 'key-a', priority: null, models: null, 'request-retry': null, 'disable-cooling': null,
      weight: null, 'auth-index': 'runtime-a', custom: { list: [1, 2], 'test-model': 'extension' } },
    { 'api-key': 'key-b', headers: {}, 'excluded-models': [], weight: 0, websockets: false },
  ],
}];

const edit = (groups: Value[], change: (draft: ProviderDraft) => void, section: ProviderSection = 'codex-api-key', index = 0) => {
  const entry = providerEntries(section, groups)[index];
  const draft = providerDraftFromRecord(section, entry.record);
  change(draft);
  const after = buildProviderKeyRecord(section, draft, entry.record);
  return { after, draft, result: updateProviderEntry(groups, entry.source, entry.record, after) };
};

describe('single-provider form edits over native groups', () => {
  for (const section of ['codex-api-key', 'claude-api-key', 'gemini-api-key', 'interactions-api-key', 'vertex-api-key', 'xai-api-key', 'meta-api-key'] as const) {
    test(`${section} untouched form preserves inheritance, aliases, unknown configuration and sibling keys`, () => {
      const original = fixture();
      const { draft, result } = edit(original, () => {}, section);
      expect(draft.models.map((model) => model.alias)).toEqual(['regular', 'fast', 'careful']);
      expect(result).toEqual(original.map(cleanProviderGroup));
      expect(keys(result[0])[0]).toMatchObject({ priority: null, models: null, 'request-retry': null, 'disable-cooling': null, weight: null });
      expect(keys(result[0])[0]).not.toHaveProperty('headers');
      expect(keys(result[0])[0]).not.toHaveProperty('websockets');
      expect(keys(result[0])[0].custom).toEqual({ list: [1, 2], 'test-model': 'extension' });
    });
  }

  test('untouched absent, null and explicit empty form values retain their stored representations', () => {
    for (const fields of [
      {},
      { models: null, headers: null, priority: null, 'proxy-url': null, 'excluded-models': null, 'disable-cooling': null, websockets: null },
      { models: [], headers: {}, priority: 0, 'proxy-url': '', 'excluded-models': [], 'disable-cooling': false, websockets: false },
    ]) {
      const original = [{ name: 'untouched', keys: [{ 'api-key': 'key', ...fields }] }];
      expect(edit(original, () => {}).result).toEqual(original);
    }
  });

  test('changing only a local remark does not modify provider configuration', () => {
    const original = fixture();
    const { result } = edit(original, (draft) => { draft.remark = 'My display note'; });
    expect(result).toEqual(original.map(cleanProviderGroup));
    expect(keys(result[0])[0]).not.toHaveProperty('remark');
  });

  test('preserves an existing key-owned name extension on unrelated edits', () => {
    const original = fixture();
    keys(original[0])[0].name = 'retained key metadata';
    expect(edit(original, (draft) => { draft.remark = 'Updated note'; }).result).toEqual(original.map(cleanProviderGroup));
  });

  test('removes exactly one repeated-source alias and keeps other model metadata', () => {
    const original = fixture();
    const { result } = edit(original, (draft) => { draft.models = draft.models.filter((_, index) => index !== 1); });
    const existing = original[0].models as Value[];
    expect(keys(result[0])[0].models).toEqual([existing[0], existing[2]]);
    expect(result[0].models).toEqual(existing);
    expect(keys(result[0])[1]).toEqual(keys(original[0])[1]);
    expect(providerEntries('codex-api-key', result)[1].record.models).toEqual(existing);
  });

  test('renames one alias without duplicating or merging its repeated-source siblings', () => {
    const original = fixture();
    const { result } = edit(original, (draft) => { draft.models[1].alias = 'fast-renamed'; });
    const existing = original[0].models as Value[];
    expect(keys(result[0])[0].models).toEqual([existing[0], { ...existing[1], alias: 'fast-renamed' }, existing[2]]);
  });

  test('clearing every selected model writes an explicit empty list for that credential', () => {
    const original = fixture();
    const { result } = edit(original, (draft) => { draft.models = []; });
    expect(keys(result[0])[0].models).toEqual([]);
    expect(result[0].models).toEqual(original[0].models);
  });

  test('clearing shared headers and exclusions writes empty overrides while preserving siblings', () => {
    const original = fixture();
    const { result } = edit(original, (draft) => { draft.headersText = ''; draft.excludedModelsText = ''; });
    expect(keys(result[0])[0]).toMatchObject({ headers: {}, 'excluded-models': [] });
    expect(result[0].headers).toEqual(original[0].headers);
    expect(result[0]['excluded-models']).toEqual(original[0]['excluded-models']);
    expect(keys(result[0])[1]).toEqual(keys(original[0])[1]);
  });

  test('editing header values does not strip fields named like response metadata', () => {
    const original = fixture();
    const { result } = edit(original, (draft) => { draft.headersText = 'auth-index: literal header\ntest-model: allowed header\nX-New: added'; });
    expect(keys(result[0])[0].headers).toEqual({ 'auth-index': 'literal header', 'test-model': 'allowed header', 'X-New': 'added' });
  });

  test('changing a shared endpoint splits only the edited credential and retains inherited policies', () => {
    const original = fixture();
    const { result } = edit(original, (draft) => { draft.baseUrl = 'https://new.test/v1'; });
    expect(result).toHaveLength(2);
    expect(result[0]['base-url']).toBe(original[0]['base-url']);
    expect(keys(result[0])).toEqual([keys(original[0])[1]]);
    expect(result[1]['base-url']).toBe('https://new.test/v1');
    expect(result[1].models).toEqual(original[0].models);
    expect(result[1].headers).toEqual(original[0].headers);
    expect(keys(result[1])).toEqual([cleanProviderGroup(keys(original[0])[0])]);
  });

  test('weight changes affect only the selected key and clearing it restores the default', () => {
    const original = fixture();
    const changed = edit(original, (draft) => { draft.weight = '5'; }).result;
    expect(keys(changed[0])[0].weight).toBe(5);
    expect(keys(changed[0])[1].weight).toBe(0);
    const cleared = edit(changed, (draft) => { draft.weight = ''; }).result;
    expect(keys(cleared[0])[0]).not.toHaveProperty('weight');
    for (const weight of ['1.5', 'nope', '1000001']) {
      expect(() => edit(original, (draft) => { draft.weight = weight; })).toThrow();
    }
  });

  test('template edits retain untouched policies and apply explicit false and zero', () => {
    const original = fixture();
    keys(original[0])[0]['disable-codex-cloaking'] = true;
    keys(original[0])[0]['alpha-search'] = null;
    const { result } = edit(original, (draft) => {
      draft.templateFields = { ...draft.templateFields, 'request-retry': 0, 'disable-codex-cloaking': false, 'alpha-search': true };
    });
    expect(keys(result[0])[0]).toMatchObject({ 'request-retry': 0, 'disable-codex-cloaking': false, 'alpha-search': true });
    expect(keys(result[0])[0]).not.toHaveProperty('request-scoped-errors');
    expect(result[0]['request-scoped-errors']).toEqual(original[0]['request-scoped-errors']);
    expect(keys(result[0])[1]).toEqual(keys(original[0])[1]);
  });

  test('edited template rules retain unedited extension fields and clearing inherited rules is explicit', () => {
    const original = fixture();
    const rules = [{ status: 503, action: 'continue-and-cooldown', match: ['overloaded'], custom: { retained: true } }];
    const changed = edit(original, (draft) => { draft.templateFields = { ...draft.templateFields, 'request-scoped-errors': rules }; }).result;
    expect(keys(changed[0])[0]['request-scoped-errors']).toEqual(rules);
    const cleared = edit(original, (draft) => { delete draft.templateFields!['request-scoped-errors']; }).result;
    expect(keys(cleared[0])[0]['request-scoped-errors']).toEqual([]);
  });

  test('untouched Claude cloak metadata survives and an edited cache choice preserves unrelated fields', () => {
    const original = fixture();
    keys(original[0])[0].cloak = { mode: 'always', 'strict-mode': true, 'cache-user-id': true, 'sensitive-words': ['private'], custom: { retained: true } };
    expect(edit(original, () => {}, 'claude-api-key').result).toEqual(original.map(cleanProviderGroup));
    const changed = edit(original, (draft) => { draft.cloakCacheUserId = false; }, 'claude-api-key').result;
    expect(keys(changed[0])[0].cloak).toEqual({ ...(keys(original[0])[0].cloak as Value), 'cache-user-id': false });
  });

  test('editing one Claude cloak option keeps explicit false and absent sibling options distinct', () => {
    for (const cloak of [
      { 'strict-mode': false, 'cache-user-id': false, custom: { retained: true } },
      { 'cache-user-id': false, custom: { retained: true } },
    ]) {
      const original = fixture();
      keys(original[0])[0].cloak = cloak;
      const changed = edit(original, (draft) => { draft.cloakCacheUserId = true; }, 'claude-api-key').result;
      expect(keys(changed[0])[0].cloak).toEqual({ ...cloak, 'cache-user-id': true });
    }
  });
});
