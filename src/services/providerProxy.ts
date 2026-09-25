export function normalizeProviderProxyUrl(value: string): string {
  const proxyUrl = value.trim();
  if (!proxyUrl) return '';
  if (/^(direct|none)$/i.test(proxyUrl)) return proxyUrl.toLowerCase();

  try {
    if (/\s/.test(proxyUrl)) throw new Error('invalid');
    const url = new URL(proxyUrl);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)
      || !url.hostname
      || (!url.port && !['http:', 'https:'].includes(url.protocol))
      || !['', '/'].includes(url.pathname)
      || url.search
      || url.hash) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('invalid');
  }
  return proxyUrl;
}
