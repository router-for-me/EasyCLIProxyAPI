import { invoke } from '@tauri-apps/api/core';
import { normalizeAuthIndex } from './managementApi';
import type { AuthFile } from './quotaService';

export type DashboardRequest = {
  timestamp: string; auth_index?: string; model: string; user_agent?: string;
  failed: boolean; canceled: boolean;
  alias?: string; reasoning_effort?: string; failure_status?: number; failure_body?: string;
};
export type DashboardActivity = { items: DashboardRequest[]; latest: DashboardRequest | null; checkedAt: number };
export const successfulRequest = (item: DashboardRequest) => !item.failed && !item.canceled;
export function accountRequests(file: AuthFile, items: DashboardRequest[]) {
  const index = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  return index ? items.filter((item) => normalizeAuthIndex(item.auth_index) === index) : [];
}
export function requestClient(item: DashboardRequest) {
  const agent = item.user_agent?.toLowerCase() ?? '';
  if (agent.includes('claude-desktop')) return 'Claude Desktop';
  if (agent.includes('claude-cli')) return 'Claude Code CLI';
  if (agent.includes('codex')) return 'Codex';
  return null;
}
export async function loadDashboardActivity(): Promise<DashboardActivity> {
  const [recent, successful] = await Promise.all([
    invoke<{ items: DashboardRequest[] }>('get_usage_events', { query: { page: 1, page_size: 200 } }),
    invoke<{ items: DashboardRequest[] }>('get_usage_events', { query: { page: 1, page_size: 20, failed: false, canceled: false } }),
  ]);
  return { items: recent.items, latest: successful.items.find(successfulRequest) ?? null, checkedAt: Date.now() };
}
export const privateText = (text: string, hidden: boolean) => hidden
  ? text.replace(/[^\s<>@]+@[^\s<>@]+/g, '••••') : text;
