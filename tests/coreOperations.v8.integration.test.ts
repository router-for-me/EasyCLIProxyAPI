import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { managementApi, responseList } from '../src/services/managementApi';
import { loadAuthFileSettings, saveAuthFileSettings } from '../src/services/authFileSettings';
import { setOAuthCredentialFileDisabled } from '../src/services/authFiles';
import { loadOAuthModelSettings, saveOAuthModelSettings, saveOAuthProviderExclusions } from '../src/services/oauthModelSettings';
import { fetchModels } from '../src/services/modelService';

const executable = process.env.CPA_V8_TEST_CORE;
describe.skipIf(!executable)('real v8 management operations', () => {
  let child: ChildProcess;
  let work = '';
  let origin = '';
  let originalWindow: PropertyDescriptor | undefined;
  const headers = { Authorization: 'Bearer isolated-test-secret', 'Content-Type': 'application/json' };
  const name = 'contract-codex.json';
  const call = async (method: string, path: string, query?: Record<string, string>, body?: unknown) => {
    const url = new URL(origin + path);
    Object.entries(query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let result: any;
    try { result = JSON.parse(text); } catch { result = text; }
    if (!response.ok) throw new Error(`Management API error (${response.status}): ${result.error ?? text}${result.message ? `: ${result.message}` : ''}`);
    return result;
  };

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'easycpa-v8-operations-'));
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
    child = spawn(resolve(executable!), ['-config', config, '-local-model'], {
      cwd: work, windowsHide: true, stdio: 'ignore',
    });
    let startupError: Error | undefined;
    child.on('error', (error) => { startupError = error; });
    origin = `http://127.0.0.1:${port}/v8/management`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Kernel exited: ${child.exitCode}`);
      try { await call('GET', '/config'); ready = true; break; } catch {}
      await Bun.sleep(100);
    }
    if (!ready) throw new Error('Kernel startup timed out');
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
    mockIPC(async (command, args) => {
      if (command === 'upload_auth_file') {
        return call('POST', '/credentials', { name: args!.name as string }, JSON.parse(new TextDecoder().decode(new Uint8Array(args!.data as number[]))));
      }
      expect(command).toBe('management_request');
      const request = args!.request as { method: string; path: string; query?: Record<string, string>; body?: unknown };
      return call(request.method, request.path, request.query, request.body);
    });
  }, 15000);

  afterAll(async () => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (child?.pid && child.exitCode === null) {
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      child.kill();
      await exited;
    }
    if (work && resolve(work).startsWith(resolve(tmpdir()) + sep + 'easycpa-v8-operations-')) {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('uploads, edits every credential setting, clears overrides, toggles and deletes', async () => {
    await managementApi.uploadAuthFile(new File([JSON.stringify({
      type: 'codex', access_token: 'isolated-access-token', expired: '2099-01-01T00:00:00Z',
      email: 'test@example.invalid', custom_metadata: { preserve: true },
    })], name, { type: 'application/json' }));
    let file: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      file = responseList(await managementApi.get('/credentials'), 'files').find((item) => item.name === name);
      if (file) break;
      await Bun.sleep(100);
    }
    expect(file).toBeDefined();
    const original = await loadAuthFileSettings(name);
    const edited = {
      ...original, prefix: 'team', proxy_url: 'direct', priority: '-2', weight: '3',
      disable_cooling: 'false' as const, websockets: 'false' as const,
      excluded_models: 'old-*\nretired', headers: '{"X-Test":"one","X-Remove":"two"}', note: 'test note',
    };
    await saveAuthFileSettings(name, original, edited);
    const reloaded = await loadAuthFileSettings(name);
    expect(reloaded).toMatchObject({ ...edited, headers: reloaded.headers });
    expect(JSON.parse(reloaded.headers)).toEqual(JSON.parse(edited.headers));
    const models = await loadOAuthModelSettings({ scope: 'credential', provider: 'codex', label: 'test', name });
    expect(models.catalogError).toBe('');
    expect(models.excludedRules).toEqual(['old-*', 'retired']);
    await saveOAuthModelSettings(models, ['next-*']);
    const beforeClear = await loadAuthFileSettings(name);
    await saveAuthFileSettings(name, beforeClear, {
      ...beforeClear, prefix: '', proxy_url: '', priority: '', weight: '',
      disable_cooling: '', websockets: '', excluded_models: '', headers: '{"X-Test":"updated"}', note: '',
    });
    const cleared = await loadAuthFileSettings(name);
    expect(cleared).toMatchObject({ prefix: '', proxy_url: '', priority: '0', weight: '',
      disable_cooling: '', websockets: '', excluded_models: '', note: '' });
    expect(JSON.parse(cleared.headers)).toEqual({ 'X-Test': 'updated' });
    const metadata = await managementApi.get<Record<string, unknown>>('/credentials/download', { name });
    expect(metadata.custom_metadata).toEqual({ preserve: true });
    expect(metadata.access_token).toBe('isolated-access-token');
    await setOAuthCredentialFileDisabled(file!, true);
    expect(responseList(await managementApi.get('/credentials'), 'files').find((item) => item.name === name)?.disabled).toBe(true);
    await setOAuthCredentialFileDisabled(file!, false);
    expect(responseList(await managementApi.get('/credentials'), 'files').find((item) => item.name === name)?.disabled).toBe(false);
    await managementApi.delete('/credentials', { query: { name } });
    expect(responseList(await managementApi.get('/credentials'), 'files').some((item) => item.name === name)).toBe(false);
  });

  it('edits provider model exclusions without changing siblings and clears the last rule', async () => {
    await call('PUT', '/config/oauth/excluded-models', undefined, null);
    const target = { scope: 'provider' as const, provider: 'codex', label: 'Codex' };
    const original = await loadOAuthModelSettings(target);
    expect(original.catalogError).toBe('');
    expect(original.models.length).toBeGreaterThan(0);
    expect(original.excludedRules).toEqual([]);
    await saveOAuthProviderExclusions('claude', ['keep-*']);
    await saveOAuthModelSettings(original, ['hide-*']);
    const edited = await loadOAuthModelSettings(target);
    expect(edited.excludedRules).toEqual(['hide-*']);
    await saveOAuthModelSettings(edited, []);
    expect((await loadOAuthModelSettings(target)).excludedRules).toEqual([]);
    expect(await managementApi.get('/config/oauth/excluded-models')).toEqual({ claude: ['keep-*'] });
    await saveOAuthProviderExclusions('claude', undefined);
  });

  it('round-trips template credential aliases and Claude settings without replacing token metadata', async () => {
    const fileName = 'template-claude.json';
    await managementApi.uploadAuthFile(new File([JSON.stringify({ type: 'claude', access_token: 'isolated-template-token',
      expired: '2099-01-01T00:00:00Z', custom_metadata: { keep: true } })], fileName, { type: 'application/json' }));
    try {
      const original = await loadAuthFileSettings(fileName);
      const advanced = { cloak_mode: 'always', cloak_strict_mode: false, cloak_cache_user_id: true, cloak_sensitive_words: ['Word'],
        fingerprint_profile: 'claude-code-cli', timezone: 'Asia/Shanghai',
        model_aliases: [{ name: 'claude-template', alias: 'public-template', fork: false, 'display-name': 'Template model', 'force-mapping': true }] };
      await saveAuthFileSettings(fileName, original, { ...original, advanced });
      const loaded = await loadAuthFileSettings(fileName);
      expect(loaded.advanced).toEqual(advanced);
      const metadata = await managementApi.get<Record<string, unknown>>('/credentials/download', { name: fileName });
      expect(metadata.access_token).toBe('isolated-template-token');
      expect(metadata.custom_metadata).toEqual({ keep: true });
      await saveAuthFileSettings(fileName, loaded, { ...loaded, advanced: {} });
      const cleared = await loadAuthFileSettings(fileName);
      expect(Object.values(cleared.advanced).every(value => value === null)).toBe(true);
    } finally { await managementApi.delete('/credentials', { query: { name: fileName } }); }
  });

  it('discovers models and forwards API-call requests to an isolated local upstream', async () => {
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      if (request.headers.get('Authorization') !== 'Bearer local-key') return new Response('wrong key', { status: 401 });
      return Response.json({ data: [{ id: 'local-model' }] });
    } });
    try {
      const models = await fetchModels('openai', `http://127.0.0.1:${upstream.port}/v1`, 'local-key');
      expect(models.map((model) => model.name)).toEqual(['local-model']);
      const response = await managementApi.post<Record<string, unknown>>('/requests/api-call', {
        method: 'GET', url: `http://127.0.0.1:${upstream.port}/usage`, header: { Authorization: 'Bearer local-key' },
      });
      expect(response.status_code).toBe(200);
      expect(JSON.parse(response.body as string)).toEqual({ data: [{ id: 'local-model' }] });
    } finally { await upstream.stop(true); }
  });

  it('uses the v8 usage queue and OAuth validation/session endpoints', async () => {
    expect(await call('GET', '/observability/usage/queue', { count: '10' })).toEqual([]);
    const status = await call('GET', '/oauth/status', { state: 'isolated-unknown-state' });
    expect(typeof status.status).toBe('string');
    await expect(call('GET', '/oauth/auth-url', { provider: 'unsupported-test-provider' })).rejects.toThrow('(404): provider_not_found');
    await expect(call('POST', '/oauth/callback', undefined, { provider: 'codex', redirect_url: 'http://localhost/callback' })).rejects.toThrow('(400)');
    await managementApi.delete('/oauth/session', { query: { state: 'isolated-unknown-state' } });
  });

  it('accepts new template controls and retains explicit false, zero and empty collections', async () => {
    const values: Array<[string, unknown]> = [
      ['routing/strategy', 'weighted-round-robin'], ['routing/session-affinity-subagents', false],
      ['routing/cooldown/transient-error-cooldown-seconds', -1], ['routing/retry/max-retry-interval', -1],
      ['requests/streaming/keepalive-seconds', 0], ['plugins/store-sources', []],
      ['client/codex/enable-apply-patch', false], ['client/codex/optimize-multi-agent-v2', true],
      ['multimedia/disable-image-generation', 'passthrough'],
      ['oauth/settings', { codex: [{ name: 'gpt-template', 'max-context-length': 524288 }] }],
      ['oauth/model-alias', { meta: [{ name: 'muse-template', alias: 'public-template', fork: false, 'display-name': 'Template', 'force-mapping': true }] }],
      ['oauth/request-scoped-errors', { claude: [{ status: 400, match: ['context'], 'match-regexr': ['^limit'], action: 'stop' }] }],
      ['requests/payload/default-raw', [{ models: [{ name: 'gpt-*', protocol: 'codex', 'from-protocol': 'responses', headers: { 'X-Tier': 'test-*' },
        match: [{ 'metadata.client': 'codex' }], 'not-match': [{ 'metadata.mode': 'dev' }], exist: ['input'], 'not-exist': ['metadata.disable'] }],
        params: { response_format: '{"type":"json_object"}', temperature: 0.5, enabled: false, schema: { type: 'object' } } }]],
      ['plugins/configs', { 'template-test': { enabled: false, mode: 'safe', nested: { list: [1, false, 'value'] } } }],
    ];
    for (const [path, value] of values) {
      await call('PUT', `/config/${path}`, undefined, value);
      const actual = await call('GET', `/config/${path}`);
      // The core's typed alias JSON omits fork:false (its default); the
      // effective value is still false. Other explicit defaults stay intact.
      if (path === 'oauth/model-alias') actual.meta[0].fork ??= false;
      expect(actual).toEqual(value);
    }
  });

  it('keeps TURN secrets in YAML although the JSON config response redacts them', async () => {
    const relay = { enabled: false, 'max-sessions': 1, 'udp-port-min': 49152, 'udp-port-max': 49155,
      'ice-servers': [{ urls: ['turn:example.invalid:3478'], username: 'isolated', credential: 'isolated-turn-secret' }] };
    await call('PUT', '/config/oauth/providers/codex/live-media-relay', undefined, relay);
    const json = await call('GET', '/config/oauth/providers/codex/live-media-relay');
    expect(JSON.stringify(json)).not.toContain('isolated-turn-secret');
    expect(await readFile(join(work, 'config.yaml'), 'utf8')).toContain('isolated-turn-secret');
    await call('PUT', '/config/oauth/providers/codex/live-media-relay/max-sessions', undefined, 2);
    expect(await readFile(join(work, 'config.yaml'), 'utf8')).toContain('isolated-turn-secret');
  });
});
