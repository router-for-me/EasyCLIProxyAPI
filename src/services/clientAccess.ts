import { getCurrentLocale, translate } from '../i18n';

export type ClientApiProfile = {
  id: 'openai' | 'claude' | 'gemini';
  name: string;
  description: string;
  baseUrl: string;
};

const safeLocalPort = (port: number) =>
  Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 8317;

const normalizedConnectHost = (listenHost: string) => {
  const host = listenHost.trim().replace(/^\[|\]$/g, '');
  if (!host || host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
};

const urlHost = (host: string) => host.includes(':') ? `[${host}]` : host;

export function webUiManagementUrl(
  port: number,
  tlsEnabled = false,
  listenHost = '127.0.0.1',
): string {
  const scheme = tlsEnabled ? 'https' : 'http';
  const host = urlHost(normalizedConnectHost(listenHost));
  return `${scheme}://${host}:${safeLocalPort(port)}/management.html#/login`;
}

export function clientApiProfiles(
  port: number,
  tlsEnabled = false,
  listenHost = '127.0.0.1',
): ClientApiProfile[] {
  const safePort = safeLocalPort(port);
  const scheme = tlsEnabled ? 'https' : 'http';
  const connectHost = normalizedConnectHost(listenHost);
  const origin = `${scheme}://${urlHost(connectHost)}:${safePort}`;

  return [
    {
      id: 'openai',
      name: 'OpenAI',
      description: translate(getCurrentLocale(), 'kernel.access.openaiDescription'),
      baseUrl: `${origin}/v1`,
    },
    {
      id: 'claude',
      name: 'Claude',
      description: translate(getCurrentLocale(), 'kernel.access.claudeDescription'),
      baseUrl: origin,
    },
    {
      id: 'gemini',
      name: 'Gemini',
      description: translate(getCurrentLocale(), 'kernel.access.geminiDescription'),
      baseUrl: origin,
    },
  ];
}
