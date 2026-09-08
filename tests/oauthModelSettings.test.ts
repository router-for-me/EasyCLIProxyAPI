import { describe, expect, it } from 'bun:test';
import {
  authFileExcludedRulesFromPayload,
  loadOAuthModelSettings,
  saveOAuthModelSettings,
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
      if (path.startsWith('/model-definitions/')) return { models };
      if (path === '/oauth-excluded-models') return { 'oauth-excluded-models': structuredClone(globalRules) };
      const file = query?.name ? files[query.name] : undefined;
      if (path === '/auth-files/download' && file) return structuredClone(file);
      if (path === '/auth-files/models' && file) {
        const allowed = openOAuthModelNames(models, [...authFileExcludedRulesFromPayload(file), ...globalRules.codex ?? []]);
        return { models: models.filter((model) => allowed.has(model.id)) };
      }
      throw new Error('file not found');
    },
    async patch(path: string, body: Record<string, unknown>): Promise<unknown> {
      writes.push({ path, body });
      if (path === '/auth-files/fields') {
        const { name, ...fields } = body;
        Object.assign(files[String(name)], fields);
      } else if (path === '/oauth-excluded-models') {
        globalRules[String(body.provider)] = body.models as string[];
      } else throw new Error('unexpected write');
      return { status: 'ok' };
    },
    async delete(path: string, options?: { query?: Record<string, string> }): Promise<unknown> {
      if (path !== '/oauth-excluded-models' || !options?.query?.provider) throw new Error('unexpected delete');
      deletes.push({ path, query: options.query });
      delete globalRules[options.query.provider];
      return { status: 'ok' };
    },
  };
  return { files, globalRules, writes, deletes, reads, api };
}

describe('OAuth model settings scopes', () => {
  it('saves A exclusions without changing B, global rules, or refreshed account fields', async () => {
    const { api, files, globalRules, writes, reads } = createApi();
    const settings = await loadOAuthModelSettings(account('a.json'), api);
    files['a.json'].access_token = 'refreshed-during-edit';
    files['a.json'].priority = 9;
    await saveOAuthModelSettings(settings, [modelId], api);
    expect(files['a.json']).toMatchObject({ excluded_models: [modelId], access_token: 'refreshed-during-edit', priority: 9 });
    expect((await loadOAuthModelSettings(account('b.json'), api)).excludedRules).toEqual([]);
    expect(globalRules).toEqual({ codex: [], claude: ['claude-old-*'] });
    expect(writes).toEqual([{ path: '/auth-files/fields', body: { name: 'a.json', excluded_models: [modelId] } }]);
    expect(reads).toContainEqual({ path: '/auth-files/models', query: { name: 'a.json' } });
    expect(reads.some(({ path }) => path === '/oauth-excluded-models' || path.startsWith('/model-definitions/'))).toBe(false);
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
    expect((await api.get('/auth-files/models', { name: 'a.json' }) as { models: typeof models }).models)
      .toEqual([{ id: 'gpt-image-2' }]);
  });

  it('supports explicitly excluding a globally hidden model in account rules', async () => {
    const { api, files, globalRules } = createApi();
    globalRules.codex = ['gpt-image-*'];
    const settings = await loadOAuthModelSettings(account('a.json'), api);
    await saveOAuthModelSettings(settings, ['gpt-image-*'], api);
    globalRules.codex = [];
    expect(files['a.json'].excluded_models).toEqual(['gpt-image-*']);
    expect((await api.get('/auth-files/models', { name: 'a.json' }) as { models: typeof models }).models)
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
      if (path === '/auth-files/models') throw new Error('catalog unavailable');
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
    expect(writes).toEqual([{ path: '/oauth-excluded-models', body: { provider: 'codex', models: ['gpt-image-*'] } }]);
    await saveOAuthModelSettings(await loadOAuthModelSettings(provider, api), [], api);
    expect(deletes).toEqual([{ path: '/oauth-excluded-models', query: { provider: 'codex' } }]);
    expect(globalRules).toEqual({ claude: ['claude-old-*'] });
    expect(files['a.json'].excluded_models).toEqual([modelId]);
    expect(reads.some(({ path }) => path.startsWith('/auth-files/'))).toBe(false);
    await saveOAuthModelSettings(await loadOAuthModelSettings(provider, api), [], api);
    expect(deletes).toHaveLength(1);
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
      .toThrow('无法读取凭证文件内容，未加载模型设置');
  });
});
