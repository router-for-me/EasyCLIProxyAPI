import type { AgentModelMappings } from './agentConfigurationDraft';
import type { ModelOption } from './modelService';
import claudeDesktopModelRules from './claudeDesktopModelRules.json';

export type ClaudeDesktopModelMapping = { model: string; alias: string; context1m: boolean };

export const desktopModelId = (entry: ClaudeDesktopModelMapping) => entry.alias.trim() || entry.model.trim();

export const claudeDesktopDefaultAliases = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

export const createDefaultDesktopModels = (): ClaudeDesktopModelMapping[] =>
  claudeDesktopDefaultAliases.map((alias) => ({ model: '', alias, context1m: false }));

export const selectedDesktopModelEntries = (entries: ClaudeDesktopModelMapping[]) =>
  entries.filter((entry) => entry.model.trim());

export const claudeDesktopAliasSuggestions = [
  'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5',
  'claude-opus-4-8', 'claude-opus-4-7',
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
  'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001',
];

export const validClaudeDesktopAlias = (alias: string) => alias.trim().length <= 128
  && /^claude-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(alias.trim())
  && isClaudeDesktopModel(alias);

const modelKey = (id: string) => id.trim().toLowerCase();

const otherModelFamily = new RegExp(claudeDesktopModelRules.otherModelFamilyPattern);

export function isClaudeDesktopModel(id: string) {
  const name = modelKey(id);
  return !/\s/.test(name) && !otherModelFamily.test(name)
    && (name.startsWith('claude-') || /\banthropic[/.]/.test(name)
      || /^(opus|sonnet|haiku|fable|mythos)(-[\d.]+)?$/.test(name));
}

export function desktopEntryValidation(entry: ClaudeDesktopModelMapping) {
  const model = entry.model.trim();
  const alias = entry.alias.trim();
  if (!model) return 'model' as const;
  if (new TextEncoder().encode(model).length > 240 || /[\s\u0000-\u001f\u007f]/.test(model)) return 'modelFormat' as const;
  if (alias && modelKey(alias) !== modelKey(model) && !validClaudeDesktopAlias(alias)) return 'alias' as const;
  return null;
}

export function desktopAliasNotice(
  entry: ClaudeDesktopModelMapping,
  entries: ClaudeDesktopModelMapping[],
  models: ModelOption[],
  appliedEntries: ClaudeDesktopModelMapping[] = [],
) {
  const alias = modelKey(entry.alias);
  if (!alias) return null;
  if (alias === modelKey(entry.model)) return 'sameModel' as const;
  const appliedAlias = appliedEntries.some((applied) => modelKey(applied.alias) === alias
    && applied.model.trim() && modelKey(applied.model) !== alias);
  if (models.some((model) => modelKey(model.name) === alias && (!model.isAlias || !appliedAlias))
    || entries.some((other) => modelKey(other.model) === alias)) return 'aliasExists' as const;
  return null;
}

export function desktopModelEntries(mappings: AgentModelMappings): ClaudeDesktopModelMapping[] {
  if (mappings.desktopModels) return mappings.desktopModels.map((entry) => {
    const model = entry.model.trim() || entry.alias.trim();
    return { ...entry, model, alias: modelKey(entry.alias) === modelKey(model) ? '' : entry.alias };
  });
  const aliases = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
  const entries = (['opus', 'sonnet', 'haiku'] as const).flatMap((role, index) => {
    const model = mappings[role];
    if (!model) return [];
    return [{ model, alias: isClaudeDesktopModel(model) ? '' : aliases[index], context1m: Boolean(mappings[`${role}1m`]) }];
  });
  const unique: ClaudeDesktopModelMapping[] = [];
  for (const entry of entries) {
    const existing = unique.find((other) => desktopModelId(other) === desktopModelId(entry));
    if (existing) existing.context1m ||= entry.context1m;
    else unique.push(entry);
  }
  return unique;
}

export function desktopModelValidation(
  entries: ClaudeDesktopModelMapping[],
  models: ModelOption[],
  appliedEntries: ClaudeDesktopModelMapping[] = [],
) {
  const selectedEntries = selectedDesktopModelEntries(entries);
  if (!selectedEntries.length) return 'empty' as const;
  for (const entry of selectedEntries) {
    const error = desktopEntryValidation(entry);
    if (error) return error;
  }
  const aliases = selectedEntries.map((entry) => desktopModelId(entry).toLowerCase());
  if (new Set(aliases).size !== aliases.length) return 'duplicate' as const;
  if (selectedEntries.some((entry) => desktopAliasNotice(entry, selectedEntries, models, appliedEntries) === 'aliasExists')) return 'aliasExists' as const;
  return null;
}
