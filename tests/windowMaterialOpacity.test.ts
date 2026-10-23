import { describe, expect, test } from 'bun:test';
import { createThemeApplicator } from '../src/themes/applyTheme';
import { parseCustomThemes } from '../src/themes/customThemes';
import { builtinThemes, normalizeTheme } from '../src/themes/registry';
import { themeOpacityTokenProperties, type ThemeDefinition } from '../src/themes/types';

const base: ThemeDefinition = { id: 'glass-dark', name: 'Glass', appearance: 'dark', order: 20,
  windowBackground: '#102030', windowMaterial: 'translucent', tokens: {} };

describe('window material opacity tokens', () => {
  for (const [key, properties] of Object.entries(themeOpacityTokenProperties)) {
    test(`${key} accepts percentages and rejects invalid built-in and external values`, () => {
      for (const value of ['0%', '100%', '37.5%']) {
        const definition = normalizeTheme({ ...base, tokens: { [key]: value } });
        expect(definition.tokens[key as keyof typeof themeOpacityTokenProperties]).toBe(value);
        const { order: _order, ...external } = definition;
        const result = parseCustomThemes([{ folder: 'glass', content: JSON.stringify(external) }]);
        expect(result.skipped).toEqual([]);
        expect(result.themes[0].tokens).toEqual(definition.tokens);
        const styles = new Map<string, string>();
        const root = { dataset: {}, style: {
          setProperty: (key: string, value: string) => styles.set(key, value),
          removeProperty: (key: string) => styles.delete(key),
        } };
        const document = { documentElement: root, body: { style: {} }, querySelector: () => null,
          head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) } as unknown as Document;
        const apply = createThemeApplicator(document, () => 'mica');
        apply(definition);
        for (const property of properties) expect(styles.get(property)).toBe(value);
        apply(base);
        for (const property of properties) expect(styles.has(property)).toBe(false);
      }
      for (const value of ['-1%', '100.1%', '50', '50 %', 'NaN%', 'Infinity%', '#ffffff', 'var(--x)', '', 50, null, [], {}]) {
        const definition = { ...base, tokens: { [key]: value } } as unknown as ThemeDefinition;
        expect(normalizeTheme(definition).tokens).toEqual({});
        const { order: _order, ...external } = definition;
        const result = parseCustomThemes([{ folder: 'bad', content: JSON.stringify(external) }]);
        expect(result.skipped).toEqual([]);
        expect(result.themes[0].tokens).toEqual({});
        expect(result.diagnostics).toEqual([{ folder: 'bad', issues: [{ field: key, code: 'invalid-token' }] }]);
      }
    });
  }

  test('built-in themes keep native materials disabled', () => {
    for (const theme of builtinThemes) expect(theme.windowMaterial ?? 'solid').toBe('solid');
  });
});
