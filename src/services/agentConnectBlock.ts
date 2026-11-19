export type AgentConnectBlockReason =
  | 'busy'
  | 'loading'
  | 'statusUnavailable'
  | 'unsupportedPlatform'
  | 'clientUnavailable'
  | 'configInvalid'
  | 'modelsLoading'
  | 'noModels'
  | 'noModelSelected'
  | 'modelSelectionGone'
  | 'mappingIncomplete'
  | 'claudeCodeRuntimeInvalid'
  | 'noPendingChanges';

export type TransientConnectBlockReason = 'busy' | 'loading' | 'statusUnavailable' | 'modelsLoading';

export type AgentConnectBlockInput = {
  busy: boolean;
  loading: boolean;
  hasStatus: boolean;
  supportedPlatform: boolean;
  installed: boolean;
  configExists: boolean;
  connectionInvalid: boolean;
  modelLoading: boolean;
  modelCount: number;
  hasSavedModelSelection: boolean;
  hasSelectedModel: boolean;
  claudeMappingClient: boolean;
  claudeMappingsReady: boolean;
  claudeRuntimeSettingsReady: boolean;
  // Only the management apply row additionally requires an edited setting.
  requirePendingChanges?: boolean;
  hasPendingChanges?: boolean;
};

const transientReasons: ReadonlySet<TransientConnectBlockReason> = new Set([
  'busy',
  'loading',
  'statusUnavailable',
  'modelsLoading',
]);

// First-match ordering matters: it mirrors the previous
// `busy || !canEnable || configurationWriteBlocked` gate exactly while naming the cause.
export function resolveAgentConnectBlockReason(
  input: AgentConnectBlockInput,
): AgentConnectBlockReason | null {
  if (input.busy) return 'busy';
  if (input.loading) return 'loading';
  if (!input.hasStatus) return 'statusUnavailable';
  if (!input.supportedPlatform) return 'unsupportedPlatform';
  if (!input.installed && !input.configExists) return 'clientUnavailable';
  if (input.connectionInvalid) return 'configInvalid';
  if (input.modelLoading) return 'modelsLoading';
  if (input.claudeMappingClient) {
    // Claude clients map roles/aliases instead of one catalog entry, so readiness
    // replaces the single-selection checks above.
    if (!input.claudeMappingsReady) {
      return input.modelCount === 0 ? 'noModels' : 'mappingIncomplete';
    }
    if (!input.claudeRuntimeSettingsReady) return 'claudeCodeRuntimeInvalid';
  } else {
    if (input.modelCount === 0) return 'noModels';
    if (!input.hasSelectedModel) {
      return input.hasSavedModelSelection ? 'modelSelectionGone' : 'noModelSelected';
    }
  }
  if (input.requirePendingChanges && !input.hasPendingChanges) return 'noPendingChanges';
  return null;
}

export function isTransientConnectBlockReason(
  reason: AgentConnectBlockReason | null,
): reason is TransientConnectBlockReason {
  return reason !== null && (transientReasons as ReadonlySet<AgentConnectBlockReason>).has(reason);
}
