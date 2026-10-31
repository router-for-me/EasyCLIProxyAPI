import { invoke } from '@tauri-apps/api/core';
import { isRecord, readNumber, readString } from './managementApi';
import type { ModelPrice, UsagePricing } from './usage';

export type AgentUsageModel = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUSD: number | null;
};

export type AgentUsageDaily = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUSD: number;
  models: AgentUsageModel[];
};

export type AgentUsageSource = {
  source: string;
  status: 'ok' | 'empty' | 'error';
  error: string;
  daily: AgentUsageDaily[];
};

export type AgentUsageReport = {
  schemaVersion: number;
  generatedAt: string;
  sources: AgentUsageSource[];
};

export type AgentUsagePriceRow = {
  model: string;
  days: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  recordedCostUSD: number | null;
  price: ModelPrice | null;
  estimatedCostUSD: number | null;
};

const tokenValue = (value: unknown, ...keys: string[]): number => {
  const parsed = readNumber(value, ...keys);
  return parsed !== null && parsed >= 0 ? Math.floor(parsed) : 0;
};

const costValue = (value: unknown, ...keys: string[]): number => {
  const parsed = readNumber(value, ...keys);
  return parsed !== null && parsed >= 0 ? parsed : 0;
};

const optionalCostValue = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : readNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
};

const normalizeModel = (value: unknown): AgentUsageModel => {
  if (!isRecord(value)) throw new Error('Invalid Agent usage model row');
  const model = readString(value, 'model');
  if (!model) throw new Error('Agent usage model is missing');
  return {
    model,
    inputTokens: tokenValue(value, 'inputTokens'),
    outputTokens: tokenValue(value, 'outputTokens'),
    cacheCreationTokens: tokenValue(value, 'cacheCreationTokens'),
    cacheReadTokens: tokenValue(value, 'cacheReadTokens'),
    reasoningTokens: tokenValue(value, 'reasoningOutputTokens', 'reasoningTokens'),
    totalTokens: tokenValue(value, 'totalTokens'),
    costUSD: optionalCostValue(value.costUSD),
  };
};

const normalizeDaily = (value: unknown): AgentUsageDaily => {
  if (!isRecord(value)) throw new Error('Invalid Agent usage daily row');
  const date = readString(value, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Agent usage date is invalid');
  const models = Array.isArray(value.models) ? value.models.map(normalizeModel) : [];
  return {
    date,
    inputTokens: tokenValue(value, 'inputTokens'),
    outputTokens: tokenValue(value, 'outputTokens'),
    cacheCreationTokens: tokenValue(value, 'cacheCreationTokens'),
    cacheReadTokens: tokenValue(value, 'cacheReadTokens'),
    reasoningTokens: tokenValue(value, 'reasoningOutputTokens', 'reasoningTokens'),
    totalTokens: tokenValue(value, 'totalTokens'),
    costUSD: costValue(value, 'costUSD', 'totalCost'),
    models,
  };
};

const normalizeSource = (value: unknown): AgentUsageSource => {
  if (!isRecord(value)) throw new Error('Invalid Agent usage source');
  const source = readString(value, 'source');
  if (!source) throw new Error('Agent usage source is missing');
  const status = readString(value, 'status');
  if (status !== 'ok' && status !== 'empty' && status !== 'error') throw new Error('Agent usage status is invalid');
  return {
    source,
    status,
    error: readString(value, 'error'),
    daily: Array.isArray(value.daily) ? value.daily.map(normalizeDaily) : [],
  };
};

export function normalizeAgentUsageReport(value: unknown): AgentUsageReport {
  if (!isRecord(value) || !Array.isArray(value.sources)) throw new Error('Invalid Agent usage report');
  return {
    schemaVersion: tokenValue(value, 'schemaVersion'),
    generatedAt: readString(value, 'generatedAt'),
    sources: value.sources.map(normalizeSource),
  };
}

function priceForModel(model: string, pricing: UsagePricing | null): ModelPrice | null {
  if (!pricing) return null;
  const key = model.trim().toLowerCase();
  return pricing.rows.find((row) => {
    const rowModel = row.model.trim().toLowerCase();
    const sourceModel = row.price?.sourceModelId.trim().toLowerCase();
    return rowModel === key || sourceModel === key;
  })?.price ?? null;
}

function estimatedCostForModel(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  price: ModelPrice | null,
): number | null {
  if (!price) return null;
  return (
    inputTokens * price.prompt
    + outputTokens * price.completion
    + cacheReadTokens * price.cacheRead
    + cacheCreationTokens * price.cacheCreation
  ) / 1_000_000;
}

export function buildAgentUsagePriceRows(
  report: AgentUsageReport,
  pricing: UsagePricing | null,
): AgentUsagePriceRow[] {
  const rows = new Map<string, Omit<AgentUsagePriceRow, 'price' | 'estimatedCostUSD'>>();
  report.sources.forEach((source) => source.daily.forEach((daily) => daily.models.forEach((model) => {
    const name = model.model.trim();
    if (!name) return;
    const key = name.toLowerCase();
    const current = rows.get(key) ?? {
      model: name,
      days: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      recordedCostUSD: null,
    };
    current.days += 1;
    current.inputTokens += model.inputTokens;
    current.outputTokens += model.outputTokens;
    current.cacheReadTokens += model.cacheReadTokens;
    current.cacheCreationTokens += model.cacheCreationTokens;
    current.totalTokens += model.totalTokens;
    if (model.costUSD !== null) current.recordedCostUSD = (current.recordedCostUSD ?? 0) + model.costUSD;
    rows.set(key, current);
  })));

  return [...rows.values()]
    .map((row) => {
      const price = priceForModel(row.model, pricing);
      return {
        ...row,
        price,
        estimatedCostUSD: estimatedCostForModel(
          row.inputTokens,
          row.outputTokens,
          row.cacheReadTokens,
          row.cacheCreationTokens,
          price,
        ),
      };
    })
    .sort((left, right) => {
      const leftPriced = left.price ? 1 : 0;
      const rightPriced = right.price ? 1 : 0;
      return rightPriced - leftPriced
        || right.totalTokens - left.totalTokens
        || left.model.localeCompare(right.model);
    });
}

export function estimateAgentUsageModelCost(
  model: AgentUsageModel,
  pricing: UsagePricing | null,
): number | null {
  return estimatedCostForModel(
    model.inputTokens,
    model.outputTokens,
    model.cacheReadTokens,
    model.cacheCreationTokens,
    priceForModel(model.model, pricing),
  );
}

export const getAgentUsage = (_refresh = false): Promise<AgentUsageReport> =>
  invoke<unknown>('get_agent_usage').then(normalizeAgentUsageReport);
