import { describe, expect, test } from 'bun:test';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';
import { routingTemplateGroups } from '../src/services/generalTemplateFields';
import { applyTemplateChanges, draftTemplateField, readTemplatePath, templateSwitchChange, templateSwitchChecked } from '../src/services/templateConfig';

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
});
