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
  return findAgentModel(models, previous)?.name ?? models[0]?.name.trim() ?? '';
}
