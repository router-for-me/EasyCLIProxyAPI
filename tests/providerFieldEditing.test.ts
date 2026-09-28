import { describe, expect, it } from 'bun:test';
import { applyProviderPreset, buildProviderRecord, createProviderDraft, stripResponseFields } from '../src/pages/ApiAccessPage';
import { modelsFromDiscoveredPayload, modelsFromRecord } from '../src/services/modelService';

describe('provider field editing semantics', () => {
  it('distinguishes explicit false, inherited defaults and untouched optional settings', () => {
    for (const section of ['codex-api-key', 'claude-api-key', 'gemini-api-key', 'openai-compatibility'] as const) {
      const draft = { ...createProviderDraft(section), name: 'provider', apiKey: 'key', baseUrl: 'https://example.test/v1' };
      const current = { 'disable-cooling': false, 'request-retry': 0, weight: 0 };
      for (const value of [true, false, null, undefined]) {
        const result = buildProviderRecord(section, { ...draft, disableCooling: value }, current);
        if (value === null) expect(result).not.toHaveProperty('disable-cooling');
        else expect(result['disable-cooling']).toBe(value ?? false);
        expect(result['request-retry']).toBe(0);
        expect(result.weight).toBe(0);
      }
    }
  });

  it('preserves other cloak fields during a partial update and can restore inherited caching', () => {
    const draft = { name: '', remark: '', apiKey: 'key', baseUrl: '', priority: '', models: [] };
    const current = { cloak: { mode: 'always', 'strict-mode': true, 'cache-user-id': true, 'sensitive-words': ['private'] } };
    for (const value of [false, true, null]) {
      const result = buildProviderRecord('claude-api-key', { ...draft, cloakCacheUserId: value }, current);
      expect(result.cloak).toMatchObject({ mode: 'always', 'strict-mode': true, 'sensitive-words': ['private'] });
      if (value === null) expect(result.cloak).not.toHaveProperty('cache-user-id');
      else expect(result.cloak).toMatchObject({ 'cache-user-id': value });
    }
    expect(current.cloak['cache-user-id']).toBe(true);
  });

  it('leaves each model reasoning policy intact when only another field was edited', () => {
    const current = { name: 'compat', models: [
      { name: 'first', thinking: { levels: ['low', 'high'] } },
      { name: 'second', thinking: { min: 128, max: 8192, levels: ['medium'] } },
    ] };
    const draft = applyProviderPreset('openai-compatibility', {
      ...createProviderDraft('openai-compatibility'), name: 'compat', apiKey: 'key',
      models: modelsFromRecord(current.models), thinkingLevels: ['low', 'high', 'medium'],
      thinkingLevelsEdited: false, priority: '2',
    });
    expect(buildProviderRecord('openai-compatibility', draft, current).models).toEqual(current.models);
  });

  it('normalizes discovery JSON names and ignores non-config upstream reasoning metadata', () => {
    const models = modelsFromDiscoveredPayload({ data: [{ id: 'model', thinking: {
      min: 128, max: 8192, zero_allowed: true, 'zero-allowed': false, dynamic_allowed: true,
      levels: ['low', 'high'], effort: 'high', vendor_metadata: { arbitrary: true },
    } }, { id: 'bad-metadata', thinking: { min: 'oops', max: 1.5, levels: [1], zero_allowed: 'yes' } }] });
    expect(models[0].thinking).toEqual({ min: 128, max: 8192, 'zero-allowed': false, 'dynamic-allowed': true, levels: ['low', 'high'] });
    expect(models[1].thinking).toBeUndefined();
    expect(stripResponseFields({ 'test-model': 'old', models: [{ name: 'model', thinking: { zero_allowed: true }, custom: true }] }))
      .toEqual({ models: [{ name: 'model', thinking: { 'zero-allowed': true }, custom: true }] });
  });

  it('accepts negative priorities and rejects fractional, nonnumeric and unsafe values', () => {
    const draft = { ...createProviderDraft('codex-api-key'), apiKey: 'key' };
    expect(buildProviderRecord('codex-api-key', { ...draft, priority: '-2' }).priority).toBe(-2);
    for (const priority of ['1.5', 'abc', 'Infinity', '9007199254740992']) {
      expect(() => buildProviderRecord('codex-api-key', { ...draft, priority })).toThrow('Priority must be a safe integer');
    }
  });
});
