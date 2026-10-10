import type { ModelOption } from './modelService';

export const claudeCodeRoles = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type ClaudeCodeRole = typeof claudeCodeRoles[number];
export type ClaudeCodeRoutes = Record<ClaudeCodeRole, string> & {
  opus1m: boolean; sonnet1m: boolean; haiku1m: boolean; fable1m: boolean;
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

export const CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
export const CLAUDE_CODE_EXTENDED_MAX_CONTEXT_TOKENS = 1_000_000;

type ClaudeCodeContextSource = Partial<ClaudeCodeRoutes> & {
  startupModel?: string;
  subagentModel?: string;
};

const hasExtendedSuffix = (value: string | undefined) => Boolean(value) && /\[1m\]$/i.test(value!.trim());

export function claudeCodeUsesExtendedContext(routes: ClaudeCodeContextSource): boolean {
  return Boolean(routes.opus1m || routes.sonnet1m || routes.haiku1m || routes.fable1m)
    || [routes.opus, routes.sonnet, routes.haiku, routes.fable, routes.startupModel, routes.subagentModel]
      .some(hasExtendedSuffix);
}

// 200000 and 1000000 are the automatic values: they follow the 1M preference.
// Any other window is an explicit user choice and must survive 1M changes.
export function resolveClaudeCodeMaxContextTokens(current: number, extended: boolean): number {
  const automatic = current === CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS
    || current === CLAUDE_CODE_EXTENDED_MAX_CONTEXT_TOKENS;
  if (!automatic) return current;
  return extended ? CLAUDE_CODE_EXTENDED_MAX_CONTEXT_TOKENS : CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS;
}

// Keep the automatic window in step with the 1M preference without clobbering
// an explicit value such as 400000.
export function followClaudeCodeContextWindow<
  T extends ClaudeCodeContextSource & { maxContextTokens?: number },
>(next: T, currentMaxContextTokens: number, follow: boolean): T {
  if (!follow) return next;
  return {
    ...next,
    maxContextTokens: resolveClaudeCodeMaxContextTokens(
      currentMaxContextTokens,
      claudeCodeUsesExtendedContext(next),
    ),
  } as T;
}
