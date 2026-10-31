import type { AppLocale } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { themeOpacityTokenProperties, themeTokenProperties, type ThemeTokenKey, type ThemeTokens } from './tokenContract';

export { themeOpacityTokenProperties, themeTokenProperties };
export type { ThemeTokenKey, ThemeTokens };

export type ThemeAppearance = 'light' | 'dark';
export type ThemePreference = string;

export type ThemeGradientStop = Readonly<{ color: string; at: number }>;
export type ThemeGradient = Readonly<(
  | { kind: 'linear'; angle: number }
  | { kind: 'radial'; center: readonly [number, number]; size: readonly [number, number] }
) & { stops: readonly ThemeGradientStop[] }>;
export type ThemeBackdrop = Readonly<{
  layers: readonly ThemeGradient[];
  sidebar: string;
  panel: string;
  inset?: string;
  hover?: string;
  imagePosition?: readonly [number, number];
}>;
export type ThemePreview = { background: string; sidebar: string; surface: string; accent: string };
export type ThemeWindowMaterial = 'solid' | 'translucent';
export type PlatformWindowMaterial = 'liquid-glass' | 'vibrancy' | 'mica' | 'acrylic';
export type ThemeLabel = string | Readonly<Partial<Record<AppLocale, string>>>;
export type ThemeDefinition = {
  schemaVersion?: number;
  id: string;
  nameKey?: MessageKey;
  descriptionKey?: MessageKey;
  name?: ThemeLabel;
  description?: ThemeLabel;
  appearance: ThemeAppearance;
  order: number;
  windowBackground: string;
  windowMaterial?: ThemeWindowMaterial;
  icon?: string;
  assets?: Readonly<Record<string, string>>;
  backdropImage?: string;
  tokens: Readonly<ThemeTokens>;
  backdrop?: ThemeBackdrop;
};

export type ThemeIssueCode = 'unknown-token' | 'invalid-token' | 'invalid-icon' | 'invalid-asset';
export type ThemeIssue = Readonly<{ field: string; code: ThemeIssueCode }>;

export type SystemThemes = Readonly<Record<ThemeAppearance, string>>;
export type ThemeSelection = {
  version: 1;
  selectedId: string;
  lastLightId?: string;
  lastDarkId?: string;
};
export const isThemeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);

const themeLabelLocales: readonly AppLocale[] = ['zh-CN', 'zh-TW', 'ja', 'en'];
const isLabelText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 80;

export function isThemeLabel(value: unknown): value is ThemeLabel {
  if (isLabelText(value)) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([locale, text]) =>
    themeLabelLocales.includes(locale as AppLocale) && isLabelText(text));
}

export function localizeThemeLabel(label: ThemeLabel, locale: AppLocale): string {
  if (typeof label === 'string') return label;
  return label[locale] ?? (locale === 'zh-TW' ? label['zh-CN'] : undefined) ?? label.en ?? Object.values(label)[0]!;
}

export function isThemeSelection(value: unknown): value is ThemeSelection {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && isThemeId(record.selectedId)
    && ['lastLightId', 'lastDarkId'].every((key) =>
      record[key] === undefined || (isThemeId(record[key]) && record[key] !== 'system'));
}
