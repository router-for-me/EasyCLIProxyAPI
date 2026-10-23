import { themeTokenProperties, type PlatformWindowMaterial, type ThemeDefinition } from './types';
import { backdropImage, themeBackdropImage, themeImagePosition } from './backdrop';
import { themeMaterialTokens, themeOverlayRules, themeOverlayPalette } from './materials';

export const themeWindowMaterial = (theme: ThemeDefinition, platform: PlatformWindowMaterial | null) =>
  theme.windowMaterial === 'translucent' && !theme.backdropImage ? platform : null;

export function createThemeApplicator(document: Document, platformMaterial: () => PlatformWindowMaterial | null = () => null) {
  const ownedProperties = [...Object.values(themeTokenProperties).flat(),
    '--theme-backdrop-image', '--theme-backdrop-color', '--theme-backdrop-sidebar',
    '--theme-backdrop-panel', '--theme-backdrop-position', '--theme-sticky-background', '--theme-sticky-hover-background'];
  let overlayStyle = document.querySelector<HTMLStyleElement>('style[data-theme-materials]') ?? undefined;
  return (theme: ThemeDefinition) => {
    const root = document.documentElement;
    for (const property of ownedProperties) root.style.removeProperty(property);
    delete root.dataset.themeBackdrop;
    delete root.dataset.windowMaterial;
    root.dataset.theme = theme.appearance;
    root.dataset.themeId = theme.id;
    root.style.colorScheme = theme.appearance;
    const material = themeWindowMaterial(theme, platformMaterial());
    if (material) root.dataset.windowMaterial = material;
    for (const [key, value] of Object.entries(themeMaterialTokens(theme))) {
      if (!Object.prototype.hasOwnProperty.call(themeTokenProperties, key)) continue;
      const properties = themeTokenProperties[key as keyof typeof themeTokenProperties];
      for (const property of properties) {
        root.style.setProperty(property, value);
      }
    }
    const overlayRules = themeOverlayRules(theme);
    if (overlayRules) {
      const palette = themeOverlayPalette(theme);
      for (const [property, value] of Object.entries({
        '--theme-overlay-surface': palette.surface,
        '--sidebar-popover-bg': palette.surface,
        '--theme-overlay-soft-surface': palette.softSurface,
      })) root.style.setProperty(property, value);
    }
    if (theme.backdrop || theme.backdropImage) {
      root.dataset.themeBackdrop = theme.backdropImage ? 'image' : 'gradient';
      const canvas = [...(theme.backdrop?.layers ?? []).map((layer) =>
        `${backdropImage({ ...theme.backdrop!, layers: [layer] })} center / 100vw 100vh no-repeat fixed`,
      ), ...(theme.backdropImage ? [`url("${theme.backdropImage}") ${themeImagePosition(theme)} / cover no-repeat fixed`] : [])].join(', ');
      const base = theme.tokens.workspaceBackground ?? theme.windowBackground;
      const panel = theme.backdrop?.panel ?? theme.tokens.surface ?? theme.windowBackground;
      const hover = theme.backdrop ? theme.backdrop.hover ?? panel : theme.tokens.hoverBackground ?? panel;
      for (const [property, value] of Object.entries({
        '--theme-backdrop-image': themeBackdropImage(theme),
        '--theme-backdrop-position': themeImagePosition(theme),
        '--theme-backdrop-color': theme.tokens.workspaceBackground ?? theme.windowBackground,
        '--theme-backdrop-sidebar': theme.backdrop?.sidebar ?? theme.tokens.sidebarBackground ?? theme.windowBackground,
        '--theme-backdrop-panel': panel,
        '--theme-sticky-background': `${canvas} ${base}`,
        '--theme-sticky-hover-background': `linear-gradient(${hover}, ${hover}), ${canvas} ${base}`,
      })) {
        root.style.setProperty(property, value);
      }
    }
    if (overlayRules) {
      if (!overlayStyle) {
        overlayStyle = document.createElement('style');
        overlayStyle.dataset.themeMaterials = '';
        document.head.append(overlayStyle);
      }
      overlayStyle.textContent = `@layer theme {\n${overlayRules}\n}`;
    } else {
      overlayStyle?.remove();
      overlayStyle = undefined;
    }
    if (material) {
      root.style.backgroundColor = '';
      if (document.body) document.body.style.backgroundColor = '';
    } else {
      root.style.backgroundColor = theme.windowBackground;
      if (document.body) document.body.style.backgroundColor = theme.backdrop || theme.backdropImage ? '' : theme.windowBackground;
    }
  };
}
