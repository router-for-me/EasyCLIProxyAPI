import { describe, expect, it } from 'bun:test';
import { defaultStructuredValue, validateStructuredValue, validateStructuredValueText, errorRulesShape, type ConfigShape } from '../src/services/structuredConfig';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StructuredConfigEditor } from '../src/components/StructuredConfigEditor';
import { I18nProvider } from '../src/i18n';
import { credentialAdvancedShape } from '../src/services/credentialAdvancedSettings';
import { payloadShape } from '../src/services/payloadTemplateFields';
import { oauthTemplateGroups } from '../src/services/oauthTemplateFields';
import { pluginStoreAuthShape } from '../src/services/extensionTemplateFields';

describe('structured configuration forms', () => {
  it('allows decimals for arbitrary JSON values while schema numbers retain integer controls', () => {
    const render = (shape: ConfigShape) => renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(StructuredConfigEditor, { shape, value: 0.5, onChange: () => {}, id: 'value' })));
    const arbitrary = render({ type: 'any', label: 'Temperature' });
    expect(arbitrary).toContain('step="any"');
    expect(arbitrary).toContain('aria-label="Temperature type"');
    expect(arbitrary).toContain('value="number" selected="">Number');
    expect(render({ type: 'number' })).toContain('step="1"');
    expect(validateStructuredValue({ type: 'number' }, 0.5)).toContain('integer');
    expect(validateStructuredValue({ type: 'any' }, 0.5)).toBeNull();
  });

  it('localizes nested and custom validation without changing the default English API', () => {
    const integer: ConfigShape = { type: 'object', fields: { count: { type: 'number', min: 0 } } };
    expect(validateStructuredValue(integer, { count: 1.5 })).toBe('.count: expected an integer ≥ 0');
    expect(validateStructuredValueText(integer, { count: 1.5 })).toEqual({
      en: '.count: expected an integer ≥ 0', zh: '.count: 请输入整数 ≥ 0', ja: '.count: 整数を入力してください ≥ 0',
    });
    expect(validateStructuredValueText(credentialAdvancedShape, { timezone: 'Not/AZone' })).toEqual({
      en: 'Enter an IANA timezone such as Asia/Shanghai', zh: '请输入 IANA 时区，例如 Asia/Shanghai', ja: 'Asia/Shanghai などの IANA タイムゾーンを入力してください',
    });
    expect(validateStructuredValueText(credentialAdvancedShape, { timezone: 'Asia/Tokyo' })).toBeNull();
  });
  it('does not turn optional settings into explicit defaults when a row is added', () => {
    expect(defaultStructuredValue(credentialAdvancedShape)).toEqual({});
    expect(defaultStructuredValue(errorRulesShape.item!)).toEqual({ status: 400, action: 'stop' });
  });

  it('keeps explicit false, zero and empty collections distinct from missing values', () => {
    const shape: ConfigShape = { type: 'object', fields: { enabled: { type: 'boolean', optional: true }, cap: { type: 'number', optional: true, min: 0 },
      list: { type: 'array', optional: true, item: { type: 'string' } } } };
    expect(validateStructuredValue(shape, { enabled: false, cap: 0, list: [], future_metadata: true })).toBeNull();
    expect(validateStructuredValue(shape, {})).toBeNull();
    expect(validateStructuredValue(shape, { cap: -1 })).toContain('integer');
    expect(validateStructuredValue(shape, { cap: 1.5 })).toContain('integer');
  });

  it('validates nested rule actions and model identifiers while preserving unknown metadata', () => {
    expect(validateStructuredValue(errorRulesShape, [{ status: 429, action: 'continue-and-cooldown', match: [] }])).toBeNull();
    expect(validateStructuredValue(errorRulesShape, [{ status: 99, action: 'stop' }])).not.toBeNull();
    expect(validateStructuredValue(errorRulesShape, [{ status: 400, action: 'retry-forever' }])).not.toBeNull();
    expect(validateStructuredValue(credentialAdvancedShape, { model_aliases: [{ name: 'upstream', alias: 'public', fork: false, future_metadata: { retain: true } }] })).toBeNull();
    expect(validateStructuredValue(credentialAdvancedShape, { model_aliases: [{ name: 'upstream', alias: '' }] })).not.toBeNull();
  });

  it('accepts typed raw JSON values and validates only strings as raw JSON syntax', () => {
    const shape = payloadShape('override-raw');
    expect(validateStructuredValue(shape, [{ models: [{ name: 'gpt-*' }], params: { temperature: 0.5, enabled: false,
      schema: { type: 'object' }, list: [1, 'value'], literal: '"string"', number: '0.5' } }])).toBeNull();
    expect(validateStructuredValue(shape, [{ models: [{ name: 'gpt-*' }], params: { invalid: 'unquoted-string' } }])).toContain('valid JSON');
  });

  it('accepts native plugin authentication defaults and all supported scopes', () => {
    for (const rule of [
      { match: 'https://plugins.example.com/' },
      { match: 'http://plugins.example.com/', type: 'none', 'allow-insecure': true },
      { match: 'https://plugins.example.com/', type: 'bearer', 'token-env': 'PLUGIN_TOKEN' },
      { match: 'https://plugins.example.com/', type: 'github-token', 'token-env': 'GITHUB_TOKEN', 'apply-to': [] },
      { match: 'https://plugins.example.com/', type: 'header', 'header-name': 'X-Token', 'header-value-env': 'PLUGIN_TOKEN', 'apply-to': ['metadata', 'artifact', 'registry'] },
    ]) expect(validateStructuredValue(pluginStoreAuthShape, [rule])).toBeNull();
    expect(validateStructuredValue(pluginStoreAuthShape, [{ match: 'https://plugins.example.com/', type: 'bearer' }])).not.toBeNull();
    expect(validateStructuredValue(pluginStoreAuthShape, [{ match: 'https://plugins.example.com/', 'apply-to': ['unknown'] }])).not.toBeNull();
  });

  it('edits OAuth model capabilities without forcing an optional context override', () => {
    const field = oauthTemplateGroups.find(group => group.id === 'oauth-models')!.fields.find(field => field.path.at(-1) === 'settings')!;
    for (const setting of [
      { name: 'gpt-5.4' },
      { name: 'gpt-5.4', alias: 'public-model' },
      { name: 'gpt-5.4', 'max-context-length': 0 },
      { name: 'gpt-5.4', alias: 'public-model', 'max-context-length': 200000, future: true },
    ]) expect(field.validate!({ codex: [setting] })).toBeNull();
    expect(field.validate!({ codex: [{ name: 'gpt-5.4', 'max-context-length': -1 }] })).not.toBeNull();
  });
});
