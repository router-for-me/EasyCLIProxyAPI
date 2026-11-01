import { describe, expect, it } from 'bun:test';
import { parseWslDirectory } from '../src/services/agentEnvironments';

describe('WSL configuration directory recognition', () => {
  it('recognizes both share names and preserves distro and user names', () => {
    for (const share of ['wsl$', 'wsl.localhost', 'WSL.LOCALHOST']) {
      expect(parseWslDirectory(`\\\\${share}\\Ubuntu-24.04\\home\\my user\\.config\\opencode`))
        .toEqual({ distro: 'Ubuntu-24.04', user: 'my user' });
    }
  });

  it('supports forward slashes, root, and nonstandard directories', () => {
    expect(parseWslDirectory('\\\\?\\UNC\\wsl$\\Debian\\home\\user\\.codex')).toEqual({ distro: 'Debian', user: 'user' });
    expect(parseWslDirectory('//wsl$/Debian/root/.codex')).toEqual({ distro: 'Debian', user: 'root' });
    expect(parseWslDirectory('\\\\wsl.localhost\\Debian\\srv\\settings')).toEqual({ distro: 'Debian', user: null });
  });

  it('does not confuse local paths or unrelated network shares with WSL', () => {
    for (const directory of ['', 'C:\\Users\\user\\.codex', '/home/user/.claude', '\\\\server\\Ubuntu\\home', '\\\\wsl.localhost.evil\\Ubuntu', '\\\\wsl$\\']) {
      expect(parseWslDirectory(directory)).toBeNull();
    }
  });
});
