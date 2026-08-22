import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAppVersion } from './version.mjs';

export function portableUpdateManifestName(platform) {
  const normalizedPlatform = String(platform).trim().toLowerCase();
  if (!['windows', 'linux', 'darwin'].includes(normalizedPlatform)) {
    throw new Error(`Unsupported update platform: ${platform}`);
  }
  // New macOS builds use a separate channel because the signed-bundle updater
  // requires the newer update flow.
  return normalizedPlatform === 'darwin'
    ? 'portable-update-darwin-v2.json'
    : `portable-update-${normalizedPlatform}.json`;
}

export function portableUpdateManifestNames(platform) {
  const primaryName = portableUpdateManifestName(platform);
  return primaryName === 'portable-update-darwin-v2.json'
    ? [primaryName, 'portable-update-darwin.json']
    : [primaryName];
}

export async function generatePortableUpdateManifest({
  directory,
  output,
  platform = 'windows',
  repository,
  gitcodeRepository,
  tag: rawTag,
  publishedAt = new Date().toISOString(),
}) {
  const resolvedDirectory = resolve(directory ?? 'artifacts');
  const platformSpecs = {
    windows: { display: 'Windows', suffix: 'zip', legacy: true },
    linux: { display: 'Linux', suffix: 'tar.gz', legacy: false },
    darwin: { display: 'Darwin', suffix: 'dmg', legacy: false },
  };
  const normalizedPlatform = String(platform).trim().toLowerCase();
  const platformSpec = platformSpecs[normalizedPlatform];
  if (!platformSpec) throw new Error(`Unsupported update platform: ${platform}`);
  const resolvedOutput = resolve(output ?? join(
    resolvedDirectory,
    portableUpdateManifestName(normalizedPlatform),
  ));
  const resolvedRepository = repository ?? 'router-for-me/EasyCLIProxyAPI';
  const resolvedGitcodeRepository = String(gitcodeRepository ?? '').trim();
  const normalizedRawTag = String(rawTag ?? '').trim();
  const tag = normalizedRawTag.startsWith('v') ? normalizedRawTag : `v${normalizedRawTag}`;
  const version = tag.slice(1);

  validateAppVersion(version, 'release tag');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(resolvedRepository)) {
    throw new Error(`Invalid GitHub repository: ${resolvedRepository}`);
  }
  if (resolvedGitcodeRepository
    && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(resolvedGitcodeRepository)) {
    throw new Error(`Invalid GitCode repository: ${resolvedGitcodeRepository}`);
  }
  if (Number.isNaN(Date.parse(publishedAt))) {
    throw new Error(`Invalid publishedAt: ${publishedAt}`);
  }

  const assets = {};
  const fullAssets = {};
  for (const arch of ['amd64', 'aarch64']) {
    const fullFilename = `EasyCLIProxyAPI-${tag}-${platformSpec.display}-${arch}.${platformSpec.suffix}`;
    const candidates = platformSpec.legacy
      ? [
        [assets, `EasyCLIProxyAPI-update-${tag}-Windows-${arch}.zip`],
        [fullAssets, fullFilename],
      ]
      : [[assets, fullFilename]];
    for (const [collection, filename] of candidates) {
      const path = join(resolvedDirectory, filename);
      const [contents, metadata] = await Promise.all([readFile(path), stat(path)]);
      if (!metadata.isFile() || metadata.size === 0) {
        throw new Error(`Portable release asset is empty or not a file: ${filename}`);
      }
      const asset = {
        url: `https://github.com/${resolvedRepository}/releases/download/${tag}/${filename}`,
        sha256: createHash('sha256').update(contents).digest('hex'),
        sizeBytes: metadata.size,
      };
      if (resolvedGitcodeRepository) {
        asset.fallbackUrls = [gitcodeReleaseAttachmentUrl(
          resolvedGitcodeRepository,
          tag,
          filename,
        )];
      }
      collection[`${normalizedPlatform}-${arch}`] = asset;
    }
  }

  const manifest = {
    schemaVersion: 1,
    version,
    publishedAt,
    releaseUrl: `https://github.com/${resolvedRepository}/releases/tag/${tag}`,
    assets,
    ...(platformSpec.legacy ? { fullAssets } : {}),
  };

  await writeFile(resolvedOutput, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function gitcodeReleaseAttachmentUrl(repository, tag, filename) {
  const [owner, repo] = repository.split('/');
  return `https://api.gitcode.com/api/v5/repos/${owner}/${repo}`
    + `/releases/${tag}/attach_files/${filename}/download`;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
  }
  const directory = resolve(args.get('--directory') ?? 'artifacts');
  const platform = args.get('--platform') ?? 'windows';
  const requestedOutput = args.get('--output');
  const outputs = requestedOutput
    ? [resolve(requestedOutput)]
    : portableUpdateManifestNames(platform).map((name) => join(directory, name));
  let manifest;
  for (const output of outputs) {
    manifest = await generatePortableUpdateManifest({
      directory,
      output,
      platform,
      repository: args.get('--repository'),
      gitcodeRepository: args.get('--gitcode-repository'),
      tag: args.get('--tag'),
    });
  }
  console.log(`Generated ${outputs.map(basename).join(', ')} for v${manifest.version}`);
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  await main();
}
