import { invokeAgentCommand as invoke, type AgentClientId } from './agents';

export type PromptRewriteMode = 'replace' | 'prepend' | 'append';

export interface AgentSystemPromptEditorModel {
  id: string;
  customized: boolean;
  prompt: string;
  defaultPrompt: string;
  mode: PromptRewriteMode;
  preserveDynamicContext: boolean;
}

export interface AgentSystemPromptEditorSnapshot {
  client: AgentClientId;
  defaultPrompt: string;
  builtinDefaultPrompt: string;
  defaultSource: 'installed' | 'observed' | 'template' | string;
  defaultCustomized: boolean;
  defaultMode: PromptRewriteMode;
  defaultPreserveDynamicContext: boolean;
  overridesEnabled?: boolean | null;
  proxyActive: boolean;
  proxyPort: number | null;
  coreTlsEnabled?: boolean;
  models: AgentSystemPromptEditorModel[];
}

export interface AgentSystemPromptModelSaveItem {
  id: string;
  customized: boolean;
  prompt: string;
  mode: PromptRewriteMode;
  preserveDynamicContext: boolean;
}

export interface AgentSystemPromptEditorSaveRequest {
  client: AgentClientId;
  overridesEnabled?: boolean | null;
  defaultCustomized: boolean;
  defaultPrompt: string;
  defaultMode: PromptRewriteMode;
  defaultPreserveDynamicContext: boolean;
  models: AgentSystemPromptModelSaveItem[];
}

export const getAgentSystemPromptEditor = (
  client: AgentClientId,
): Promise<AgentSystemPromptEditorSnapshot> =>
  invoke<AgentSystemPromptEditorSnapshot>('get_agent_system_prompt_editor', { client });

export const saveAgentSystemPromptEditor = (
  request: AgentSystemPromptEditorSaveRequest,
): Promise<AgentSystemPromptEditorSnapshot> =>
  invoke<AgentSystemPromptEditorSnapshot>('save_agent_system_prompt_editor', { request });
