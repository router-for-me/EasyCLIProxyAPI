import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAppVersion } from './version.mjs';

export const releaseNotesLanguages = [
  { locale: 'zh-CN', label: '简体中文', missing: '暂未提供该版本的简体中文更新说明。' },
  { locale: 'zh-TW', label: '繁體中文', missing: '暫未提供此版本的繁體中文更新說明。' },
  { locale: 'ja', label: '日本語', missing: 'このバージョンの日本語の更新内容はありません。' },
  { locale: 'en', label: 'English', missing: 'Release notes for this version are not available in English.' },
  { locale: 'ru', label: 'Русский', missing: 'Примечания к выпуску этой версии на русском языке недоступны.' },
];

// Only explicitly authored translations are published. Missing languages stay missing.
export async function resolveReleaseNotes({ root = process.cwd(), tag }) {
  const rawTag = String(tag ?? '').trim();
  if (!rawTag || rawTag.includes('..') || !/^[A-Za-z0-9_.-]+$/.test(rawTag)) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  let dirName = rawTag;
  try {
    const version = validateAppVersion(rawTag.replace(/^v/, ''), 'release tag');
    dirName = `v${version}`;
  } catch {
    // Non-semver tags (e.g. only-preview) use rawTag as the release-notes directory name
  }
  const directory = join(root, 'docs', 'release-notes', dirName);
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

const stableVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const maxSkippedReleaseNotes = 9;
const maxReleaseNotesHistoryBytes = 128 * 1024;

function compareVersionParts(left, right) {
  const difference = left.findIndex((part, index) => part !== right[index]);
  return difference < 0 ? 0 : left[difference] > right[difference] ? 1 : -1;
}

export async function resolveReleaseNotesHistory({ root = process.cwd(), tag }) {
  const target = String(tag ?? '').trim().replace(/^v/, '');
  if (!stableVersionPattern.test(target)) return {};
  const targetParts = target.split('.').map(BigInt);
  const entries = await readdir(join(root, 'docs', 'release-notes'), { withFileTypes: true })
    .catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  const olderReleases = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('v')) continue;
    const version = entry.name.slice(1);
    if (!stableVersionPattern.test(version)) continue;
    const parts = version.split('.').map(BigInt);
    if (compareVersionParts(parts, targetParts) < 0) olderReleases.push({ version, parts });
  }
  olderReleases.sort((left, right) => compareVersionParts(right.parts, left.parts));

  let history = {};
  for (const { version } of olderReleases) {
    if (Object.keys(history).length >= maxSkippedReleaseNotes) break;
    const notes = await resolveReleaseNotes({ root, tag: `v${version}` });
    if (!Object.keys(notes).length) continue;
    const nextHistory = { ...history, [version]: notes };
    const bytes = Buffer.byteLength(JSON.stringify({ releaseNotesHistory: nextHistory }, null, 2));
    if (bytes > maxReleaseNotesHistoryBytes) break;
    history = nextHistory;
  }
  return history;
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
  // The GitHub Release page shows English then Simplified Chinese only; every other authored
  // locale still reaches the app through the portable update manifest's releaseNotes map.
  const order = ['en', 'zh-CN'];
  const authored = order.filter((locale) => notes[locale]?.trim());
  const published = authored.length ? authored : ['en'];
  const languages = published.map((locale) => releaseNotesLanguages.find((language) => language.locale === locale));
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
