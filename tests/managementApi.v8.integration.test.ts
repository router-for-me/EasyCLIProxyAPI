import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  applyProviderPreset, buildProviderRecord, buildProviderGroupRecord, createProviderDraft, providerDraftFromRecord,
  type ProviderSection,
} from '../src/pages/ApiAccessPage';
import { flattenV8ProviderGroups, groupLegacyProviderRecords } from './fixtures/legacyProviderRecords';

const executable = process.env.CPA_V8_TEST_CORE;
describe.skipIf(!executable)('real v8 provider configuration', () => {
  let child: ChildProcess;
  let work = '';
  let origin = '';
  const headers = { Authorization: 'Bearer isolated-test-secret', 'Content-Type': 'application/json' };
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'easycpa-v8-fields-'));
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((done) => listener.close(() => done()));
    const config = join(work, 'config.yaml');
    await writeFile(config, `config-version: 8
server: {host: 127.0.0.1, port: ${port}}
management: {secret-key: isolated-test-secret, disable-control-panel: true, disable-auto-update-panel: true}
access: {api-keys: [isolated-client-key]}
oauth: {auth-dir: ${JSON.stringify(join(work, 'auth'))}}
`);
    child = spawn(resolve(executable!), ['--config', config, '--local-model'], {
      cwd: work, windowsHide: true, stdio: 'ignore',
    });
    let startupError: Error | undefined;
    child.on('error', (error) => { startupError = error; });
    origin = `http://127.0.0.1:${port}/v8/management`;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Kernel exited: ${child.exitCode}`);
      try { if ((await fetch(`${origin}/config`, { headers })).ok) return; } catch {}
      await Bun.sleep(100);
    }
    throw new Error('Kernel startup timed out');
  }, 15000);
  afterAll(async () => {
    if (child?.pid && child.exitCode === null) {
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      child.kill();
      await exited;
    }
    if (work && resolve(work).startsWith(resolve(tmpdir()) + sep + 'easycpa-v8-fields-')) {
      await rm(work, { recursive: true, force: true });
    }
  });

  const save = async (provider: string, records: Record<string, unknown>[]) => {
    const url = `${origin}/config/api-keys/${provider}`;
    const response = await fetch(url, {
      method: 'PUT', headers, body: JSON.stringify(groupLegacyProviderRecords(provider, records)),
    });
    const result = await response.text();
    expect({ status: response.status, result: response.ok ? 'ok' : result }).toEqual({ status: 200, result: 'ok' });
    const loaded = await fetch(url, { headers });
    expect(loaded.status).toBe(200);
    return flattenV8ProviderGroups(provider, await loaded.json());
  };

  for (const provider of ['gemini', 'interactions', 'vertex', 'codex', 'claude', 'xai', 'meta', 'openai-compatibility']) {
    it(`${provider}: saves all template provider, key and model options through native v8 groups`, async () => {
      const section = (provider === 'openai-compatibility' ? provider : `${provider}-api-key`) as ProviderSection;
      const model: Record<string, unknown> = { name: 'isolated-model', alias: 'isolated-public' };
      {
        model.thinking = { levels: ['low', 'high'], min: 0, max: 32768, 'zero-allowed': false, 'dynamic-allowed': true };
        model['display-name'] = 'Isolated model';
        if (provider !== 'vertex') { model['max-context-length'] = 1048576; model['is-compat'] = false; }
      }
      model['force-mapping'] = true;
      if (['codex', 'xai', 'meta'].includes(provider)) model['support-configuration-update'] = false;
      if (provider === 'openai-compatibility') Object.assign(model, { image: false, 'input-modalities': ['text', 'image'], 'output-modalities': ['text'], 'use-max-completion-tokens': true });
      const special = provider === 'codex' ? { 'disable-codex-cloaking': false, 'alpha-search': false, websockets: false }
        : provider === 'claude' ? { 'rebuild-mid-system-message': false, 'fingerprint-profile': 'claude-code-cli', 'experimental-cch-signing': false,
          cloak: { mode: 'auto', 'strict-mode': false, 'sensitive-words': [], 'cache-user-id': false } }
        : provider === 'xai' ? { websockets: true } : {};
      const group = { name: 'isolated-template', 'base-url': 'https://gateway.example.test/v1', priority: 0, prefix: '', 'proxy-url': 'direct',
        headers: { 'X-Session': '$X-Client-Session' }, 'request-retry': 0, 'disable-cooling': false,
        'request-scoped-errors': [{ status: 400, match: ['context'], 'match-regexr': ['^context'], action: 'stop' }],
        ...(provider === 'openai-compatibility' ? { 'support-prompt-cache-key': false } : {}),
        models: [model], 'excluded-models': [],
        keys: [{ 'api-key': 'isolated-template-key', weight: 0, priority: null, models: null, headers: {}, 'request-scoped-errors': [], ...special }],
      };
      if (provider === 'vertex') {
        delete (group as Record<string, unknown>)['request-scoped-errors'];
        delete (group.keys[0] as Record<string, unknown>)['request-scoped-errors'];
      }
      if (provider === 'openai-compatibility') {
        delete (group as Record<string, unknown>)['proxy-url'];
        delete (group as Record<string, unknown>)['excluded-models'];
        group.keys = [{ 'api-key': 'isolated-template-key', weight: 0, 'proxy-url': 'direct' }] as never;
      }
      const draft = providerDraftFromRecord(section, group);
      const saved = buildProviderGroupRecord(section, draft, group);
      const url = `${origin}/config/api-keys/${provider}`;
      const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify([saved]) });
      const result = await response.text();
      expect({ status: response.status, result: response.ok ? 'ok' : result }).toEqual({ status: 200, result: 'ok' });
      const loaded = await (await fetch(url, { headers })).json();
      expect(loaded[0].keys[0]['api-key']).toBe('isolated-template-key');
      expect(loaded[0]['request-retry']).toBe(0);
      expect(loaded[0].models[0].alias).toBe('isolated-public');
    });
  }

  it('native group edits preserve multiple keys, shared models and explicit overrides in v8', async () => {
    const url = `${origin}/config/api-keys/codex`;
    const groups = [{ name: 'native-multi-key', 'base-url': 'https://gateway.example.test/v1',
      models: [{ name: 'gpt-test' }, { name: 'gpt-test', alias: 'gpt-test-fast' }],
      headers: { 'X-Group': 'shared' }, 'excluded-models': ['old-*'],
      keys: [{ 'api-key': 'native-first', weight: 2 }, { 'api-key': 'native-second', priority: 0,
        weight: 5, models: null, headers: {}, 'excluded-models': [], 'disable-cooling': false, 'request-retry': 0 }],
    }];
    const write = async (value: unknown) => {
      const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(value) });
      const body = await response.text();
      expect({ status: response.status, result: response.ok ? 'ok' : body }).toEqual({ status: 200, result: 'ok' });
      return (await (await fetch(url, { headers })).json()) as Record<string, unknown>[];
    };
    const loaded = await write(groups);
    const draft = providerDraftFromRecord('codex-api-key', loaded[0]);
    draft.name = 'renamed-native'; draft.priority = '6';
    const saved = await write([buildProviderGroupRecord('codex-api-key', draft, loaded[0])]);
    expect(saved.length).toBe(1);
    expect(saved[0].name).toBe('renamed-native');
    expect(saved[0].priority).toBe(6);
    expect(saved[0].keys).toEqual(loaded[0].keys);
    expect(saved[0].models).toEqual(loaded[0].models);
  });

  for (const category of ['codex-api-key', 'deepseek', 'claude-api-key', 'gemini-api-key', 'openai-compatibility'] as const) {
    const section: ProviderSection = category === 'deepseek' ? 'codex-api-key' : category;
    const provider = section.replace('-api-key', '');
    it(`${category}: accepts advanced fields and discovered reasoning metadata`, async () => {
      const draft = {
        ...createProviderDraft(category), name: category === 'deepseek' ? 'DeepSeek' : 'integration',
        apiKey: 'test-key', baseUrl: 'https://gateway.example.test/v1', priority: '-2',
        proxyUrl: 'direct', prefix: 'team', headersText: 'X-Team: test', excludedModelsText: 'old-*',
        disableCooling: true, websockets: true,
        cloakMode: 'always', cloakStrictMode: true, cloakSensitiveWordsText: 'internal', cloakCacheUserId: true,
        models: [{ name: 'upstream', alias: 'public', thinking: {
          min: 0, max: 8192, zero_allowed: true, dynamic_allowed: true, levels: ['low', 'high'],
        } }],
      };
      const [loaded] = await save(provider, [buildProviderRecord(section, draft)]);
      expect(loaded).toMatchObject({ priority: -2, prefix: 'team', headers: { 'X-Team': 'test' }, 'disable-cooling': true });
      expect(loaded.models).toMatchObject([{ name: 'upstream', alias: 'public', thinking: {
        min: 0, max: 8192, 'zero-allowed': true, 'dynamic-allowed': true, levels: ['low', 'high'],
      } }]);
      if (section === 'openai-compatibility') expect(loaded['api-key-entries']).toMatchObject([{ 'proxy-url': 'direct' }]);
      else expect(loaded).toMatchObject({ 'proxy-url': 'direct', 'excluded-models': ['old-*'] });
      if (section === 'codex-api-key') expect(loaded.websockets).toBe(true);
      if (section === 'claude-api-key') expect(loaded.cloak).toMatchObject({
        mode: 'always', 'strict-mode': true, 'sensitive-words': ['internal'], 'cache-user-id': true,
      });

      const editedDraft = { ...draft, priority: '0', prefix: '', headersText: '', proxyUrl: '',
        excludedModelsText: '', disableCooling: false, websockets: false,
        cloakMode: 'never', cloakStrictMode: false, cloakSensitiveWordsText: '', cloakCacheUserId: false,
        models: [{ name: 'upstream', alias: 'renamed' }],
      };
      const [edited] = await save(provider, [buildProviderRecord(section, editedDraft, loaded)]);
      expect(edited.priority ?? 0).toBe(0);
      for (const field of ['prefix', 'headers', 'proxy-url', 'excluded-models']) expect(edited).not.toHaveProperty(field);
      expect(edited['disable-cooling']).toBe(false);
      expect(edited.models).toMatchObject([{ name: 'upstream', alias: 'renamed' }]);
      if (section === 'codex-api-key') expect(edited.websockets ?? false).toBe(false);
      if (section === 'openai-compatibility') {
        expect((edited['api-key-entries'] as Record<string, unknown>[])[0]).not.toHaveProperty('proxy-url');
      }
      if (section === 'claude-api-key') {
        expect(edited.cloak).toMatchObject({ mode: 'never', 'cache-user-id': false });
        expect((edited.cloak as Record<string, unknown>)['strict-mode'] ?? false).toBe(false);
        expect(edited.cloak).not.toHaveProperty('sensitive-words');
      }
      const [inherited] = await save(provider, [buildProviderRecord(section, {
        ...editedDraft, disableCooling: null, cloakMode: '', cloakCacheUserId: null,
      }, edited)]);
      expect(inherited).not.toHaveProperty('disable-cooling');
      if (section === 'claude-api-key') expect(inherited).not.toHaveProperty('cloak');
    });
  }

  for (const provider of ['interactions', 'vertex', 'xai', 'meta']) {
    it(`${provider}: round-trips the additional provider families supported by the adapter`, async () => {
      const [loaded] = await save(provider, [{
        'api-key': 'test-key', 'base-url': 'https://gateway.example.test/v1', weight: 2,
        'disable-cooling': false, 'request-retry': 0,
        models: [{ name: 'model', thinking: { zero_allowed: false, dynamic_allowed: true } }],
      }]);
      expect(loaded).toMatchObject({ weight: 2, 'disable-cooling': false, 'request-retry': 0 });
      expect(loaded.models).toMatchObject([{ thinking: { 'zero-allowed': false, 'dynamic-allowed': true } }]);
    });
  }

  it('removes obsolete OpenAI test-model metadata when saving old records', async () => {
    const [loaded] = await save('openai-compatibility', [{
      name: 'compat', 'base-url': 'https://gateway.example.test/v1',
      'api-key-entries': [{ 'api-key': 'test-key' }], models: [{ name: 'model' }], 'test-model': 'model',
    }]);
    expect(loaded).not.toHaveProperty('test-model');
  });

  it('persists explicit false for cooldown and Claude user ID caching', async () => {
    const draft = { ...createProviderDraft('claude-api-key'), apiKey: 'test-key',
      baseUrl: 'https://gateway.example.test', disableCooling: false,
      cloakMode: 'always', cloakCacheUserId: false,
    };
    const [loaded] = await save('claude', [buildProviderRecord('claude-api-key', draft)]);
    expect(loaded['disable-cooling']).toBe(false);
    expect(loaded.cloak).toMatchObject({ 'cache-user-id': false });
  });

  it('clears reasoning levels without restoring the previous values or dropping model options', async () => {
    const current = { name: 'compat', 'base-url': 'https://gateway.example.test/v1',
      'api-key-entries': [{ 'api-key': 'test-key' }], models: [
        { name: 'model', alias: 'first', 'max-context-length': 65536, thinking: { levels: ['low', 'high'] } },
        { name: 'model', alias: 'second', thinking: { min: 128, max: 8192, levels: ['high'] } },
      ],
    };
    const draft = applyProviderPreset('openai-compatibility', {
      ...createProviderDraft('openai-compatibility'), name: 'compat', apiKey: 'test-key',
      baseUrl: current['base-url'], thinkingLevels: [], thinkingLevelsEdited: true,
      models: [{ name: 'model', alias: 'first', thinking: { levels: ['low', 'high'] } }],
    });
    const [loaded] = await save('openai-compatibility', [buildProviderRecord('openai-compatibility', draft, current)]);
    expect(loaded.models).toEqual([
      { name: 'model', alias: 'first', 'max-context-length': 65536 },
      { name: 'model', alias: 'second', thinking: { min: 128, max: 8192 } },
    ]);
  });
});
