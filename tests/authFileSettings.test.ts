import { describe, expect, it } from 'bun:test';
import { authFileSettingsFromPayload, buildAuthFileSettingsPatch, loadAuthFileSettings, saveAuthFileSettings } from '../src/services/authFileSettings';

describe('credential settings', () => {
  it('reads all fields and legacy aliases without retaining credential tokens', () => {
    const draft = authFileSettingsFromPayload(JSON.stringify({ prefix: 'team', 'proxy-url': 'socks5://localhost:1080', priority: -4, weight: 6,
      'disable-cooling': false, websocket: true, 'excluded-models': [' GPT-* ', 'gpt-*'], headers: { 'X-Team': 'test' }, note: 'note', access_token: 'secret' }));
    expect(draft).toEqual({ prefix: 'team', proxy_url: 'socks5://localhost:1080', priority: '-4', weight: '6', disable_cooling: 'false',
      websockets: 'true', excluded_models: 'gpt-*', headers: '{\n  "X-Team": "test"\n}', note: 'note' });
    expect(JSON.stringify(draft)).not.toContain('secret');
  });

  it('patches only changed settings while tokens or other fields refresh concurrently', async () => {
    const file = { access_token: 'before', priority: 5, note: 'old', auth_index: 'private-index' };
    const writes: unknown[] = [];
    const api = {
      async get(path: string, query: Record<string, string>) {
        expect([path, query]).toEqual(['/auth-files/download', { name: 'test.json' }]);
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
    expect(writes).toEqual([{ path: '/auth-files/fields', body: { name: 'test.json', note: 'new' } }]);
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
});
