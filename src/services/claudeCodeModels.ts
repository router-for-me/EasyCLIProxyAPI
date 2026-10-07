import type { ModelOption } from './modelService';

export const claudeCodeRoles = ['opus', 'sonnet', 'haiku'] as const;
export type ClaudeCodeRole = typeof claudeCodeRoles[number];
export type ClaudeCodeRoutes = Record<ClaudeCodeRole, string> & {
  opus1m: boolean; sonnet1m: boolean; haiku1m: boolean;
};

export function claudeCodeModelBase(value: string): string {
  return value.trim().replace(/(?:\[1m\])+$/i, '');
}

export function claudeCodeRole(value: string): ClaudeCodeRole | null {
  const base = claudeCodeModelBase(value).toLowerCase();
  return claudeCodeRoles.find(role => role === base) ?? null;
}

export function claudeCodeModelPreview(value: string, routes: ClaudeCodeRoutes) {
  const role = claudeCodeRole(value);
  const base = role ? claudeCodeModelBase(routes[role]) : claudeCodeModelBase(value);
  const context1m = /\[1m\]$/i.test(value.trim()) || Boolean(role && routes[`${role}1m`]);
  return { role, model: base ? base + (context1m ? '[1m]' : '') : '', context1m };
}

export function isKnownClaudeCodeModel(value: string, models: ModelOption[]): boolean {
  const base = claudeCodeModelBase(value).toLowerCase();
  return !base || Boolean(claudeCodeRole(value)) || models.some(model => model.name.toLowerCase() === base);
}
