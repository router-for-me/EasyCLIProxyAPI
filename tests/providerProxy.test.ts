import { normalizeProviderProxyUrl } from '../src/services/providerProxy';

describe('provider proxy URL', () => {
  it('accepts supported proxies and explicit direct connections', () => {
    expect(normalizeProviderProxyUrl(' socks5://user:pass@127.0.0.1:1080 ')).toBe('socks5://user:pass@127.0.0.1:1080');
    expect(normalizeProviderProxyUrl('HTTP://127.0.0.1:7890')).toBe('HTTP://127.0.0.1:7890');
    expect(normalizeProviderProxyUrl(' DIRECT ')).toBe('direct');
    expect(normalizeProviderProxyUrl('none')).toBe('none');
    expect(normalizeProviderProxyUrl('')).toBe('');
  });

  it('rejects PAC URLs, paths, and missing SOCKS ports', () => {
    for (const url of ['https://proxy.example/proxy.pac', 'http://proxy.example/path', 'socks5://proxy.example', 'ftp://proxy.example:21', 'not a url']) {
      expect(() => normalizeProviderProxyUrl(url)).toThrow();
    }
  });
});
