import { invoke } from "@tauri-apps/api/core";

export interface ZCodeSubagentItem {
  name: string;
  description: string;
  filePath: string;
  model: string | null;
  thoughtLevel: string | null;
  tools: string[];
}

export interface ZCodeSubagentConfigSnapshot {
  defaultSubagentModel: string | null;
  defaultThoughtLevel: string | null;
  subagents: ZCodeSubagentItem[];
}

export interface ZCodeSubagentConfigSaveRequest {
  defaultSubagentModel: string | null;
  defaultThoughtLevel: string | null;
  subagents: ZCodeSubagentItem[];
}

export const getZCodeSubagentConfig = (): Promise<ZCodeSubagentConfigSnapshot> =>
  invoke<ZCodeSubagentConfigSnapshot>("get_zcode_subagent_config");

export const saveZCodeSubagentConfig = (
  request: ZCodeSubagentConfigSaveRequest
): Promise<ZCodeSubagentConfigSnapshot> =>
  invoke<ZCodeSubagentConfigSnapshot>("save_zcode_subagent_config", { request });
