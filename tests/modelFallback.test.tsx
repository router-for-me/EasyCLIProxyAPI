import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, supportedLocales, translate } from '../src/i18n';
import {
  defaultModelFallbackSettings, modelFallbackFromConfig, modelFallbackToConfig, normalizeModelFallbackCondition,
  readModelFallback, saveModelFallback, validateModelFallback, type ModelFallbackSettings,
} from '../src/services/modelFallback';
import { draftFromModelFallback, modelFallbackFromDraft, ModelFallbackPanel } from '../src/pages/routing/ModelFallbackPanel';

const configured: ModelFallbackSettings = {
  enabled: true, maxHops: 2, on: ['429', 'quota_exhausted'],
  chains: [{ model: 'gpt-6-astra', targets: ['claude-opus-5-5'] }, { model: 'coder', targets: ['claude-opus-5-5', 'gpt-6.1-terra'] }],
};

describe('model fallback service', () => {
  it('reads the core section and defaults a missing one', async () => {
    const parsed = modelFallbackFromConfig({ enabled: true, 'max-hops': 3, on: [429, 'QUOTA_EXHAUSTED', 401, 429], chains: { b: ['c'], a: ['b', 'c'] } });
    expect(parsed).toEqual({ enabled: true, maxHops: 3, on: ['429', 'quota_exhausted'], chains: [{ model: 'a', targets: ['b', 'c'] }, { model: 'b', targets: ['c'] }] });
    const missing = { get: async () => { throw new Error('Management API error (404): not_found'); }, put: async () => ({}) };
    expect(await readModelFallback(missing)).toEqual(defaultModelFallbackSettings());
    const broken = { get: async () => { throw new Error('Management API error (500): boom'); }, put: async () => ({}) };
    await expect(readModelFallback(broken)).rejects.toThrow('500');
  });

  it('does not turn malformed responses or unrelated 404 errors into writable defaults', async () => {
    for (const raw of [null, [], 'unavailable', { enabled: 'true' }, { 'max-hops': 'two' }, { on: {} }, { chains: [] }, { chains: { a: 'b' } }]) {
      const api = { get: async <T,>() => raw as T, put: async () => ({}) };
      await expect(readModelFallback(api)).rejects.toThrow();
    }
    for (const detail of ['Management API error (404): not_found: endpoint unavailable', 'Management API error (404): 404 page not found']) {
      const api = { get: async () => { throw new Error(detail); }, put: async () => ({}) };
      await expect(readModelFallback(api)).rejects.toThrow(detail);
    }
    expect(modelFallbackFromConfig({ on: [] }).on).toEqual([]);
  });

  it('keeps explicit empty conditions distinct from omitted defaults through save and read', async () => {
    let stored: unknown = {};
    const api = {
      get: async <T,>() => stored as T,
      put: async <T,>(_path: string, body?: unknown) => { stored = body; return {} as T; },
    };
    const baseline = await readModelFallback(api);
    expect(baseline.on).toEqual(defaultModelFallbackSettings().on);
    const next = { ...configured, on: [] };
    expect((await saveModelFallback(next, baseline, api)).on).toEqual([]);
    expect((await readModelFallback(api)).on).toEqual([]);
  });

  it('rejects stale drafts and failed reads before any write', async () => {
    let writes = 0;
    const api = {
      get: async <T,>() => modelFallbackToConfig({ ...configured, maxHops: 4 }) as T,
      put: async () => { writes++; return {}; },
    };
    await expect(saveModelFallback({ ...configured, maxHops: 3 }, configured, api)).rejects.toThrow('Configuration changed');
    await expect(saveModelFallback(configured, configured, { ...api, get: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
    expect(writes).toBe(0);
  });

  it('preserves unknown fields and special model names without a fallible post-write read', async () => {
    let reads = 0;
    let stored: unknown;
    const api = {
      get: async <T,>() => {
        if (++reads > 1) throw new Error('read unavailable after commit');
        return { ...modelFallbackToConfig(configured), future: { keep: true } } as T;
      },
      put: async <T,>(_path: string, body?: unknown) => { stored = body; return {} as T; },
    };
    const next = { ...configured, on: [' 429 ', ' Auth_Unavailable '], chains: [{ model: '__proto__', targets: ['backup'] }] };
    const result = await saveModelFallback(next, configured, api);
    expect(result.on).toEqual(['429', 'auth_unavailable']);
    expect(result.chains).toEqual(next.chains);
    expect(stored).toEqual({ enabled: true, 'max-hops': 2, on: [429, 'auth_unavailable'], chains: JSON.parse('{"__proto__":["backup"]}'), future: { keep: true } });
    expect(reads).toBe(1);
    const failing = { get: async <T,>() => modelFallbackToConfig(configured) as T, put: async () => { throw new Error('write failed'); } };
    await expect(saveModelFallback(next, configured, failing)).rejects.toThrow('write failed');
  });

  it('mirrors the core condition rules', () => {
    for (const ok of ['408', '429', '500', '529', '599', '5xx', 'quota_exhausted', ' Auth_Unavailable ']) expect(normalizeModelFallbackCondition(ok)).not.toBeNull();
    for (const bad of ['400', '401', '403', '404', '413', '422', '600', 'often', '42']) expect(normalizeModelFallbackCondition(bad)).toBeNull();
  });

  it('validates hops, conditions and chains', () => {
    expect(validateModelFallback(configured)).toBe('');
    expect(validateModelFallback({ ...configured, maxHops: 0 })).not.toBe('');
    expect(validateModelFallback({ ...configured, maxHops: 9 })).not.toBe('');
    expect(validateModelFallback({ ...configured, on: ['401'] })).toContain('401');
    expect(validateModelFallback({ ...configured, on: [] })).toBe('');
    expect(validateModelFallback({ ...configured, chains: [{ model: '', targets: ['b'] }] })).not.toBe('');
    expect(validateModelFallback({ ...configured, chains: [{ model: 'a', targets: [] }] })).not.toBe('');
    expect(validateModelFallback({ ...configured, chains: [{ model: 'a', targets: ['A'] }] })).toContain('a');
    expect(validateModelFallback({ ...configured, chains: [{ model: 'a', targets: ['b'] }, { model: 'A', targets: ['c'] }] })).not.toBe('');
  });

  it('writes the whole section through the v8 config path', async () => {
    const writes: [string, unknown][] = [];
    let stored: unknown = {};
    const api = {
      get: async <T,>() => stored as T,
      put: async <T,>(path: string, body?: unknown) => { writes.push([path, body]); stored = body; return {} as T; },
    };
    const result = await saveModelFallback(configured, defaultModelFallbackSettings(), api);
    expect(writes).toEqual([['/config/routing/model-fallback', {
      enabled: true, 'max-hops': 2, on: [429, 'quota_exhausted'],
      chains: { 'gpt-6-astra': ['claude-opus-5-5'], coder: ['claude-opus-5-5', 'gpt-6.1-terra'] },
    }]]);
    expect(result.chains.map(chain => chain.model)).toEqual(['coder', 'gpt-6-astra']);
    await expect(saveModelFallback({ ...configured, on: ['403'] }, result, api)).rejects.toThrow('403');
    expect(writes).toHaveLength(1);
    expect(modelFallbackToConfig(defaultModelFallbackSettings())).toEqual({ enabled: false, 'max-hops': 2, on: [429, 'quota_exhausted', 'auth_unavailable', 529], chains: {} });
  });
});

describe('model fallback panel', () => {
  it('round-trips comma-separated targets through the draft', () => {
    const draft = draftFromModelFallback(configured);
    expect(draft.rows[1]).toEqual({ model: 'coder', targets: 'claude-opus-5-5, gpt-6.1-terra' });
    draft.rows[1].targets = ' claude-opus-5-5 ,, gpt-6.1-terra , ';
    expect(modelFallbackFromDraft(draft)).toEqual(configured);
  });

  it('renders configured chains and conditions', () => {
    const html = renderToStaticMarkup(<I18nProvider><ModelFallbackPanel disabled={false} initial={configured} /></I18nProvider>);
    expect(html).toContain('value="gpt-6-astra"');
    expect(html).toContain('value="claude-opus-5-5, gpt-6.1-terra"');
    expect(html).toContain('X-CPA-Fallback-Model');
    expect(html).not.toContain('routing.fallback.');
  });

  it('translates every fallback message in every supported locale', () => {
    for (const locale of supportedLocales) {
      expect(translate(locale, 'routing.fallback.title')).not.toBe('routing.fallback.title');
      expect(translate(locale, 'routing.fallback.maxHopsDesc', { max: 8 })).toContain('8');
      expect(translate(locale, 'routing.fallback.selfTarget', { model: 'm' })).toContain('m');
    }
  });
});
