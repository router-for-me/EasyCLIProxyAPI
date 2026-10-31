import { usagePreferences } from './usagePreferences';

export const AGENT_USAGE_REFRESH_INTERVAL_KEY = 'cpa-gui.usage-agent-refresh-interval.v1';
export const DEFAULT_AGENT_USAGE_REFRESH_INTERVAL = 5 * 60 * 1000;

export const AGENT_USAGE_REFRESH_INTERVALS = [
  0,
  1 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
] as const;

export type AgentUsageRefreshInterval = (typeof AGENT_USAGE_REFRESH_INTERVALS)[number];

export function loadAgentUsageRefreshInterval(): AgentUsageRefreshInterval {
  const value = Number(usagePreferences.getItem(AGENT_USAGE_REFRESH_INTERVAL_KEY));
  return AGENT_USAGE_REFRESH_INTERVALS.includes(value as AgentUsageRefreshInterval)
    ? value as AgentUsageRefreshInterval
    : DEFAULT_AGENT_USAGE_REFRESH_INTERVAL;
}

export function saveAgentUsageRefreshInterval(value: AgentUsageRefreshInterval) {
  usagePreferences.setItem(AGENT_USAGE_REFRESH_INTERVAL_KEY, String(value));
}
