export type AgentConfigurationClientId =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'opencode'
  | 'openclaw'
  | 'hermes'
  | 'deepseek-harness'
  | 'zcode'
  | 'kimi-code'
  | 'grok-build'
  | 'pi';

export type AgentConfigurationModificationState = 'unconfigured' | 'applied' | 'invalid';

export type AgentConfigurationAction = 'apply' | 'update' | 'close';

export type ClaudeModelMappingClientId = 'claude-code' | 'claude-desktop';

export type AgentModelMappings = {
  opus: string;
  sonnet: string;
  haiku: string;
  opus1m?: boolean;
  sonnet1m?: boolean;
  haiku1m?: boolean;
  maxContextTokens?: number;
  autoCompactPct?: number;
  disableAutoCompact?: boolean;
};

type ResolveAgentConfigurationActionOptions = {
  client: AgentConfigurationClientId;
  modificationState: AgentConfigurationModificationState;
  configurationSynchronized?: boolean;
  selectedModel: string;
  appliedModel: string;
  oauthConfiguration: boolean;
  appliedOauthConfiguration: boolean;
  remoteCompaction: boolean;
  appliedRemoteCompaction: boolean;
  modelMappings: AgentModelMappings;
  appliedModelMappings: AgentModelMappings;
};

const normalizedModel = (value: string) => value.trim().toLocaleLowerCase();

export const sameAgentModel = (left: string, right: string) => (
  normalizedModel(left) === normalizedModel(right)
);

export const sameAgentModelMappings = (
  left: AgentModelMappings,
  right: AgentModelMappings,
) => sameAgentModel(left.opus, right.opus)
  && sameAgentModel(left.sonnet, right.sonnet)
  && sameAgentModel(left.haiku, right.haiku)
  && Boolean(left.opus1m) === Boolean(right.opus1m)
  && Boolean(left.sonnet1m) === Boolean(right.sonnet1m)
  && Boolean(left.haiku1m) === Boolean(right.haiku1m)
  && (left.maxContextTokens ?? 200_000) === (right.maxContextTokens ?? 200_000)
  && (left.autoCompactPct ?? 90) === (right.autoCompactPct ?? 90)
  && Boolean(left.disableAutoCompact) === Boolean(right.disableAutoCompact);

export const resolveAgentModelMappingsDraftSource = <T>(
  current: T,
  applied: T | null | undefined,
  fallback: T,
  dirty: boolean,
): T => (dirty ? current : applied ?? fallback);

export const resolveAgentModelMappingsDraftSourceForClient = <T>(
  currentByClient: Record<ClaudeModelMappingClientId, T>,
  client: ClaudeModelMappingClientId,
  applied: T | null | undefined,
  fallback: T,
  dirty: boolean,
): T => resolveAgentModelMappingsDraftSource(
  currentByClient[client],
  applied,
  fallback,
  dirty,
);

export function resolveAgentConfigurationAction({
  client,
  modificationState,
  configurationSynchronized = true,
  selectedModel,
  appliedModel,
  oauthConfiguration,
  appliedOauthConfiguration,
  remoteCompaction,
  appliedRemoteCompaction,
  modelMappings,
  appliedModelMappings,
}: ResolveAgentConfigurationActionOptions): AgentConfigurationAction {
  if (modificationState !== 'applied') return 'apply';
  if (client === 'pi') return 'close';
  if (
    (client === 'zcode' || client === 'kimi-code' || client === 'grok-build')
    && !configurationSynchronized
  ) return 'update';

  const modelChanged = client === 'claude-code' || client === 'claude-desktop'
    ? !sameAgentModelMappings(modelMappings, appliedModelMappings)
    : Boolean(
      selectedModel.trim()
        && appliedModel.trim()
        && !sameAgentModel(selectedModel, appliedModel),
    );
  const oauthChanged = client === 'codex'
    && oauthConfiguration !== appliedOauthConfiguration;
  const remoteCompactionChanged = client === 'codex'
    && remoteCompaction !== appliedRemoteCompaction;

  return modelChanged || oauthChanged || remoteCompactionChanged ? 'update' : 'close';
}
