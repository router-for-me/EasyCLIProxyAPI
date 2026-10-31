import { invoke } from '@tauri-apps/api/core';

export type ThinkingAliasEntry = {
  position: ModelAliasPosition;
  sourceModel: string;
  alias: string;
  effort: string | null;
  provider: string;
  kind: string;
  oauthChannel?: string | null;
};

export type ModelAliasPosition = {
  section: string;
  providerIndex: number | null;
  modelIndex: number;
};

export type ThinkingAliasSource = {
  id: string;
  model: string;
  displayName: string | null;
  provider: string;
  kind: string;
  protocol: string;
  reasoningLevels: string[];
};

export type SpeedAliasEntry = {
  position: ModelAliasPosition;
  sourceModel: string;
  alias: string;
  serviceTier: string;
  provider: string;
  kind: string;
  oauthChannel?: string | null;
};

export type AliasListEntry = ThinkingAliasEntry & {
  serviceTier: string | null;
};

export type ModelAliasEditContext = {
  source: ThinkingAliasSource;
  effort: string | null;
  fast: boolean;
  serviceTier?: string | null;
};

export const getThinkingAliases = (): Promise<ThinkingAliasEntry[]> =>
  invoke<ThinkingAliasEntry[]>('get_thinking_aliases');

export const getModelAliasSources = (): Promise<ThinkingAliasSource[]> =>
  invoke<ThinkingAliasSource[]>('get_model_alias_sources');

export const getThinkingAliasSources = (): Promise<ThinkingAliasSource[]> =>
  invoke<ThinkingAliasSource[]>('get_thinking_alias_sources');

export const getSpeedAliases = (): Promise<SpeedAliasEntry[]> =>
  invoke<SpeedAliasEntry[]>('get_speed_aliases');

export const getSpeedAliasSources = (): Promise<ThinkingAliasSource[]> =>
  invoke<ThinkingAliasSource[]>('get_speed_alias_sources');

export const createThinkingAlias = (args: { sourceId: string; alias: string; effort: string; fast: boolean; serviceTier?: 'priority' | 'ultrafast'; originalAlias?: string; originalEntry?: AliasListEntry }): Promise<ThinkingAliasEntry[]> =>
  invoke<ThinkingAliasEntry[]>('create_thinking_alias', args);

export const createSpeedAlias = (args: { sourceId: string; alias: string; serviceTier?: 'priority' | 'ultrafast'; }): Promise<SpeedAliasEntry[]> =>
  invoke<SpeedAliasEntry[]>('create_speed_alias', args);

export const getModelAliasEditSource = (args: { alias: string; entry: AliasListEntry; }): Promise<ModelAliasEditContext> =>
  invoke<ModelAliasEditContext>('get_model_alias_edit_source', args);

export const deleteThinkingAlias = (args: { alias: string; oauthChannel: string | null | undefined; entry: AliasListEntry; }): Promise<ThinkingAliasEntry[]> =>
  invoke<ThinkingAliasEntry[]>('delete_thinking_alias', args);

export const deleteSpeedAlias = (args: { alias: string; oauthChannel: string | null | undefined; entry: AliasListEntry; }): Promise<SpeedAliasEntry[]> =>
  invoke<SpeedAliasEntry[]>('delete_speed_alias', args);
