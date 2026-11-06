import { invokeAgentCommand, type AgentClientId } from './agents';

export type AgentModelFallback = {
  model: string;
  primary: string;
  fallbacks: string[];
  revision: string;
};
export type AgentModelFallbackScope = { client: AgentClientId; slot: string; model: string };

export const readAgentModelFallback = (scope: AgentModelFallbackScope): Promise<AgentModelFallback> =>
  invokeAgentCommand<AgentModelFallback>('read_agent_model_fallback', scope);

export const saveAgentModelFallback = (scope: AgentModelFallbackScope, draft: AgentModelFallback): Promise<AgentModelFallback> =>
  invokeAgentCommand<AgentModelFallback>('save_agent_model_fallback', {
    ...scope, primary: draft.primary, fallbacks: draft.fallbacks, revision: draft.revision,
  });

export function validAgentFallbackTargets(primary: string, targets: string[]): boolean {
  const names = targets.map(model => model.trim().toLowerCase());
  return primary.trim().length > 0 && targets.length <= 8
    && names.every(name => name.length > 0 && name !== primary.trim().toLowerCase())
    && new Set(names).size === names.length;
}

export function moveAgentFallback(targets: string[], index: number, offset: number): string[] {
  const destination = index + offset;
  if (index < 0 || index >= targets.length || destination < 0 || destination >= targets.length) return targets;
  const next = [...targets];
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}
