export type ThemeTokenKind = 'color' | 'opacity' | 'radius' | 'border-width' | 'shadow';

type ThemeTokenSpec = Readonly<{
  kind: ThemeTokenKind;
  properties: readonly string[];
  max?: number;
}>;

const colorPattern = '^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$';
const opacityPattern = '^(?:100(?:\\.0+)?|\\d{1,2}(?:\\.\\d+)?)%$';
const radiusPattern = '^(?:[0-9]|1\\d|2[0-4])(?:\\.\\d+)?px$';
const borderWidthPattern = '^(?:[0-3](?:\\.\\d+)?|4(?:\\.0+)?)px$';
const shadowColor = '(?:#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*(?:,\\s*(?:0|1|0?\\.\\d+)\\s*)?\\))';
const shadowLength = '(?:0|-?\\d+(?:\\.\\d+)?px)';
const shadowLayer = `(?:inset\\s+)?${shadowLength}(?:\\s+${shadowLength}){1,3}\\s+${shadowColor}`;
const shadowPattern = `^(?:none|${shadowLayer}(?:\\s*,\\s*${shadowLayer})*)$`;
const px = (value: string) => Number(value.slice(0, -2));

export const themeTokenKinds: Readonly<Record<ThemeTokenKind, {
  schema: Readonly<Record<string, unknown>>;
  valid: (value: string, max?: number) => boolean;
}>> = {
  color: {
    schema: { type: 'string', pattern: colorPattern },
    valid: (value) => /^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(value),
  },
  opacity: {
    schema: { type: 'string', pattern: opacityPattern, description: 'Percentage from 0% to 100%.' },
    valid: (value) => /^(?:\d+(?:\.\d+)?)%$/.test(value) && Number(value.slice(0, -1)) <= 100,
  },
  radius: {
    schema: { type: 'string', pattern: radiusPattern, description: 'Corner radius from 0px to 24px.' },
    valid: (value, max = 24) => /^(?:0|[1-9]\d{0,3})(?:\.\d+)?px$/.test(value) && px(value) <= max,
  },
  'border-width': {
    schema: { type: 'string', pattern: borderWidthPattern, description: 'Border width from 0px to 4px.' },
    valid: (value) => /^(?:0|[1-4])(?:\.\d+)?px$/.test(value) && Number(value.slice(0, -2)) <= 4,
  },
  shadow: {
    schema: { type: 'string', pattern: shadowPattern, description: 'none or comma-separated box shadows: [inset] x y [blur] [spread] color.' },
    valid: (value) => new RegExp(shadowPattern).test(value),
  },
};

const color = (properties: readonly string[]): ThemeTokenSpec => ({ kind: 'color', properties });

