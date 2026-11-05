import { invoke } from '@tauri-apps/api/core';
import { isRecord, readNumber, readString } from './managementApi';

export type AgentUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUSD: number;
  samples: number;
  days: number;
};

export type AgentUsageModelRow = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUSD: number;
  priced: boolean;
  prompt: number | null;
  completion: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  days: number;
};

export type AgentUsageBucketRow = {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUSD: number;
  samples: number;
};

export type AgentUsageSource = {
  source: string;
  status: 'ok' | 'empty' | 'error' | 'archived';
  archivedAt: string;
  error: string;
  totals: AgentUsageTotals;
  models: AgentUsageModelRow[];
  series: AgentUsageBucketRow[];
};

export type AgentUsageCalendarRow = {
  date: string;
  totalTokens: number;
  costUSD: number;
};

export type AgentUsageHourRow = {
  weekday: number;
  hour: number;
  totalTokens: number;
  samples: number;
};

export type AgentUsagePeriodTotals = {
  totalTokens: number;
  costUSD: number;
};

export type AgentUsageReport = {
  schemaVersion: number;
  generatedAt: string;
  lastSyncAt: string;
  syncing: boolean;
  bucket: 'hour' | 'day' | 'week' | 'month';
  rangeStart: string;
  rangeEnd: string;
  totals: AgentUsageTotals;
  previous: AgentUsagePeriodTotals | null;
  sources: AgentUsageSource[];
  timeline: AgentUsageBucketRow[];
  calendar: AgentUsageCalendarRow[];
  hourly: AgentUsageHourRow[];
};

export type AgentUsageSyncResult = {
  skipped: boolean;
  changedFiles: number;
  scannedFiles: number;
  durationMs: number;
  lastSyncAt: string;
};

export type AgentUsageSyncProgress = {
  source: string;
  scanned: number;
  total: number;
  finished: boolean;
};

export type AgentUsageStorage = {
  databaseSizeBytes: number;
  dailyRows: number;
  hourlyRows: number;
  fileRows: number;
  lastSyncAt: string;
};

export const AGENT_USAGE_TIME_RANGES = ['today', '7d', '30d', 'all', 'custom'] as const;
export type AgentUsageTimeRange = (typeof AGENT_USAGE_TIME_RANGES)[number];

export const AGENT_USAGE_GRANULARITIES = ['hour', 'day', 'week', 'month'] as const;
export type AgentUsageGranularity = (typeof AGENT_USAGE_GRANULARITIES)[number];

export const AGENT_USAGE_METRICS = ['totalTokens', 'costUSD'] as const;
export type AgentUsageMetric = (typeof AGENT_USAGE_METRICS)[number];

export const AGENT_USAGE_GROUP_BY = ['source', 'model'] as const;
export type AgentUsageGroupBy = (typeof AGENT_USAGE_GROUP_BY)[number];

export const AGENT_USAGE_HOURLY_DAYS = 30;

export const AGENT_USAGE_PRESETS = ['yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'last90Days', 'thisYear', 'lastYear'] as const;
export type AgentUsagePreset = (typeof AGENT_USAGE_PRESETS)[number];

export type AgentUsageDateRange = { start: string; end: string };

export const agentUsageDay = (date: Date): string => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-');

export function agentUsagePresetRange(preset: AgentUsagePreset, now: Date): AgentUsageDateRange {
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  const day = (offset: number) => new Date(year, month, date + offset);
  const monday = -((now.getDay() + 6) % 7);
  const ranges: Record<AgentUsagePreset, [Date, Date]> = {
    yesterday: [day(-1), day(-1)],
    thisWeek: [day(monday), day(0)],
    lastWeek: [day(monday - 7), day(monday - 1)],
    thisMonth: [new Date(year, month, 1), day(0)],
    lastMonth: [new Date(year, month - 1, 1), new Date(year, month, 0)],
    last90Days: [day(-89), day(0)],
    thisYear: [new Date(year, 0, 1), day(0)],
    lastYear: [new Date(year - 1, 0, 1), new Date(year - 1, 11, 31)],
  };
  const [start, end] = ranges[preset];
  return { start: agentUsageDay(start), end: agentUsageDay(end) };
}

export function agentUsageHourAvailable(range: AgentUsageTimeRange, start: string, now: Date): boolean {
  if (range === 'all') return false;
  if (range !== 'custom') return true;
  return start > agentUsageDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - AGENT_USAGE_HOURLY_DAYS));
}

