import { isThemeId, isThemeLabel, type SystemThemes, type ThemeAppearance, type ThemeDefinition, type ThemeIssue, type ThemeLabel, type ThemePreview } from './types';
import { normalizeThemeTokens } from './tokenContract';
import { isThemeAssetPath, isThemeImageDataUrl, normalizeThemeAssets } from './resources';
import { warmSand } from './warmSand';
import { graphite } from './graphite';
import { midnight } from './midnight';
import { light } from './light';
import { dark } from './dark';
import { sakura } from './sakura';
import { backdropImage, normalizeBackdrop, themeBackdropImage, themeImagePosition } from './backdrop';

export function normalizeTheme(definition: ThemeDefinition, report: (issue: ThemeIssue) => void = () => {}): ThemeDefinition {
  if (!isThemeId(definition.id) || definition.id === 'system') throw new Error(`Invalid theme ID: ${definition.id}`);
  if (!['light', 'dark'].includes(definition.appearance) || !Number.isFinite(definition.order)
    || !(definition.nameKey || isThemeLabel(definition.name))
    || (definition.name !== undefined && !isThemeLabel(definition.name))
    || (definition.description !== undefined && !isThemeLabel(definition.description))
    || (definition.schemaVersion !== undefined && definition.schemaVersion !== 1)
    || (definition.windowMaterial !== undefined && !['solid', 'translucent'].includes(definition.windowMaterial))) {
    throw new Error(`Invalid theme metadata: ${definition.id}`);
  }
  if (!/^#[\da-f]{6}$/i.test(definition.windowBackground)) throw new Error(`Invalid window background: ${definition.id}`);
  if (!definition.tokens || typeof definition.tokens !== 'object') throw new Error(`Invalid theme tokens: ${definition.id}`);
  const tokens = normalizeThemeTokens(definition.tokens, report);
  const icon = isThemeAssetPath(definition.icon) ? definition.icon : undefined;
  if (definition.icon !== undefined && icon === undefined) report({ field: 'icon', code: 'invalid-icon' });
  if (definition.assets !== undefined && (!definition.assets || typeof definition.assets !== 'object' || Array.isArray(definition.assets))) {
    report({ field: 'assets', code: 'invalid-asset' });
  }
  const assets = normalizeThemeAssets(definition.assets, (field) => report({ field: `assets.${field}`, code: 'invalid-asset' }));
  const label = (value: ThemeLabel) => typeof value === 'string' ? value : Object.freeze({ ...value });
  const { icon: _icon, assets: _assets, backdropImage: image, ...rest } = definition;
  return Object.freeze({ ...rest,
    schemaVersion: 1,
    ...(definition.name === undefined ? {} : { name: label(definition.name) }),
    ...(definition.description === undefined ? {} : { description: label(definition.description) }),
    ...(icon === undefined ? {} : { icon }),
    ...(assets === undefined ? {} : { assets }),
    ...(assets?.backdropImage && /\.(?:png|jpe?g|webp|avif)$/i.test(assets.backdropImage)
      && isThemeImageDataUrl(image) ? { backdropImage: image } : {}),
    tokens: Object.freeze(tokens),
    ...(definition.backdrop === undefined ? {} : { backdrop: normalizeBackdrop(definition.backdrop, definition.id) }),
  });
}

export function createThemeRegistry(definitions: readonly ThemeDefinition[]) {
  const byId = new Map<string, ThemeDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) throw new Error(`Invalid or duplicate theme ID: ${definition.id}`);
    byId.set(definition.id, normalizeTheme(definition));
  }
  for (const appearance of ['light', 'dark'] as const) {
    if (byId.get(appearance)?.appearance !== appearance) throw new Error(`Missing default ${appearance} theme`);
  }
  const themes = Object.freeze([...byId.values()].sort((a, b) => a.order - b.order));
  const resolveSystem = (appearance: ThemeAppearance, remembered?: SystemThemes): ThemeDefinition => {
    const theme = byId.get(remembered?.[appearance] ?? appearance);
    return theme?.appearance === appearance ? theme : byId.get(appearance)!;
  };
  return {
    themes,
    get: (id: string) => byId.get(id),
    resolveSystem,
    resolve: (id: string, system: ThemeAppearance = 'light', remembered?: SystemThemes): ThemeDefinition =>
      id === 'system' ? resolveSystem(system, remembered) : byId.get(id) ?? byId.get('light')!,
  };
}

export const builtinThemes: readonly ThemeDefinition[] = [light, dark, warmSand, graphite, midnight, sakura];
export const themeRegistry = createThemeRegistry(builtinThemes);
export type ThemeRegistry = ReturnType<typeof createThemeRegistry>;

export function themePreview(theme: ThemeDefinition): ThemePreview {
  const dark = theme.appearance === 'dark';
  return {
    background: theme.backdropImage
      ? `${themeBackdropImage(theme)} ${themeImagePosition(theme)} / cover no-repeat ${theme.tokens.workspaceBackground ?? theme.windowBackground}`
      : `${theme.backdrop ? `${backdropImage(theme.backdrop)}, ` : ''}${theme.tokens.workspaceBackground ?? theme.windowBackground}`,
    sidebar: theme.backdrop?.sidebar ?? theme.tokens.sidebarBackground ?? (dark ? '#0f1218' : '#f7f8fa'),
    surface: theme.backdrop?.panel ?? theme.tokens.surface ?? (dark ? '#141720' : '#ffffff'),
    accent: theme.tokens.accent ?? (dark ? '#f5f5f5' : '#222222'),
  };
}
