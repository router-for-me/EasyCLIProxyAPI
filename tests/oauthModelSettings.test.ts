import { describe, expect, it } from 'bun:test';
import {
  authFileExcludedRulesFromPayload,
  loadOAuthModelSettings,
  saveOAuthModelSettings,
  saveOAuthProviderExclusions,
  type OAuthModelTarget,
} from '../src/services/oauthModelSettings';
import { openOAuthModelNames, setOAuthModelsExcluded } from '../src/services/oauthModels';

const modelId = 'gpt-5.6-sol';
const models = [{ id: modelId }, { id: 'gpt-5.4' }, { id: 'gpt-image-2' }];
const account = (name: string): OAuthModelTarget => ({
  scope: 'credential', provider: 'codex', label: 'Codex', name,
});
const provider: OAuthModelTarget = { scope: 'provider', provider: 'codex', label: 'Codex' };

function createApi() {
  const files: Record<string, Record<string, unknown>> = {
    'a.json': { type: 'codex', excluded_models: [], access_token: 'original', priority: 3 },
    'b.json': { type: 'codex', excluded_models: [] },
  };
  const globalRules: Record<string, string[]> = { codex: [], claude: ['claude-old-*'] };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const deletes: { path: string; query?: Record<string, string> }[] = [];
  const reads: { path: string; query?: Record<string, string> }[] = [];
  const api = {
    async get(path: string, query?: Record<string, string>): Promise<unknown> {
      reads.push({ path, query });
      if (path.startsWith('/routing/model-definitions/')) return { models };
      if (path === '/config/oauth/excluded-models') return structuredClone(globalRules);
      const file = query?.name ? files[query.name] : undefined;
      if (path === '/credentials/download' && file) return structuredClone(file);
      if (path === '/credentials/models' && file) {
        const allowed = openOAuthModelNames(models, [...authFileExcludedRulesFromPayload(file), ...globalRules.codex ?? []]);
        return { models: models.filter((model) => allowed.has(model.id)) };
      }
      throw new Error('file not found');
    },
    async patch(path: string, body: Record<string, unknown>): Promise<unknown> {
      writes.push({ path, body });
      if (path === '/credentials/fields') {
        const { name, ...fields } = body;
        Object.assign(files[String(name)], fields);
      } else throw new Error('unexpected write');
      return { status: 'ok' };
    },
    async put(path: string, body: Record<string, unknown>): Promise<unknown> {
      if (path !== '/config/oauth/excluded-models') throw new Error('unexpected put');
      writes.push({ path, body });
      for (const key of Object.keys(globalRules)) delete globalRules[key];
      Object.assign(globalRules, structuredClone(body));
      return { status: 'ok' };
    },
  };
  return { files, globalRules, writes, deletes, reads, api };
}

