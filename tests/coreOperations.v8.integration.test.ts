import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { managementApi, responseList } from '../src/services/managementApi';
import { loadAuthFileSettings, saveAuthFileSettings } from '../src/services/authFileSettings';
import { setOAuthCredentialFileDisabled } from '../src/services/authFiles';
import { loadOAuthModelSettings, saveOAuthModelSettings } from '../src/services/oauthModelSettings';
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
      file = responseList(await managementApi.get('/auth-files'), 'files').find((item) => item.name === name);
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
    const metadata = await managementApi.get<Record<string, unknown>>('/auth-files/download', { name });
    expect(metadata.custom_metadata).toEqual({ preserve: true });
    expect(metadata.access_token).toBe('isolated-access-token');
    await setOAuthCredentialFileDisabled(file!, true);
    expect(responseList(await managementApi.get('/auth-files'), 'files').find((item) => item.name === name)?.disabled).toBe(true);
    await setOAuthCredentialFileDisabled(file!, false);
    expect(responseList(await managementApi.get('/auth-files'), 'files').find((item) => item.name === name)?.disabled).toBe(false);
    await managementApi.delete('/auth-files', { query: { name } });
    expect(responseList(await managementApi.get('/auth-files'), 'files').some((item) => item.name === name)).toBe(false);
  });

  it('edits provider model exclusions without changing siblings and clears the last rule', async () => {
    await call('PUT', '/config/oauth/excluded-models', undefined, null);
    const target = { scope: 'provider' as const, provider: 'codex', label: 'Codex' };
    const original = await loadOAuthModelSettings(target);
    expect(original.catalogError).toBe('');
    expect(original.models.length).toBeGreaterThan(0);
    expect(original.excludedRules).toEqual([]);
    await managementApi.patch('/oauth-excluded-models', { provider: 'claude', models: ['keep-*'] });
    await saveOAuthModelSettings(original, ['hide-*']);
    const edited = await loadOAuthModelSettings(target);
    expect(edited.excludedRules).toEqual(['hide-*']);
    await saveOAuthModelSettings(edited, []);
    expect((await loadOAuthModelSettings(target)).excludedRules).toEqual([]);
    expect(await managementApi.get('/oauth-excluded-models')).toEqual({ 'oauth-excluded-models': { claude: ['keep-*'] } });
    await managementApi.delete('/oauth-excluded-models', { query: { provider: 'claude' } });
  });

  it('discovers models and forwards API-call requests to an isolated local upstream', async () => {
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      if (request.headers.get('Authorization') !== 'Bearer local-key') return new Response('wrong key', { status: 401 });
      return Response.json({ data: [{ id: 'local-model' }] });
    } });
    try {
      const models = await fetchModels('openai', `http://127.0.0.1:${upstream.port}/v1`, 'local-key');
      expect(models.map((model) => model.name)).toEqual(['local-model']);
      const response = await managementApi.post<Record<string, unknown>>('/api-call', {
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
    await managementApi.delete('/oauth-session', { query: { state: 'isolated-unknown-state' } });
  });
});
