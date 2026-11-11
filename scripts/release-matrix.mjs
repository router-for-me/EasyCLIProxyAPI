import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep the stable/PR runner contract intact; only resolved Preview builds narrow it.
export const fullReleaseMatrix = [
  { runner: 'ubuntu-22.04', os: 'linux', display_os: 'Linux', arch: 'amd64', suffix: 'tar.gz' },
  { runner: 'ubuntu-22.04-arm', os: 'linux', display_os: 'Linux', arch: 'aarch64', suffix: 'tar.gz' },
  { runner: 'macos-15', os: 'darwin', display_os: 'Darwin', arch: 'amd64', suffix: 'dmg', rust_target: 'x86_64-apple-darwin' },
  { runner: 'macos-15', os: 'darwin', display_os: 'Darwin', arch: 'aarch64', suffix: 'dmg', rust_target: 'aarch64-apple-darwin' },
  { runner: 'windows-2025', os: 'windows', display_os: 'Windows', arch: 'amd64', suffix: 'zip' },
  { runner: 'windows-11-arm', os: 'windows', display_os: 'Windows', arch: 'aarch64', suffix: 'zip' },
];

export function isPreviewVersion(version) {
  return /-preview(?:[.+]|$)/.test(version);
}

export function resolveBuildMatrix({ version, eventName, rollingPreview = false }) {
  // A PR tests all platforms even if its source is a Preview checkout.
  const isPreview = eventName !== 'pull_request' && (rollingPreview || isPreviewVersion(version));
  return {
    isPreview,
    matrix: { include: isPreview
      ? fullReleaseMatrix.filter(({ os, arch }) => os === 'windows' && arch === 'amd64')
      : fullReleaseMatrix },
  };
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '')) {
  const { isPreview, matrix } = resolveBuildMatrix({
    version: process.env.RESOLVED_VERSION,
    eventName: process.env.EVENT_NAME,
    rollingPreview: process.env.MIAOMIAO_PREVIEW === 'true',
  });
  console.log(`is_preview=${isPreview}`);
  console.log(`matrix=${JSON.stringify(matrix)}`);
}
