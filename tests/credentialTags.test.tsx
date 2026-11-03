import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { AuthFileBatchDialog } from '../src/components/AuthFileBatchDialog';
import { dedupeAuthFiles } from '../src/services/authFiles';
import { batchAddCredentialTag, batchRemoveCredentialTag } from '../src/services/authFileOperations';
import { loadAuthFileSettings, saveAuthFileSettings } from '../src/services/authFileSettings';
import {
  CREDENTIAL_TAGS_STORAGE_KEY, getCredentialTags, mergeCredentialTags,
  resolveCredentialTags, setCredentialTags,
} from '../src/services/credentialTags';

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
  });
});

afterEach(() => {
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('credential tag persistence', () => {
  it('normalizes and persists independent filename mappings, including special property names', () => {
    setCredentialTags('one.json', [' team ', 'team', '', 3, null, '日本語']);
    setCredentialTags('__proto__', ['special']);
    expect(getCredentialTags('one.json')).toEqual(['team', '日本語']);
    expect(getCredentialTags('__proto__')).toEqual(['special']);
    expect(JSON.parse(values.get(CREDENTIAL_TAGS_STORAGE_KEY)!)).toEqual({
      'one.json': ['team', '日本語'], ['__proto__']: ['special'],
    });
    const tags = getCredentialTags('one.json');
    tags.push('not persisted');
    expect(getCredentialTags('one.json')).toEqual(['team', '日本語']);
  });

  it('tolerates missing, corrupt and malformed storage', () => {
    for (const raw of ['null', '[]', '1', '{', '{"one.json":"bad"}']) {
      values.set(CREDENTIAL_TAGS_STORAGE_KEY, raw);
      expect(getCredentialTags('one.json')).toEqual([]);
    }
    values.set(CREDENTIAL_TAGS_STORAGE_KEY, '{"one.json":[" team ",null,"team"]}');
    expect(getCredentialTags('one.json')).toEqual(['team']);
  });

  it('does not hide storage write failures', () => {
    localStorage.setItem = () => { throw new Error('Storage full'); };
    expect(() => setCredentialTags('one.json', ['team'])).toThrow('Storage full');
  });

  it('imports incoming tags once and keeps explicit removals authoritative', () => {
    expect(resolveCredentialTags('one.json', [' team ', 'team'])).toEqual(['team']);
    expect(resolveCredentialTags('one.json', undefined)).toEqual(['team']);
    setCredentialTags('one.json', []);
    expect(resolveCredentialTags('one.json', ['team'])).toEqual([]);
    expect(getCredentialTags('one.json')).toEqual([]);
  });

  it('hydrates deduplicated real-core lists without mutating the response', () => {
    setCredentialTags('one.json', ['weekly']);
    const response = [{ name: 'one.json', source: 'file' }, { name: 'one.json', auth_index: '1' }];
    const files = mergeCredentialTags(dedupeAuthFiles(response));
    expect(files).toHaveLength(1);
    expect(files[0].tags).toEqual(['weekly']);
    expect(response[0]).not.toHaveProperty('tags');
    expect(mergeCredentialTags([{ name: 'one.json' }])[0].tags).toEqual(['weekly']);
  });

  it('loads raw JSON tags into local storage and falls back when later downloads omit tags', async () => {
    const api = { get: async () => ({ tags: ['imported'] }), patch: async () => {} };
    expect((await loadAuthFileSettings('one.json', api)).tags).toBe('imported');
    expect(getCredentialTags('one.json')).toEqual(['imported']);
    expect((await loadAuthFileSettings('one.json', { ...api, get: async () => ({}) })).tags).toBe('imported');
  });

  it('saves and clears settings locally and through the fields endpoint', async () => {
    const writes: unknown[] = [];
    const api = { get: async () => ({}), patch: async (path: string, body: unknown) => { writes.push({ path, body }); } };
    const original = await loadAuthFileSettings('one.json', api);
    await saveAuthFileSettings('one.json', original, { ...original, tags: ' team, team ' }, api);
    expect(getCredentialTags('one.json')).toEqual(['team']);
    const reloaded = await loadAuthFileSettings('one.json', api);
    expect(reloaded.tags).toBe('team');
    await saveAuthFileSettings('one.json', reloaded, { ...reloaded, tags: '' }, api);
    expect(getCredentialTags('one.json')).toEqual([]);
    expect(writes).toEqual([
      { path: '/credentials/fields', body: { name: 'one.json', tags: ['team'] } },
      { path: '/credentials/fields', body: { name: 'one.json', tags: [] } },
    ]);
  });

  it('keeps local settings on backend failure and still reports the failure', async () => {
    const api = { get: async () => ({}), patch: async () => { throw new Error('Offline'); } };
    const original = await loadAuthFileSettings('one.json', api);
    await expect(saveAuthFileSettings('one.json', original, { ...original, tags: 'weekly' }, api)).rejects.toThrow('Offline');
    expect(getCredentialTags('one.json')).toEqual(['weekly']);
  });

  it('persists batch additions and removals across lists with no backend tags', async () => {
    setCredentialTags('one.json', ['team']);
    setCredentialTags('two.json', ['team']);
    const files = [{ name: 'one.json' }, { name: 'two.json' }];
    const writes: unknown[] = [];
    const api = { patch: async (_path: string, body: unknown) => { writes.push(body); } };
    expect((await batchAddCredentialTag(files, 'weekly', api)).every(result => result.success)).toBe(true);
    expect(mergeCredentialTags(files).map(file => file.tags)).toEqual([['team', 'weekly'], ['team', 'weekly']]);
    expect((await batchRemoveCredentialTag(files, 'team', api)).every(result => result.success)).toBe(true);
    expect(mergeCredentialTags([{ name: 'one.json' }, { name: 'two.json' }]).map(file => file.tags)).toEqual([['weekly'], ['weekly']]);
    expect(writes).toHaveLength(4);
  });

  it('renders persisted batch tag groups and counts even if every API item omits tags', () => {
    setCredentialTags('one.json', ['weekly']);
    setCredentialTags('two.json', ['weekly']);
    const html = renderToStaticMarkup(<I18nProvider><AuthFileBatchDialog
      files={['one.json', 'two.json'].map(name => ({ name, provider: 'codex', source: 'file' }))}
      onClose={() => {}} onChanged={async () => {}}
    /></I18nProvider>);
    expect(html).toContain('weekly (2)');
    expect(html.match(/class="auth-batch-tag-badge"/g)).toHaveLength(2);
    expect(html).not.toContain('All tags (');
  });
});
