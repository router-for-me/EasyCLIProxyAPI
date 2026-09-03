export const DEFAULT_CLAUDE_DESKTOP_EGRESS_ALLOWED_HOSTS = [
  'localhost',
  '127.0.0.1',
  'api.anthropic.com',
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'gitlab.com',
  '*.gitlab.com',
] as const;

export type ClaudeDesktopEgressParseResult =
  | { valid: true; hosts: string[] }
  | { valid: false; reason: 'empty' | 'invalid'; invalidEntry?: string };

const validPort = (value: string) => {
  if (!/^\d+$/.test(value)) return false;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
};

const validIpv4 = (value: string) => {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((octet) => (
    /^\d{1,3}$/.test(octet) && Number(octet) <= 255
  ));
};

const validHostname = (value: string) => value.length <= 253
  && value.split('.').every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));

export function isValidClaudeDesktopEgressHost(value: string): boolean {
  if (value === '*') return true;
  if (!value || /\s/.test(value)) return false;

  const colon = value.indexOf(':');
  if (colon !== value.lastIndexOf(':')) return false;
  const hostWithWildcard = colon === -1 ? value : value.slice(0, colon);
  if (colon !== -1 && !validPort(value.slice(colon + 1))) return false;

  const wildcard = hostWithWildcard.startsWith('*.');
  const host = wildcard ? hostWithWildcard.slice(2) : hostWithWildcard;
  if (!host || host.includes('*')) return false;
  if (host === 'localhost') return !wildcard;
  if (validIpv4(host)) return !wildcard;
  if (/^[\d.]+$/.test(host) && host.includes('.')) return false;
  return validHostname(host);
}

export function parseClaudeDesktopEgressAllowedHosts(
  value: string,
): ClaudeDesktopEgressParseResult {
  const entries = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return { valid: false, reason: 'empty' };

  const hosts: string[] = [];
  for (const entry of entries) {
    const normalized = entry.toLowerCase();
    if (!isValidClaudeDesktopEgressHost(normalized)) {
      return { valid: false, reason: 'invalid', invalidEntry: entry };
    }
    if (!hosts.includes(normalized)) hosts.push(normalized);
  }
  return { valid: true, hosts };
}

export const formatClaudeDesktopEgressAllowedHosts = (
  hosts: readonly string[],
) => hosts.join('\n');

export function sameClaudeDesktopEgressAllowedHosts(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length === 0 || right.length === 0) return left.length === right.length;
  const normalize = (hosts: readonly string[]) => {
    const parsed = parseClaudeDesktopEgressAllowedHosts(hosts.join('\n'));
    return parsed.valid ? [...parsed.hosts].sort() : null;
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft !== null
    && normalizedRight !== null
    && normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((host, index) => host === normalizedRight[index]);
}

export const claudeDesktopEgressContainsWildcard = (
  hosts: readonly string[],
) => hosts.includes('*');
