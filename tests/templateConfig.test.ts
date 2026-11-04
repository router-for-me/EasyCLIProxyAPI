import { describe, expect, test } from 'bun:test';
import {
  applyTemplateChanges, draftTemplateField, readTemplatePath, sameTemplateValue,
  templateFieldSaveValue, templateFieldValidation, type TemplateConfigField,
} from '../src/services/templateConfig';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';
import { generalTemplateGroups, requestTemplateGroups, routingTemplateGroups } from '../src/services/generalTemplateFields';
import { templateMessages } from '../src/i18n/templateConfig';
import { oauthTemplateGroups } from '../src/services/oauthTemplateFields';
import { settingsCategories, settingsTemplateGroups } from '../src/services/settingsNavigation';

const field: TemplateConfigField = { path: ['oauth', 'providers', 'codex', 'response-steering'], type: 'boolean', label: 'Steering', defaultValue: false };
const change = (path: string[], value: unknown, expected: unknown = null, expectedExists = false, remove = false) => ({ path, value, expected, expectedExists, remove });

describe('template configuration drafts', () => {
  test('all general settings labels and help messages include Japanese', () => {
    const groups = [...generalTemplateGroups, ...requestTemplateGroups, ...routingTemplateGroups];
    const messages = [...Object.values(templateMessages), ...groups.flatMap((group) => [group.title, group.description, ...group.fields.flatMap((item) => [item.label, item.description, ...item.options?.map((option) => option.label) ?? []])])].filter((value) => value !== undefined);
    for (const message of messages) {
      expect(typeof message).toBe('object');
      expect((message as { ja: string }).ja.length).toBeGreaterThan(0);
    }
  });
  test('preserves absent versus explicit false, zero and empty collections', () => {
    for (const value of [false, 0, '', [], {}]) {
      const draft = draftTemplateField(field, {}, undefined, value);
      expect(draft).toMatchObject({ value, remove: false, expectedExists: false });
      const saved = applyTemplateChanges({}, [{ ...draft!, path: [...field.path] }]);
      expect(readTemplatePath(saved, field.path)).toEqual({ exists: true, value });
    }
  });

  test('retains original expected values across external refresh and subsequent edits', () => {
    const initial = applyTemplateChanges({}, [change([...field.path], false)]);
    const draft = draftTemplateField(field, initial, undefined, true);
    const refreshed = applyTemplateChanges(initial, [change([...field.path], true)]);
    expect(draftTemplateField(field, refreshed, draft, true)).toEqual(draft);
    expect(draftTemplateField(field, refreshed, draft, false)).toBeUndefined();
  });

  test('reset removes only selected leaf and preserves unknown neighbors', () => {
    const source = { requests: { payload: { rules: [1] }, enabled: false }, unknown: { nested: ['preserve'] } };
    const result = applyTemplateChanges(source, [change(['requests', 'enabled'], null, false, true, true)]);
    expect(result).toEqual({ requests: { payload: { rules: [1] } }, unknown: { nested: ['preserve'] } });
    expect(source.requests.enabled).toBe(false);
    expect(readTemplatePath(result, ['requests', 'enabled']).exists).toBe(false);
  });

  test('uses structural equality without depending on map order', () => {
    expect(sameTemplateValue({ a: false, b: [0] }, { b: [0], a: false })).toBe(true);
    expect(sameTemplateValue({}, { a: null })).toBe(false);
    expect(sameTemplateValue([], {})).toBe(false);
  });

  test('normalizes newline lists at save even without a blur event', () => {
    const listField = { ...field, type: 'string-list' as const };
    expect(templateFieldSaveValue(listField, ['', '  ', 'one ', ' two'])).toEqual(['one', 'two']);
    expect(templateFieldSaveValue(listField, [''])).toEqual([]);
  });

  test('mixed selectors retain booleans and signed numeric settings accept negative limits', () => {
    const select = { ...field, type: 'select' as const, options: [{ value: false, label: 'Enable' }, { value: true, label: 'Disable' }, { value: 'chat', label: 'Chat' }] };
    expect(templateFieldValidation(select, false)).toBeNull();
    expect(templateFieldValidation(select, 'false')).not.toBeNull();
    const number = { ...field, type: 'number' as const, min: -1 };
    expect(templateFieldValidation(number, -1)).toBeNull();
    expect(templateFieldValidation(number, -2)).not.toBeNull();
    expect(templateFieldValidation(number, '')).not.toBeNull();
  });

  test('accepts native bootstrap seconds and an explicitly empty fallback image model', () => {
    const timeout = oauthTemplateGroups.find(group => group.id === 'oauth-codex')!.fields.find(field => field.path.at(-1) === 'stream-bootstrap-timeout')!;
    for (const value of ['', '  ', '15', '0', '20s', '500ms', 'off', 'unlimited']) expect(templateFieldValidation(timeout, value)).toBeNull();
    expect(templateFieldValidation(timeout, 'invalid')).not.toBeNull();
    const imageModel = requestTemplateGroups.find(group => group.id === 'multimedia')!.fields.find(field => field.path.at(-1) === 'gpt-image-2-base-model')!;
    expect(templateFieldValidation(imageModel, '')).toBeNull();
    expect(templateFieldValidation(imageModel, 'gpt-5.4-mini')).toBeNull();
    expect(templateFieldValidation(imageModel, 'invalid')).not.toBeNull();
  });

  test('exposes missing v8 core options and organizes them in categories', () => {
    // 1. Server settings
    const serverGroup = generalTemplateGroups.find(g => g.id === 'server')!;
    expect(serverGroup).toBeDefined();
    const serverPaths = serverGroup.fields.map(f => f.path.join('.'));
    expect(serverPaths).toContain('server.max-request-body-bytes');
    expect(serverPaths).toContain('server.response-compression.enabled');
    expect(serverPaths).toContain('server.response-compression.min-bytes');
    expect(serverPaths).toContain('server.discovery.enabled');
    expect(serverGroup.fields.find(f => f.path.join('.') === 'server.discovery.enabled')?.restart).toBe(true);

    // 2. Requests & streaming
    const requestGroup = requestTemplateGroups.find(g => g.id === 'request-behavior')!;
    const requestPaths = requestGroup.fields.map(f => f.path.join('.'));
    expect(requestPaths).toContain('requests.tls-handshake-timeout-seconds');
    expect(requestPaths).toContain('requests.streaming.send-keepalive-before-ft');
    expect(requestPaths).toContain('requests.streaming.bootstrap-retries');

    // 3. Routing
    const routingGroup = routingTemplateGroups.find(g => g.id === 'routing-advanced')!;
    const routingPaths = routingGroup.fields.map(f => f.path.join('.'));
    expect(routingPaths).toContain('routing.session-affinity-rebind-on');
    expect(routingPaths).toContain('routing.retry.max-retry-credentials');
    expect(routingPaths).toContain('routing.retry.max-retry-interval');
    const rebindField = routingGroup.fields.find(f => f.path.join('.') === 'routing.session-affinity-rebind-on')!;
    expect(rebindField.type).toBe('select');
    expect(rebindField.options?.map(o => o.value)).toEqual(['quota', 'any']);

    // 4. Client Codex
    const codexClientGroup = requestTemplateGroups.find(g => g.id === 'codex-client')!;
    const codexClientPaths = codexClientGroup.fields.map(f => f.path.join('.'));
    expect(codexClientPaths).toContain('client.codex.web-search-result-cache.enabled');
    expect(codexClientPaths).toContain('client.codex.web-search-result-cache.ttl');
    expect(codexClientPaths).toContain('client.codex.web-search-result-cache.limit');
    const cacheTtlField = codexClientGroup.fields.find(f => f.path.join('.') === 'client.codex.web-search-result-cache.ttl')!;
    expect(templateFieldValidation(cacheTtlField, '24h')).toBeNull();
    expect(templateFieldValidation(cacheTtlField, '30m')).toBeNull();
    expect(templateFieldValidation(cacheTtlField, 'invalid-ttl')).not.toBeNull();

    // 5. Upstream in OAuth groups
    const codexOauthGroup = oauthTemplateGroups.find(g => g.id === 'oauth-codex')!;
    const codexOauthPaths = codexOauthGroup.fields.map(f => f.path.join('.'));
    expect(codexOauthPaths).toContain('upstream.codex.upstream-request-compression');
    expect(codexOauthPaths).toContain('upstream.codex.websocket-compression');

    const claudeOauthGroup = oauthTemplateGroups.find(g => g.id === 'oauth-claude')!;
    const claudeOauthPaths = claudeOauthGroup.fields.map(f => f.path.join('.'));
    expect(claudeOauthPaths).toContain('upstream.claude.tool-search');
    expect(claudeOauthPaths).toContain('upstream.claude.session-date-pin-days');
    expect(claudeOauthPaths).toContain('upstream.claude.disable-cloaking-model-list');

    // 6. Check categories mapping
    expect(settingsCategories.map(c => c.id)).toEqual(['general', 'proxy', 'aliases', 'routing', 'requests', 'oauth', 'diagnostics', 'software']);
    expect(settingsTemplateGroups.general.map(g => g.id)).toContain('server');
    expect(settingsTemplateGroups.general.map(g => g.id)).toContain('management');
    expect(settingsTemplateGroups.routing.map(g => g.id)).toContain('routing-advanced');
    expect(settingsTemplateGroups.requests.map(g => g.id)).toContain('request-behavior');
    expect(settingsTemplateGroups.requests.map(g => g.id)).toContain('codex-client');
    expect(settingsTemplateGroups.oauth.map(g => g.id)).toContain('oauth-codex');
    expect(settingsTemplateGroups.oauth.map(g => g.id)).toContain('oauth-claude');

    // 7. Verify all OAuth group fields have Japanese translations as well
    for (const group of oauthTemplateGroups) {
      for (const f of group.fields) {
        if (typeof f.label === 'object') {
          expect(f.label.ja?.length).toBeGreaterThan(0);
        }
        if (f.description && typeof f.description === 'object') {
          expect(f.description.ja?.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('rejects unsafe path writes', () => {
    expect(() => applyTemplateChanges({}, [change(['__proto__', 'polluted'], true)])).toThrow('Invalid configuration path');
    expect(() => applyTemplateChanges({}, [change([], true)])).toThrow('Invalid configuration path');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('extended browser mock persistence', () => {
  test('hot-reloadable diagnostics and plugins do not ask for a restart', async () => {
    const runtime = createBrowserMockRuntime('running');
    const changes = [change(['observability', 'pprof', 'enable'], true), change(['plugins', 'enabled'], true), change(['plugins', 'dir'], 'custom-plugins')];
    expect(await runtime.invoke('save_extended_core_config', { changes })).toMatchObject({ restartRequired: false });
  });
  test('credential directory changes and restoring defaults require a restart', async () => {
    const runtime = createBrowserMockRuntime('running');
    const path = ['oauth', 'auth-dir'];
    expect(await runtime.invoke('save_extended_core_config', { changes: [change(path, '~/custom-credentials')] })).toMatchObject({ restartRequired: true });
    expect(readTemplatePath(await runtime.invoke('get_extended_core_config'), path).value).toBe('~/custom-credentials');
    expect(await runtime.invoke('save_extended_core_config', { changes: [change(path, null, '~/custom-credentials', true, true)] })).toMatchObject({ restartRequired: true });
    expect(readTemplatePath(await runtime.invoke('get_extended_core_config'), path).exists).toBe(false);
  });
  test('saves offline, supports explicit overrides, removal and preserves unrelated values', async () => {
    const events: string[] = [];
    const runtime = createBrowserMockRuntime('stopped', (event) => events.push(event));
    const changes = [change(['plugins', 'enabled'], false), change(['plugins', 'configs'], {}), change(['management', 'disable-auto-update-panel'], false)];
    const result = await runtime.invoke('save_extended_core_config', { changes }) as { config: Record<string, unknown>; restartRequired: boolean };
    expect(readTemplatePath(result.config, ['plugins', 'enabled'])).toEqual({ exists: true, value: false });
    expect(readTemplatePath(result.config, ['plugins', 'configs']).value).toEqual({});
    expect(result.restartRequired).toBe(true);
    expect(events).toContain('config-files-changed');
    await runtime.invoke('save_extended_core_config', { changes: [change(['plugins', 'enabled'], null, false, true, true)] });
    const current = await runtime.invoke('get_extended_core_config');
    expect(readTemplatePath(current, ['plugins', 'enabled']).exists).toBe(false);
    expect(readTemplatePath(current, ['server', 'host']).value).toBe('127.0.0.1');
  });

  test('conflicts are atomic and absent differs from explicit null', async () => {
    const runtime = createBrowserMockRuntime('running');
    const path = ['oauth', 'auth-auto-refresh-workers'];
    await runtime.invoke('save_extended_core_config', { changes: [change(path, 2)] });
    await expect(runtime.invoke('save_extended_core_config', { changes: [change(['plugins', 'enabled'], true), change(path, 5)] })).rejects.toThrow('changed externally');
    const current = await runtime.invoke('get_extended_core_config');
    expect(readTemplatePath(current, ['plugins', 'enabled']).exists).toBe(false);
    expect(readTemplatePath(current, path).value).toBe(2);
    await runtime.invoke('save_extended_core_config', { changes: [change(['plugins', 'configs'], null)] });
    await expect(runtime.invoke('save_extended_core_config', { changes: [change(['plugins', 'configs'], {})] })).rejects.toThrow('changed externally');
  });

  test('existing and extended controls stay synchronized', async () => {
    const runtime = createBrowserMockRuntime('running');
    await runtime.invoke('save_retry_settings', { settings: { maxRetryInterval: -1 } });
    expect(readTemplatePath(await runtime.invoke('get_extended_core_config'), ['routing', 'retry', 'max-retry-interval']).value).toBe(-1);
    await runtime.invoke('save_extended_core_config', { changes: [change(['observability', 'logs', 'request-log'], true), change(['plugins', 'enabled'], true)] });
    expect(await runtime.invoke('get_core_config_settings')).toMatchObject({ requestLog: true, pluginsEnabled: true });
    await runtime.invoke('save_extended_core_config', { changes: [change(['observability', 'logs', 'request-log'], null, true, true, true)] });
    expect(await runtime.invoke('get_core_config_settings')).toMatchObject({ requestLog: false, pluginsEnabled: true });
  });
});
