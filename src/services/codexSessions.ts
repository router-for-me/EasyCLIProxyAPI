import { invoke } from '@tauri-apps/api/core';
import type { CodexSessionContextDetail, SaveCodexSessionContextResult, SaveCodexSessionContextRequest, CodexSessionPage, CodexSessionDeleteBatchResult, CodexSessionRepairResult, SessionIndexCleanupPreview, SessionIndexCleanupResult } from './codexSessionState';

export const getCodexSessionContext = (args: { request: { sessionId: string; }; }): Promise<CodexSessionContextDetail> =>
  invoke<CodexSessionContextDetail>('get_codex_session_context', args);

export const saveCodexSessionContext = (args: { request: SaveCodexSessionContextRequest; }): Promise<SaveCodexSessionContextResult> =>
  invoke<SaveCodexSessionContextResult>('save_codex_session_context', args);

export const openCodexSessionRollout = (args: { request: { sessionId: string; }; }): Promise<void> =>
  invoke<void>('open_codex_session_rollout', args);

export const listCodexSessions = (args: { request: { offset: number; limit: number; }; }): Promise<CodexSessionPage> =>
  invoke<CodexSessionPage>('list_codex_sessions', args);

export const deleteCodexSessions = (args: { request: { sessionIds: string[]; skipBackup?: boolean; }; }): Promise<CodexSessionDeleteBatchResult> =>
  invoke<CodexSessionDeleteBatchResult>('delete_codex_sessions', args);

export const repairCodexSessionMetadata = (args?: { expectedProvider: string; }): Promise<CodexSessionRepairResult> =>
  invoke<CodexSessionRepairResult>('repair_codex_session_metadata', args);

export const previewCodexSessionIndexCleanup = (): Promise<SessionIndexCleanupPreview> =>
  invoke<SessionIndexCleanupPreview>('preview_codex_session_index_cleanup');

export const applyCodexSessionIndexCleanup = (args: { request: { snapshotSha256: string; threadIds: string[]; }; }): Promise<SessionIndexCleanupResult> =>
  invoke<SessionIndexCleanupResult>('apply_codex_session_index_cleanup', args);
