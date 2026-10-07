import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

const archiveName = 'CLIProxyAPI_8.0.10_windows_amd64.zip';
const archiveContents = 'verified bundled core archive';

async function withPortableFixture(run: (root: string, coreOutput: string) => Promise<void>) {
  // Run the real CLI in a disposable project so packaging cannot touch bin-work.
  const root = await mkdtemp(join(tmpdir(), 'easycli-portable-preparation-'));
  try {
    for (const directory of ['scripts', 'src-tauri', 'cpa-core', 'bin-work/cpa-core']) {
      await mkdir(join(root, directory), { recursive: true });
    }
    for (const script of ['portable.mjs', 'version.mjs']) {
      await copyFile(fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), join(root, 'scripts', script));
    }
    await writeFile(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "cpa-gui"\nversion = "0.3.0"\n');
    await writeFile(join(root, 'core-version.txt'), '8.0.10\n');
    await writeFile(join(root, 'cpa-gui.exe'), 'new GUI executable');
    await writeFile(join(root, 'cpa-core', archiveName), archiveContents);
    const digest = createHash('sha256').update(archiveContents).digest('hex');
    await writeFile(join(root, 'cpa-core', 'checksums.txt'), `${digest}  ${archiveName}\n`);
    await run(root, join(root, 'bin-work', 'cpa-core'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function prepare(root: string, preserve = false) {
  const result = spawnSync('node', [
    join(root, 'scripts', 'portable.mjs'),
    '--binary', join(root, 'cpa-gui.exe'),
    '--output', join(root, 'bin-work'),
    '--os', 'windows',
    '--arch', 'amd64',
    '--download', 'false',
    '--preserve-runtime-config', String(preserve),
  ], { encoding: 'utf8', cwd: root });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout;
}

test('local portable rebuilds preserve installed plugins and runtime data while replacing bundled archives', async () => {
  await withPortableFixture(async (root, coreOutput) => {
    const preserved = new Map([
      ['config.yaml', 'plugins:\n  configs:\n    kiro: {enabled: true}\n'],
      ['plugins/windows/amd64/kiro-v1.2.3.dll', 'installed kiro binary'],
      ['plugins/model-fallback-router-v0.2.0.dll', 'installed fallback binary'],
      ['custom-plugins/local-router.dll', 'custom plugin binary'],
      ['oauth/account.json', '{"fixture":"credential"}'],
      ['logs/request.log', 'runtime log'],
      ['user-data.json', '{"keep":true}'],
      ['user-backup.zip', 'custom archive'],
      ['cli-proxy-api.exe', 'existing installed core'],
      ['cpa-gui-meta.json', '{"version":"v8.0.11"}'],
      ['cpa-gui-bundled-core-handled.txt', 'v8.0.9'],
      ['CLIProxyAPI_7.0.0_windows_amd64.zip/keep.txt', 'same-named directory is user data'],
    ]);
    for (const [relative, contents] of preserved) {
      const target = join(coreOutput, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    for (const oldArchive of [
      'CLIProxyAPI_8.0.9_windows_amd64.zip',
      'CLIProxyAPI_8.0.10_windows_aarch64.zip',
      'CLIProxyAPI_8.0.9_linux_amd64.tar.gz',
      'CLIProxyAPI_8.0.9_darwin_aarch64.tar.gz',
    ]) {
      await writeFile(join(coreOutput, oldArchive), 'old bundled archive');
    }

    // Repeat the same copy to exercise the ordinary rebuild/update workflow.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(prepare(root, true)).toContain('preserved installed plugins and runtime data');
      for (const [relative, contents] of preserved) {
        expect(await readFile(join(coreOutput, relative), 'utf8')).toBe(contents);
      }
      const archives = (await readdir(coreOutput, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.startsWith('CLIProxyAPI_'))
        .map(entry => entry.name);
      expect(archives).toEqual([archiveName]);
      expect(await readFile(join(coreOutput, archiveName), 'utf8')).toBe(archiveContents);
    }
  });
});

test('release portable preparation still creates an archive-only core directory', async () => {
  await withPortableFixture(async (root, coreOutput) => {
    await mkdir(join(coreOutput, 'plugins'), { recursive: true });
    await writeFile(join(coreOutput, 'plugins', 'sample.dll'), 'stale release staging file');
    await writeFile(join(coreOutput, 'config.yaml'), 'stale release configuration');
    await writeFile(join(coreOutput, 'CLIProxyAPI_8.0.9_windows_amd64.zip'), 'old archive');

    expect(prepare(root)).toContain('(archive only)');
    expect(await readdir(coreOutput)).toEqual([archiveName]);
    expect(await readFile(join(coreOutput, archiveName), 'utf8')).toBe(archiveContents);
    expect(await readFile(join(root, 'bin-work', 'EasyCLIProxyAPI.exe'), 'utf8')).toBe('new GUI executable');
  });
});
