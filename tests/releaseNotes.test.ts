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
    expect(body).toBe(`# English\n\n${translations.en.trim()}\n\n---\n\n# 简体中文\n\n${translations['zh-CN'].trim()}\n\n---\n\n# 繁體中文\n\n${translations['zh-TW'].trim()}\n\n---\n\n# 日本語\n\n${translations.ja.trim()}\n`);
  }));

  test('never copies another language into a missing or blank translation', () => withNotesRoot(async (root, directory) => {
    await writeFile(join(directory, 'zh-CN.md'), '## 新增\n\n- 中文独有正文。\n');
    await writeFile(join(directory, 'en.md'), ' \n');
    const notes = await resolveReleaseNotes({ root, tag: 'v1.2.3' });
    expect(notes).toEqual({ 'zh-CN': '## 新增\n\n- 中文独有正文。\n' });
    const body = releaseNotesBody(notes);
    expect(body).toBe(`# 简体中文\n\n## 新增\n\n- 中文独有正文。\n`);
    expect(body).not.toContain('English');
    expect(body).not.toContain('Release notes for this version are not available');
  }));

  test('publishes every authored locale in English, Simplified, Traditional, Japanese order', () => {
    const all = {
      'zh-CN': 'A\n', 'zh-TW': 'B\n', en: 'C\n', ja: 'D\n',
    };
    expect(releaseNotesBody(all)).toBe('# English\n\nC\n\n---\n\n# 简体中文\n\nA\n\n---\n\n# 繁體中文\n\nB\n\n---\n\n# 日本語\n\nD\n');
    expect(releaseNotesBody({ en: 'only\n' })).toBe('# English\n\nonly\n');
  });

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

  test('CLI preserves all translations in JSON and publishes only English then Chinese in the Release body', () => withNotesRoot(async (root, directory) => {
    const translations = {
      'zh-CN': '## 新增\n\n- 更新说明。\n',
      'zh-TW': '## 新增\n\n- 更新說明。\n',
      en: '## Added\n\n- Release notes.\n',
      ja: '## 新機能\n\n- 更新内容。\n',
    };
    for (const [locale, body] of Object.entries(translations)) {
      await writeFile(join(directory, locale + '.md'), body);
    }
    const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url));
    const jsonPath = join(root, 'notes.json');
    const bodyPath = join(root, 'notes.md');
    const result = spawnSync('node', [script, '--tag', 'v1.2.3', '--output', jsonPath, '--body-output', bodyPath], {
      cwd: root, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const notes = JSON.parse(await readFile(jsonPath, 'utf8'));
    expect(notes).toEqual(translations);
    const body = await readFile(bodyPath, 'utf8');
    expect(body).toBe(`# English\n\n${translations.en.trim()}\n\n---\n\n# 简体中文\n\n${translations['zh-CN'].trim()}\n\n---\n\n# 繁體中文\n\n${translations['zh-TW'].trim()}\n\n---\n\n# 日本語\n\n${translations.ja.trim()}\n`);
  }));

  test('rejects tags that could escape the release notes directory', () => withNotesRoot(async (root) => {
    await expect(resolveReleaseNotes({ root, tag: '../../README' })).rejects.toThrow('Invalid release tag');
  }));

  test('supports non-semver preview tags like only-preview', () => withNotesRoot(async (root) => {
    expect(await resolveReleaseNotes({ root, tag: 'only-preview' })).toEqual({});
    const previewDir = join(root, 'docs', 'release-notes', 'only-preview');
    await mkdir(previewDir, { recursive: true });
    await writeFile(join(previewDir, 'en.md'), '## Preview\n\n- Preview notes.\n');
    expect(await resolveReleaseNotes({ root, tag: 'only-preview' })).toEqual({
      en: '## Preview\n\n- Preview notes.\n',
    });
  }));

  test('CLI supports non-semver preview tags like only-preview', () => withNotesRoot(async (root) => {
    const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url));
    const jsonPath = join(root, 'notes.json');
    const bodyPath = join(root, 'notes.md');
    const result = spawnSync('node', [script, '--tag', 'only-preview', '--output', jsonPath, '--body-output', bodyPath], {
      cwd: root, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(await readFile(jsonPath, 'utf8'))).toEqual({});
    expect(await readFile(bodyPath, 'utf8')).toContain('Release notes for this version are not available in English.');
  }));
});
