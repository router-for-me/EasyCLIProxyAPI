import type { UsageRecord } from './usage';
import type { AgentClientId } from './agents';

const CLIENTS = {
  'claude-code': { name: 'Claude Code', icon: 'claude' },
  'claude-desktop': { name: 'Claude Desktop', icon: 'claude' },
  codex: { name: 'Codex', icon: 'codex' },
  'gemini-cli': { name: 'Gemini CLI', icon: 'gemini' },
  opencode: { name: 'OpenCode', icon: 'opencode' },
  openclaw: { name: 'OpenClaw', icon: 'openclaw' },
  hermes: { name: 'Hermes Agent', icon: 'hermes' },
  'deepseek-harness': { name: 'DeepSeek Harness', icon: 'deepseek' },
  zcode: { name: 'ZCode', icon: 'zcode' },
  workbuddy: { name: 'WorkBuddy', icon: 'workbuddy' },
  'antigravity-cli': { name: 'Antigravity CLI', icon: 'antigravity' },
  'copilot-cli': { name: 'Copilot CLI', icon: 'copilot' },
  'vscode-copilot': { name: 'VSCode Copilot', icon: 'copilot' },
  'kimi-code': { name: 'Kimi Code', icon: 'kimi' },
  'grok-build': { name: 'Grok Build', icon: 'grok' },
  omp: { name: 'Oh My Pi', icon: 'pi' },
  pi: { name: 'Pi', icon: 'pi' },
} as const satisfies Record<AgentClientId | 'gemini-cli', { name: string; icon: string }>;
export type KnownClientAgent = keyof typeof CLIENTS;
export type ClientAgent = { id: KnownClientAgent | 'unknown' | 'other'; name?: string; icon?: string };

/** The native usage projection sends only an allowlisted, self-reported product id. */
export function usageClientAgent(record: Pick<UsageRecord, 'client_agent'>): ClientAgent {
  const id = record.client_agent;
  if (id == null || id === '') return { id: 'unknown' };
  if (Object.prototype.hasOwnProperty.call(CLIENTS, id)) {
    return { id: id as KnownClientAgent, ...CLIENTS[id as KnownClientAgent] };
  }
  return { id: 'other' };
}
