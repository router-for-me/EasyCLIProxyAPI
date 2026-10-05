import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';
import { managementApi } from '../src/services/managementApi';
import { consumeClaudeResetCredit, consumeCodexResetCredit, loadQuota, type AuthFile } from '../src/services/quotaService';
import { resetAuthFileCooldown } from '../src/services/authFiles';

let runtime: ReturnType<typeof createBrowserMockRuntime>;
let get: ReturnType<typeof spyOn>;
let post: ReturnType<typeof spyOn>;
const request = (method: string, path: string, body?: unknown, query?: unknown) =>
  runtime.invoke('management_request', { request: { method, path, body, query } });
const files = async () => (await request('GET', '/credentials') as { files: AuthFile[] }).files;

beforeEach(() => {
  runtime = createBrowserMockRuntime('running');
  get = spyOn(managementApi, 'get').mockImplementation(async (path, query) => await request('GET', path, undefined, query) as never);
  post = spyOn(managementApi, 'post').mockImplementation(async (path, body) => await request('POST', path, body) as never);
});
afterEach(() => { get.mockRestore(); post.mockRestore(); });

test('all supported providers parse through the actual quota service', async () => {
  const accounts = await files();
  expect(accounts.filter(file => file.source === 'file').length).toBeGreaterThan(10);
  for (const provider of ['codex', 'claude', 'antigravity', 'kimi', 'xai', 'devin']) {
    const file = accounts.find(file => file.provider === provider)!;
    const quota = await loadQuota(file);
    expect(quota.status).toBe('success');
    expect(quota.rows.length).toBeGreaterThanOrEqual(2);
    expect(quota.resetCreditsError).toBeUndefined();
    expect(quota.rows.every(row => row.remainingPercent !== null), JSON.stringify({ provider, rows: quota.rows })).toBe(true);
  }
});

test('edge accounts expose exhausted, unknown, disabled and upstream-error states', async () => {
  const accounts = await files();
  const quota = (name: string) => loadQuota(accounts.find(file => file.name === name)!);
  expect((await quota('codex-exhausted.json')).rows[0].remainingPercent).toBe(0);
  expect((await quota('codex-unknown-quota.json')).rows[0].remainingPercent).toBeNull();
  expect((await quota('antigravity-empty-quota.json')).status).toBe('error');
  expect((await quota('xai-paid-api.json')).rows[0].remainingPercent).toBeNull();
  expect((await quota('codex-disabled.json')).status).toBe('error');
  expect(await quota('claude-expired.json')).toMatchObject({ status: 'error', error: 'Mock OAuth token expired' });
});

test('Codex and Claude resets consume credits and refresh only that account', async () => {
  const accounts = await files();
  for (const provider of ['codex', 'claude']) {
    const account = accounts.find(file => file.provider === provider)!;
    const reset = provider === 'codex' ? consumeCodexResetCredit : consumeClaudeResetCredit;
    expect((await loadQuota(account)).resetCredits).toBe(2);
    const result = await reset(account);
    expect(result.status).toBe('success');
    expect(result.resetCredits).toBe(1);
    expect(result.rows[0].remainingPercent).toBe(100);
    expect((await reset(account)).resetCredits).toBe(0);
  }
  expect((await loadQuota(accounts.find(file => file.name === 'codex-idle.json')!)).resetCredits).toBe(2);
});

test('cooldown reset acknowledges the correct credential and preserves disabled state', async () => {
  const account = (await files()).find(file => file.name === 'codex-exhausted.json')!;
  await request('PATCH', '/credentials/status', { name: account.name, disabled: true });
  expect(await resetAuthFileCooldown(String(account.auth_index))).toMatchObject({ status: 'ok', auth_index: account.auth_index, models: ['gpt-5.2-codex'] });
  expect((await files()).find(file => file.name === account.name)).toMatchObject({ disabled: true, cooldowns: [] });
});

test('imports JSON contents, replaces the same filename, and deletes without mutating other accounts', async () => {
  const originalCount = (await files()).length;
  const upload = (content: string) => runtime.invoke('upload_auth_file', { name: 'imported.json', data: Array.from(new TextEncoder().encode(content)) });
  await upload(JSON.stringify({ type: 'kimi', note: 'Imported example', priority: 9 }));
  const first = (await files()).find(file => file.name === 'imported.json')!;
  expect(first).toMatchObject({ provider: 'kimi', note: 'Imported example', priority: 9 });
  await upload(JSON.stringify({ type: 'claude', note: 'Replaced' }));
  expect((await files()).length).toBe(originalCount + 1);
  expect((await files()).find(file => file.name === 'imported.json')?.priority).toBeUndefined();
  expect(await request('GET', '/credentials/download', undefined, { name: 'imported.json' })).toMatchObject({ provider: 'claude', note: 'Replaced', auth_index: first.auth_index });
  await expect(upload('{broken')).rejects.toThrow();
  await expect(upload('[]')).rejects.toThrow('JSON object');
  await request('DELETE', '/credentials', undefined, { name: 'imported.json' });
  expect((await files()).length).toBe(originalCount);
  await expect(request('GET', '/credentials/download', undefined, { name: 'imported.json' })).rejects.toThrow('not found');
});
