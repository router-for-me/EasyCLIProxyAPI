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

test('a pinned version skips the upstream lookup and freezes the file', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'core-sync-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const coreVersionFile = join(rootDir, 'core-version.txt');
  await writeFile(coreVersionFile, '8.0.62\n', 'utf8');

  let lookups = 0;
  const result = await updateBundledCore({
    rootDir,
    coreVersionFile,
    pinnedVersion: '8.0.61',
    fetchLatest: async () => {
      lookups += 1;
      return '8.0.62';
    },
  });

  // A pinned release must not touch the network: the whole point is to keep the
  // build off an upstream tag that is missing an asset.
  assert.equal(lookups, 0);
  assert.equal(result.pinned, true);
  assert.equal(result.updated, true);
  assert.equal(await readFile(coreVersionFile, 'utf8'), '8.0.61\n');
});

test('freeze keeps the pinned file without any lookup', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'core-sync-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const coreVersionFile = join(rootDir, 'core-version.txt');
  await writeFile(coreVersionFile, '8.0.61\n', 'utf8');

  let lookups = 0;
  const result = await updateBundledCore({
    rootDir,
    coreVersionFile,
    freeze: true,
    fetchLatest: async () => {
      lookups += 1;
      return '8.0.62';
    },
  });

  assert.equal(lookups, 0);
  assert.equal(result.pinned, true);
  assert.equal(result.updated, false);
  assert.equal(await readFile(coreVersionFile, 'utf8'), '8.0.61\n');
});

test('freeze refuses an empty core-version.txt instead of building blind', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'core-sync-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const coreVersionFile = join(rootDir, 'core-version.txt');
  await writeFile(coreVersionFile, '\n', 'utf8');

  await assert.rejects(
    () => updateBundledCore({ rootDir, coreVersionFile, freeze: true, fetchLatest: async () => '8.0.62' }),
    /core-version\.txt is empty/,
  );
});

test('an empty pin keeps following the upstream latest version', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'core-sync-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const coreVersionFile = join(rootDir, 'core-version.txt');
  await writeFile(coreVersionFile, '8.0.60\n', 'utf8');

  const result = await updateBundledCore({
    rootDir,
    coreVersionFile,
    pinnedVersion: '',
    fetchLatest: async () => '8.0.61',
  });

  assert.equal(result.updated, true);
  assert.equal(result.pinned, undefined);
  assert.equal(await readFile(coreVersionFile, 'utf8'), '8.0.61\n');
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
