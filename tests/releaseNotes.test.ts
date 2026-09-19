import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseNotesBody, resolveReleaseNotes, validateReleaseNotes } from '../scripts/release-notes.mjs';

async function withNotesRoot(run: (root: string, directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'easycli-release-notes-'));
  const directory = join(root, 'docs', 'release-notes', 'v1.2.3');
  try {
    await mkdir(directory, { recursive: true });
    await run(root, directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('localized release notes publication', () => {
  test('keeps each authored translation under its exact locale', () => withNotesRoot(async (root, directory) => {
    const translations = {
      'zh-CN': '## 新增\n\n- 更新说明。\n',
      'zh-TW': '## 新增\n\n- 更新說明。\n',
      en: '## Added\n\n- Release notes.\n',
      ja: '## 新機能\n\n- 更新内容。\n',
    };
    for (const [locale, body] of Object.entries(translations)) {
      await writeFile(join(directory, locale + '.md'), body);
    }
    expect(await resolveReleaseNotes({ root, tag: '1.2.3' })).toEqual(translations);
    const body = releaseNotesBody(translations);
    for (const text of Object.values(translations)) expect(body).toContain(text.trim());
  }));

  test('never copies another language into a missing or blank translation', () => withNotesRoot(async (root, directory) => {
    await writeFile(join(directory, 'zh-CN.md'), '## 新增\n\n- 中文独有正文。\n');
    await writeFile(join(directory, 'en.md'), ' \n');
    const notes = await resolveReleaseNotes({ root, tag: 'v1.2.3' });
    expect(notes).toEqual({ 'zh-CN': '## 新增\n\n- 中文独有正文。\n' });
    const englishSection = releaseNotesBody(notes).split('# English\n\n')[1].split('\n\n---')[0];
    expect(englishSection).toBe('Release notes for this version are not available in English.');
    expect(englishSection).not.toContain('中文独有正文');
  }));

  test('missing versions and legacy flat files produce no translations', () => withNotesRoot(async (root) => {
    await writeFile(join(root, 'docs', 'release-notes', 'v1.2.3.md'), 'Legacy single-language text');
    expect(await resolveReleaseNotes({ root, tag: 'v1.2.3' })).toEqual({});
    expect(await resolveReleaseNotes({ root, tag: 'v9.9.9' })).toEqual({});
    expect(releaseNotesBody({})).not.toContain('Legacy single-language text');
  }));

  test('validates localized maps without requiring every translation', () => {
    expect(() => validateReleaseNotes({})).not.toThrow();
    expect(() => validateReleaseNotes({ en: 'English only' })).not.toThrow();
    for (const invalid of ['Legacy text', null, [], { en: 123 }, { ja: ' ' }, { fr: 'Other language' }]) {
      expect(() => validateReleaseNotes(invalid)).toThrow();
    }
  });

  test('CLI creates matching localized JSON and multilingual Release body', () => withNotesRoot(async (root, directory) => {
    await writeFile(join(directory, 'en.md'), '## Added\n\n- Release notes.\n');
    const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url));
    const jsonPath = join(root, 'notes.json');
    const bodyPath = join(root, 'notes.md');
    const result = spawnSync('node', [script, '--tag', 'v1.2.3', '--output', jsonPath, '--body-output', bodyPath], {
      cwd: root, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const notes = JSON.parse(await readFile(jsonPath, 'utf8'));
    expect(notes).toEqual({ en: '## Added\n\n- Release notes.\n' });
    expect(await readFile(bodyPath, 'utf8')).toBe(releaseNotesBody(notes));
  }));

  test('rejects tags that could escape the release notes directory', () => withNotesRoot(async (root) => {
    await expect(resolveReleaseNotes({ root, tag: '../../README' })).rejects.toThrow('Invalid release tag');
  }));
});
