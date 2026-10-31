import { invoke } from '@tauri-apps/api/core';

export type OAuthStatusResult = {
  status: string;
  error?: string | null;
};

export type OAuthStartResult = {
  url: string;
  state?: string | null;
  userCode?: string | null;
  flow?: string | null;
  expiresIn?: number | null;
  opened: boolean;
  openError?: string | null;
};

export type OAuthBrowserOption = {
  id: string;
  label: string;
};

export const getOAuthStatus = (args: { state: string; }): Promise<OAuthStatusResult> =>
  invoke<OAuthStatusResult>('get_oauth_status', args);

export const startOAuthLogin = (args: { provider: string; browser: string; pluginProvider?: boolean }): Promise<OAuthStartResult> =>
  invoke<OAuthStartResult>('start_oauth_login', args);

export const openOAuthUrl = (args: { url: string; browser: string; }): Promise<void> =>
  invoke<void>('open_oauth_url', args);

export const submitOAuthCallback = (args: { provider: string; redirectUrl: string; pluginProvider?: boolean }): Promise<void> =>
  invoke<void>('submit_oauth_callback', args);

export const listOAuthBrowsers = (): Promise<OAuthBrowserOption[]> =>
  invoke<OAuthBrowserOption[]>('list_oauth_browsers');

export const checkCodexOAuthLogin = (): Promise<void> =>
  invoke<void>('check_codex_oauth_login');
