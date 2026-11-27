import { isTauri as nativeIsTauri, invoke as nativeInvoke } from '@tauri-apps/api/core';
import { listen as nativeListen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';

export type RuntimeMode = 'desktop' | 'webui';

export type RuntimeCapabilities = {
  mode: RuntimeMode;
  canOpenLocalBrowser: boolean;
  canOpenFileManager: boolean;
  canLaunchDesktopApps: boolean;
  canSelfUpdate: boolean;
  supportsNativePluginWebview: boolean;
  supportsNativeDialog: boolean;
  supportsTray: boolean;
  supportsAutostart: boolean;
  supportsWindowMaterial: boolean;
  appVersion: string;
  dataDir: string;
};

export type WebAuthStatus = {
  mode: 'desktop' | 'webui' | 'browser';
  authRequired: boolean;
  authenticated: boolean;
  version: string;
};

export type ServerPathEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size?: number | null;
};

export type ServerPathListing = {
  currentPath: string;
  parentPath: string | null;
  entries: ServerPathEntry[];
};

export type StagedUploadResult = {
  path: string;
  fileName: string;
  size: number;
};

export type ServerFileFilter = { name: string; extensions: string[] };
export type ServerPathPickerOptions = {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  filters?: ServerFileFilter[];
};

const DEFAULT_DESKTOP_CAPABILITIES: RuntimeCapabilities = {
  mode: 'desktop',
  canOpenLocalBrowser: true,
  canOpenFileManager: true,
  canLaunchDesktopApps: true,
  canSelfUpdate: true,
  supportsNativePluginWebview: true,
  supportsNativeDialog: true,
  supportsTray: true,
  supportsAutostart: true,
  supportsWindowMaterial: true,
  appVersion: '',
  dataDir: '',
};

const DEFAULT_WEBUI_CAPABILITIES: RuntimeCapabilities = {
  mode: 'webui',
  canOpenLocalBrowser: false,
  canOpenFileManager: false,
  canLaunchDesktopApps: false,
  canSelfUpdate: false,
  supportsNativePluginWebview: false,
  supportsNativeDialog: false,
  supportsTray: false,
  supportsAutostart: false,
  supportsWindowMaterial: false,
  appVersion: '',
  dataDir: '',
};

let webUiDetected = false;
let authSnapshot: WebAuthStatus = {
  mode: nativeIsTauri() ? 'desktop' : 'browser',
  authRequired: false,
  authenticated: nativeIsTauri(),
  version: '',
};
let capabilitiesSnapshot: RuntimeCapabilities = DEFAULT_DESKTOP_CAPABILITIES;

const authListeners = new Set<() => void>();
const capabilityListeners = new Set<() => void>();

function notifyAuth() {
  authListeners.forEach((listener) => listener());
}

function notifyCapabilities() {
  capabilityListeners.forEach((listener) => listener());
}

function setAuthSnapshot(next: WebAuthStatus) {
  if (
    authSnapshot.mode === next.mode
    && authSnapshot.authRequired === next.authRequired
    && authSnapshot.authenticated === next.authenticated
    && authSnapshot.version === next.version
  ) {
    return;
  }
  authSnapshot = next;
  notifyAuth();
}

function setCapabilitiesSnapshot(next: RuntimeCapabilities) {
  capabilitiesSnapshot = next;
  notifyCapabilities();
}

export const isDesktopApp = (): boolean => nativeIsTauri();
export const isWebUi = (): boolean => !nativeIsTauri() && webUiDetected;
export const hasBackend = (): boolean => isDesktopApp() || isWebUi();

export const getWebAuthSnapshot = (): WebAuthStatus => authSnapshot;
export const subscribeWebAuth = (listener: () => void): (() => void) => {
  authListeners.add(listener);
  return () => {
    authListeners.delete(listener);
  };
};
export const useWebAuthStatus = (): WebAuthStatus =>
  useSyncExternalStore(subscribeWebAuth, getWebAuthSnapshot, getWebAuthSnapshot);

