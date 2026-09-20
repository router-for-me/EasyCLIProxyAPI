import { describe, expect, it } from 'bun:test';
import {
  changedOAuthAuthFileNames,
  dedupeAuthFiles,
  isOAuthCredentialFile,
  normalizeAuthFilePriorityInput,
  oauthModelProvidersFromAuthFiles,
  parseAuthFilePriority,
  setOAuthCredentialFileDisabled,
  snapshotAuthFiles,
} from '../src/services/authFiles';

describe('认证文件列表规范化', () => {
  it('合并同名的磁盘和运行时记录并优先保留磁盘状态', () => {
    const files = dedupeAuthFiles([
      {
        name: 'codex-user.json',
        provider: 'codex',
        runtime_only: true,
        account_type: 'api_key',
        auth_index: 'runtime-index',
        email: 'user@example.com',
      },
      {
        name: 'codex-user.json',
        provider: 'codex',
        source: 'file',
        path: '/tmp/codex-user.json',
        disabled: false,
        modtime: 100,
      },
    ]);

    expect(files).toHaveLength(1);
    expect(files[0].source).toBe('file');
    expect(files[0].path).toBe('/tmp/codex-user.json');
    expect(files[0].email).toBe('user@example.com');
    expect(files[0].auth_index).toBe('runtime-index');
    expect(files[0].runtime_only).toBeUndefined();
    expect(files[0].account_type).toBeUndefined();
    expect(isOAuthCredentialFile(files[0])).toBe(true);
  });
});

const oauthFile = { name: 'codex-user.json', provider: 'codex', source: 'file', account_type: 'oauth' };
const nonOAuthFiles = [
  { ...oauthFile, runtime_only: true },
  { ...oauthFile, runtimeOnly: true },
  { ...oauthFile, account_type: 'api_key' },
  { ...oauthFile, account_type: 'API-KEY' },
  { ...oauthFile, auth_kind: 'apikey' },
  { ...oauthFile, authKind: 'api_key' },
  { ...oauthFile, source: 'memory' },
  { ...oauthFile, source: 'config:codex[key]' },
  { ...oauthFile, name: 'codex:apikey:runtime-id' },
  { ...oauthFile, name: '' },
];

describe('OAuth credential file boundaries', () => {
  it('accepts disk-backed OAuth files, disabled files, and legacy disk listings', () => {
    expect(isOAuthCredentialFile(oauthFile)).toBe(true);
    expect(isOAuthCredentialFile({ ...oauthFile, disabled: true })).toBe(true);
    expect(isOAuthCredentialFile({ name: 'legacy.JSON', type: 'codex' })).toBe(true);
    expect(isOAuthCredentialFile({})).toBe(false);
  });

  it('rejects API-key and runtime records even when they use an OAuth provider or JSON name', () => {
    for (const file of nonOAuthFiles) expect(isOAuthCredentialFile(file)).toBe(false);
  });

  it('offers only providers with OAuth credential files, preserving aliases and plugin providers', () => {
    expect(oauthModelProvidersFromAuthFiles([
      ...nonOAuthFiles.map((file) => ({ ...file, provider: 'api-only' })),
      oauthFile,
      { ...oauthFile, name: 'second.json' },
      { name: 'claude.json', type: 'anthropic' },
      { name: 'devin.json', type: 'cognition' },
      { name: 'antigravity.json', type: 'anti-gravity' },
      { name: 'openai.json', type: 'openai' },
      { name: 'plugin.json', provider: 'custom-oauth', source: 'file' },
      { name: 'unknown.json' },
    ])).toEqual(['antigravity', 'claude', 'codex', 'custom-oauth', 'devin']);
    expect(oauthModelProvidersFromAuthFiles(nonOAuthFiles)).toEqual([]);
  });

  it('enables and disables only the selected OAuth file without touching API configuration', async () => {
    const writes: unknown[] = [];
    const api = { patch: async (path: string, body: Record<string, unknown>) => { writes.push({ path, body }); } };
    await setOAuthCredentialFileDisabled(oauthFile, true, api);
    await setOAuthCredentialFileDisabled({ ...oauthFile, disabled: true }, false, api);
    expect(writes).toEqual([
      { path: '/auth-files/status', body: { name: 'codex-user.json', disabled: true } },
      { path: '/auth-files/status', body: { name: 'codex-user.json', disabled: false } },
    ]);
  });

  it('rejects runtime and API-key status changes before any management request', async () => {
    const writes: unknown[] = [];
    const api = { patch: async (path: string, body: Record<string, unknown>) => { writes.push({ path, body }); } };
    for (const file of nonOAuthFiles) {
      for (const disabled of [true, false]) {
        await expect(setOAuthCredentialFileDisabled(file, disabled, api)).rejects.toThrow('OAuth');
      }
    }
    expect(writes).toEqual([]);
  });
});

describe('authentication file priority', () => {
  it('accepts safe integers from API values', () => {
    expect(parseAuthFilePriority(10)).toBe(10);
    expect(parseAuthFilePriority(' -3 ')).toBe(-3);
    expect(parseAuthFilePriority(1.5)).toBeUndefined();
    expect(parseAuthFilePriority('high')).toBeUndefined();
  });

  it('uses zero to restore the default and rejects invalid input', () => {
    expect(normalizeAuthFilePriorityInput('')).toBe(0);
    expect(normalizeAuthFilePriorityInput('0')).toBe(0);
    expect(normalizeAuthFilePriorityInput('12')).toBe(12);
    expect(normalizeAuthFilePriorityInput('1.5')).toBeNull();
  });

  it('finds only credentials created or updated by the completed OAuth provider', () => {
    const before = snapshotAuthFiles([
      { name: 'codex-old.json', provider: 'codex', modtime: 1, priority: 8 },
      { name: 'codex-custom.json', provider: 'codex', modtime: 1, priority: 5 },
      { name: 'claude-old.json', provider: 'claude', modtime: 1 },
    ]);

    expect(changedOAuthAuthFileNames(before, [
      { name: 'codex-old.json', provider: 'codex', modtime: 2 },
      { name: 'codex-custom.json', provider: 'codex', modtime: 2, priority: 5 },
      { name: 'codex-new.json', type: 'codex', modtime: 2 },
      { name: 'claude-old.json', provider: 'claude', modtime: 2 },
    ], 'codex')).toEqual(['codex-old.json', 'codex-new.json']);
  });
});
