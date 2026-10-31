import { invoke } from '@tauri-apps/api/core';
import type { UsageTimelinePoint } from './usageTrend';

export type UsageEventPage = {
  items: UsageRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type UsageRecord = {
  id: string;
  row_id: string;
  timestamp: string;
  latency_ms: number;
  ttft_ms: number | null;
  source: string;
  source_display: string;
  failed: boolean;
  canceled: boolean;
  failure_status: number;
  failure_body: string;
  provider: string;
  auth_type?: string;
  model: string;
  /** Model name reported by the upstream response, when available. */
  response_model?: string;
  cost?: { total: number; pricing_model: string } | null;
  alias: string;
  reasoning_effort: string;
  service_tier?: string;
  response_service_tier?: string;
  endpoint: string;
  api_key_hash: string;
  api_key_display: string;
  api_key_remark: string;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_tokens: number;
  };
};

export type UsageEventQuery = {
  start?: string;
  end?: string;
  model?: string;
  provider?: string;
  source?: string;
  upstream?: string;
  api_key_hash?: string;
  failed?: boolean;
  canceled?: boolean;
  page?: number;
  page_size?: number;
};

export type CollectorStatus = {
  state: 'waiting-core' | 'collecting' | 'error';
  message: string;
  lastCollectedAt: string | null;
  totalRecords: number;
};

export type UsageAnalysis = {
  models: UsageCategory[];
  providers: UsageCategory[];
  sources: UsageCategory[];
  apiKeys: UsageCategory[];
  upstreams?: (UsageCategory & { provider: string })[];
};

export type UsageCategory = {
  key: string;
  label: string;
  requests: number;
  failures: number;
  tokens: number;
};

export type UsageQuery = {
  start?: string;
  end?: string;
  model?: string;
  provider?: string;
  source?: string;
  upstream?: string;
  api_key_hash?: string;
  failed?: boolean;
  canceled?: boolean;
  page?: number;
  page_size?: number;
};

export type UsageOverview = {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  canceledCount: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  rpm: number;
  tpm: number;
  tps: number;
  tpsSampleCount: number;
  averageLatencyMs: number;
  cacheHitRate: number;
  estimatedCost: number;
  pricedRequests: number;
  timeline: TimelinePoint[];
};

export type TimelinePoint = UsageTimelinePoint;

export type UsagePricing = {
  rows: UsagePriceRow[];
  totalCost: number;
  totalRequests: number;
  pricedRequests: number;
  savedPrices: number;
};

export type UsagePriceRow = {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  estimatedCost: number;
  price: ModelPrice | null;
};

export type ModelPrice = {
  model: string;
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheCreation: number;
  promptConfigured: boolean;
  completionConfigured: boolean;
  cacheReadConfigured: boolean;
  cacheCreationConfigured: boolean;
  source: string;
  sourceModelId: string;
  updatedAtMs: number;
};

export type UsageStorageSettings = {
  maxDatabaseSizeMb: number;
  databaseSizeBytes: number;
  totalRecords: number;
  deletedRecords: number;
};

export type UsageRepairResult = {
  scanned: number;
  repaired: number;
  deleted: number;
  backupPath: string | null;
};

export type ModelPriceSyncPreview = {
  source: string;
  sourceUrl: string;
  matches: ModelPrice[];
  unmatched: string[];
};

export type ModelPriceSyncResult = {
  imported: number;
};

export const getUsageEvents = (args: { query: UsageEventQuery }): Promise<UsageEventPage> =>
  invoke<UsageEventPage>('get_usage_events', args);

export const saveUsageEventsExport = (args: { path: string; contents: string; }): Promise<void> =>
  invoke<void>('save_usage_events_export', args);

export const getUsageCollectorStatus = (): Promise<CollectorStatus> =>
  invoke<CollectorStatus>('get_usage_collector_status');

export const getUsageAnalysis = (args: { query: UsageQuery }): Promise<UsageAnalysis> =>
  invoke<UsageAnalysis>('get_usage_analysis', args);

export const getUsageOverview = (args: { query: UsageQuery }): Promise<UsageOverview> =>
  invoke<UsageOverview>('get_usage_overview', args);

export const getUsagePricing = (args: { query: UsageQuery }): Promise<UsagePricing> =>
  invoke<UsagePricing>('get_usage_pricing', args);

export const getUsageStorageSettings = (): Promise<UsageStorageSettings> =>
  invoke<UsageStorageSettings>('get_usage_storage_settings');

export const saveUsageStorageSettings = (args: { maxDatabaseSizeMb: number; }): Promise<UsageStorageSettings> =>
  invoke<UsageStorageSettings>('save_usage_storage_settings', args);

export const shrinkUsageDatabase = (args: { targetDatabaseSizeMb: number; }): Promise<UsageStorageSettings> =>
  invoke<UsageStorageSettings>('shrink_usage_database', args);

export const repairUsageCacheRecords = (): Promise<UsageRepairResult> =>
  invoke<UsageRepairResult>('repair_usage_cache_records');

export const saveUsageModelPrice = (args: { price: ModelPrice }): Promise<void> =>
  invoke<void>('save_usage_model_price', args);

export const deleteUsageModelPrice = (args: { model: string; }): Promise<void> =>
  invoke<void>('delete_usage_model_price', args);

export const previewUsageModelPrices = (args: { query: UsageQuery; source: "models-dev" | "litellm"; }): Promise<ModelPriceSyncPreview> =>
  invoke<ModelPriceSyncPreview>('preview_usage_model_prices', args);

export const applyUsageModelPrices = (args: { prices: ModelPrice[]; }): Promise<ModelPriceSyncResult> =>
  invoke<ModelPriceSyncResult>('apply_usage_model_prices', args);
