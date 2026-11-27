import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateAppVersion(value, source = 'app version') {
  const version = String(value).trim();
  if (!semverPattern.test(version)) {
    throw new Error(`Invalid ${source}: ${version}`);
  }
  return version;
}

function matchSection(contents, header) {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return contents.match(new RegExp(`(?:^|\\r?\\n)\\[${escaped}\\][ \\t]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\[|$)`));
}

export function parseCargoPackageVersion(contents, source = 'Cargo.toml') {
  const packageSection = matchSection(contents, 'package');
  if (!packageSection) {
    throw new Error(`Missing [package] section in ${source}`);
  }

  const versionMatch = packageSection[1].match(/^[ \t]*version[ \t]*=[ \t]*"([^"]+)"[ \t]*(?:#.*)?$/m);
  if (versionMatch) {
    return validateAppVersion(versionMatch[1], `package version in ${source}`);
  }

  const workspaceInherited = /^[ \t]*version\.workspace[ \t]*=[ \t]*true[ \t]*(?:#.*)?$/m.test(packageSection[1]);
  if (workspaceInherited) {
    const workspacePackage = matchSection(contents, 'workspace.package');
    const wsVersionMatch = workspacePackage?.[1].match(/^[ \t]*version[ \t]*=[ \t]*"([^"]+)"[ \t]*(?:#.*)?$/m);
    if (wsVersionMatch) {
      return validateAppVersion(wsVersionMatch[1], `workspace package version in ${source}`);
    }
  }

  throw new Error(`Missing package version in ${source}`);
}

export function setCargoPackageVersion(contents, version, source = 'Cargo.toml') {
  const nextVersion = validateAppVersion(version);
  const packageSection = matchSection(contents, 'package');
  if (!packageSection) {
    throw new Error(`Missing [package] section in ${source}`);
  }

  const versionPattern = /^[ \t]*version[ \t]*=[ \t]*"[^"]+"[ \t]*(?:#.*)?$/m;
  let updated = contents;
  let replacedAny = false;

  if (versionPattern.test(packageSection[0])) {
    const updatedSection = packageSection[0].replace(versionPattern, `version = "${nextVersion}"`);
    updated = updated.replace(packageSection[0], updatedSection);
    replacedAny = true;
  }

  const workspacePackage = matchSection(updated, 'workspace.package');
  if (workspacePackage && versionPattern.test(workspacePackage[0])) {
    const updatedWsSection = workspacePackage[0].replace(versionPattern, `version = "${nextVersion}"`);
    updated = updated.replace(workspacePackage[0], updatedWsSection);
    replacedAny = true;
  }

  if (!replacedAny) {
    throw new Error(`Missing package version in ${source}`);
  }

  return updated;
}

export function setCargoLockPackageVersion(contents, packageName, version, source = 'Cargo.lock', { optional = false } = {}) {
  const nextVersion = validateAppVersion(version);
  const packageBlocks = contents.match(/\[\[package\]\]\r?\n[\s\S]*?(?=\r?\n\[\[package\]\]|$)/g) ?? [];
  const matchingBlocks = packageBlocks.filter((block) => (
    new RegExp(`^name = "${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm').test(block)
    && !/^source = /m.test(block)
  ));

  if (matchingBlocks.length === 0 && optional) {
    return contents;
  }

  if (matchingBlocks.length !== 1) {
    throw new Error(`Expected one local ${packageName} package in ${source}, found ${matchingBlocks.length}`);
  }

  const versionPattern = /^version = "[^"]+"$/m;
  if (!versionPattern.test(matchingBlocks[0])) {
    throw new Error(`Missing ${packageName} version in ${source}`);
  }

  const updatedBlock = matchingBlocks[0].replace(versionPattern, `version = "${nextVersion}"`);
  return contents.replace(matchingBlocks[0], updatedBlock);
}

export async function readAppVersion() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = join(root, 'src-tauri', 'Cargo.toml');
  return parseCargoPackageVersion(await readFile(manifest, 'utf8'), manifest);
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  console.log(process.argv[2]
    ? validateAppVersion(process.argv[2], 'app version argument')
    : await readAppVersion());
}
