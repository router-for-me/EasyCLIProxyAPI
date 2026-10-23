import { builtinThemes, normalizeTheme } from './registry';
import type { ThemeDefinition, ThemeIssue } from './types';

export type CustomThemeFile = { folder: string; content: string | null; backdropImage?: string };
export type CustomThemeList = { files: CustomThemeFile[]; omitted: number };
export type CustomThemeSkipReason = 'unreadable' | 'invalid-json' | 'unsupported-version' | 'invalid-metadata' | 'duplicate-id';
export type SkippedCustomTheme = { folder: string; reason: CustomThemeSkipReason };
export type CustomThemeDiagnostic = { folder: string; issues: readonly ThemeIssue[] };
export type CustomThemes = { themes: ThemeDefinition[]; skipped: SkippedCustomTheme[]; diagnostics: CustomThemeDiagnostic[] };

const allowedKeys = new Set(['$schema', 'schemaVersion', 'id', 'name', 'description', 'appearance', 'windowBackground', 'windowMaterial', 'icon', 'assets', 'tokens', 'backdrop']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function parseCustomTheme(record: Record<string, unknown>, order: number, issues: ThemeIssue[], backdropImage?: string): ThemeDefinition {
  if (Object.keys(record).some((key) => !allowedKeys.has(key))
    || record.name === undefined || typeof record.windowBackground !== 'string'
    || (record.$schema !== undefined && typeof record.$schema !== 'string')
    || !isRecord(record.tokens)) {
    throw new Error('Invalid custom theme');
  }
  const { $schema: _schema, schemaVersion: _version, ...definition } = record;
  return normalizeTheme({ ...definition, order, backdropImage } as ThemeDefinition, (issue) => issues.push(issue));
}

export function parseCustomThemes(files: readonly CustomThemeFile[], builtins: readonly ThemeDefinition[] = builtinThemes): CustomThemes {
  const ids = new Set(builtins.map((theme) => theme.id));
  const first = Math.max(...builtins.map((theme) => theme.order)) + 1;
  const themes: ThemeDefinition[] = [];
  const skipped: SkippedCustomTheme[] = [];
  const diagnostics: CustomThemeDiagnostic[] = [];
  for (const file of files) {
    if (file.content === null) {
      skipped.push({ folder: file.folder, reason: 'unreadable' });
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(file.content);
    } catch {
      skipped.push({ folder: file.folder, reason: 'invalid-json' });
      continue;
    }
    if (!isRecord(record)) {
      skipped.push({ folder: file.folder, reason: 'invalid-metadata' });
      continue;
    }
    if ((record.schemaVersion ?? 1) !== 1) {
      skipped.push({ folder: file.folder, reason: 'unsupported-version' });
      continue;
    }
    const issues: ThemeIssue[] = [];
    let theme: ThemeDefinition;
    try {
      theme = parseCustomTheme(record, first + themes.length, issues, file.backdropImage);
    } catch {
      skipped.push({ folder: file.folder, reason: 'invalid-metadata' });
      continue;
    }
    if (ids.has(theme.id)) {
      skipped.push({ folder: file.folder, reason: 'duplicate-id' });
      continue;
    }
    ids.add(theme.id);
    themes.push(theme);
    if (issues.length) diagnostics.push({ folder: file.folder, issues });
  }
  return { themes, skipped, diagnostics };
}
