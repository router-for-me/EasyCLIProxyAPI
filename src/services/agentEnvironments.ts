import { invoke } from '@tauri-apps/api/core';
import type { AgentClientId } from './agents';

export type WslUserDirectory = { name: string; directory: string; exists: boolean };
export type WslDistribution = { name: string; users: WslUserDirectory[] };
export type AgentEnvironmentOptions = {
  supported: boolean;
  defaultDirectory: string;
  distributions: WslDistribution[];
};

export const getAgentEnvironmentOptions = (client: AgentClientId): Promise<AgentEnvironmentOptions> =>
  invoke('get_agent_environment_options', { client });

export function parseWslDirectory(directory: string): { distro: string; user: string | null } | null {
  const normalized = directory.replace(/\//g, '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\');
  const match = normalized.match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\|$)(.*)/i);
  if (!match) return null;
  const home = match[2].match(/^home\\([^\\]+)(?:\\|$)/);
  return { distro: match[1], user: home?.[1] ?? (match[2].match(/^root(?:\\|$)/) ? 'root' : null) };
}
