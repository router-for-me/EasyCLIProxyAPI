import { describe, expect, it } from 'bun:test';
import { buildProviderGroupRecord, providerDraftFromRecord, type ProviderSection } from '../src/pages/ApiAccessPage';
import { appendNativeProviderGroup, validateProviderTemplateRecord, validateProviderGroupKeys, providerKeyDraft } from '../src/services/providerGroups';
import { modelEndpointCandidates, modelsFromRecord } from '../src/services/modelService';
import { buildProviderHealthProbe } from '../src/services/providerHealthCheck';

const sections: ProviderSection[] = ['gemini-api-key', 'interactions-api-key', 'vertex-api-key', 'codex-api-key', 'claude-api-key', 'xai-api-key', 'meta-api-key', 'openai-compatibility'];
describe('v8 provider template fields', () => {
  for (const section of sections) it(`${section} preserves unknown data, explicit defaults and inheritance`, () => {
    const group = {
      name: 'production', priority: 0, headers: {}, 'request-retry': -1, 'request-scoped-errors': [],
      extension: { future: false }, models: null,
      keys: [{ 'api-key': 'first', weight: -2, 'request-scoped-errors': null, models: [], headers: null, 'disable-cooling': false },
        { 'api-key': 'second', weight: 0, 'proxy-url': '', extension: { opaque: 0 } }],
    };
    const draft = providerDraftFromRecord(section, group);
    draft.name = 'renamed';
    expect(buildProviderGroupRecord(section, draft, group)).toEqual({ ...group, name: 'renamed' });
  });

  it('edits group error rules separately from key overrides without merging lists', () => {
    const group = { name: 'gateway', 'request-retry': 5,
      'request-scoped-errors': [{ status: 400, match: ['old'], action: 'continue', opaque: { keep: true } }],
      keys: [{ 'api-key': 'inherited', 'request-scoped-errors': null }, { 'api-key': 'cleared', 'request-scoped-errors': [] }] };
    const draft = providerDraftFromRecord('codex-api-key', group);
    draft.templateFields!['request-retry'] = 0;
    (draft.templateFields!['request-scoped-errors'] as any[])[0].match = [];
    const saved = buildProviderGroupRecord('codex-api-key', draft, group);
    expect(saved['request-retry']).toBe(0);
    expect(saved['request-scoped-errors']).toEqual([{ ...group['request-scoped-errors'][0], match: [] }]);
    expect(saved.keys).toEqual(group.keys);
    delete draft.templateFields!['request-retry'];
    expect(buildProviderGroupRecord('codex-api-key', draft, group)).not.toHaveProperty('request-retry');
  });

  it('supports explicit model capabilities and removal without dropping future metadata or pooled aliases', () => {
    const models = [
      { name: 'model-a', alias: 'pooled', 'display-name': 'A', 'max-context-length': 32768, 'is-compat': true,
        thinking: { levels: ['low', 'high'], 'zero-allowed': false, vendor: 1 }, custom: { preserve: [] } },
      { name: 'model-b', alias: 'pooled', image: false, 'input-modalities': ['text', 'image'], 'output-modalities': ['text'] },
    ];
    const group = { name: 'gateway', models, keys: [{ 'api-key': 'key' }] };
    const draft = providerDraftFromRecord('openai-compatibility', group);
    const first = draft.models[0];
    first.config = { ...first.config, 'is-compat': false, 'max-context-length': 0, 'display-name': '' };
    delete first.config.thinking;
    delete first.thinking;
    const second = draft.models[1];
    second.config = { ...second.config, 'input-modalities': [], 'output-modalities': [], 'use-max-completion-tokens': false };
    const saved = buildProviderGroupRecord('openai-compatibility', draft, group);
    expect(saved.models).toEqual([
      { name: 'model-a', alias: 'pooled', 'display-name': '', 'max-context-length': 0, 'is-compat': false, custom: { preserve: [] } },
      { ...models[1], 'input-modalities': [], 'output-modalities': [], 'use-max-completion-tokens': false },
    ]);
  });

  it('retains per-key provider options when rotating the credential', () => {
    for (const options of [
      { 'disable-codex-cloaking': false, 'alpha-search': true, websockets: false },
      { 'rebuild-mid-system-message': false, 'fingerprint-profile': '', 'experimental-cch-signing': false,
        cloak: { mode: 'never', 'strict-mode': false, 'sensitive-words': [], 'cache-user-id': false, custom: {} } },
    ]) {
      const group = { name: 'gateway', keys: [{ 'api-key': 'old', ...options }] };
      const draft = providerDraftFromRecord('claude-api-key', group);
      draft.groupKeys![0].value['api-key'] = 'new';
      expect(buildProviderGroupRecord('claude-api-key', draft, group).keys).toEqual([{ 'api-key': 'new', ...options }]);
    }
  });

  it('rejects invalid retry/error/model values and accepts negative weights that disable weighted routing', () => {
    for (const value of [
      { 'request-retry': 1.5 }, { 'request-scoped-errors': [{ status: 600, action: 'stop' }] },
      { 'request-scoped-errors': [{ status: 400, action: 'retry' }] },
      { models: [{ name: 'm', 'max-context-length': -1 }] },
      { models: [{ name: 'm', thinking: { min: 500, max: 200 } }] },
      { keys: [{ models: [{ name: 'm', thinking: { levels: [2] } }] }] },
    ]) expect(validateProviderTemplateRecord(value)).not.toBeNull();
    expect(validateProviderTemplateRecord({ 'request-retry': -1, keys: [{ weight: -1 }] })).toBeNull();
    expect(validateProviderGroupKeys([providerKeyDraft({ 'api-key': 'k', weight: -1 })])).toBeNull();
  });

  it('EasyMode appends one native group without flattening or losing existing overrides', () => {
    const existing = [{ name: 'codex', opaque: { keep: null }, models: [{ name: 'm', thinking: { levels: [] } }], keys: [
      { 'api-key': 'a', weight: 5, headers: null, models: null },
      { 'api-key': 'b', weight: 0, headers: {}, models: [], 'request-retry': 0 },
    ] }, { name: 'codex (2)', keys: [] }];
    const snapshot = structuredClone(existing);
    const next = appendNativeProviderGroup(existing, { name: 'codex', keys: [{ 'api-key': 'c' }] });
    expect(next.slice(0, 2)).toEqual(snapshot);
    expect(next[2]).toEqual({ name: 'codex (3)', keys: [{ 'api-key': 'c' }] });
    expect(existing).toEqual(snapshot);
  });

  it('retains full model metadata only when requested for the configuration editor', () => {
    const record = { name: 'm', 'support-configuration-update': false, thinking: { zero_allowed: false, levels: [] }, unknown: [] };
    expect(modelsFromRecord([record], true)[0].config).toEqual({ ...record, thinking: { 'zero-allowed': false, levels: [] } });
    expect(modelsFromRecord([record])[0]).not.toHaveProperty('config');
  });
});

