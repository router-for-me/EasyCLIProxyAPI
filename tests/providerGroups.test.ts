import { describe, expect, test } from 'bun:test';
import { buildProviderGroupRecord, providerDraftFromRecord, reorderProviderRecords, resolveProviderRecordIndex } from '../src/pages/ApiAccessPage';
import { cleanProviderGroup, effectiveProviderKey, providerGroupStatus, providerKeyDraft, serializeProviderKey } from '../src/services/providerGroups';

const group = () => ({
  name: 'shared-gateway', 'base-url': 'https://gateway.test/v1',
  priority: 3, 'proxy-url': 'http://proxy.test:80', 'excluded-models': ['old-*'],
  headers: { 'X-Group': 'shared' }, 'request-retry': 0,
  models: [{ name: 'upstream' }, { name: 'upstream', alias: 'upstream-fast', thinking: { levels: ['high'] } }],
  keys: [
    { 'api-key': 'key-a', weight: 2, 'auth-index': 'runtime-a' },
    { 'api-key': 'key-b', weight: 5, priority: null, headers: {}, models: null,
      'excluded-models': [], 'disable-cooling': false, websockets: false, 'request-scoped-errors': [{ status: 429, action: 'continue' }] },
    { 'api-key': 'key-c', priority: 0, models: [{ name: 'private', alias: 'private-alias' }], 'proxy-url': 'direct' },
  ],
});

describe('native v8 provider groups', () => {
  for (const section of ['codex-api-key', 'claude-api-key', 'gemini-api-key', 'openai-compatibility'] as const) {
    test(`${section} keeps one group, key order and overrides on a shared edit`, () => {
      const original = group();
      const draft = providerDraftFromRecord(section, original);
      draft.name = 'renamed'; draft.priority = '4';
      const saved = buildProviderGroupRecord(section, draft, original);
      expect(saved).toEqual({ ...cleanProviderGroup(original), name: 'renamed', priority: 4 });
      expect(original.keys[0]['auth-index']).toBe('runtime-a');
      expect(saved).not.toHaveProperty('api-key');
      expect(saved).not.toHaveProperty('api-key-entries');
    });
  }
  test('preserves absent, null and empty shared fields on an unrelated edit', () => {
    for (const fields of [{}, { models: null, headers: null, 'proxy-url': null }, { models: [], headers: {}, 'proxy-url': '' }]) {
      const original = { name: 'empty', keys: [], ...fields };
      const draft = providerDraftFromRecord('codex-api-key', original);
      expect(buildProviderGroupRecord('codex-api-key', draft, original)).toEqual(original);
    }
  });
  test('shared model edits keep existing aliases and independent key models', () => {
    const original = group();
    const draft = providerDraftFromRecord('codex-api-key', original);
    draft.models = [...draft.models, { name: 'new-model' }];
    const saved = buildProviderGroupRecord('codex-api-key', draft, original);
    expect(saved.models).toEqual(expect.arrayContaining([...original.models, { name: 'new-model' }]));
    expect((saved.models as unknown[]).length).toBe(3);
    expect(saved.keys).toEqual(cleanProviderGroup(original).keys);
  });
  test('key rotation and removal do not transfer settings to another key', () => {
    const original = group();
    const draft = providerDraftFromRecord('codex-api-key', original);
    const second = draft.groupKeys![1];
    second.value['api-key'] = 'rotated';
    draft.groupKeys = [second, providerKeyDraft({ 'api-key': 'new' })];
    const saved = buildProviderGroupRecord('codex-api-key', draft, original);
    expect(saved.keys).toEqual([{ ...original.keys[1], 'api-key': 'rotated' }, { 'api-key': 'new' }]);
  });
  test('all aliases of one upstream can be edited and removed individually', () => {
    const original = group();
    const draft = providerDraftFromRecord('codex-api-key', original);
    expect(draft.models.map((model) => model.alias ?? '')).toEqual(['', 'upstream-fast']);
    draft.models[1].alias = 'upstream-renamed';
    const renamed = buildProviderGroupRecord('codex-api-key', draft, original);
    expect(renamed.models).toEqual([original.models[0], { ...original.models[1], alias: 'upstream-renamed' }]);
    draft.models = [draft.models[1]];
    expect(buildProviderGroupRecord('codex-api-key', draft, original).models)
      .toEqual([{ ...original.models[1], alias: 'upstream-renamed' }]);
  });
  test('stale checks distinguish inherited null from explicit empty overrides', () => {
    const original = group();
    const changed = structuredClone(original);
    changed.keys[1].models = [] as never;
    expect(resolveProviderRecordIndex([changed], { section: 'codex-api-key', name: original.name,
      apiKey: 'key-a', baseUrl: original['base-url'], index: 0, record: original })).toBe(-1);
  });
  test('inheritance respects null, explicit false, zero and entire map/list overrides', () => {
    const original = group();
    const effective = effectiveProviderKey(original, original.keys[1]);
    expect(effective).toMatchObject({ priority: 3, models: original.models, headers: {}, 'excluded-models': [], 'disable-cooling': false });
    expect(effectiveProviderKey(original, original.keys[2]).priority).toBe(0);
    expect(providerGroupStatus({ ...original, 'excluded-models': ['*'] })).toBe('partial');
    expect(providerGroupStatus({ ...original, disabled: true })).toBe('disabled');
  });
  test('serializes explicit blank overrides and rejects malformed headers', () => {
    const draft = providerKeyDraft({ 'api-key': 'key', headers: null, 'excluded-models': ['old'] });
    draft.text = { headers: '', 'excluded-models': '' };
    expect(serializeProviderKey(draft)).toEqual({ 'api-key': 'key', headers: {}, 'excluded-models': [] });
    draft.text.headers = 'bad header';
    expect(() => serializeProviderKey(draft)).toThrow();
  });
  test('external changes to a sibling key reject stale group saves', () => {
    const original = group();
    const identity = { section: 'codex-api-key' as const, name: original.name, apiKey: 'key-a', baseUrl: original['base-url'], index: 0, record: original };
    const changed = group(); changed.keys[1].weight = 10;
    expect(resolveProviderRecordIndex([changed], identity)).toBe(-1);
    const other = { ...group(), name: 'other' };
    const second = { ...identity, index: 1, name: 'other', record: other };
    expect(reorderProviderRecords([original, other], [identity, second], identity, second))
      .toEqual([cleanProviderGroup(other), cleanProviderGroup(original)]);
  });
});
