import { desktopEntryValidation, desktopModelId, isClaudeDesktopModel, validClaudeDesktopAlias, type ClaudeDesktopModelMapping } from './claudeDesktopModels';
export const PRESET_LIMIT = 256 * 1024;
const format = 'tim-ai-hub.desktop-models';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
export function parseDesktopModelPreset(text: string): ClaudeDesktopModelMapping[] {
  if (new TextEncoder().encode(text).length > PRESET_LIMIT) throw new Error('invalid');
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!object(value) || !keysOnly(value, ['format', 'version', 'client', 'models'])
    || value.format !== format || value.version !== 1 || value.client !== 'claude-desktop'
    || !Array.isArray(value.models) || !value.models.length || value.models.length > 100) throw new Error('invalid');
  const ids = new Set<string>();
  return value.models.map((row) => {
    if (!object(row) || !keysOnly(row, ['model', 'alias', 'context1m']) || typeof row.model !== 'string'
      || typeof row.alias !== 'string' || typeof row.context1m !== 'boolean') throw new Error('invalid');
    const entry = { model: row.model.trim(), alias: row.alias.trim(), context1m: row.context1m };
    if (desktopEntryValidation(entry) || (!isClaudeDesktopModel(entry.model) && !validClaudeDesktopAlias(entry.alias))) throw new Error('invalid');
    const id = desktopModelId(entry).toLowerCase();
    if (ids.has(id)) throw new Error('invalid');
    ids.add(id);
    return entry;
  });
}
export function exportDesktopModelPreset(entries: ClaudeDesktopModelMapping[]) {
  const preset = { format, version: 1, client: 'claude-desktop', models: entries.filter((entry) => entry.model.trim()).map(({ model, alias, context1m }) => ({ model: model.trim(), alias: alias.trim(), context1m })) };
  const text = JSON.stringify(preset, null, 2) + '\n';
  parseDesktopModelPreset(text);
  return text;
}
