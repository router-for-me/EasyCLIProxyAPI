import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function formatPreviewStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}`;
}

export function formatPreviewTag(date = new Date()) {
  return `preview-${formatPreviewStamp(date)}`;
}

export const previewStamp = formatPreviewStamp;
export const previewTag = formatPreviewTag;

export function runSelfTest() {
  const fixed = '2026-11-04T17:50:00Z';
  assert.equal(formatPreviewStamp(fixed), '20261104-1750');
  assert.equal(formatPreviewTag(fixed), 'preview-20261104-1750');

  const singleDigits = '2026-01-02T03:04:05Z';
  assert.equal(formatPreviewStamp(singleDigits), '20260102-0304');
  assert.equal(formatPreviewTag(singleDigits), 'preview-20260102-0304');

  assert.equal(formatPreviewTag(new Date(fixed)), 'preview-20261104-1750');

  const currentStamp = formatPreviewStamp();
  const currentTag = formatPreviewTag();
  assert.match(currentStamp, /^[0-9]{8}-[0-9]{4}$/);
  assert.match(currentTag, /^preview-[0-9]{8}-[0-9]{4}$/);
  assert.equal(currentTag, `preview-${currentStamp}`);

  assert.throws(() => formatPreviewStamp('invalid-date'), /Invalid date/);

  console.log('preview-tag selftest passed');
}

function main() {
  const args = process.argv.slice(2);
  let at = null;
  let stampOnly = false;
  let selftest = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--selftest') {
      selftest = true;
    } else if (arg === '--stamp') {
      stampOnly = true;
    } else if (arg === '--at') {
      i++;
      if (i >= args.length) {
        throw new Error('--at requires an ISO date argument');
      }
      at = args[i];
    } else if (arg.startsWith('--at=')) {
      at = arg.slice('--at='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (selftest) {
    runSelfTest();
    return;
  }

  const date = at ? new Date(at) : new Date();
  if (stampOnly) {
    console.log(formatPreviewStamp(date));
  } else {
    console.log(formatPreviewTag(date));
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  main();
}
