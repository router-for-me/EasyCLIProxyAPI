import { describe, expect, test } from 'bun:test';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';
import { routingTemplateGroups } from '../src/services/generalTemplateFields';
import { applyTemplateChanges, confirmQuotaResponseModeWithCore, draftTemplateField, readTemplatePath, templateSwitchChange, templateSwitchChecked } from '../src/services/templateConfig';

const group = routingTemplateGroups.find(item => item.id === 'routing-advanced')!;
const field = group.fields.find(item => item.path.join('.') === 'routing.cooldown.quota-response-mode')!;
const neighbour = group.fields.find(item => item.path.join('.') === 'routing.cooldown.save-cooldown-status')!;
const path = ['routing', 'cooldown', 'quota-response-mode'];
const stored = (value: string) => ({ routing: { cooldown: { 'disable-cooling': false, 'quota-response-mode': value } } });
const toggle = (config: Record<string, unknown>, checked: boolean) => {
  const next = templateSwitchChange(field, checked);
  return draftTemplateField(field, config, undefined, next.value, next.remove);
};

describe('quota response mode toggle', () => {
  test('is a switch that is on only when usage-limit is stored', () => {
    expect(field).toMatchObject({ type: 'boolean', defaultValue: false, checkedValue: 'usage-limit' });
    expect(templateSwitchChecked(field, false)).toBe(false);
    expect(templateSwitchChecked(field, 'retryable')).toBe(false);
    expect(templateSwitchChecked(field, 'usage-limit')).toBe(true);
    // Plain boolean switches keep their true/false behaviour.
    expect(templateSwitchChecked(neighbour, true)).toBe(true);
    expect(templateSwitchChange(neighbour, false)).toEqual({ value: false, remove: false });
  });

  test('on writes usage-limit and off removes the key', () => {
    expect(toggle({}, true)).toEqual({ value: 'usage-limit', remove: false, expectedExists: false, expected: null });
    expect(toggle({}, false)).toBeUndefined();
    const removal = toggle(stored('usage-limit'), false);
    expect(removal).toEqual({ value: null, remove: true, expectedExists: true, expected: 'usage-limit' });
    const saved = applyTemplateChanges(stored('usage-limit'), [{ ...removal!, path }]);
    expect(readTemplatePath(saved, path).exists).toBe(false);
    expect(readTemplatePath(saved, ['routing', 'cooldown', 'disable-cooling']).value).toBe(false);
    expect(toggle(stored('retryable'), false)).toMatchObject({ remove: true, expectedExists: true });
    expect(toggle(stored('usage-limit'), true)).toBeUndefined();
  });

  test('round-trips through the browser mock configuration', async () => {
    const runtime = createBrowserMockRuntime('running');
    const on = toggle(await runtime.invoke('get_extended_core_config') as Record<string, unknown>, true)!;
    const result = await runtime.invoke('save_extended_core_config', { changes: [{ ...on, path }] }) as { config: Record<string, unknown>; restartRequired: boolean };
    expect(result.restartRequired).toBe(false);
    expect(readTemplatePath(result.config, path).value).toBe('usage-limit');
    const off = toggle(result.config, false)!;
    await runtime.invoke('save_extended_core_config', { changes: [{ ...off, path }] });
    expect(readTemplatePath(await runtime.invoke('get_extended_core_config'), path).exists).toBe(false);
  });

  // What the app's management client reports for the 400 a core without the setting returns.
  const unsupported = new Error('Management API error (400): invalid_config: yaml: unmarshal errors:\n  line 2: field cooldown not found in type config.RoutingConfig');

  test('a core without the setting refuses it, so nothing is saved', async () => {
    const puts: string[] = [];
    const on = toggle({}, true)!;
    const result = await confirmQuotaResponseModeWithCore([{ ...on, path }], async (target) => { puts.push(target); throw unsupported; });
    expect(result).toBeNull();
    expect(puts).toEqual(['/config/routing/cooldown/quota-response-mode']);
  });

  test('a core with the setting stores it first, and the file save then succeeds', async () => {
    const runtime = createBrowserMockRuntime('running');
    const put = (target: string, value: string) => runtime.invoke('management_request', { request: { method: 'PUT', path: target, body: value } });
    const on = toggle(await runtime.invoke('get_extended_core_config') as Record<string, unknown>, true)!;
    const neighbourOn = draftTemplateField(neighbour, {}, undefined, true, false)!;
    const changes = await confirmQuotaResponseModeWithCore([{ ...on, path }, { ...neighbourOn, path: [...neighbour.path] }], put);
    expect(changes).not.toBeNull();
    const result = await runtime.invoke('save_extended_core_config', { changes }) as { config: Record<string, unknown> };
    expect(readTemplatePath(result.config, path).value).toBe('usage-limit');
    expect(readTemplatePath(result.config, [...neighbour.path]).value).toBe(true);
  });

  test('other failures and turning it off keep the plain file save', async () => {
    const on = [{ ...toggle({}, true)!, path }];
    expect(await confirmQuotaResponseModeWithCore(on, async () => { throw new Error('Management API error (400): invalid_config: invalid port'); })).toEqual(on);
    expect(await confirmQuotaResponseModeWithCore(on, async () => { throw new Error('Failed to send management API request: connection refused'); })).toEqual(on);
    const off = [{ ...toggle(stored('usage-limit'), false)!, path }];
    expect(await confirmQuotaResponseModeWithCore(off, async () => { throw new Error('must not be called'); })).toEqual(off);
  });
});
