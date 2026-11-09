import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB_REPO = 'router-for-me/CLIProxyAPI';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_ATOM_URL = `https://github.com/router-for-me/CLIProxyAPI/releases.atom`;

export function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/, '');
}

export function parseSemver(value) {
  const clean = normalizeVersion(value);
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    raw: clean,
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    throw new Error(`Cannot compare invalid semver strings: '${a}', '${b}'`);
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease && pb.prerelease) {
    return pa.prerelease.localeCompare(pb.prerelease, undefined, { numeric: true });
  }
  return 0;
}

export function extractVersionsFromAtom(xml) {
  const versions = new Set();
  const linkMatches = xml.matchAll(/\/releases\/tag\/(v?[0-9]+(?:\.[0-9]+)+[^\s"'>]*)/g);
  for (const match of linkMatches) {
    versions.add(match[1]);
  }
  const titleMatches = xml.matchAll(/<title>(v?[0-9]+(?:\.[0-9]+)+[^\s<]*)<\/title>/g);
  for (const match of titleMatches) {
    versions.add(match[1]);
  }
  return Array.from(versions);
}

export function getLatestFromVersions(versions) {
  const valid = versions.filter((v) => parseSemver(v) !== null);
  if (valid.length === 0) return null;
  valid.sort((a, b) => compareSemver(b, a));
  return normalizeVersion(valid[0]);
}

export async function fetchLatestFromGithubApi({ timeout = 15000, token = process.env.GITHUB_TOKEN } = {}) {
  const headers = {
    'User-Agent': 'EasyCLIProxyAPI-Kernel-Updater',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const signal = AbortSignal.timeout(timeout);
  const res = await fetch(GITHUB_API_URL, { headers, signal });
  if (!res.ok) {
    throw new Error(`GitHub API returned HTTP ${res.status}: ${res.statusText}`);
  }
  const data = await res.json();
  if (!data?.tag_name) {
    throw new Error('GitHub API response is missing tag_name');
  }
  const version = normalizeVersion(data.tag_name);
  if (!parseSemver(version)) {
    throw new Error(`GitHub API returned invalid semver tag: '${data.tag_name}'`);
  }
  return version;
}

export async function fetchLatestFromGithubAtom({ timeout = 15000 } = {}) {
  const headers = {
    'User-Agent': 'EasyCLIProxyAPI-Kernel-Updater',
    'Accept': 'application/atom+xml, text/xml, application/xml, */*',
  };
  const signal = AbortSignal.timeout(timeout);
  const res = await fetch(GITHUB_ATOM_URL, { headers, signal });
  if (!res.ok) {
    throw new Error(`GitHub Atom feed returned HTTP ${res.status}: ${res.statusText}`);
  }
  const xml = await res.text();
  const versions = extractVersionsFromAtom(xml);
  const latest = getLatestFromVersions(versions);
  if (!latest) {
    throw new Error('No valid semver tags found in GitHub Atom feed');
  }
  return latest;
}

export async function fetchLatestFromGitcode({ timeout = 15000, repo = process.env.GITCODE_CORE_REPOSITORY || GITHUB_REPO } = {}) {
  const headers = {
    'User-Agent': 'EasyCLIProxyAPI-Kernel-Updater',
    'Accept': 'application/json',
  };
  const signal = AbortSignal.timeout(timeout);
  const url = `https://api.gitcode.com/api/v5/repos/${repo}/releases/latest`;
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    throw new Error(`GitCode API returned HTTP ${res.status}: ${res.statusText}`);
  }
  const data = await res.json();
  if (!data?.tag_name) {
    throw new Error('GitCode API response is missing tag_name');
  }
  const version = normalizeVersion(data.tag_name);
  if (!parseSemver(version)) {
    throw new Error(`GitCode API returned invalid semver tag: '${data.tag_name}'`);
  }
  return version;
}

export async function fetchLatestUpstreamVersion(options = {}) {
  const errors = [];

  try {
    return await fetchLatestFromGithubApi(options);
  } catch (err) {
    errors.push(`GitHub API: ${err.message}`);
  }

  try {
    return await fetchLatestFromGithubAtom(options);
  } catch (err) {
    errors.push(`GitHub Atom feed: ${err.message}`);
  }

  try {
    return await fetchLatestFromGitcode(options);
  } catch (err) {
    errors.push(`GitCode API: ${err.message}`);
  }

  throw new Error(`Failed to fetch latest upstream kernel version:\n  ${errors.join('\n  ')}`);
}

export async function readCurrentCoreVersion(coreVersionFile) {
  try {
    const raw = await readFile(coreVersionFile, 'utf8');
    return normalizeVersion(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

// A pinned value skips the upstream lookup entirely. Releases use this when an
// upstream tag is missing a platform asset: following "latest" would move the
// build onto an incomplete release and fail one platform's download.
export const readCoreVersionPin = () => normalizeVersion(process.env.CORE_VERSION_PIN || '');
// `--freeze` pins to the version already in core-version.txt without a lookup.
export const readFreezeFlag = (argv = process.argv) => argv.includes('--freeze');

export async function updateBundledCore({
  rootDir = defaultRoot,
  coreVersionFile = join(rootDir, 'core-version.txt'),
  checkOnly = false,
  fetchLatest = fetchLatestUpstreamVersion,
  pinnedVersion = readCoreVersionPin(),
  freeze = false,
} = {}) {
  const currentVersion = await readCurrentCoreVersion(coreVersionFile);

  if (freeze && !pinnedVersion) {
    if (!currentVersion) {
      throw new Error('Cannot freeze the bundled kernel: core-version.txt is empty');
    }
    console.log(`Kernel version is frozen at ${currentVersion}`);
    return { updated: false, updateAvailable: false, currentVersion, latestVersion: currentVersion, pinned: true };
  }

  if (pinnedVersion) {
    if (checkOnly) {
      throw new Error(`Kernel version is pinned to ${pinnedVersion}; skipping the upstream check`);
    }
    if (pinnedVersion !== currentVersion) {
      await writeFile(coreVersionFile, `${pinnedVersion}\n`, 'utf8');
      console.log(`Pinned core-version.txt: ${currentVersion || 'none'} -> ${pinnedVersion}`);
      return { updated: true, updateAvailable: false, currentVersion, latestVersion: pinnedVersion, pinned: true };
    }
    console.log(`Kernel version is pinned to ${pinnedVersion}`);
    return { updated: false, updateAvailable: false, currentVersion, latestVersion: pinnedVersion, pinned: true };
  }

  let latestVersion;
  try {
    latestVersion = await fetchLatest();
  } catch (err) {
    // The released build bundles whichever version core-version.txt pins, and
    // the core archive is restored from a cache keyed by that file. A flaky
    // upstream lookup therefore must not block a release; only a checkout with
    // nothing pinned has no usable version to build against.
    if (checkOnly || !currentVersion) {
      throw err;
    }
    console.warn(`Keeping pinned core version ${currentVersion}: ${err.message}`);
    return {
      updated: false,
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
      fetchFailed: true,
    };
  }

  const isNewer = !currentVersion || compareSemver(latestVersion, currentVersion) > 0;

  if (checkOnly) {
    if (isNewer) {
      console.log(`Kernel version update available: ${currentVersion || 'none'} -> ${latestVersion}`);
      return { updated: false, updateAvailable: true, currentVersion, latestVersion };
    }
    console.log(`Kernel version is up to date: ${currentVersion}`);
    return { updated: false, updateAvailable: false, currentVersion, latestVersion };
  }

  if (isNewer) {
    await writeFile(coreVersionFile, `${latestVersion}\n`, 'utf8');
    console.log(`Updated core-version.txt: ${currentVersion || 'none'} -> ${latestVersion}`);
    return { updated: true, updateAvailable: true, currentVersion, latestVersion };
  }

  console.log(`Kernel version is up to date: ${currentVersion}`);
  return { updated: false, updateAvailable: false, currentVersion, latestVersion };
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  const checkOnly = process.argv.includes('--check');
  try {
    const result = await updateBundledCore({ checkOnly, freeze: readFreezeFlag() });
    if (checkOnly && result.updateAvailable) {
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}
