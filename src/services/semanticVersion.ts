type SemanticVersion = {
  core: [string, string, string];
  prerelease: string[] | null;
};

const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemanticVersion(version: string | null | undefined): SemanticVersion | null {
  const match = semanticVersionPattern.exec((version ?? '').trim().replace(/^v/i, ''));
  if (!match) return null;

  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

function compareNumericIdentifier(left: string, right: string) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

/** Returns null when either tag is not SemVer, otherwise compares release precedence. */
export function compareSemanticVersions(leftVersion: string | null | undefined, rightVersion: string | null | undefined): number | null {
  const left = parseSemanticVersion(leftVersion);
  const right = parseSemanticVersion(rightVersion);
  if (!left || !right) return null;

  for (let index = 0; index < left.core.length; index += 1) {
    const difference = compareNumericIdentifier(left.core[index], right.core[index]);
    if (difference !== 0) return difference;
  }

  if (left.prerelease === null) return right.prerelease === null ? 0 : 1;
  if (right.prerelease === null) return -1;

  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;

    const leftIsNumeric = /^\d+$/.test(leftIdentifier);
    const rightIsNumeric = /^\d+$/.test(rightIdentifier);
    if (leftIsNumeric && rightIsNumeric) {
      return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    }
    if (leftIsNumeric) return -1;
    if (rightIsNumeric) return 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }

  return 0;
}