export const getRuntimeCapabilities = (): RuntimeCapabilities => capabilitiesSnapshot;
export const subscribeRuntimeCapabilities = (listener: () => void): (() => void) => {
  capabilityListeners.add(listener);
  return () => {
    capabilityListeners.delete(listener);
  };
};
export const useRuntimeCapabilities = (): RuntimeCapabilities =>
  useSyncExternalStore(
    subscribeRuntimeCapabilities,
    getRuntimeCapabilities,
    getRuntimeCapabilities,
  );

function markWebUnauthenticated() {
  if (!webUiDetected) return;
  closeSseStream();
  setAuthSnapshot({
    ...authSnapshot,
    authenticated: false,
  });
}

export async function loadRuntimeCapabilities(): Promise<RuntimeCapabilities> {
  if (!hasBackend()) {
    return capabilitiesSnapshot;
  }
  try {
    const caps = await invoke<RuntimeCapabilities>('get_runtime_capabilities');
    if (caps && typeof caps === 'object' && (caps.mode === 'desktop' || caps.mode === 'webui')) {
      setCapabilitiesSnapshot(caps);
      return caps;
    }
  } catch {
    if (isWebUi()) {
      setCapabilitiesSnapshot({
        ...DEFAULT_WEBUI_CAPABILITIES,
        appVersion: authSnapshot.version,
      });
    }
  }
  return capabilitiesSnapshot;
}

