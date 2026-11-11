import { readFileSync } from 'node:fs';
import { formatPreviewStamp } from './preview-tag.mjs';
import { validateAppVersion } from './version.mjs';

const anchors = JSON.parse(readFileSync(new URL('../app-version-anchors.json', import.meta.url), 'utf8'));
const [series] = process.argv.slice(2);
if (series === 'stable') {
  const version = validateAppVersion(anchors.stable, 'stable release anchor');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Stable release anchor must be a final release');
  console.log(version);
} else if (series === 'preview') {
  const stamp = anchors.preview;
  const match = typeof stamp === 'string' && /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(stamp);
  if (!match) throw new Error('Preview release anchor must be a UTC YYYYMMDD-HHMM coordinate');
  const [, y, m, d, h, min] = match;
  if (formatPreviewStamp(`${y}-${m}-${d}T${h}:${min}:00Z`) !== stamp) {
    throw new Error('Invalid preview release anchor');
  }
  console.log(stamp);
} else {
  throw new Error('Expected stable or preview');
}
