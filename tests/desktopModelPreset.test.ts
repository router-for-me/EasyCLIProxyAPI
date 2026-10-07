import { describe, expect, it } from 'bun:test';
import { exportDesktopModelPreset, parseDesktopModelPreset } from '../src/services/desktopModelPreset';
const entries = [{ model: 'claude-sonnet-5', alias: '', context1m: false }, { model: 'gemini-3.1-pro-low', alias: 'claude-custom-1', context1m: true }];
describe('desktop model preset', () => {
  it('round-trips order, aliases and context flags', () => { expect(parseDesktopModelPreset(exportDesktopModelPreset(entries))).toEqual(entries); });
  it('exports only model fields, excluding extra credential properties', () => {
    const text = exportDesktopModelPreset([{ ...entries[0], apiKey: 'secret' } as typeof entries[0]]);
    expect(text).not.toContain('secret'); expect(text).not.toContain('apiKey');
  });
  it('rejects unknown versions, credentials, duplicate names and wrong types', () => {
    const valid = exportDesktopModelPreset(entries);
    for (const text of [valid.replace('"version": 1', '"version": 2'), valid.replace('"context1m": false', '"context1m": "false"'), valid.replace('"context1m": false', '"apiKey": "secret", "context1m": false'), valid.replace('claude-custom-1', 'claude-sonnet-5')]) expect(() => parseDesktopModelPreset(text)).toThrow();
  });
  it('rejects missing non-Claude aliases, empty lists, oversized files and malformed JSON', () => {
    expect(() => exportDesktopModelPreset([{ ...entries[1], alias: '' }])).toThrow();
    expect(() => exportDesktopModelPreset([{ ...entries[1], alias: entries[1].model }])).toThrow();
    expect(() => exportDesktopModelPreset([])).toThrow();
    expect(() => parseDesktopModelPreset(' '.repeat(262145))).toThrow();
    expect(() => parseDesktopModelPreset('{')).toThrow();
  });
});