describe('OAuth model settings scopes', () => {
  it('serializes simultaneous provider edits and preserves unrelated values verbatim', async () => {
    const { api, globalRules } = createApi();
    globalRules[' CODEX '] = ['old'];
    globalRules['Future-Plugin'] = ['CaseSensitive-*'];
    await Promise.all([
      saveOAuthProviderExclusions(' Codex ', ['next'], api),
      saveOAuthProviderExclusions('meta', [], api),
      saveOAuthProviderExclusions('claude', undefined, api),
    ]);
    expect(globalRules).toEqual({ codex: ['next'], meta: [], 'Future-Plugin': ['CaseSensitive-*'] });
  });

  it('only defaults missing config nodes and releases the write queue after errors', async () => {
    const { api, writes } = createApi();
    const get = api.get;
    for (const error of ['Management API error (401): unauthorized', 'Management API error (404): 404 page not found']) {
      api.get = async () => { throw new Error(error); };
      await expect(saveOAuthProviderExclusions('codex', ['next'], api)).rejects.toThrow(error);
    }
    api.get = async () => [];
    await expect(saveOAuthProviderExclusions('codex', ['next'], api)).rejects.toThrow('Invalid OAuth exclusion configuration');
    expect(writes).toEqual([]);
    api.get = async () => { throw 'Management API error (404): not_found'; };
    await saveOAuthProviderExclusions('codex', ['next'], api);
    expect(writes).toEqual([{ path: '/config/oauth/excluded-models', body: { codex: ['next'] } }]);
    api.get = get;
    await saveOAuthProviderExclusions('claude', ['next'], api);
    expect(writes.at(-1)?.body).toEqual({ codex: ['next'], claude: ['next'] });
  });

  it('saves A exclusions without changing B, global rules, or refreshed account fields', async () => {
    const { api, files, globalRules, writes, reads } = createApi();
    const settings = await loadOAuthModelSettings(account('a.json'), api);
    files['a.json'].access_token = 'refreshed-during-edit';
    files['a.json'].priority = 9;
    await saveOAuthModelSettings(settings, [modelId], api);
    expect(files['a.json']).toMatchObject({ excluded_models: [modelId], access_token: 'refreshed-during-edit', priority: 9 });
    expect((await loadOAuthModelSettings(account('b.json'), api)).excludedRules).toEqual([]);
    expect(globalRules).toEqual({ codex: [], claude: ['claude-old-*'] });
    expect(writes).toEqual([{ path: '/credentials/fields', body: { name: 'a.json', excluded_models: [modelId] } }]);
    expect(reads).toContainEqual({ path: '/credentials/models', query: { name: 'a.json' } });
    expect(reads.some(({ path }) => path === '/config/oauth/excluded-models' || path.startsWith('/routing/model-definitions/'))).toBe(false);
  });

  it('loads exact account exclusions as checked candidates without copying inherited bans', async () => {
    const { api, files, globalRules } = createApi();
    globalRules.codex = ['gpt-image-*'];
    files['a.json'].excluded_models = ['gpt-5.4'];
    const settings = await loadOAuthModelSettings(account('a.json'), api);
    expect(settings.models.map((model) => model.id)).toEqual(['gpt-5.4', modelId]);
    expect(settings.excludedRules).toEqual(['gpt-5.4']);
    await saveOAuthModelSettings(settings, setOAuthModelsExcluded(settings.excludedRules, settings.models, true), api);
    expect(files['a.json'].excluded_models).toEqual(['gpt-5.4', modelId]);
    expect(globalRules.codex).toEqual(['gpt-image-*']);
    globalRules.codex = [];
    expect((await api.get('/credentials/models', { name: 'a.json' }) as { models: typeof models }).models)
      .toEqual([{ id: 'gpt-image-2' }]);
  });

  it('supports explicitly excluding a globally hidden model in account rules', async () => {
    const { api, files, globalRules } = createApi();
    globalRules.codex = ['gpt-image-*'];
    const settings = await loadOAuthModelSettings(account('a.json'), api);
    await saveOAuthModelSettings(settings, ['gpt-image-*'], api);
    globalRules.codex = [];
    expect(files['a.json'].excluded_models).toEqual(['gpt-image-*']);
    expect((await api.get('/credentials/models', { name: 'a.json' }) as { models: typeof models }).models)
      .not.toContainEqual({ id: 'gpt-image-2' });
  });

  it('can remove a wildcard ban and save with no candidate models', async () => {
    const { api, files } = createApi();
    files['a.json'].excluded_models = ['*'];
    const settings = await loadOAuthModelSettings(account('a.json'), api);
    expect(settings.models).toEqual([]);
    expect(settings.excludedRules).toEqual(['*']);
    await saveOAuthModelSettings(settings, [], api);
    expect(files['a.json'].excluded_models).toEqual([]);
    expect((await loadOAuthModelSettings(account('a.json'), api)).models).toHaveLength(3);
  });

  it('allows manual rule editing if the model catalog fails to load', async () => {
    const { api, files } = createApi();
    const originalGet = api.get;
    api.get = async (path, query) => {
      if (path === '/credentials/models') throw new Error('catalog unavailable');
      return originalGet(path, query);
    };
    const settings = await loadOAuthModelSettings(account('a.json'), api);
    expect(settings.catalogError).toContain('catalog unavailable');
    await saveOAuthModelSettings(settings, ['future-*', '*'], api);
    expect(files['a.json'].excluded_models).toEqual(['future-*', '*']);
  });

  it('updates and deletes provider exclusions without touching account files', async () => {
    const { api, files, globalRules, writes, deletes, reads } = createApi();
    files['a.json'].excluded_models = [modelId];
    await saveOAuthModelSettings(await loadOAuthModelSettings(provider, api), ['gpt-image-*'], api);
    expect(writes).toEqual([{ path: '/config/oauth/excluded-models', body: { codex: ['gpt-image-*'], claude: ['claude-old-*'] } }]);
    await saveOAuthModelSettings(await loadOAuthModelSettings(provider, api), [], api);
    expect(deletes).toEqual([]);
    expect(writes.at(-1)).toEqual({ path: '/config/oauth/excluded-models', body: { claude: ['claude-old-*'] } });
    expect(globalRules).toEqual({ claude: ['claude-old-*'] });
    expect(files['a.json'].excluded_models).toEqual([modelId]);
    expect(reads.some(({ path }) => path.startsWith('/credentials/'))).toBe(false);
    await saveOAuthModelSettings(await loadOAuthModelSettings(provider, api), [], api);
    expect(writes).toHaveLength(2);
  });

  it('uses only the OAuth exclusion endpoint even when excluding every model for a provider', async () => {
    const { api, files, globalRules, writes, deletes, reads } = createApi();
    const beforeFiles = structuredClone(files);
    await saveOAuthModelSettings(await loadOAuthModelSettings(provider, api), ['*'], api);
    expect(reads).toEqual([
      { path: '/routing/model-definitions/codex', query: undefined },
      { path: '/config/oauth/excluded-models', query: undefined },
      { path: '/config/oauth/excluded-models', query: undefined },
    ]);
    expect(writes).toEqual([
      { path: '/config/oauth/excluded-models', body: { codex: ['*'], claude: ['claude-old-*'] } },
    ]);
    expect(globalRules).toEqual({ codex: ['*'], claude: ['claude-old-*'] });
    expect(files).toEqual(beforeFiles);
    await saveOAuthModelSettings(await loadOAuthModelSettings(provider, api), [], api);
    expect(deletes).toEqual([]);
    expect(writes.at(-1)).toEqual({ path: '/config/oauth/excluded-models', body: { claude: ['claude-old-*'] } });
    expect(writes).toHaveLength(2);
    expect(files).toEqual(beforeFiles);
  });

  it('does not rewrite unchanged account rules, including legacy metadata', async () => {
    const { api, files, writes } = createApi();
    delete files['a.json'].excluded_models;
    files['a.json']['excluded-models'] = ['future-*'];
    const settings = await loadOAuthModelSettings(account('a.json'), api);
    await saveOAuthModelSettings(settings, [' FUTURE-* '], api);
    expect(writes).toEqual([]);
    expect(files['a.json']['excluded-models']).toEqual(['future-*']);
  });

  it('fails closed on missing or unreadable credential metadata', async () => {
    const { api, files, writes } = createApi();
    await expect(loadOAuthModelSettings(account('missing.json'), api)).rejects.toThrow('file not found');
    files['a.json'].excluded_models = 'gpt-*';
    await expect(loadOAuthModelSettings(account('a.json'), api)).rejects.toThrow();
    expect(writes).toEqual([]);
  });
});

describe('credential model exclusion metadata', () => {
  it('supports legacy keys and JSON text, with canonical empty values taking precedence', () => {
    expect(authFileExcludedRulesFromPayload(JSON.stringify({ 'excluded-models': [' GPT-* ', 'gpt-*'] }))).toEqual(['gpt-*']);
    expect(authFileExcludedRulesFromPayload({ excluded_models: [], 'excluded-models': ['gpt-*'] })).toEqual([]);
    expect(authFileExcludedRulesFromPayload({ excluded_models: null, 'excluded-models': ['gpt-*'] })).toEqual([]);
    expect(authFileExcludedRulesFromPayload({ type: 'codex' })).toEqual([]);
  });

  it('rejects malformed metadata without exposing credential contents', () => {
    for (const payload of [null, [], 'invalid json', { excluded_models: {} }, { excluded_models: [123] }]) {
      expect(() => authFileExcludedRulesFromPayload(payload)).toThrow();
    }
    expect(() => authFileExcludedRulesFromPayload('{"access_token": "sensitive-token"'))
      .toThrow('Could not read the credential file; model settings were not loaded');
  });
});
