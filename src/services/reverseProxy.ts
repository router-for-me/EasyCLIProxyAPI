import { invoke } from './platform';

export type ReverseProxyConfig = {
  enabled: boolean;
  listenHost: string;   // default "0.0.0.0"
  listenPort: number;   // default 443
  targetPort: number;   // default: current core port from config, else 8317
  certPath: string;
  keyPath: string;
};

export type ReverseProxyPathField = 'certPath' | 'keyPath';

export const reverseProxyPathErrors = (error: unknown): Partial<Record<ReverseProxyPathField, string>> => {
  const message = String(error);
  const errors: Partial<Record<ReverseProxyPathField, string>> = {};
  if (/certificate|cert.*pem/i.test(message)) errors.certPath = message;
  if (/private key|key.*pem|certificate\/key/i.test(message)) errors.keyPath = message;
  return errors;
};

export type ReverseProxyHardening = {
  loopbackBind: boolean;
  trustedProxies: boolean;
  restartRequired: boolean;
};

export type ReverseProxyState = {
  running: boolean;
  listening: string | null;
  target: string | null;
  requestsTotal: number;
  error: string | null;
  hardening?: ReverseProxyHardening;
  config?: ReverseProxyConfig | null;
};

export const getReverseProxyState = async (): Promise<ReverseProxyState> => {
  return await invoke<ReverseProxyState>('reverse_proxy_get_state');
};

export const applyReverseProxyConfig = async (config: ReverseProxyConfig): Promise<ReverseProxyState> => {
  return await invoke<ReverseProxyState>('reverse_proxy_apply', { config });
};

export const startReverseProxy = async (config: ReverseProxyConfig): Promise<ReverseProxyState> => {
  return await invoke<ReverseProxyState>('reverse_proxy_start', { config });
};

export const stopReverseProxy = async (): Promise<ReverseProxyState> => {
  return await invoke<ReverseProxyState>('reverse_proxy_stop');
};
