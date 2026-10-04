import { describe, expect, it } from 'bun:test';
import { authFileSettingsFromPayload, buildAuthFileSettingsPatch, loadAuthFileSettings, saveAuthFileSettings } from '../src/services/authFileSettings';

describe('credential settings', () => {
  it('reads all fields and legacy aliases without retaining credential tokens', () => {
    const draft = authFileSettingsFromPayload(JSON.stringify({ prefix: 'team', 'proxy-url': 'socks5://localhost:1080', priority: -4, weight: 6,
      'disable-cooling': false, websocket: true, 'excluded-models': [' GPT-* ', 'gpt-*'], headers: { 'X-Team': 'test' }, note: 'note', access_token: 'secret' }));
    expect(draft).toEqual({ prefix: 'team', proxy_url: 'socks5://localhost:1080', priority: '-4', weight: '6', disable_cooling: 'false',
      websockets: 'true', excluded_models: 'gpt-*', headers: '{\n  "X-Team": "test"\n}', note: 'note', advanced: {} });
    expect(JSON.stringify(draft)).not.toContain('secret');
  });

  it('patches only changed settings while tokens or other fields refresh concurrently', async () => {
    const file = { access_token: 'before', priority: 5, note: 'old', auth_index: 'private-index' };
    const writes: unknown[] = [];
    const api = {
      async get(path: string, query: Record<string, string>) {
        expect([path, query]).toEqual(['/credentials/download', { name: 'test.json' }]);
        return { ...file };
      },
      async patch(path: string, body: Record<string, unknown>) {
        writes.push({ path, body });
        const { name, ...fields } = body;
        Object.assign(file, fields);
      },
    };
    const original = await loadAuthFileSettings('test.json', api);
    file.access_token = 'refreshed';
    file.priority = 9;
    expect(await saveAuthFileSettings('test.json', original, { ...original, note: 'new' }, api)).toBe(true);
    expect(writes).toEqual([{ path: '/credentials/fields', body: { name: 'test.json', note: 'new' } }]);
    expect(file).toEqual({ access_token: 'refreshed', priority: 9, note: 'new', auth_index: 'private-index' });
    expect(await saveAuthFileSettings('test.json', original, original, api)).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it('honors explicit canonical defaults and backend-supported boolean representations', () => {
    expect(authFileSettingsFromPayload({ disable_cooling: null, 'disable-cooling': true, excluded_models: [], 'excluded-models': ['old'] }))
      .toMatchObject({ disable_cooling: '', excluded_models: '' });
    expect(authFileSettingsFromPayload({ disable_cooling: 0, websockets: 'TRUE' }))
      .toMatchObject({ disable_cooling: 'false', websockets: 'true' });
    expect(authFileSettingsFromPayload({ disable_cooling: ' 1 ', websockets: 'False' }))
      .toMatchObject({ disable_cooling: 'true', websockets: 'false' });
  });

  it('clears all nine settings with backend-compatible values', () => {
    const original = authFileSettingsFromPayload({ prefix: 'p', proxy_url: 'http://proxy', priority: 4, weight: 4, disable_cooling: true,
      websockets: true, excluded_models: ['model'], headers: { 'X-One': '1', 'X-Two': '2' }, note: 'note' });
    const empty = authFileSettingsFromPayload({});
    expect(buildAuthFileSettingsPatch(original, empty)).toEqual({ prefix: '', proxy_url: '', priority: 0, weight: null,
      disable_cooling: null, websockets: null, excluded_models: [], headers: { 'X-One': '', 'X-Two': '' }, note: '' });
  });

  it('merges header edits and deletions without resending unchanged headers', () => {
    const original = authFileSettingsFromPayload({ headers: { 'X-Keep': 'a', 'X-Remove': 'b', 'X-Edit': 'old' } });
    expect(buildAuthFileSettingsPatch(original, { ...original, headers: '{"X-Keep":"a","X-Edit":"new","X-Add":"c"}' }))
      .toEqual({ headers: { 'X-Remove': '', 'X-Edit': 'new', 'X-Add': 'c' } });
  });

  it('preserves inheritance and recognizes semantically unchanged values', () => {
    const original = authFileSettingsFromPayload({ priority: 0, weight: 1, excluded_models: ['b', 'a'], headers: { 'X-Team': 'a' } });
    expect(buildAuthFileSettingsPatch(original, { ...original, priority: '', weight: '01', excluded_models: ' A \nb\na', headers: '{"X-Team":"a"}' })).toEqual({});
    expect(buildAuthFileSettingsPatch(original, { ...original, disable_cooling: 'false', websockets: 'true', weight: '-3' }))
      .toEqual({ disable_cooling: false, websockets: true, weight: 0 });
  });

  it('rejects unsafe values before sending a request', async () => {
    const original = authFileSettingsFromPayload({});
    for (const change of [{ priority: '1.5' }, { priority: '9007199254740992' }, { weight: '1e3' }, { weight: '1000001' }, { weight: 'NaN' },
      { headers: '[]' }, { headers: '{"X-Test":3}' }, { headers: '{"Invalid Header":"a"}' }, { headers: '{"X-Test":"a\\r\\nb"}' },
      { headers: '{"X-Test":"a","x-test":"b"}' }]) {
      let called = false;
      const api = { get: async () => ({}), patch: async () => { called = true; } };
      await expect(saveAuthFileSettings('test.json', original, { ...original, ...change }, api)).rejects.toThrow();
      expect(called).toBe(false);
    }
  });

  it('blocks editing when metadata is malformed and propagates save failures', async () => {
    for (const payload of ['not-json', [], null, { headers: [] }, { excluded_models: [3] }]) {
      expect(() => authFileSettingsFromPayload(payload)).toThrow();
    }
    const original = authFileSettingsFromPayload({});
    await expect(saveAuthFileSettings('test.json', original, { ...original, note: 'test' }, {
      get: async () => ({}), patch: async () => { throw new Error('save failed'); },
    })).rejects.toThrow('save failed');
  });

  it('edits template credential fields without resending tokens or unmodified metadata', () => {
    const original = authFileSettingsFromPayload({ access_token: 'never-copy', cloak_mode: 'auto', timezone: 'Asia/Tokyo',
      cloak_strict_mode: 'true', model_aliases: [{ name: 'upstream', alias: 'public', future_metadata: true }] });
    expect(buildAuthFileSettingsPatch(original, { ...original, advanced: { ...original.advanced, cloak_mode: 'always', cloak_strict_mode: false } }))
      .toEqual({ cloak_mode: 'always', cloak_strict_mode: 'false' });
    const next = { ...original.advanced }; delete next.timezone;
    expect(buildAuthFileSettingsPatch(original, { ...original, advanced: next })).toEqual({ timezone: null });
    expect(buildAuthFileSettingsPatch(original, { ...original, advanced: { ...original.advanced, model_aliases: [] } })).toEqual({ model_aliases: [] });
    expect(JSON.stringify(original)).not.toContain('never-copy');
    for (const advanced of [{ timezone: 'Not/AZone' }, { cloak_mode: 'invalid' }, { model_aliases: [{ name: '', alias: 'x' }] }]) {
      expect(() => buildAuthFileSettingsPatch(original, { ...original, advanced: { ...original.advanced, ...advanced } })).toThrow();
    }
  });

  it('converts native string cloak metadata to typed controls and writes executor-compatible strings', () => {
    const original = authFileSettingsFromPayload({ cloak_strict_mode: 'true', cloak_cache_user_id: 'false',
      cloak_sensitive_words: ' first,second , ', custom_metadata: { keep: true } });
    expect(original.advanced).toEqual({ cloak_strict_mode: true, cloak_cache_user_id: false, cloak_sensitive_words: ['first', 'second'] });
    expect(buildAuthFileSettingsPatch(original, original)).toEqual({});
    const patch = buildAuthFileSettingsPatch(original, { ...original, advanced: {
      cloak_strict_mode: false, cloak_cache_user_id: true, cloak_sensitive_words: ['changed', ' second '],
    } });
    expect(patch).toEqual({ cloak_strict_mode: 'false', cloak_cache_user_id: 'true', cloak_sensitive_words: 'changed,second' });
    expect(authFileSettingsFromPayload(patch).advanced).toEqual({ cloak_strict_mode: false, cloak_cache_user_id: true,
      cloak_sensitive_words: ['changed', 'second'] });
    expect(buildAuthFileSettingsPatch(original, { ...original, advanced: { cloak_sensitive_words: [] } }))
      .toEqual({ cloak_strict_mode: null, cloak_cache_user_id: null, cloak_sensitive_words: '' });
  });

  it('can edit older incorrectly typed cloak metadata without resending unrelated fields', () => {
    const original = authFileSettingsFromPayload({ cloak_strict_mode: false, cloak_cache_user_id: true,
      cloak_sensitive_words: ['old'], fingerprint_profile: 'claude-code-cli', model_aliases: [{ name: 'upstream', alias: 'public', extension: true }] });
    expect(original.advanced.cloak_strict_mode).toBe(false);
    expect(original.advanced.cloak_sensitive_words).toEqual(['old']);
    expect(buildAuthFileSettingsPatch(original, { ...original, advanced: { ...original.advanced,
      cloak_strict_mode: true, cloak_cache_user_id: false, cloak_sensitive_words: ['new'],
    } })).toEqual({ cloak_strict_mode: 'true', cloak_cache_user_id: 'false', cloak_sensitive_words: 'new' });
    expect(buildAuthFileSettingsPatch(original, { ...original, note: 'only note' })).toEqual({ note: 'only note',
      cloak_strict_mode: 'false', cloak_cache_user_id: 'true', cloak_sensitive_words: 'old' });
    const canonicalNull = authFileSettingsFromPayload({ cloak_strict_mode: null, 'cloak-strict-mode': 'true', cloak_sensitive_words: null });
    expect(canonicalNull.advanced).toEqual({ cloak_strict_mode: null, cloak_sensitive_words: null });
    expect(canonicalNull.normalizeCloakMetadata).toBeUndefined();
  });

  it('repairs previously typed cloak fields on an unchanged explicit save and stops after reload', async () => {
    const metadata = { cloak_strict_mode: true, cloak_cache_user_id: false, cloak_sensitive_words: [] as string[],
      access_token: 'retain', extension: { untouched: true } } as Record<string, unknown>;
    const writes: Record<string, unknown>[] = [];
    const api = { get: async () => metadata, patch: async (_path: string, body: Record<string, unknown>) => {
      const { name, ...patch } = body;
      writes.push(patch);
      Object.assign(metadata, patch);
    } };
    const original = await loadAuthFileSettings('old.json', api);
    expect(original.normalizeCloakMetadata).toEqual(['cloak_strict_mode', 'cloak_cache_user_id', 'cloak_sensitive_words']);
    expect(await saveAuthFileSettings('old.json', original, original, api)).toBe(true);
    expect(writes).toEqual([{ cloak_strict_mode: 'true', cloak_cache_user_id: 'false', cloak_sensitive_words: '' }]);
    expect(metadata.access_token).toBe('retain');
    expect(metadata.extension).toEqual({ untouched: true });
    const reloaded = await loadAuthFileSettings('old.json', api);
    expect(reloaded.normalizeCloakMetadata).toBeUndefined();
    expect(reloaded.advanced).toEqual(original.advanced);
    expect(await saveAuthFileSettings('old.json', reloaded, reloaded, api)).toBe(false);
    expect(writes).toHaveLength(1);
    expect(buildAuthFileSettingsPatch(original, { ...original, advanced: {} })).toEqual({
      cloak_strict_mode: null, cloak_cache_user_id: null, cloak_sensitive_words: null,
    });
  });
});
