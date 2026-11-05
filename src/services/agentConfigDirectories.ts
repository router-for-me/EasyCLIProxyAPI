import type { AgentClientId } from './agents';

export type AgentConfigDirectories = Partial<Record<AgentClientId, string>>;
const STORAGE_KEY = 'cpa-gui.agent-config-directory-overrides.v1';

export function readAgentConfigDirectories(): AgentConfigDirectories {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string' && !!entry[1].trim()).map(([key, directory]) => [key, directory.trim()]));
  } catch {
    return {};
  }
}

export function writeAgentConfigDirectories(directories: AgentConfigDirectories): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(directories));
}