export async function initializeRuntimeTransport(): Promise<WebAuthStatus> {
  if (isDesktopApp()) {
    setAuthSnapshot({
      mode: 'desktop',
      authRequired: false,
      authenticated: true,
      version: '',
    });
    void loadRuntimeCapabilities();
    return authSnapshot;
  }

  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return authSnapshot;
  }

  try {
    const response = await fetch('/api/auth/status', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (response.ok) {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const data = (await response.json()) as Partial<WebAuthStatus>;
        if (data && data.mode === 'webui') {
          webUiDetected = true;
          const next: WebAuthStatus = {
            mode: 'webui',
            authRequired: Boolean(data.authRequired),
            authenticated: Boolean(data.authenticated),
            version: typeof data.version === 'string' ? data.version : '',
          };
          setAuthSnapshot(next);
          setCapabilitiesSnapshot({
            ...DEFAULT_WEBUI_CAPABILITIES,
            appVersion: next.version,
          });
          if (next.authenticated) {
            await loadRuntimeCapabilities();
          }
          return next;
        }
      }
    }
  } catch {
    // No WebUI backend reachable (e.g. standalone Vite dev server using browserMock).
  }

  return authSnapshot;
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isWebUi()) {
    return nativeInvoke<T>(command, args);
  }

  const response = await fetch(`/api/rpc/${encodeURIComponent(command)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-ECPA-Client': 'webui',
    },
    body: JSON.stringify(args ?? {}),
  });

  if (response.status === 401) {
    markWebUnauthenticated();
    throw new Error('Authentication required');
  }

  let body: { ok?: boolean; data?: T; error?: unknown } | null = null;
  try {
    body = (await response.json()) as { ok?: boolean; data?: T; error?: unknown };
  } catch {
    body = null;
  }

  if (!body || typeof body !== 'object') {
    throw new Error(`RPC ${command} failed (${response.status})`);
  }
  if (!body.ok) {
    throw body.error ?? `RPC ${command} failed (${response.status})`;
  }
  return body.data as T;
}

// Shared SSE event bus for WebUI mode
type EventHandler<T = unknown> = (event: { payload: T }) => void;
const sseHandlers = new Map<string, Set<EventHandler>>();
let eventSource: EventSource | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function closeSseStream() {
  if (sseReconnectTimer !== null) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function ensureSseStream() {
  if (!isWebUi() || !authSnapshot.authenticated) return;
  if (eventSource || typeof EventSource === 'undefined') return;
  if (sseHandlers.size === 0) return;

  const source = new EventSource('/api/events', { withCredentials: true });
  eventSource = source;

  source.addEventListener('ecpa', (raw: Event) => {
    const message = raw as MessageEvent<string>;
    if (!message.data) return;
    try {
      const parsed = JSON.parse(message.data) as { event?: string; payload?: unknown };
      if (!parsed.event) return;
      const listeners = sseHandlers.get(parsed.event);
      if (!listeners || listeners.size === 0) return;
      listeners.forEach((fn) => {
        try {
          fn({ payload: parsed.payload });
        } catch (error) {
          console.error(`WebUI event handler failed for ${parsed.event}`, error);
        }
      });
    } catch {
      // Ignore malformed frames
    }
  });

  source.onerror = () => {
    if (eventSource !== source) return;
    source.close();
    eventSource = null;
    if (!authSnapshot.authenticated || sseHandlers.size === 0) return;
    if (sseReconnectTimer === null) {
      sseReconnectTimer = setTimeout(() => {
        sseReconnectTimer = null;
        ensureSseStream();
      }, 2000);
    }
  };
}

export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  if (!isWebUi()) {
    return nativeListen<T>(event, handler);
  }

  let set = sseHandlers.get(event);
  if (!set) {
    set = new Set();
    sseHandlers.set(event, set);
  }
  const wrapped = handler as EventHandler;
  set.add(wrapped);
  ensureSseStream();

  return () => {
    const existing = sseHandlers.get(event);
    if (!existing) return;
    existing.delete(wrapped);
    if (existing.size === 0) {
      sseHandlers.delete(event);
    }
    if (sseHandlers.size === 0) {
      closeSseStream();
    }
  };
}

export const webAuth = {
  async login(password: string): Promise<void> {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-ECPA-Client': 'webui',
      },
      body: JSON.stringify({ password }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !body?.ok) {
      throw new Error(body?.error || `Login failed (${response.status})`);
    }
    setAuthSnapshot({
      ...authSnapshot,
      mode: 'webui',
      authenticated: true,
    });
    await loadRuntimeCapabilities();
    ensureSseStream();
  },

  async logout(): Promise<void> {
    closeSseStream();
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'X-ECPA-Client': 'webui',
      },
    }).catch(() => undefined);
    setAuthSnapshot({
      ...authSnapshot,
      authenticated: !authSnapshot.authRequired,
    });
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const response = await fetch('/api/auth/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-ECPA-Client': 'webui',
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (response.status === 401) {
      markWebUnauthenticated();
      throw new Error('Authentication required');
    }
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !body?.ok) {
      throw new Error(body?.error || `Failed to update password (${response.status})`);
    }
  },
};

export async function uploadTempFile(file: File): Promise<StagedUploadResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await fetch('/api/upload/temp', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'X-ECPA-Client': 'webui',
    },
    body: form,
  });
  if (response.status === 401) {
    markWebUnauthenticated();
    throw new Error('Authentication required');
  }
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    data?: StagedUploadResult;
    error?: string;
  } | null;
  if (!response.ok || !body?.ok || !body.data) {
    throw new Error(body?.error || `Upload failed (${response.status})`);
  }
  return body.data;
}

export function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise<File | null>((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onWindowFocus);
      input.remove();
      resolve(file);
    };
    const onWindowFocus = () => {
      // Wait briefly for `change` to fire after native browser file picker closes.
      setTimeout(() => {
        finish(input.files?.[0] ?? null);
      }, 300);
    };
    input.addEventListener('change', () => {
      finish(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    window.addEventListener('focus', onWindowFocus);
    input.click();
  });
}

export const browseServerPath = (args: {
  path?: string | null;
  directoriesOnly?: boolean;
  extensions?: string[];
}): Promise<ServerPathListing> => invoke<ServerPathListing>('browse_server_path', args);

type ServerPathPickerHandler = (options: ServerPathPickerOptions) => Promise<string | null>;
let serverPathPickerHandler: ServerPathPickerHandler | null = null;

export function registerServerPathPicker(handler: ServerPathPickerHandler | null) {
  serverPathPickerHandler = handler;
}

export async function requestServerPathPicker(
  options: ServerPathPickerOptions,
): Promise<string | null> {
  if (!serverPathPickerHandler) {
    return null;
  }
  return serverPathPickerHandler(options);
}
