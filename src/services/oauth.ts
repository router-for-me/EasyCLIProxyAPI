import { remoteTargetRevision } from './remoteCpa';
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
  invoke<OAuthStatusResult>('get_oauth_status', { ...args, targetRevision: remoteTargetRevision() });

export const startOAuthLogin = (args: { provider: string; browser: string; pluginProvider?: boolean }): Promise<OAuthStartResult> =>
  invoke<OAuthStartResult>('start_oauth_login', { ...args, targetRevision: remoteTargetRevision() });

export const openOAuthUrl = (args: { url: string; browser: string; }): Promise<void> =>
  invoke<void>('open_oauth_url', args);

export const submitOAuthCallback = (args: { provider: string; redirectUrl: string; pluginProvider?: boolean }): Promise<void> =>
  invoke<void>('submit_oauth_callback', { ...args, targetRevision: remoteTargetRevision() });

export const listOAuthBrowsers = (): Promise<OAuthBrowserOption[]> =>
  invoke<OAuthBrowserOption[]>('list_oauth_browsers');

const OAUTH_BROWSER_STORAGE_KEY = 'easy-cli-proxy-api.oauth-browser.v3';
export const NO_AUTO_OPEN_BROWSER_ID = 'none';

export const loadOAuthBrowserPreference = (): string => {
  try {
    return window.localStorage.getItem(OAUTH_BROWSER_STORAGE_KEY)?.trim() || '';
  } catch {
    return '';
  }
};

export const saveOAuthBrowserPreference = (browser: string) => {
  try {
    window.localStorage.setItem(OAUTH_BROWSER_STORAGE_KEY, browser);
  } catch {
  }
};

export const checkCodexOAuthLogin = (): Promise<void> =>
  invoke<void>('check_codex_oauth_login');
