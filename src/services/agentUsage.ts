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
  timestamp?: string;
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
  events?: AgentUsageDaily[];
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
  return parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

const costValue = (value: unknown, ...keys: string[]): number => {
  const parsed = readNumber(value, ...keys);
  return parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const optionalCostValue = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : readNumber(value);
  return parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) throw new Error('Agent usage date is invalid');
  const models = Array.isArray(value.models) ? value.models.map(normalizeModel) : [];
  return {
    date,
    ...(typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp)) ? { timestamp: value.timestamp } : {}),
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
    ...(Array.isArray(value.events) ? { events: value.events.map(normalizeDaily) } : {}),
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
  const modelDays = new Map<string, Set<string>>();
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
    const days = modelDays.get(key) ?? new Set<string>();
    days.add(daily.date);
    modelDays.set(key, days);
    current.days = days.size;
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

export const AGENT_USAGE_TIME_RANGES = ['today', '24h', '7d', '30d', 'all'] as const;
export type AgentUsageTimeRange = (typeof AGENT_USAGE_TIME_RANGES)[number];

export function formatAgentUsageNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number.isFinite(value) ? value : 0);
}

export function filterAgentUsageReport(
  report: AgentUsageReport,
  range: AgentUsageTimeRange,
  source = '',
  now = new Date(),
): AgentUsageReport {
  const start = new Date(now);
  if (range === '24h') start.setTime(start.getTime() - 24 * 60 * 60 * 1000);
  else if (range === '7d') start.setDate(start.getDate() - 6);
  else if (range === '30d') start.setDate(start.getDate() - 29);
  const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const firstDate = dateKey(start);
  const lastDate = dateKey(now);
  return {
    ...report,
    sources: report.sources.filter((row) => !source || row.source === source).map((row) => ({
      ...row,
      daily: (row.events?.length ? row.events : row.daily).filter((day) => {
        if (day.timestamp) {
          const time = new Date(day.timestamp);
          if (range === 'all') return true;
          if (range === '24h') return time >= start && time <= now;
          const date = dateKey(time);
          return date >= firstDate && date <= lastDate;
        }
        return range === 'all' || (day.date >= firstDate && day.date <= lastDate);
      }).map((day) => day.timestamp ? { ...day, date: dateKey(new Date(day.timestamp)) } : day),
    })),
  };
}

export function estimateAgentUsageDailyCost(row: AgentUsageDaily, pricing: UsagePricing | null): number {
  if (!row.models.length) return row.costUSD;
  const costs = row.models.map((model) => estimateAgentUsageModelCost(model, pricing) ?? model.costUSD);
  if (costs.every((cost) => cost === null)) return row.costUSD;
  return costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
}
