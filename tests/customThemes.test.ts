import { describe, expect, test } from 'bun:test';
import { parseCustomThemes } from '../src/themes/customThemes';
import { builtinThemes, createThemeRegistry } from '../src/themes/registry';
import { createThemeApplicator } from '../src/themes/applyTheme';

const theme = (fields: Record<string, unknown> = {}) => JSON.stringify({
  $schema: './theme.schema.json', schemaVersion: 1, id: 'harbor-dark', name: { en: 'Harbor', 'zh-CN': '港湾' },
  appearance: 'dark', windowBackground: '#0E1A1F',
  tokens: { workspaceBackground: '#0E1A1F', accent: '#6FD3C1' }, ...fields,
});
const file = (folder: string, content: string | null) => ({ folder, content });
const applicator = () => {
  const applied: Record<string, string> = {};
  const root = { dataset: {} as Record<string, string>, style: {
    setProperty(key: string, value: string) { applied[key] = value; },
    removeProperty(key: string) { delete applied[key]; },
  } };
  const document = { documentElement: root, body: { style: {} }, head: { append() {} }, querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }) } as unknown as Document;
  return { applied, apply: createThemeApplicator(document) };
};

describe('custom themes', () => {
  test('parses folder themes in order after the built-in themes', () => {
    const { themes, skipped, diagnostics } = parseCustomThemes([
      file('a-harbor', theme()),
      file('b-paper', theme({ id: 'paper-light', name: 'Paper', appearance: 'light', description: 'Plain', $schema: undefined })),
    ]);
    expect([skipped, diagnostics]).toEqual([[], []]);
    expect(themes.map(({ id }) => id)).toEqual(['harbor-dark', 'paper-light']);
    const last = Math.max(...builtinThemes.map(({ order }) => order));
    expect(themes.map(({ order }) => order)).toEqual([last + 1, last + 2]);
    expect(themes.map(({ schemaVersion }) => schemaVersion)).toEqual([1, 1]);
    expect(themes[0]).not.toHaveProperty('$schema');
    expect(Object.isFrozen(themes[0].tokens)).toBe(true);
    const registry = createThemeRegistry([...builtinThemes, ...themes]);
    expect(registry.themes.slice(-2).map(({ id }) => id)).toEqual(['harbor-dark', 'paper-light']);
  });

  test('accepts a window material request', () => {
    const { themes, skipped } = parseCustomThemes([
      file('glass', theme({ id: 'glass-dark', windowMaterial: 'translucent' })),
      file('solid', theme({ id: 'solid-dark', windowMaterial: 'solid' })),
    ]);
    expect(skipped).toEqual([]);
    expect(themes.map(({ windowMaterial }) => windowMaterial)).toEqual(['translucent', 'solid']);
  });

  test('drops unknown and mistyped tokens but keeps the rest of the theme', () => {
    const { themes, skipped, diagnostics } = parseCustomThemes([
      file('legacy', theme({ id: 'legacy-dark', tokens: {
        accent: '#6FD3C1', surface: 42, borderWidth: '2px', spacing: '8px', fontFamily: 'serif',
        windowMaterialTitlebarOpacity: '72%', futureToken: { value: 'ignored' }, toString: 'ignored',
      } })),
    ]);
    expect(skipped).toEqual([]);
    expect(themes.map(({ id }) => id)).toEqual(['legacy-dark']);
    expect(themes[0].tokens).toEqual({ accent: '#6FD3C1' });
    expect(diagnostics).toEqual([{ folder: 'legacy', issues: [
      { field: 'surface', code: 'invalid-token' },
      { field: 'borderWidth', code: 'unknown-token' },
      { field: 'spacing', code: 'unknown-token' },
      { field: 'fontFamily', code: 'unknown-token' },
      { field: 'windowMaterialTitlebarOpacity', code: 'unknown-token' },
      { field: 'futureToken', code: 'unknown-token' },
      { field: 'toString', code: 'unknown-token' },
    ] }]);
    const { applied, apply } = applicator();
    expect(() => apply(themes[0])).not.toThrow();
    expect(applied['--ui-accent']).toBe('#6FD3C1');
  });

  test('accepts radius and border widths inside their ranges and drops values outside', () => {
    const accepted = { radiusSmall: '0px', radiusMedium: '8.5px', radiusLarge: '24px', radiusFull: '9999px', controlBorderWidth: '0px', cardBorderWidth: '4px' };
    const rejected = { radiusSmall: '25px', radiusMedium: '-1px', radiusLarge: '12', radiusFull: '10000px', controlBorderWidth: '4.5px', cardBorderWidth: '5px' };
    const { themes, diagnostics } = parseCustomThemes([
      file('ok', theme({ id: 'ok-dark', tokens: accepted })),
      file('bad', theme({ id: 'bad-dark', tokens: rejected })),
    ]);
    expect(themes[0].tokens).toEqual(accepted);
    expect(themes[1].tokens).toEqual({});
    expect(diagnostics).toEqual([{ folder: 'bad', issues: Object.keys(rejected).map((field) => ({ field, code: 'invalid-token' as const })) }]);
  });

  test('keeps appearance shadows and ignores a malformed shadow', () => {
    const { themes, diagnostics } = parseCustomThemes([
      file('shadow', theme({ id: 'shadow-dark', tokens: {
        shadowSmall: '0 1px 2px rgba(45, 42, 38, 0.08)', shadowDialog: 'none',
        shadowLarge: '0 4px 16px #00000040, inset 0 0 0 1px #ffffff20',
        shadowMedium: 'url(https://example.com/bad.png)',
      } })),
    ]);
    expect(themes[0].tokens).toEqual({
      shadowSmall: '0 1px 2px rgba(45, 42, 38, 0.08)', shadowDialog: 'none',
      shadowLarge: '0 4px 16px #00000040, inset 0 0 0 1px #ffffff20',
    });
    expect(diagnostics[0].issues).toEqual([{ field: 'shadowMedium', code: 'invalid-token' }]);
  });

  test('requires a supported schema version but accepts a missing one', () => {
    const { themes, skipped } = parseCustomThemes([
      file('missing', theme({ id: 'missing-dark', schemaVersion: undefined })),
      file('future', theme({ id: 'future-dark', schemaVersion: 2 })),
      file('text', theme({ id: 'text-dark', schemaVersion: '1' })),
    ]);
    expect(themes.map(({ id }) => id)).toEqual(['missing-dark']);
    expect(skipped).toEqual([
      { folder: 'future', reason: 'unsupported-version' },
      { folder: 'text', reason: 'unsupported-version' },
    ]);
  });

  test('validates icon and asset paths without reading the files', () => {
    const { themes, diagnostics } = parseCustomThemes([
      file('assets', theme({ id: 'assets-dark', icon: 'assets/icon.png', assets: {
        backdropImage: 'assets/backdrop.webp', bad: '../secrets.png', absolute: '/tmp/a.png',
        remote: 'https://example.com/a.png', scheme: 'file://a.svg', wrong: 'assets/icon.gif',
        backslash: 'assets\\\\icon.png', 'bad name': 'assets/icon.png',
      } })),
      file('bad-icon', theme({ id: 'bad-icon-dark', icon: '../icon.png', assets: { good: 'assets/a.avif' } })),
    ]);
    expect(themes[0].icon).toBe('assets/icon.png');
    expect(themes[0].assets).toEqual({ backdropImage: 'assets/backdrop.webp' });
    expect(diagnostics[0]).toEqual({ folder: 'assets', issues: [
      { field: 'assets.bad', code: 'invalid-asset' },
      { field: 'assets.absolute', code: 'invalid-asset' },
      { field: 'assets.remote', code: 'invalid-asset' },
      { field: 'assets.scheme', code: 'invalid-asset' },
      { field: 'assets.wrong', code: 'invalid-asset' },
      { field: 'assets.backslash', code: 'invalid-asset' },
      { field: 'assets.bad name', code: 'invalid-asset' },
    ] });
    expect(themes[1].icon).toBeUndefined();
    expect(themes[1].assets).toEqual({ good: 'assets/a.avif' });
    expect(diagnostics[1]).toEqual({ folder: 'bad-icon', issues: [{ field: 'icon', code: 'invalid-icon' }] });
  });

  test('skips only the invalid file and records why', () => {
    const { themes, skipped, diagnostics } = parseCustomThemes([
      file('broken', '{'),
      file('unreadable', null),
      file('array', '[]'),
      file('nameless', theme({ name: undefined })),
      file('builtin', theme({ id: 'dark' })),
      file('extra', theme({ id: 'extra-dark', order: 1 })),
      file('key', theme({ id: 'key-dark', nameKey: 'app.theme.dark' })),
      file('material', theme({ id: 'glass-dark', windowMaterial: 'glass' })),
      file('background', theme({ id: 'background-dark', windowBackground: ['#ffffff'] })),
      file('backdrop', theme({ id: 'backdrop-dark', backdrop: { layers: [] } })),
      file('token-type', theme({ id: 'token-type-dark', tokens: { accent: ['#ffffff'] } })),
      file('good', theme()),
      file('duplicate', theme({ name: 'Copy' })),
    ]);
    expect(themes.map(({ id }) => id)).toEqual(['token-type-dark', 'harbor-dark']);
    expect(skipped).toEqual([
      { folder: 'broken', reason: 'invalid-json' },
      { folder: 'unreadable', reason: 'unreadable' },
      { folder: 'array', reason: 'invalid-metadata' },
      { folder: 'nameless', reason: 'invalid-metadata' },
      { folder: 'builtin', reason: 'duplicate-id' },
      { folder: 'extra', reason: 'invalid-metadata' },
      { folder: 'key', reason: 'invalid-metadata' },
      { folder: 'material', reason: 'invalid-metadata' },
      { folder: 'background', reason: 'invalid-metadata' },
      { folder: 'backdrop', reason: 'invalid-metadata' },
      { folder: 'duplicate', reason: 'duplicate-id' },
    ]);
    expect(diagnostics).toEqual([{ folder: 'token-type', issues: [{ field: 'accent', code: 'invalid-token' }] }]);
  });
});
