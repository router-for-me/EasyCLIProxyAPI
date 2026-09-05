import { describe, expect, it } from 'bun:test';
import {
  authFilesForBatchAction,
  changedOAuthAuthFileNames,
  dedupeAuthFiles,
  normalizeAuthFilePriorityInput,
  parseAuthFilePriority,
  snapshotAuthFiles,
} from '../src/services/authFiles';

describe('认证文件列表规范化', () => {
  it('合并同名的磁盘和运行时记录并优先保留磁盘状态', () => {
    const files = dedupeAuthFiles([
      {
        name: 'codex-user.json',
        provider: 'codex',
        runtime_only: true,
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

describe('authentication file batch management', () => {
  const files = [
    { name: 'enabled.json', disabled: false },
    { name: 'disabled.json', disabled: true },
    { name: 'runtime.json', disabled: false, runtime_only: true },
    { name: 'unselected.json', disabled: false },
  ];
  const selected = new Set(['enabled.json', 'disabled.json', 'runtime.json']);

  it('only enables selected credentials that are currently disabled', () => {
    expect(authFilesForBatchAction(files, selected, 'enable').map((file) => file.name))
      .toEqual(['disabled.json']);
  });

  it('only disables selected credentials that are currently enabled', () => {
    expect(authFilesForBatchAction(files, selected, 'disable').map((file) => file.name))
      .toEqual(['enabled.json', 'runtime.json']);
  });

  it('excludes runtime credentials from batch deletion', () => {
    expect(authFilesForBatchAction(files, selected, 'delete').map((file) => file.name))
      .toEqual(['enabled.json', 'disabled.json']);
  });
});
