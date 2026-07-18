import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const root = resolve(import.meta.dirname, '..');
const output = resolve(args.get('--output') ?? join(root, 'bin-work'));
const binary = resolve(args.get('--binary') ?? join(root, 'src-tauri', 'target', 'release', process.platform === 'win32' ? 'cpa-gui.exe' : 'cpa-gui'));
const targetOS = args.get('--os') ?? ({ linux: 'linux', darwin: 'darwin', win32: 'windows' })[process.platform];
const targetArch = args.get('--arch') ?? ({ x64: 'amd64', arm64: 'aarch64' })[process.arch];
const shouldDownload = args.get('--download') === 'true';
const cleanCore = args.get('--clean-core') === 'true';

if (!targetOS || !targetArch) throw new Error(`Unsupported target: ${process.platform}/${process.arch}`);
if (!existsSync(binary)) throw new Error(`GUI binary not found: ${binary}`);

const rawVersion = (await readFile(join(root, 'core-version.txt'), 'utf8')).trim();
if (!/^v?\d+(?:\.\d+)+$/.test(rawVersion)) throw new Error(`Invalid core-version.txt: ${rawVersion}`);
const version = rawVersion.replace(/^v/i, '');
const extension = targetOS === 'windows' ? 'zip' : 'tar.gz';
const assetName = `CLIProxyAPI_${version}_${targetOS}_${targetArch}.${extension}`;
const sourceDir = join(root, 'cpa-core');
const sourceArchive = join(sourceDir, assetName);
const checksumsPath = join(sourceDir, 'checksums.txt');

await mkdir(sourceDir, { recursive: true });
if (!existsSync(sourceArchive)) {
  if (!shouldDownload) {
    console.warn(`Built-in core archive not found; portable output keeps the existing core: ${sourceArchive}`);
    await mkdir(output, { recursive: true });
    const outputBinary = join(output, targetOS === 'windows' ? 'cpa-gui.exe' : 'cpa-gui');
    await copyFile(binary, outputBinary);
    if (targetOS !== 'windows') await chmod(outputBinary, 0o755);
    await copyFile(join(root, 'core-version.txt'), join(output, 'core-version.txt'));
    process.exit(0);
  }
  const tag = `v${version}`;
  const releaseBase = `https://github.com/router-for-me/CLIProxyAPI/releases/download/${tag}`;
  const [archiveResponse, checksumsResponse] = await Promise.all([
    fetch(`${releaseBase}/${assetName}`),
    fetch(`${releaseBase}/checksums.txt`),
  ]);
  if (!archiveResponse.ok) throw new Error(`Download ${assetName} failed: HTTP ${archiveResponse.status}`);
  if (!checksumsResponse.ok) throw new Error(`Download checksums.txt failed: HTTP ${checksumsResponse.status}`);
  await writeFile(sourceArchive, Buffer.from(await archiveResponse.arrayBuffer()));
  await writeFile(checksumsPath, await checksumsResponse.text());
}

if (existsSync(checksumsPath)) {
  const checksums = await readFile(checksumsPath, 'utf8');
  const expected = checksums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((parts) => parts[1]?.replace(/^\*/, '') === assetName)?.[0]?.toLowerCase();
  if (!expected) throw new Error(`checksums.txt does not contain ${assetName}`);
  const actual = createHash('sha256').update(await readFile(sourceArchive)).digest('hex');
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${assetName}`);
}

await mkdir(output, { recursive: true });
const outputBinary = join(output, targetOS === 'windows' ? 'cpa-gui.exe' : 'cpa-gui');
await copyFile(binary, outputBinary);
if (targetOS !== 'windows') await chmod(outputBinary, 0o755);
await copyFile(join(root, 'core-version.txt'), join(output, 'core-version.txt'));

const coreOutput = join(output, 'cpa-core');
if (cleanCore) await rm(coreOutput, { recursive: true, force: true });
await mkdir(coreOutput, { recursive: true });
let extraction;
if (extension === 'zip') {
  if (process.platform === 'win32') {
    const quotePowerShell = (value) => value.replaceAll("'", "''");
    const command = `Expand-Archive -LiteralPath '${quotePowerShell(sourceArchive)}' -DestinationPath '${quotePowerShell(coreOutput)}' -Force`;
    extraction = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' });
  } else {
    extraction = spawnSync('unzip', ['-q', sourceArchive, '-d', coreOutput], { stdio: 'inherit' });
  }
} else {
  extraction = spawnSync('tar', ['-xf', sourceArchive, '-C', coreOutput], { stdio: 'inherit' });
}
if (extraction.error) throw new Error(`Failed to start archive extractor for ${assetName}: ${extraction.error.message}`);
if (extraction.status !== 0) throw new Error(`Failed to extract ${assetName} (exit code ${extraction.status})`);
await copyFile(sourceArchive, join(coreOutput, assetName));
if (existsSync(checksumsPath)) await copyFile(checksumsPath, join(coreOutput, 'checksums.txt'));
await writeFile(join(coreOutput, 'cpa-gui-meta.json'), `${JSON.stringify({
  version: `v${version}`,
  assetName,
  installedAtUnix: Math.floor(Date.now() / 1000),
}, null, 2)}\n`);

console.log(`Prepared portable directory: ${output}`);
console.log(`Bundled core: ${basename(sourceArchive)}`);
