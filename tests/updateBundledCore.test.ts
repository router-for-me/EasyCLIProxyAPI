import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  compareSemver,
  extractVersionsFromAtom,
  getLatestFromVersions,
  normalizeVersion,
  parseSemver,
  updateBundledCore,
} from '../scripts/update-bundled-core.mjs';

describe('update bundled core', () => {
  it('normalizes version tags correctly', () => {
    expect(normalizeVersion('v8.0.52')).toBe('8.0.52');
    expect(normalizeVersion('8.0.52\n')).toBe('8.0.52');
    expect(normalizeVersion('  v8.0.52  ')).toBe('8.0.52');
  });

  it('parses semantic versions', () => {
    expect(parseSemver('8.0.52')).toEqual({
      major: 8,
      minor: 0,
      patch: 52,
      prerelease: null,
      raw: '8.0.52',
    });
    expect(parseSemver('v8.0.52-beta.1')).toEqual({
      major: 8,
      minor: 0,
      patch: 52,
      prerelease: 'beta.1',
      raw: '8.0.52-beta.1',
    });
    expect(parseSemver('invalid')).toBeNull();
  });

  it('compares semantic versions accurately', () => {
    expect(compareSemver('8.0.52', '8.0.48')).toBeGreaterThan(0);
    expect(compareSemver('8.0.48', '8.0.52')).toBeLessThan(0);
    expect(compareSemver('v8.0.52', '8.0.52')).toBe(0);
    expect(compareSemver('8.1.0', '8.0.99')).toBeGreaterThan(0);
    expect(compareSemver('9.0.0', '8.99.99')).toBeGreaterThan(0);
    expect(compareSemver('8.0.52', '8.0.52-beta.1')).toBeGreaterThan(0);
  });

  it('extracts and sorts releases from Atom feed xml', () => {
    const xml = `
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>v8.0.50</title>
          <link rel="alternate" type="text/html" href="https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.50"/>
        </entry>
        <entry>
          <title>v8.0.52</title>
          <link rel="alternate" type="text/html" href="https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.52"/>
        </entry>
        <entry>
          <title>v8.0.48</title>
          <link rel="alternate" type="text/html" href="https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.48"/>
        </entry>
      </feed>
    `;
    const versions = extractVersionsFromAtom(xml);
    expect(versions).toContain('v8.0.52');
    expect(versions).toContain('v8.0.50');
    expect(versions).toContain('v8.0.48');

    const latest = getLatestFromVersions(versions);
    expect(latest).toBe('8.0.52');
  });

  it('updates core-version.txt when upstream is newer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cpa-core-update-test-'));
    const coreFile = join(dir, 'core-version.txt');
    try {
      await writeFile(coreFile, '8.0.48\n', 'utf8');

      const result = await updateBundledCore({
        coreVersionFile: coreFile,
        checkOnly: false,
        fetchLatest: async () => '8.0.52',
      });

      expect(result.updated).toBe(true);
      expect(result.updateAvailable).toBe(true);
      expect(result.currentVersion).toBe('8.0.48');
      expect(result.latestVersion).toBe('8.0.52');

      const written = await readFile(coreFile, 'utf8');
      expect(written.trim()).toBe('8.0.52');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports update without modifying file when checkOnly is true', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cpa-core-check-test-'));
    const coreFile = join(dir, 'core-version.txt');
    try {
      await writeFile(coreFile, '8.0.48\n', 'utf8');

      const result = await updateBundledCore({
        coreVersionFile: coreFile,
        checkOnly: true,
        fetchLatest: async () => '8.0.52',
      });

      expect(result.updated).toBe(false);
      expect(result.updateAvailable).toBe(true);

      const content = await readFile(coreFile, 'utf8');
      expect(content.trim()).toBe('8.0.48');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not update when already on the latest or newer version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cpa-core-uptodate-test-'));
    const coreFile = join(dir, 'core-version.txt');
    try {
      await writeFile(coreFile, '8.0.52\n', 'utf8');

      const result = await updateBundledCore({
        coreVersionFile: coreFile,
        checkOnly: false,
        fetchLatest: async () => '8.0.52',
      });

      expect(result.updated).toBe(false);
      expect(result.updateAvailable).toBe(false);

      const content = await readFile(coreFile, 'utf8');
      expect(content.trim()).toBe('8.0.52');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
