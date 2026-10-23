import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  isThemeTokenKey, isValidThemeToken, normalizeThemeTokens, themeTokenDefinitions,
  themeTokenProperties, type ThemeTokenKey,
} from '../src/themes/tokenContract';
import { themeSchemaJson } from '../src/themes/themeSchema';
import { builtinThemes, normalizeTheme } from '../src/themes/registry';
import { themeOverlayRules } from '../src/themes/materials';

const root = fileURLToPath(new URL('../', import.meta.url));
const tokenKeys = Object.keys(themeTokenDefinitions) as ThemeTokenKey[];

async function sourceText(): Promise<string> {
  const parts: string[] = [];
  for (const pattern of ['src/**/*.css', 'src/**/*.ts', 'src/**/*.tsx']) {
    for await (const file of new Bun.Glob(pattern).scan(root)) {
      if (file === 'src/themes/tokenContract.ts') continue;
      parts.push(await readFile(`${root}${file}`, 'utf8'));
    }
  }
  return parts.join('\n');
}

describe('theme token contract', () => {
  test('exposes independent colors for percentage meters', () => {
    for (const key of ['meterLow', 'meterMedium', 'meterHigh']) {
      expect(isThemeTokenKey(key)).toBe(true);
      expect(isValidThemeToken(key as ThemeTokenKey, '#123456')).toBe(true);
    }
  });
  test('keeps every exposed token appearance-only and typed', () => {
    expect(tokenKeys.length).toBeGreaterThan(40);
    for (const key of tokenKeys) expect(key).not.toMatch(/size|spacing|gap|height|font|line|padding|margin/i);
    expect(themeTokenDefinitions.cardBorderWidth.kind).toBe('border-width');
    expect(themeTokenDefinitions.radiusLarge.kind).toBe('radius');
    expect(themeTokenDefinitions.shadowDialog.kind).toBe('shadow');
    expect(themeTokenDefinitions.windowMaterialWorkspaceOpacity.kind).toBe('opacity');
    expect(themeTokenDefinitions.accent.kind).toBe('color');
  });

  test('validates values by kind and range', () => {
    for (const value of ['#ffffff', '#FFFFFF00']) expect(isValidThemeToken('accent', value)).toBe(true);
    for (const value of ['red', '#fff', 'rgba(0,0,0,0.5)', 'url(x)', 42, null]) expect(isValidThemeToken('accent', value)).toBe(false);
    for (const value of ['0%', '100%', '37.5%']) expect(isValidThemeToken('windowMaterialWorkspaceOpacity', value)).toBe(true);
    for (const value of ['-1%', '100.1%', '50']) expect(isValidThemeToken('windowMaterialWorkspaceOpacity', value)).toBe(false);
    for (const value of ['0px', '4px', '2.5px']) expect(isValidThemeToken('controlBorderWidth', value)).toBe(true);
    for (const value of ['-1px', '4.5px', '5px', '2', '2em']) expect(isValidThemeToken('controlBorderWidth', value)).toBe(false);
    for (const value of ['0px', '24px']) expect(isValidThemeToken('radiusMedium', value)).toBe(true);
    for (const value of ['25px', '-2px', '50%']) expect(isValidThemeToken('radiusMedium', value)).toBe(false);
    expect(isValidThemeToken('radiusFull', '9999px')).toBe(true);
    expect(isValidThemeToken('radiusFull', '10000px')).toBe(false);
    for (const value of ['none', '0 1px 2px rgba(45, 42, 38, 0.08)', '0 4px 16px #00000040, inset 0 0 0 1px #ffffff20'])
      expect(isValidThemeToken('shadowSmall', value)).toBe(true);
    for (const value of ['0 1px 2px', '1px solid red', 'url(x)', '0 1px 2px var(--x)'])
      expect(isValidThemeToken('shadowSmall', value)).toBe(false);
  });

  test('normalizes tokens into the runtime whitelist', () => {
    const issues: string[] = [];
    const tokens = normalizeThemeTokens({
      accent: '#112233', unknownToken: '#112233', radiusMedium: '8px', borderWidth: '2px',
      spacing: '8px', shadowSmall: 'none', surface: '#zzzzzz',
    }, (issue) => issues.push(`${issue.code}:${issue.field}`));
    expect(tokens).toEqual({ accent: '#112233', radiusMedium: '8px', shadowSmall: 'none' });
    expect(issues).toEqual(['unknown-token:unknownToken', 'unknown-token:borderWidth', 'unknown-token:spacing', 'invalid-token:surface']);
  });

  test('built-in themes only use registered tokens and valid values', () => {
    for (const theme of builtinThemes) {
      const issues: string[] = [];
      normalizeTheme(theme, (issue) => issues.push(`${issue.code}:${issue.field}`));
      expect(issues).toEqual([]);
      for (const key of Object.keys(theme.tokens)) expect(isThemeTokenKey(key)).toBe(true);
    }
  });

  test('every exposed property is consumed by styles or the generated overlay rules', async () => {
    const source = await sourceText();
    const overlay = themeOverlayRules(normalizeTheme({
      id: 'probe-dark', name: 'Probe', appearance: 'dark', order: 99, windowBackground: '#000000',
      tokens: { accent: '#ffffff' },
    }));
    const unaccounted = tokenKeys.flatMap((key) => themeTokenProperties[key]
      .filter((property) => !source.includes(property) && !overlay.includes(property)));
    expect(unaccounted).toEqual([]);
  });

  test('tokens without CSS properties are still consumed programmatically', () => {
    const propertyless = tokenKeys.filter((key) => themeTokenProperties[key].length === 0);
    expect(propertyless).toEqual(['overlayHoverBackground']);
    const overlay = themeOverlayRules(normalizeTheme({
      id: 'probe-overlay-dark', name: 'Probe', appearance: 'dark', order: 99, windowBackground: '#000000',
      tokens: { accent: '#ffffff', overlayHoverBackground: '#112233' },
    }));
    expect(overlay).toContain('--theme-sticky-hover-background:#112233');
  });

  test('generated theme.schema.json matches the contract', async () => {
    expect(await readFile(`${root}theme.schema.json`, 'utf8')).toBe(themeSchemaJson());
    const schema = JSON.parse(themeSchemaJson()) as {
      required: string[];
      properties: { tokens: { additionalProperties: boolean; properties: Record<string, unknown> } };
    };
    expect(schema.required).toContain('schemaVersion');
    expect(schema.properties.tokens.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.tokens.properties).sort()).toEqual([...tokenKeys].sort());
  });
});
