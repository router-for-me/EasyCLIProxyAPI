import { describe, expect, it } from 'bun:test';
import {
  parseCargoPackageVersion,
  setCargoLockPackageVersion,
  setCargoPackageVersion,
  validateAppVersion,
} from '../scripts/version.mjs';
import { applyAppVersion, runCargoMetadata } from '../scripts/set-version.mjs';

describe('app version', () => {
  it('reads the version from the package section', () => {
    expect(parseCargoPackageVersion(`
[package]
name = "cpa-gui"
version = "1.2.3-beta.1+build.7"

[dependencies]
example = "9.9.9"
`)).toBe('1.2.3-beta.1+build.7');
  });

  it('rejects a missing package version', () => {
    expect(() => parseCargoPackageVersion('[package]\nname = "cpa-gui"\n'))
      .toThrow('Missing package version');
  });

  it('rejects an invalid semantic version', () => {
    expect(() => parseCargoPackageVersion('[package]\nversion = "v1.2.3"\n'))
      .toThrow('Invalid package version');
  });

  it('updates only the package version', () => {
    const manifest = `[package]
name = "cpa-gui"
version = "1.2.3"

[dependencies]
example = "9.9.9"
`;
    const updated = setCargoPackageVersion(manifest, '2.0.0-rc.1');
    expect(parseCargoPackageVersion(updated)).toBe('2.0.0-rc.1');
    expect(updated).toContain('example = "9.9.9"');
  });

  it('validates a version supplied by a release tag', () => {
    expect(validateAppVersion('0.2.15')).toBe('0.2.15');
    expect(() => validateAppVersion('v0.2.15')).toThrow('Invalid app version');
  });

  it('updates only the local app entry in Cargo.lock', () => {
    const lockfile = `[[package]]
name = "cpa-gui"
version = "1.2.3"

[[package]]
name = "dependency"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
    const updated = setCargoLockPackageVersion(lockfile, 'cpa-gui', '2.0.0');
    expect(updated).toContain('name = "cpa-gui"\nversion = "2.0.0"');
    expect(updated).toContain('name = "dependency"\nversion = "1.2.3"');
  });

  it('repairs a stale lockfile even when Cargo.toml already has the requested version', async () => {
    const files = new Map<string, string>([
      ['Cargo.toml', '[package]\nname = "cpa-gui"\nversion = "2.0.0"\n'],
      ['Cargo.lock', '[[package]]\nname = "cpa-gui"\nversion = "1.0.0"\n'],
    ]);
    const writes: string[] = [];

    const result = await applyAppVersion('2.0.0', {
      rootDir: 'test-root',
      readText: async (path: string) => files.get(
        path.endsWith('Cargo.toml') ? 'Cargo.toml' : 'Cargo.lock',
      )!,
      writeText: async (path: string, contents: string) => {
        const name = path.endsWith('Cargo.toml') ? 'Cargo.toml' : 'Cargo.lock';
        writes.push(name);
        files.set(name, contents);
      },
      validateProject: async () => {},
    });

    expect(result).toMatchObject({ version: '2.0.0', previousVersion: '2.0.0', changed: true });
    expect(writes).toEqual(['Cargo.lock']);
    expect(files.get('Cargo.lock')).toContain('version = "2.0.0"');
  });

  it('restores both files when cargo metadata validation fails', async () => {
    const originalManifest = '[package]\nname = "cpa-gui"\nversion = "1.0.0"\n';
    const originalLockfile = '[[package]]\nname = "cpa-gui"\nversion = "1.0.0"\n';
    const files = new Map<string, string>([
      ['Cargo.toml', originalManifest],
      ['Cargo.lock', originalLockfile],
    ]);

    await expect(applyAppVersion('2.0.0', {
      rootDir: 'test-root',
      readText: async (path: string) => files.get(
        path.endsWith('Cargo.toml') ? 'Cargo.toml' : 'Cargo.lock',
      )!,
      writeText: async (path: string, contents: string) => {
        files.set(path.endsWith('Cargo.toml') ? 'Cargo.toml' : 'Cargo.lock', contents);
      },
      validateProject: async () => { throw new Error('metadata validation failed'); },
    })).rejects.toThrow('metadata validation failed');

    expect(files.get('Cargo.toml')).toBe(originalManifest);
    expect(files.get('Cargo.lock')).toBe(originalLockfile);
  });

  it('restores the manifest when writing the lockfile fails', async () => {
    const originalManifest = '[package]\nname = "cpa-gui"\nversion = "1.0.0"\n';
    const originalLockfile = '[[package]]\nname = "cpa-gui"\nversion = "1.0.0"\n';
    const files = new Map<string, string>([
      ['Cargo.toml', originalManifest],
      ['Cargo.lock', originalLockfile],
    ]);
    let lockfileWrites = 0;

    await expect(applyAppVersion('2.0.0', {
      rootDir: 'test-root',
      readText: async (path: string) => files.get(
        path.endsWith('Cargo.toml') ? 'Cargo.toml' : 'Cargo.lock',
      )!,
      writeText: async (path: string, contents: string) => {
        const name = path.endsWith('Cargo.toml') ? 'Cargo.toml' : 'Cargo.lock';
        if (name === 'Cargo.lock' && lockfileWrites++ === 0) {
          throw new Error('lockfile write failed');
        }
        files.set(name, contents);
      },
      validateProject: async () => {},
    })).rejects.toThrow('lockfile write failed');

    expect(files.get('Cargo.toml')).toBe(originalManifest);
    expect(files.get('Cargo.lock')).toBe(originalLockfile);
  });

  it('includes cargo stderr when metadata validation fails', () => {
    expect(() => runCargoMetadata('Cargo.toml', () => ({
      status: 101,
      stderr: 'manifest parse error',
      stdout: '',
    }))).toThrow('cargo metadata failed with exit code 101: manifest parse error');
  });

  it('supports workspace-inherited package version and updates all local workspace members in Cargo.lock', async () => {
    const manifest = `[workspace]
resolver = "2"
members = ["crates/ecpa-core", "crates/ecpa-web"]

[workspace.package]
version = "1.0.0"

[package]
name = "cpa-gui"
version.workspace = true
`;
    expect(parseCargoPackageVersion(manifest)).toBe('1.0.0');
    const updatedManifest = setCargoPackageVersion(manifest, '2.1.0');
    expect(parseCargoPackageVersion(updatedManifest)).toBe('2.1.0');
    expect(updatedManifest).toContain('version.workspace = true');

    const lockfile = `[[package]]
name = "cpa-gui"
version = "1.0.0"

[[package]]
name = "ecpa-core"
version = "1.0.0"

[[package]]
name = "ecpa-web"
version = "1.0.0"
`;
    const files = new Map<string, string>([
      ['Cargo.toml', manifest],
      ['Cargo.lock', lockfile],
    ]);
    await applyAppVersion('2.1.0', {
      rootDir: 'test-root',
      readText: async (path: string) => files.get(path.endsWith('Cargo.toml') ? 'Cargo.toml' : 'Cargo.lock')!,
      writeText: async (path: string, contents: string) => {
        files.set(path.endsWith('Cargo.toml') ? 'Cargo.toml' : 'Cargo.lock', contents);
      },
      validateProject: async () => {},
    });
    expect(files.get('Cargo.lock')).toContain('name = "cpa-gui"\nversion = "2.1.0"');
    expect(files.get('Cargo.lock')).toContain('name = "ecpa-core"\nversion = "2.1.0"');
    expect(files.get('Cargo.lock')).toContain('name = "ecpa-web"\nversion = "2.1.0"');
  });
});
