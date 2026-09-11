import { describe, expect, test } from 'bun:test';
import { harnessContextDefault, harnessDraft, parseHarnessDraft, sameHarnessDraft, updateHarnessDraft } from '../src/services/deepSeekHarnessCatalog';

describe('DSH catalog overrides', () => {
  test('context values use model metadata, provider configuration, then DSH defaults', () => {
    expect(harnessContextDefault({ contextWindow: 128000 }, { defaultContextWindow: '64000' })).toEqual({ value: 128000, source: 'model' });
    expect(harnessContextDefault({}, { defaultContextWindow: '64000' })).toEqual({ value: 64000, source: 'provider' });
    expect(harnessContextDefault({}, {})).toEqual({ value: 262144, source: 'default' });
    expect(harnessContextDefault({ contextWindow: null }, { defaultContextWindow: '0' })).toEqual({ value: 262144, source: 'default' });
  });
  test('empty values inherit while explicit false and zero remain overrides', () => {
    const draft = harnessDraft({ timeoutMs: 0, retryPolicy: { mode: 'normal', maxRetries: 0 }, compat: { supportsStore: false } }, 'provider');
    expect(parseHarnessDraft(draft, 'provider', 'openai-completions')).toEqual({ timeoutMs: 0, retryPolicy: { mode: 'normal', maxRetries: 0 }, compat: { supportsStore: false } });
    expect(parseHarnessDraft(updateHarnessDraft(draft, 'timeoutMs', ''), 'provider', 'openai-completions').timeoutMs).toBeUndefined();
    expect(parseHarnessDraft({}, 'model', 'openai-completions')).toEqual({});
    expect(parseHarnessDraft({ input: '[]' }, 'model', 'openai-completions')).toEqual({ input: [] });
  });
  test('reasoning levels keep wire values and only off allows null', () => {
    expect(parseHarnessDraft({ reasoningEfforts: '{"off":null,"high":"custom-high"}' }, 'model', 'openai-completions')).toEqual({ reasoningEfforts: { off: null, high: 'custom-high' } });
    expect(parseHarnessDraft({ reasoningEfforts: 'false' }, 'model', 'openai-completions')).toEqual({ reasoningEfforts: false });
    expect(() => parseHarnessDraft({ reasoningEfforts: '{"high":null}' }, 'model', 'openai-completions')).toThrow();
    expect(() => parseHarnessDraft({ reasoningEfforts: '{}' }, 'model', 'openai-completions')).toThrow();
  });
  test('reasoning maps require a thinking level beyond off', () => {
    for (const reasoningEfforts of ['{"off":null}', '{"off":"none"}']) {
      expect(() => parseHarnessDraft({ reasoningEfforts }, 'model', 'openai-completions')).toThrow('reasoningEfforts');
    }
    expect(parseHarnessDraft({ reasoningEfforts: '{"high":"high"}' }, 'model', 'openai-completions')).toEqual({ reasoningEfforts: { high: 'high' } });
  });
  test('invalid numbers, JSON, headers and incompatible protocol switches are rejected', () => {
    for (const draft of [{ maxTokens: '-1' }, { input: '["audio"]' }, { contextWindow: '2.5' }, { 'compat.supportsStore': 'null' }, { 'compat.supportsTemperature': 'true' }]) {
      expect(() => parseHarnessDraft(draft, 'model', 'openai-completions')).toThrow();
    }
    expect(() => parseHarnessDraft({ headers: '{bad json}' }, 'provider', 'openai-completions')).toThrow();
    expect(() => parseHarnessDraft({ headers: '{"x-test":"a\\r\\nb"}' }, 'provider', 'openai-completions')).toThrow();
    expect(() => parseHarnessDraft({ 'retryPolicy.backoff.initialDelayMs': '20000' }, 'provider', 'openai-completions')).toThrow();
  });
  test('nested groups round trip and follow current protocol', () => {
    const profile = { api: 'anthropic-messages', compat: { supportsTemperature: false }, retryPolicy: { mode: 'always', backoff: { maxDelayMs: 60000 } }, thinkingBudgets: { high: 8192 } };
    expect(parseHarnessDraft(harnessDraft(profile, 'provider'), 'provider', 'anthropic-messages')).toEqual(profile);
    expect(sameHarnessDraft({ input: '["text"]', name: 'A' }, { name: 'A', input: '["text"]' })).toBe(true);
  });
});
