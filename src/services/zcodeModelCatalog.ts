import { invoke } from "@tauri-apps/api/core";

export interface ZCodeModelConfig {
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImage: boolean;
  supportsPdf: boolean;
  supportsVideo: boolean;
  supportsJsonSchemaOutput: boolean;
  supportsNativeWebSearch: boolean;
  supportsMidConversationSystem: boolean;
  reasoningLevels: string[];
  reasoningMap?: string;
  isManual: boolean;
}

export interface ZCodeCatalogEditorModel {
  id: string;
  enabled: boolean;
  configuration: ZCodeModelConfig;
  defaults: ZCodeModelConfig;
}

export interface ZCodeCatalogEditorSnapshot {
  models: ZCodeCatalogEditorModel[];
  modelOrder: string[];
  defaultModel?: string;
  configured: boolean;
}

export interface ZCodeCatalogEditorSaveRequest {
  models: ZCodeCatalogEditorModel[];
  modelOrder: string[];
}

export const getZCodeModelCatalogEditor = (): Promise<ZCodeCatalogEditorSnapshot> =>
  invoke<ZCodeCatalogEditorSnapshot>("get_zcode_model_catalog_editor");

export const saveZCodeModelCatalogEditor = (
  request: ZCodeCatalogEditorSaveRequest
): Promise<ZCodeCatalogEditorSnapshot> =>
  invoke<ZCodeCatalogEditorSnapshot>("save_zcode_model_catalog_editor", { request });
