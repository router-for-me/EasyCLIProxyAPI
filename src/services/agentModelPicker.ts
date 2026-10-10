import type { ModelOption } from './modelService';

const normalized = (value: string) => value.trim().toLocaleLowerCase();

const matchScore = (model: ModelOption, query: string) => {
  const name = normalized(model.name);
  const alias = normalized(model.alias ?? '');
  if (!query) return 10;
  if (name === query) return 0;
  if (alias === query) return 1;
  if (name.startsWith(query)) return 2;
  if (alias.startsWith(query)) return 3;
  if (name.includes(query)) return 4;
  if (alias.includes(query)) return 5;
  return Number.POSITIVE_INFINITY;
};

export function filterAgentModels(models: ModelOption[], search: string): ModelOption[] {
  const query = normalized(search);
  return models
    .map((model, index) => ({ model, index, score: matchScore(model, query) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => (
      left.score - right.score
      || left.model.name.localeCompare(right.model.name, undefined, { sensitivity: 'base' })
      || left.index - right.index
    ))
    .map((item) => item.model);
}

const aliasedSourceNames = (models: ModelOption[]) => {
  const names = new Set<string>();
  for (const model of models) {
    if (!model.isAlias) continue;
    const source = normalized(model.alias ?? '');
    if (source) names.add(source);
  }
  return names;
};

export function filterAgentModelsByAlias(
  models: ModelOption[],
  aliasesOnly: boolean,
): ModelOption[] {
  if (aliasesOnly) return models.filter((model) => Boolean(model.isAlias));
  const aliasedSources = aliasedSourceNames(models);
  return models.filter((model) => !model.isAlias && !aliasedSources.has(normalized(model.name)));
}

export function resolveAgentModelForAliasMode(
  models: ModelOption[],
  current: string,
  aliasesOnly: boolean,
): string {
  const candidates = filterAgentModelsByAlias(models, aliasesOnly);
  const selected = findAgentModel(models, current);
  if (selected && candidates.some((candidate) => normalized(candidate.name) === normalized(selected.name))) {
    return selected.name;
  }

  if (selected && aliasesOnly) {
    const alias = candidates.find((candidate) => normalized(candidate.alias ?? '') === normalized(selected.name));
    if (alias) return alias.name;
  }
  if (selected?.isAlias && !aliasesOnly) {
    const original = candidates.find((candidate) => normalized(candidate.name) === normalized(selected.alias ?? ''));
    if (original) return original.name;
  }
  return candidates[0]?.name ?? '';
}

export function hasExactAgentModel(models: ModelOption[], value: string): boolean {
  const query = normalized(value);
  if (!query) return false;
  return models.some((model) => (
    normalized(model.name) === query || normalized(model.alias ?? '') === query
  ));
}

export function agentModelAlias(models: ModelOption[], value: string): string {
  const query = normalized(value);
  return models.find((model) => normalized(model.name) === query)?.alias ?? '';
}

export function findAgentModel(models: ModelOption[], value: string): ModelOption | null {
  const query = normalized(value);
  if (!query) return null;
  return models.find((model) => normalized(model.name) === query) ?? null;
}

export function resolveAgentModelSelection(models: ModelOption[], previous: string): string {
  // A refresh may temporarily omit a model; only default when no choice exists.
  return findAgentModel(models, previous)?.name ?? (previous.trim() || models[0]?.name.trim() || '');
}
