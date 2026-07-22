import { getCurrentLocale, translate } from '../i18n';

export const DEFAULT_CLIENT_API_KEY = '123456';

export type ClientApiProfile = {
  id: 'openai' | 'claude' | 'gemini';
  name: string;
  description: string;
  baseUrl: string;
  lanUrl: string | null;
};

export function clientApiProfiles(port: number, lanIpv4?: string | null): ClientApiProfile[] {
  const safePort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 8317;
  const origin = `http://127.0.0.1:${safePort}`;
  const lanOrigin = lanIpv4?.trim() ? `http://${lanIpv4.trim()}:${safePort}` : null;

  return [
    {
      id: 'openai',
      name: 'OpenAI',
      description: translate(getCurrentLocale(), 'kernel.access.openaiDescription'),
      baseUrl: `${origin}/v1`,
      lanUrl: lanOrigin ? `${lanOrigin}/v1` : null,
    },
    {
      id: 'claude',
      name: 'Claude',
      description: translate(getCurrentLocale(), 'kernel.access.claudeDescription'),
      baseUrl: origin,
      lanUrl: lanOrigin,
    },
    {
      id: 'gemini',
      name: 'Gemini',
      description: translate(getCurrentLocale(), 'kernel.access.geminiDescription'),
      baseUrl: origin,
      lanUrl: lanOrigin,
    },
  ];
}