describe('new native provider connections', () => {
  it('uses native model discovery defaults', () => {
    expect(modelEndpointCandidates('interactions', '')).toEqual(['https://generativelanguage.googleapis.com/v1beta/models']);
    expect(modelEndpointCandidates('vertex', '')[0]).toBe('https://aiplatform.googleapis.com/v1/publishers/google/models');
    expect(modelEndpointCandidates('xai', '')).toEqual(['https://api.x.ai/v1/models']);
    expect(modelEndpointCandidates('meta', '')).toEqual(['https://api.meta.ai/v1/models']);
  });
  it('probes Interactions and Vertex with Google keys and their native endpoints', () => {
    const interactions = buildProviderHealthProbe('interactions', '', 'models/gemini-3-pro-preview', 'google-key');
    expect(interactions.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(interactions.protocol).toBe('interactions');
    expect(interactions.header['x-goog-api-key']).toBe('google-key');
    expect(JSON.parse(interactions.data)).toEqual({ model: 'gemini-3-pro-preview', input: 'hi', stream: true });
    const vertex = buildProviderHealthProbe('vertex', '', 'gemini-3-pro-preview', 'vertex-key');
    expect(vertex.url).toBe('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3-pro-preview:streamGenerateContent?alt=sse');
    expect(vertex.header['x-goog-api-key']).toBe('vertex-key');
  });
  it('uses native Responses defaults for xAI and Meta', () => {
    for (const [provider, host] of [['xai', 'api.x.ai'], ['meta', 'api.meta.ai']] as const) {
      const probe = buildProviderHealthProbe(provider, '', 'native-model', 'key');
      expect(probe.url).toBe(`https://${host}/v1/responses`);
      expect(probe.protocol).toBe('openai-responses');
      expect(probe.header.Authorization).toBe('Bearer key');
      expect(buildProviderHealthProbe(provider, 'https://gateway.test/api', 'native-model', 'key').url).toBe('https://gateway.test/api/responses');
      expect(modelEndpointCandidates(provider, 'https://gateway.test/api')).toEqual(['https://gateway.test/api/models']);
    }
  });
});