export function rangeGranularity(current: AgentUsageGranularity | '', hourAvailable: boolean): AgentUsageGranularity | '' {
  return !hourAvailable && current === 'hour' ? 'day' : current;
}

export type AgentUsageQuery = {
  range: AgentUsageTimeRange;
  sources?: string[];
  groupBy?: AgentUsageGroupBy;
  granularity?: AgentUsageGranularity | '';
  start?: string;
  end?: string;
};

const tokenValue = (value: unknown, ...keys: string[]): number => {
  const parsed = readNumber(value, ...keys);
  return parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

const costValue = (value: unknown, ...keys: string[]): number => {
  const parsed = readNumber(value, ...keys);
  return parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const optionalNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : readNumber(value);
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
};

const normalizeTotals = (value: unknown): AgentUsageTotals => {
  if (!isRecord(value)) throw new Error('Invalid Agent usage totals');
  return {
    inputTokens: tokenValue(value, 'inputTokens'),
    outputTokens: tokenValue(value, 'outputTokens'),
    cacheCreationTokens: tokenValue(value, 'cacheCreationTokens'),
    cacheReadTokens: tokenValue(value, 'cacheReadTokens'),
    reasoningTokens: tokenValue(value, 'reasoningOutputTokens', 'reasoningTokens'),
    totalTokens: tokenValue(value, 'totalTokens'),
    costUSD: costValue(value, 'costUSD'),
    samples: tokenValue(value, 'samples'),
    days: tokenValue(value, 'days'),
  };
};

const normalizeBucket = (value: unknown): AgentUsageBucketRow => {
  if (!isRecord(value)) throw new Error('Invalid Agent usage series row');
  const bucket = readString(value, 'bucket');
  if (!bucket) throw new Error('Agent usage series bucket is missing');
  return {
    bucket,
    inputTokens: tokenValue(value, 'inputTokens'),
    outputTokens: tokenValue(value, 'outputTokens'),
    cacheCreationTokens: tokenValue(value, 'cacheCreationTokens'),
    cacheReadTokens: tokenValue(value, 'cacheReadTokens'),
    reasoningTokens: tokenValue(value, 'reasoningOutputTokens', 'reasoningTokens'),
    totalTokens: tokenValue(value, 'totalTokens'),
    costUSD: costValue(value, 'costUSD'),
    samples: tokenValue(value, 'samples'),
  };
};

const normalizeModel = (value: unknown): AgentUsageModelRow => {
  if (!isRecord(value)) throw new Error('Invalid Agent usage model row');
  const model = readString(value, 'model');
  return {
    model,
    inputTokens: tokenValue(value, 'inputTokens'),
    outputTokens: tokenValue(value, 'outputTokens'),
    cacheCreationTokens: tokenValue(value, 'cacheCreationTokens'),
    cacheReadTokens: tokenValue(value, 'cacheReadTokens'),
    reasoningTokens: tokenValue(value, 'reasoningOutputTokens', 'reasoningTokens'),
    totalTokens: tokenValue(value, 'totalTokens'),
    costUSD: costValue(value, 'costUSD'),
    priced: value.priced === true,
    prompt: optionalNumber(value.prompt),
    completion: optionalNumber(value.completion),
    cacheRead: optionalNumber(value.cacheRead),
    cacheCreation: optionalNumber(value.cacheCreation),
    days: tokenValue(value, 'days'),
  };
};

const normalizeSource = (value: unknown): AgentUsageSource => {
  if (!isRecord(value)) throw new Error('Invalid Agent usage source');
  const source = readString(value, 'source');
  if (!source) throw new Error('Agent usage source is missing');
  const status = readString(value, 'status');
  if (status !== 'ok' && status !== 'empty' && status !== 'error' && status !== 'archived') {
    throw new Error('Agent usage status is invalid');
  }
  return {
    source,
    status,
    archivedAt: readString(value, 'archivedAt'),
    error: readString(value, 'error'),
    totals: normalizeTotals(value.totals),
    models: Array.isArray(value.models) ? value.models.map(normalizeModel) : [],
    series: Array.isArray(value.series) ? value.series.map(normalizeBucket) : [],
  };
};

export function normalizeAgentUsageReport(value: unknown): AgentUsageReport {
  if (!isRecord(value) || !Array.isArray(value.sources) || !Array.isArray(value.timeline)) {
    throw new Error('Invalid Agent usage report');
  }
  const bucket = readString(value, 'bucket');
  if (bucket !== 'hour' && bucket !== 'day' && bucket !== 'week' && bucket !== 'month') {
    throw new Error('Agent usage bucket is invalid');
  }
  return {
    schemaVersion: tokenValue(value, 'schemaVersion'),
    generatedAt: readString(value, 'generatedAt'),
    lastSyncAt: readString(value, 'lastSyncAt'),
    syncing: value.syncing === true,
    bucket,
    rangeStart: readString(value, 'rangeStart'),
    rangeEnd: readString(value, 'rangeEnd'),
    totals: normalizeTotals(value.totals),
    previous: isRecord(value.previous)
      ? { totalTokens: tokenValue(value.previous, 'totalTokens'), costUSD: costValue(value.previous, 'costUSD') }
      : null,
    sources: value.sources.map(normalizeSource),
    timeline: value.timeline.map(normalizeBucket),
    calendar: Array.isArray(value.calendar)
      ? value.calendar.flatMap((row) => {
        if (!isRecord(row)) return [];
        const date = readString(row, 'date');
        return date ? [{ date, totalTokens: tokenValue(row, 'totalTokens'), costUSD: costValue(row, 'costUSD') }] : [];
      })
      : [],
    hourly: Array.isArray(value.hourly)
      ? value.hourly.flatMap((row) => {
        if (!isRecord(row)) return [];
        return [{
          weekday: tokenValue(row, 'weekday'),
          hour: tokenValue(row, 'hour'),
          totalTokens: tokenValue(row, 'totalTokens'),
          samples: tokenValue(row, 'samples'),
        }];
      })
      : [],
  };
}

const normalizeSyncResult = (value: unknown): AgentUsageSyncResult => {
  if (!isRecord(value)) throw new Error('Invalid Agent usage sync result');
  return {
    skipped: value.skipped === true,
    changedFiles: tokenValue(value, 'changedFiles'),
    scannedFiles: tokenValue(value, 'scannedFiles'),
    durationMs: tokenValue(value, 'durationMs'),
    lastSyncAt: readString(value, 'lastSyncAt'),
  };
};

const normalizeStorage = (value: unknown): AgentUsageStorage => {
  if (!isRecord(value)) throw new Error('Invalid Agent usage storage');
  return {
    databaseSizeBytes: tokenValue(value, 'databaseSizeBytes'),
    dailyRows: tokenValue(value, 'dailyRows'),
    hourlyRows: tokenValue(value, 'hourlyRows'),
    fileRows: tokenValue(value, 'fileRows'),
    lastSyncAt: readString(value, 'lastSyncAt'),
  };
};

export const getAgentUsage = (query: AgentUsageQuery): Promise<AgentUsageReport> =>
  invoke<unknown>('get_agent_usage', { query }).then(normalizeAgentUsageReport);

export const syncAgentUsage = (): Promise<AgentUsageSyncResult> =>
  invoke<unknown>('sync_agent_usage').then(normalizeSyncResult);

export const getAgentUsageStorage = (): Promise<AgentUsageStorage> =>
  invoke<unknown>('get_agent_usage_storage').then(normalizeStorage);

export const clearAgentUsageHistory = (): Promise<void> =>
  invoke<void>('clear_agent_usage_history');

export function formatAgentUsageNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number.isFinite(value) ? value : 0);
}

const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatAgentUsageCompact(value: number): string {
  return compactFormatter.format(Number.isFinite(value) ? value : 0);
}

export function formatAgentUsageBucket(bucket: string, kind: AgentUsageReport['bucket']): string {
  if (kind === 'hour') {
    const [date, hour] = bucket.split('T');
    return `${date} ${hour}:00`;
  }
  return bucket;
}

export function formatAgentUsageAxisLabel(bucket: string, kind: AgentUsageReport['bucket'], previous?: string): string {
  if (kind !== 'month' && previous && previous.slice(0, 4) !== bucket.slice(0, 4)) return formatAgentUsageBucket(bucket, kind);
  if (kind === 'hour') {
    const [date, hour] = bucket.split('T');
    return `${date.slice(5)} ${hour}:00`;
  }
  if (kind === 'month') return bucket;
  return bucket.slice(5);
}
