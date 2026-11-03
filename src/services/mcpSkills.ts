import { invoke } from '@tauri-apps/api/core';

export type McpTransport = 'stdio' | 'sse' | 'http';

export type McpServer = {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  description: string | null;
};

export type SkillSource = 'openclaw' | 'project' | 'workshop' | 'custom';

export type SkillEntry = {
  id: string;
  name: string;
  description: string;
  path: string;
  root: string;
  source: SkillSource;
  enabled: boolean;
  fileCount: number;
};

export type ImportResult = {
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
};

export function createEmptyMcpServer(): McpServer {
  return {
    id: '',
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    url: '',
    headers: {},
    enabled: true,
    description: '',
  };
}

export function isBackendMissingError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes('not found')
    || lower.includes('not implemented')
    || lower.includes('unknown command')
    || lower.includes('cannot find command')
  );
}

export async function listMcpServers(): Promise<McpServer[]> {
  return invoke<McpServer[]>('list_mcp_servers');
}

export async function saveMcpServer(server: McpServer): Promise<void> {
  return invoke<void>('save_mcp_server', { server });
}

export async function deleteMcpServer(id: string): Promise<void> {
  return invoke<void>('delete_mcp_server', { id });
}

export async function setMcpServerEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke<void>('set_mcp_server_enabled', { id, enabled });
}

export async function importMcpServersJson(raw: string): Promise<ImportResult> {
  return invoke<ImportResult>('import_mcp_servers_json', { raw });
}

export async function exportMcpServersJson(): Promise<string> {
  return invoke<string>('export_mcp_servers_json');
}

export async function listSkills(): Promise<SkillEntry[]> {
  return invoke<SkillEntry[]>('list_skills');
}

export async function getSkillDetail(path: string): Promise<string> {
  const result = await invoke<string | { content?: string; markdown?: string; body?: string }>('get_skill_detail', { path });
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    return result.content ?? result.markdown ?? result.body ?? '';
  }
  return '';
}

export async function setSkillEnabled(path: string, enabled: boolean): Promise<void> {
  return invoke<void>('set_skill_enabled', { path, enabled });
}

export async function openMcpSkillsDirectory(): Promise<void> {
  return invoke<void>('open_mcp_skills_directory');
}
