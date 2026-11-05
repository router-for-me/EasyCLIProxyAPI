import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Switch } from '../src/components/Switch';
import { settingsCategories, settingsMessages } from '../src/services/settingsNavigation';
import type { ReverseProxyConfig, ReverseProxyState } from '../src/services/reverseProxy';

const root = join(import.meta.dir, '..');

describe('reverse proxy contract and settings card', () => {
  it('conforms to the frozen reverse proxy contract types', () => {
    const config: ReverseProxyConfig = {
      enabled: true,
      listenHost: '0.0.0.0',
      listenPort: 443,
      targetPort: 8317,
      certPath: '/path/to/cert.pem',
      keyPath: '/path/to/key.pem',
    };
    const state: ReverseProxyState = {
      running: true,
      listening: '0.0.0.0:443',
      target: '127.0.0.1:8317',
      requestsTotal: 42,
      error: null,
    };
    expect(config.enabled).toBe(true);
    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.listenPort).toBe(443);
    expect(config.targetPort).toBe(8317);
    expect(state.running).toBe(true);
    expect(state.requestsTotal).toBe(42);
    expect(state.error).toBeNull();
  });

  it('renders Switch toggle with role="switch" and aria-checked', () => {
    const markup = renderToStaticMarkup(
      <Switch aria-checked={true} checked={true} onChange={() => {}} title="Toggle" />
    );
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
  });

  it('includes all required i18n keys across all locales in settingsMessages', () => {
    const requiredKeys: (keyof typeof settingsMessages)[] = [
      'reverseProxyTitle',
      'reverseProxyEnable',
      'reverseProxyEnableHint',
      'reverseProxyListenHost',
      'reverseProxyListenHostHint',
      'reverseProxyListenPort',
      'reverseProxyListenPortHint',
      'reverseProxyTargetPort',
      'reverseProxyTargetPortHint',
      'reverseProxyCertPath',
      'reverseProxyCertPathHint',
      'reverseProxyKeyPath',
      'reverseProxyKeyPathHint',
      'reverseProxyStart',
      'reverseProxyStop',
      'reverseProxyRunning',
      'reverseProxyStopped',
      'reverseProxyStatus',
      'reverseProxyStatusRunning',
      'reverseProxyStatusListening',
      'reverseProxyStatusTarget',
      'reverseProxyStatusRequests',
      'reverseProxySecurityWarning',
      'reverseProxyBackendNotReady',
    ];
    for (const key of requiredKeys) {
      expect(settingsMessages[key]).toBeDefined();
      expect(settingsMessages[key].zh).toBeTruthy();
      expect(settingsMessages[key].en).toBeTruthy();
      expect(settingsMessages[key].ja).toBeTruthy();
    }
  });

  it('contains the security warning mentioning 127.0.0.1, trusted-proxies, and allow-remote: false', () => {
    const warning = settingsMessages.reverseProxySecurityWarning;
    expect(warning.zh).toContain('127.0.0.1');
    expect(warning.zh).toContain('trusted-proxies');
    expect(warning.zh).toContain('allow-remote: false');
    expect(warning.en).toContain('127.0.0.1');
    expect(warning.en).toContain('trusted-proxies');
    expect(warning.en).toContain('allow-remote: false');
    expect(warning.ja).toContain('127.0.0.1');
    expect(warning.ja).toContain('trusted-proxies');
    expect(warning.ja).toContain('allow-remote: false');
  });

  it('places config-native-reverse-proxy after config-native-tls with expected classes', () => {
    expect(settingsCategories.some(category => category.id === 'proxy')).toBe(true);
    expect(settingsMessages.reverseProxyTitle.zh).toBe('对外访问');
    expect(JSON.stringify(settingsMessages)).not.toContain('内置反向代理');

    const configPanelSrc = readFileSync(join(root, 'src/pages/ConfigPanel.tsx'), 'utf8');

    expect(configPanelSrc).toContain("activeSubpage !== 'proxy'");

    // Section placement immediately after TLS
    const tlsIndex = configPanelSrc.indexOf('id="config-native-tls"');
    const proxyIndex = configPanelSrc.indexOf('id="config-native-reverse-proxy"');
    const routingIndex = configPanelSrc.indexOf('id="config-native-routing"');

    expect(tlsIndex).toBeGreaterThan(-1);
    expect(proxyIndex).toBeGreaterThan(tlsIndex);
    expect(routingIndex).toBeGreaterThan(proxyIndex);

    // Matches existing classes
    expect(configPanelSrc).toContain('id="config-native-reverse-proxy"');
    expect(configPanelSrc).toContain('surface-card config-network-section');
    expect(configPanelSrc).toContain('config-network-section-heading config-tls-section-heading');
    expect(configPanelSrc).toContain('config-tls-section-title');

    // Required controls
    expect(configPanelSrc).toContain('aria-checked={proxyDraft.enabled}');
    expect(configPanelSrc).toContain('config-input-reverse-proxy-listen-host');
    expect(configPanelSrc).toContain('config-input-reverse-proxy-listen-port');
    expect(configPanelSrc).toContain('config-input-reverse-proxy-target-port');
    expect(configPanelSrc).toContain('config-input-reverse-proxy-cert-path');
    expect(configPanelSrc).toContain('config-input-reverse-proxy-key-path');

    // Status block
    expect(configPanelSrc).toContain('st(\'reverseProxyStatus\')');
    expect(configPanelSrc).toContain('st(\'reverseProxyStatusRunning\')');
    expect(configPanelSrc).toContain('st(\'reverseProxyStatusListening\')');
    expect(configPanelSrc).toContain('st(\'reverseProxyStatusTarget\')');
    expect(configPanelSrc).toContain('st(\'reverseProxyStatusRequests\')');

    // Error alert & backend not ready
    expect(configPanelSrc).toContain('Notice tone="error"');
    expect(configPanelSrc).toContain('st(\'reverseProxyBackendNotReady\')');
    expect(configPanelSrc).toContain('config-key-row skeleton');
  });
});
