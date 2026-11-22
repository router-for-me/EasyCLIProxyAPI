import { maskSecret } from '../../services/managementApi';

export const maskApiKey = maskSecret;
export const isValidApiKeyCharset = (value: string) => /^[\x21-\x7E]+$/.test(value);
export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function copyToClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
