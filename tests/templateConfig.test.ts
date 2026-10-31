import { describe, expect, test } from 'bun:test';
import {
  applyTemplateChanges, draftTemplateField, readTemplatePath, sameTemplateValue,
  templateFieldSaveValue, templateFieldValidation, type TemplateConfigField,
} from '../src/services/templateConfig';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';
import { generalTemplateGroups, requestTemplateGroups, routingTemplateGroups } from '../src/services/generalTemplateFields';
import { templateMessages } from '../src/i18n/templateConfig';
import { oauthTemplateGroups } from '../src/services/oauthTemplateFields';

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
