import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { updateBundledCore } from './update-bundled-core.mjs';

test('keeps pinned core-version.txt when fetchLatest throws', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'core-sync-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const coreVersionFile = join(rootDir, 'core-version.txt');
  await writeFile(coreVersionFile, '8.0.52\n', 'utf8');

  const result = await updateBundledCore({
    rootDir,
    coreVersionFile,
    fetchLatest: async () => {
      throw new Error('network down');
    },
  });

  assert.equal(result.fetchFailed, true);
  assert.equal(result.currentVersion, '8.0.52');
  assert.equal(result.updated, false);
  assert.equal(await readFile(coreVersionFile, 'utf8'), '8.0.52\n');
});

test('rejects when checkOnly is true and fetchLatest throws', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'core-sync-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const coreVersionFile = join(rootDir, 'core-version.txt');
  await writeFile(coreVersionFile, '8.0.52\n', 'utf8');

  await assert.rejects(
    () =>
      updateBundledCore({
        rootDir,
        coreVersionFile,
        checkOnly: true,
        fetchLatest: async () => {
          throw new Error('network down');
        },
      }),
    /network down/,
  );
});

test('rejects when core-version.txt is missing or empty and fetchLatest throws', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'core-sync-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const coreVersionFile = join(rootDir, 'core-version.txt');

  await assert.rejects(
    () =>
      updateBundledCore({
        rootDir,
        coreVersionFile,
        fetchLatest: async () => {
          throw new Error('network down');
        },
      }),
    /network down/,
  );

  await writeFile(coreVersionFile, '\n', 'utf8');

  await assert.rejects(
    () =>
      updateBundledCore({
        rootDir,
        coreVersionFile,
        fetchLatest: async () => {
          throw new Error('network down');
        },
      }),
    /network down/,
  );
});
