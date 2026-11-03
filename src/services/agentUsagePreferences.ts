import { usagePreferences } from './usagePreferences';

export const AGENT_USAGE_REFRESH_INTERVAL_KEY = 'cpa-gui.usage-agent-refresh-interval.v1';
export const DEFAULT_AGENT_USAGE_REFRESH_INTERVAL = 300_000;

export const AGENT_USAGE_REFRESH_INTERVALS = [0, 300_000, 900_000, 1_800_000, 3_600_000] as const;

export type AgentUsageRefreshInterval = (typeof AGENT_USAGE_REFRESH_INTERVALS)[number];

export function loadAgentUsageRefreshInterval(): AgentUsageRefreshInterval {
  const stored = usagePreferences.getItem(AGENT_USAGE_REFRESH_INTERVAL_KEY);
  if (stored === null || stored.trim() === '') return DEFAULT_AGENT_USAGE_REFRESH_INTERVAL;
  const value = Number(stored);
  return AGENT_USAGE_REFRESH_INTERVALS.includes(value as AgentUsageRefreshInterval)
    ? value as AgentUsageRefreshInterval
    : DEFAULT_AGENT_USAGE_REFRESH_INTERVAL;
}

export function saveAgentUsageRefreshInterval(value: AgentUsageRefreshInterval) {
  usagePreferences.setItem(AGENT_USAGE_REFRESH_INTERVAL_KEY, String(value));
}

export function shouldSyncAgentUsageOnOpen(interval: AgentUsageRefreshInterval, lastSyncAt?: string): boolean {
  return interval !== 0 || !lastSyncAt;
}
