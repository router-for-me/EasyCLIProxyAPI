import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseCargoPackageVersion,
  setCargoLockPackageVersion,
  setCargoPackageVersion,
  validateAppVersion,
} from './version.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const errorMessage = (error) => error instanceof Error ? error.message : String(error);

export function runCargoMetadata(manifest, spawnImpl = spawnSync) {
  const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const metadata = spawnImpl(cargo, [
    'metadata',
    '--manifest-path', manifest,
    '--no-deps',
    '--format-version', '1',
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (metadata.error) throw metadata.error;
  if (metadata.status !== 0) {
    const detail = String(metadata.stderr || metadata.stdout || '').trim();
    throw new Error(
      `cargo metadata failed with exit code ${metadata.status}${detail ? `: ${detail}` : ''}`,
    );
  }
}

export async function applyAppVersion(requestedVersion, {
  rootDir = defaultRoot,
  readText = readFile,
  writeText = writeFile,
  validateProject = runCargoMetadata,
} = {}) {
  const version = validateAppVersion(requestedVersion, 'requested app version');
  const manifest = join(rootDir, 'src-tauri', 'Cargo.toml');
  const lockfile = join(rootDir, 'src-tauri', 'Cargo.lock');
  const [contents, lockContents] = await Promise.all([
    readText(manifest, 'utf8'),
    readText(lockfile, 'utf8'),
  ]);
  const previousVersion = parseCargoPackageVersion(contents, manifest);

  const nextContents = setCargoPackageVersion(contents, version, manifest);
  let nextLockContents = setCargoLockPackageVersion(
    lockContents,
    'cpa-gui',
    version,
    lockfile,
  );
  for (const member of ['ecpa-core', 'ecpa-web', 'ecpa-macros']) {
    nextLockContents = setCargoLockPackageVersion(
      nextLockContents,
      member,
      version,
      lockfile,
      { optional: true },
    );
  }
  const manifestChanged = nextContents !== contents;
  const lockfileChanged = nextLockContents !== lockContents;
  let manifestWriteAttempted = false;
  let lockfileWriteAttempted = false;

  try {
    if (manifestChanged) {
      manifestWriteAttempted = true;
      await writeText(manifest, nextContents);
    }
    if (lockfileChanged) {
      lockfileWriteAttempted = true;
      await writeText(lockfile, nextLockContents);
    }
    await validateProject(manifest);
  } catch (error) {
    const rollbackTasks = [];
    if (manifestWriteAttempted) rollbackTasks.push(writeText(manifest, contents));
    if (lockfileWriteAttempted) rollbackTasks.push(writeText(lockfile, lockContents));
    const rollbackResults = await Promise.allSettled(rollbackTasks);
    const rollbackFailures = rollbackResults
      .filter((result) => result.status === 'rejected')
      .map((result) => errorMessage(result.reason));
    if (rollbackFailures.length > 0) {
      throw new Error(
        `${errorMessage(error)}; rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }

  return {
    version,
    previousVersion,
    changed: manifestChanged || lockfileChanged,
  };
}

async function main() {
  const requestedVersion = process.argv[2];
  if (!requestedVersion || process.argv.length > 3) {
    throw new Error('Usage: node scripts/set-version.mjs <semver>');
  }
  const result = await applyAppVersion(requestedVersion);
  console.log(`Applied app version ${result.version}${result.changed ? '' : ' (unchanged)'}`);
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  await main();
}
