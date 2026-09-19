import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAppVersion } from './version.mjs';

export const releaseNotesLanguages = [
  { locale: 'zh-CN', label: '简体中文', missing: '暂未提供该版本的简体中文更新说明。' },
  { locale: 'zh-TW', label: '繁體中文', missing: '暫未提供此版本的繁體中文更新說明。' },
  { locale: 'en', label: 'English', missing: 'Release notes for this version are not available in English.' },
  { locale: 'ja', label: '日本語', missing: 'このバージョンの日本語の更新内容はありません。' },
];

// Only explicitly authored translations are published. Missing languages stay missing.
export async function resolveReleaseNotes({ root = process.cwd(), tag }) {
  const version = validateAppVersion(String(tag ?? '').trim().replace(/^v/, ''), 'release tag');
  const directory = join(root, 'docs', 'release-notes', `v${version}`);
  const notes = {};
  for (const { locale } of releaseNotesLanguages) {
    try {
      const text = (await readFile(join(directory, `${locale}.md`), 'utf8')).trim();
      if (text) notes[locale] = `${text}\n`;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return notes;
}

export function validateReleaseNotes(notes) {
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) {
    throw new Error('Release notes must be an object keyed by locale');
  }
  for (const [locale, text] of Object.entries(notes)) {
    if (!releaseNotesLanguages.some((language) => language.locale === locale)
      || typeof text !== 'string' || !text.trim()) {
      throw new Error(`Invalid release notes for locale: ${locale}`);
    }
  }
}

export function releaseNotesBody(notes) {
  validateReleaseNotes(notes);
  const languages = ['en', 'zh-CN'].map((locale) => releaseNotesLanguages.find((language) => language.locale === locale));
  return `${languages.map(({ locale, label, missing }) => (
    `# ${label}\n\n${notes[locale]?.trim() || missing}`
  )).join('\n\n---\n\n')}\n`;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
  }
  if (!args.get('--output') || !args.get('--body-output')) {
    throw new Error('--output and --body-output are required');
  }
  const notes = await resolveReleaseNotes({ tag: args.get('--tag') });
  await writeFile(resolve(args.get('--output')), `${JSON.stringify(notes, null, 2)}\n`, 'utf8');
  await writeFile(resolve(args.get('--body-output')), releaseNotesBody(notes), 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
