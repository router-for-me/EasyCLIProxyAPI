type VersionParts = { numbers: number[]; prerelease: boolean };

function versionSegments(version: string): VersionParts | null {
  const trimmed = version.trim().replace(/^v/i, '');
  const [core, ...rest] = trimmed.split('-');
  if (!core) return null;
  const numbers = core.split('.').map(segment => (/^\d+$/.test(segment) ? Number(segment) : Number.NaN));
  if (numbers.length === 0 || numbers.some(number => Number.isNaN(number))) return null;
  const prerelease = rest.length > 0 && rest.join('-').trim() !== '';
  return { numbers, prerelease };
}

/**
 * Reports whether the registry version should be offered as an update. A higher
 * numeric release counts as an update, and a prerelease never matches the plain
 * release of the same numbers (1.0.0-preview.3 is not 1.0.0). Versions that
 * cannot be parsed report false so the card keeps its installed state.
 */
export function isStoreUpdateAvailable(installedVersion: string | undefined, latestVersion: string | undefined): boolean {
  if (!installedVersion || !latestVersion) return false;
  const installed = versionSegments(installedVersion);
  const latest = versionSegments(latestVersion);
  if (!installed || !latest) return false;
  const length = Math.max(installed.numbers.length, latest.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const installedNumber = installed.numbers[index] ?? 0;
    const latestNumber = latest.numbers[index] ?? 0;
    if (installedNumber !== latestNumber) return latestNumber > installedNumber;
  }
  return installed.prerelease !== latest.prerelease;
}