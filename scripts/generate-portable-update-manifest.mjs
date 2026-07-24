import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function generatePortableUpdateManifest({
  directory,
  output,
  repository,
  tag: rawTag,
  publishedAt = new Date().toISOString(),
}) {
  const resolvedDirectory = resolve(directory ?? 'artifacts');
  const resolvedOutput = resolve(output ?? join(resolvedDirectory, 'portable-update-windows.json'));
  const resolvedRepository = repository ?? 'router-for-me/EasyCLIProxyAPI';
  const normalizedRawTag = String(rawTag ?? '').trim();
  const tag = normalizedRawTag.startsWith('v') ? normalizedRawTag : `v${normalizedRawTag}`;
  const version = tag.slice(1);
  const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

  if (!semverPattern.test(version)) {
    throw new Error(`Invalid release tag: ${normalizedRawTag}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(resolvedRepository)) {
    throw new Error(`Invalid GitHub repository: ${resolvedRepository}`);
  }
  if (Number.isNaN(Date.parse(publishedAt))) {
    throw new Error(`Invalid publishedAt: ${publishedAt}`);
  }

  const assets = {};
  for (const arch of ['amd64', 'aarch64']) {
    const filename = `EasyCLIProxyAPI-update-${tag}-Windows-${arch}.zip`;
    const path = join(resolvedDirectory, filename);
    const [contents, metadata] = await Promise.all([readFile(path), stat(path)]);
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error(`Portable updater asset is empty or not a file: ${filename}`);
    }
    assets[`windows-${arch}`] = {
      url: `https://github.com/${resolvedRepository}/releases/download/${tag}/${filename}`,
      sha256: createHash('sha256').update(contents).digest('hex'),
      sizeBytes: metadata.size,
    };
  }

  const manifest = {
    schemaVersion: 1,
    version,
    publishedAt,
    releaseUrl: `https://github.com/${resolvedRepository}/releases/tag/${tag}`,
    assets,
  };

  await writeFile(resolvedOutput, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
  }
  const directory = resolve(args.get('--directory') ?? 'artifacts');
  const output = resolve(args.get('--output') ?? join(directory, 'portable-update-windows.json'));
  const manifest = await generatePortableUpdateManifest({
    directory,
    output,
    repository: args.get('--repository'),
    tag: args.get('--tag'),
  });
  console.log(`Generated ${basename(output)} for v${manifest.version}`);
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  await main();
}