export const themeTokenDefinitions = {
  windowMaterialWorkspaceOpacity: { kind: 'opacity', properties: ['--theme-window-material-workspace-opacity'] },
  windowMaterialSidebarOpacity: { kind: 'opacity', properties: ['--theme-window-material-sidebar-opacity'] },

  workspaceBackground: color(['--theme-workspace-background', '--bg-secondary', '--color-workspace']),
  surface: color(['--theme-surface', '--bg-primary', '--bg-card', '--color-surface']),
  softSurface: color(['--theme-soft-surface', '--bg-tertiary', '--count-badge-bg', '--color-surface-subtle']),
  hoverBackground: color(['--theme-hover-background', '--bg-hover', '--color-surface-hover']),
  textPrimary: color(['--theme-text-primary', '--text-primary', '--color-text-primary']),
  textSecondary: color(['--theme-text-secondary', '--text-secondary', '--color-text-secondary']),
  textTertiary: color(['--theme-text-tertiary', '--text-tertiary', '--color-text-tertiary']),
  textMuted: color(['--theme-text-muted', '--text-quaternary', '--color-text-muted']),
  border: color(['--theme-border', '--border-color', '--color-border-default']),
  borderSubtle: color(['--theme-border-subtle', '--border-secondary', '--color-border-subtle']),
  borderStrong: color(['--border-primary', '--color-border-strong']),
  borderHover: color(['--border-hover', '--color-border-hover']),
  panelShadow: color(['--theme-panel-shadow-color']),
  accent: color(['--ui-accent', '--primary-color', '--color-accent']),
  accentStrong: color(['--ui-accent-strong', '--color-accent-strong']),
  accentSoft: color(['--ui-accent-soft', '--color-accent-soft']),
  accentContrast: color(['--primary-contrast', '--color-text-on-accent']),
  accentShadow: color(['--ui-accent-shadow', '--color-accent-shadow']),
  focusRing: color(['--ui-focus-ring', '--sidebar-focus', '--color-focus-ring']),
  meterLow: color(['--theme-meter-low']),
  meterMedium: color(['--theme-meter-medium']),
  meterHigh: color(['--theme-meter-high']),
  primaryButtonBackground: color(['--theme-primary-button-background']),
  primaryButtonHoverBackground: color(['--theme-primary-button-hover-background']),
  primaryButtonText: color(['--theme-primary-button-text']),
  primaryButtonBorder: color(['--theme-primary-button-border']),
  primaryButtonHoverBorder: color(['--theme-primary-button-hover-border']),
  controlActiveBackground: color(['--theme-control-active-background']),
  controlActiveThumb: color(['--theme-control-active-thumb']),
  controlThumb: color(['--theme-control-thumb']),
  sidebarBackground: color(['--sidebar-bg']),
  sidebarText: color(['--sidebar-text']),
  sidebarTextStrong: color(['--sidebar-text-strong']),
  sidebarTextMuted: color(['--sidebar-text-subtle', '--sidebar-icon']),
  sidebarBorder: color(['--sidebar-edge', '--sidebar-popover-edge']),
  sidebarHover: color(['--sidebar-hover-bg', '--sidebar-press-bg']),
  sidebarSelected: color(['--sidebar-selected-bg']),
  sidebarSelectedBorder: color(['--sidebar-selected-border-color']),
  sidebarSelectedShadow: color(['--sidebar-selected-shadow-color']),
  popoverBackground: color(['--sidebar-popover-bg', '--theme-overlay-surface']),
  overlaySoftSurface: color(['--theme-overlay-soft-surface']),
  overlayHoverBackground: color([]),
  scrim: color(['--theme-scrim']),

  radiusSmall: { kind: 'radius', properties: ['--radius-sm'], max: 24 },
  radiusMedium: { kind: 'radius', properties: ['--radius-md'], max: 24 },
  radiusLarge: { kind: 'radius', properties: ['--radius-lg'], max: 24 },
  radiusFull: { kind: 'radius', properties: ['--radius-full'], max: 9999 },

  controlBorderWidth: { kind: 'border-width', properties: ['--border-width'] },
  cardBorderWidth: { kind: 'border-width', properties: ['--card-border-width'] },

  shadowExtraSmall: { kind: 'shadow', properties: ['--shadow-xs'] },
  shadowSmall: { kind: 'shadow', properties: ['--shadow-sm'] },
  shadowMedium: { kind: 'shadow', properties: ['--shadow-md'] },
  shadowLarge: { kind: 'shadow', properties: ['--shadow-lg'] },
  shadowPopover: { kind: 'shadow', properties: ['--shadow-popover'] },
  shadowDialog: { kind: 'shadow', properties: ['--shadow-dialog'] },
  shadowSpotlight: { kind: 'shadow', properties: ['--shadow-spotlight'] },
} as const satisfies Record<string, ThemeTokenSpec>;

export type ThemeTokenKey = keyof typeof themeTokenDefinitions;
export type ThemeTokens = Partial<Record<ThemeTokenKey, string>>;

export const themeTokenProperties: Readonly<Record<ThemeTokenKey, readonly string[]>> = Object.fromEntries(
  Object.entries(themeTokenDefinitions).map(([key, definition]) => [key, definition.properties]),
) as Readonly<Record<ThemeTokenKey, readonly string[]>>;

export const themeOpacityTokenProperties = Object.fromEntries(
  Object.entries(themeTokenDefinitions)
    .filter(([, definition]) => definition.kind === 'opacity')
    .map(([key, definition]) => [key, definition.properties]),
) as Readonly<Record<string, readonly string[]>>;

export type ThemeTokenIssueCode = 'unknown-token' | 'invalid-token';
export type ThemeTokenIssue = Readonly<{ field: string; code: ThemeTokenIssueCode }>;

export function isThemeTokenKey(key: string): key is ThemeTokenKey {
  return Object.prototype.hasOwnProperty.call(themeTokenDefinitions, key);
}

export function isValidThemeToken(key: ThemeTokenKey, value: unknown): value is string {
  const definition: ThemeTokenSpec = themeTokenDefinitions[key];
  return typeof value === 'string' && themeTokenKinds[definition.kind].valid(value, definition.max);
}

export function normalizeThemeTokens(
  input: unknown,
  report: (issue: ThemeTokenIssue) => void = () => {},
): ThemeTokens {
  const tokens: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return tokens;
  for (const [key, value] of Object.entries(input)) {
    if (!isThemeTokenKey(key)) {
      report({ field: key, code: 'unknown-token' });
      continue;
    }
    if (!isValidThemeToken(key, value)) {
      report({ field: key, code: 'invalid-token' });
      continue;
    }
    tokens[key] = value;
  }
  return tokens;
}

export function themeTokenSchema(): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.keys(themeTokenDefinitions).map((key) => {
    const definition: ThemeTokenSpec = themeTokenDefinitions[key as ThemeTokenKey];
    const schema = { ...themeTokenKinds[definition.kind].schema };
    if (definition.kind === 'radius' && (definition.max ?? 24) > 24) {
      schema.pattern = '^(?:0|[1-9]\\d{0,3})(?:\\.\\d+)?px$';
      schema.description = 'Corner radius from 0px to 9999px.';
    }
    return [key, schema];
  }));
}
