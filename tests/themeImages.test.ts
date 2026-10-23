import { expect, test } from 'bun:test';
import { parseCustomThemes } from '../src/themes/customThemes';
import { builtinThemes, createThemeRegistry, themePreview } from '../src/themes/registry';
import { createThemeApplicator, themeWindowMaterial } from '../src/themes/applyTheme';
import { themeBackdropImage } from '../src/themes/backdrop';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const definition = {
  schemaVersion: 1, id: 'mountain-dark', name: 'Mountain', appearance: 'dark',
  windowBackground: '#142130', windowMaterial: 'translucent',
  assets: { backdropImage: 'assets/mountain.png' },
  tokens: { surface: '#24384E', workspaceBackground: '#142130', accent: '#F4C28F' },
  backdrop: {
    layers: [{ kind: 'linear', angle: 180, stops: [{ color: '#14213044', at: 0 }, { color: '#14213099', at: 100 }] }],
    sidebar: '#142130CC', panel: '#24384EDD', imagePosition: [50, 25],
  },
};
const parse = (value: unknown = definition, data: string | undefined = image) =>
  parseCustomThemes([{ folder: 'mountain', content: JSON.stringify(value), backdropImage: data }]);

test('loads backend-resolved images through the registry and renders matching preview artwork', () => {
  const { themes, skipped, diagnostics } = parse();
  expect([skipped, diagnostics]).toEqual([[], []]);
  const theme = createThemeRegistry([...builtinThemes, ...themes]).get('mountain-dark')!;
  expect(theme.backdropImage).toBe(image);
  expect(themeBackdropImage(theme)).toContain(`, url("${image}")`);
  expect(themePreview(theme).background).toContain('50% 25% / cover no-repeat');
  for (const material of ['liquid-glass', 'vibrancy', 'mica', 'acrylic'] as const) {
    expect(themeWindowMaterial(theme, material)).toBeNull();
  }
  expect(Object.isFrozen(theme.backdrop!.imagePosition)).toBe(true);
});

test('missing or unsafe image payloads preserve the theme and original material fallback', () => {
  for (const data of ['', 'https://example.com/photo.jpg', 'file:///photo.png',
    'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,AA==");color:red;/*',
    `data:image/png;base64,${'A'.repeat(11_184_841)}`]) {
    const { themes, skipped } = parse(definition, data);
    expect(skipped).toEqual([]);
    expect(themes[0].backdropImage).toBeUndefined();
    expect(themeBackdropImage(themes[0])).not.toContain('url(');
    expect(themeWindowMaterial(themes[0], 'mica')).toBe('mica');
  }
  const missing = parseCustomThemes([{ folder: 'mountain', content: JSON.stringify(definition) }]);
  expect(missing.themes[0].backdropImage).toBeUndefined();
  for (const assets of [{}, { backdropImage: '../photo.png' }, { backdropImage: 'assets/photo.svg' }]) {
    expect(parse({ ...definition, assets }).themes[0].backdropImage).toBeUndefined();
  }
  expect(parse({ ...definition, backdropImage: image }).skipped[0].reason).toBe('invalid-metadata');
});

test('rejects invalid image focal positions', () => {
  for (const imagePosition of [[-1, 50], [50, 101], [50], [0, 50, 100], ['50%', 25], null]) {
    expect(parse({ ...definition, backdrop: { ...definition.backdrop, imagePosition } }).skipped[0].reason).toBe('invalid-metadata');
  }
});

test('switching image, image-only and default themes clears artwork, focal position and material state', () => {
  const properties = new Map<string, string>();
  const root = { dataset: {} as Record<string, string>, style: {
    setProperty: (key: string, value: string) => properties.set(key, value),
    removeProperty: (key: string) => properties.delete(key),
  } };
  const document = { documentElement: root, body: { style: {} }, head: { append() {} }, querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }) } as unknown as Document;
  const apply = createThemeApplicator(document, () => 'mica');
  const theme = parse().themes[0];
  apply(theme);
  expect(root.dataset.themeBackdrop).toBe('image');
  expect(root.dataset.windowMaterial).toBeUndefined();
  expect(properties.get('--theme-backdrop-position')).toBe('50% 25%');
  expect(properties.get('--theme-sticky-background')).toContain('50% 25% / cover no-repeat fixed');
  expect(properties.get('--theme-backdrop-image')).toBe(themeBackdropImage(theme));
  apply(parse({ ...definition, backdrop: undefined }).themes[0]);
  expect(properties.get('--theme-backdrop-position')).toBe('center');
  expect(properties.get('--theme-backdrop-sidebar')).toBe('#142130');
  apply(builtinThemes[0]);
  expect(root.dataset.themeBackdrop).toBeUndefined();
  for (const property of ['--theme-backdrop-image', '--theme-backdrop-position', '--theme-sticky-background']) {
    expect(properties.has(property)).toBe(false);
  }
  apply(parse(definition, '').themes[0]);
  expect(root.dataset.themeBackdrop).toBe('gradient');
  expect(root.dataset.windowMaterial).toBe('mica');
});
