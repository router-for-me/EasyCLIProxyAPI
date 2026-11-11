import { describe, expect, it } from 'bun:test';
import {
  isTransientConnectBlockReason,
  resolveAgentConnectBlockReason,
  type AgentConnectBlockInput,
  type AgentConnectBlockReason,
} from '../src/services/agentConnectBlock';

const booleans = [
  'busy',
  'loading',
  'hasStatus',
  'supportedPlatform',
  'installed',
  'configExists',
  'connectionInvalid',
  'modelLoading',
  'claudeMappingClient',
  'claudeMappingsReady',
  'claudeRuntimeSettingsReady',
  'hasSelectedModel',
  'hasPendingChanges',
] as const;

type Flag = typeof booleans[number];

function* combinations(): Generator<{ flags: Record<Flag, boolean>; modelCount: number }> {
  const total = 2 ** booleans.length;
  for (let mask = 0; mask < total; mask += 1) {
    const flags = {} as Record<Flag, boolean>;
    booleans.forEach((flag, index) => { flags[flag] = Boolean(mask & (1 << index)); });
    for (const modelCount of [0, 1]) yield { flags, modelCount };
  }
}

// The expression this page used before the blocked-reason model was introduced.
function legacyDisabled(input: AgentConnectBlockInput) {
  const canConfigureActiveClient = input.supportedPlatform && (input.installed || input.configExists);
  const canEnable = canConfigureActiveClient
    && !input.modelLoading
    && (input.claudeMappingClient
      ? input.claudeMappingsReady && input.claudeRuntimeSettingsReady
      : input.hasSelectedModel);
  const configurationWriteBlocked = input.loading || !input.hasStatus || input.connectionInvalid;
  return input.busy || !canEnable || configurationWriteBlocked;
}

describe('agent connect block reason', () => {
  it('keeps the enable/disable result identical to the previous boolean expression', () => {
    const mismatches: Array<Record<string, unknown>> = [];
    for (const { flags, modelCount } of combinations()) {
      const input: AgentConnectBlockInput = {
        ...flags,
        // A resolved selection implies a non-empty catalog in practice.
        hasSelectedModel: flags.hasSelectedModel && modelCount > 0,
        modelCount,
        hasSavedModelSelection: flags.hasSelectedModel,
      };
      const blocked = resolveAgentConnectBlockReason(input) !== null;
      if (blocked !== Boolean(legacyDisabled(input))) mismatches.push({ flags, blocked });
    }
    expect(mismatches).toEqual([]);
  });

  it('keeps the management apply row identical, including its pending-change requirement', () => {
    const mismatches: Array<Record<string, unknown>> = [];
    for (const { flags, modelCount } of combinations()) {
      const input: AgentConnectBlockInput = {
        ...flags,
        hasSelectedModel: flags.hasSelectedModel && modelCount > 0,
        modelCount,
        hasSavedModelSelection: flags.hasSelectedModel,
        requirePendingChanges: true,
      };
      const blocked = resolveAgentConnectBlockReason(input) !== null;
      if (blocked !== Boolean(legacyDisabled(input) || !flags.hasPendingChanges)) {
        mismatches.push({ flags, modelCount, blocked });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('names each stable blocking cause in order', () => {
    const base: AgentConnectBlockInput = {
      busy: false,
      loading: false,
      hasStatus: true,
      supportedPlatform: true,
      installed: true,
      configExists: true,
      connectionInvalid: false,
      modelLoading: false,
      modelCount: 2,
      hasSavedModelSelection: true,
      hasSelectedModel: true,
      claudeMappingClient: false,
      claudeMappingsReady: true,
      claudeRuntimeSettingsReady: true,
    };
    const cases: Array<[Partial<AgentConnectBlockInput>, AgentConnectBlockReason | null]> = [
      [{ busy: true }, 'busy'],
      [{ loading: true }, 'loading'],
      [{ hasStatus: false }, 'statusUnavailable'],
      [{ supportedPlatform: false }, 'unsupportedPlatform'],
      [{ installed: false, configExists: false }, 'clientUnavailable'],
      [{ connectionInvalid: true }, 'configInvalid'],
      [{ modelLoading: true }, 'modelsLoading'],
      [{ modelCount: 0 }, 'noModels'],
      [{ hasSavedModelSelection: false, hasSelectedModel: false }, 'noModelSelected'],
      [{ hasSelectedModel: false }, 'modelSelectionGone'],
      [{ claudeMappingClient: true, claudeMappingsReady: false }, 'mappingIncomplete'],
      [{ claudeMappingClient: true, claudeRuntimeSettingsReady: false }, 'claudeCodeRuntimeInvalid'],
      [{ requirePendingChanges: true, hasPendingChanges: false }, 'noPendingChanges'],
      [{ requirePendingChanges: true, hasPendingChanges: true }, null],
      [{}, null],
    ];
    for (const [patch, expected] of cases) {
      expect(resolveAgentConnectBlockReason({ ...base, ...patch })).toBe(expected);
    }
  });

  it('treats only busy/loading states as transient', () => {
    for (const reason of ['busy', 'loading', 'statusUnavailable', 'modelsLoading'] as const) {
      expect(isTransientConnectBlockReason(reason)).toBe(true);
    }
    for (const reason of ['configInvalid', 'clientUnavailable', 'noModels', 'modelSelectionGone'] as const) {
      expect(isTransientConnectBlockReason(reason)).toBe(false);
    }
    expect(isTransientConnectBlockReason(null)).toBe(false);
  });
});
