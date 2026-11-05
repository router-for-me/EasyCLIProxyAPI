import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Switch } from '../src/components/Switch';
import { resolveReverseProxySaveConfig, settingsCategories, settingsMessages } from '../src/services/settingsNavigation';
import type { ReverseProxyConfig, ReverseProxyState } from '../src/services/reverseProxy';
import { reverseProxyPathErrors } from '../src/services/reverseProxy';

const root = join(import.meta.dir, '..');

describe('reverse proxy contract and settings card', () => {
  it('keeps PEM inputs out of browser autofill', () => {
    const source = readFileSync(join(root, 'src/pages/ConfigPanel.tsx'), 'utf8');
    for (const field of ['cert', 'key']) {
      const input = source.match(new RegExp(`<input\\s+id="config-input-reverse-proxy-${field}-path"[\\s\\S]*?/>`))?.[0];
      expect(input).toBeDefined();
      for (const attribute of [`name="rp-${field}-path-nofill"`, 'autoComplete="off"', 'autoCorrect="off"', 'autoCapitalize="off"', 'spellCheck={false}']) {
        expect(input).toContain(attribute);
      }
      expect(input).toContain(`updateProxyPath('${field === 'cert' ? 'certPath' : 'keyPath'}', event.currentTarget.value)`);
    }
  });

  it('maps missing or invalid PEM errors to inline path errors', () => {
    const certError = 'Certificate file does not exist: /missing/cert.pem';
    const keyError = 'Failed to read private key file: /missing/key.pem';
    const tlsError = 'Invalid TLS certificate/key configuration: mismatch';
    expect(reverseProxyPathErrors(certError)).toEqual({ certPath: certError });
    expect(reverseProxyPathErrors(new Error(keyError)).keyPath).toContain(keyError);
    expect(reverseProxyPathErrors(tlsError)).toEqual({ certPath: tlsError, keyPath: tlsError });
    expect(reverseProxyPathErrors('Failed to bind listener on 0.0.0.0:443')).toEqual({});
  });
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
      'reverseProxyIntro',
      'reverseProxyEnable',
      'reverseProxyEnableHint',
      'reverseProxyRouteTitle',
      'reverseProxyRoutePublic',
      'reverseProxyRouteLocal',
      'reverseProxyCertTitle',
      'reverseProxyCertIntro',
      'reverseProxyAdvancedTitle',
      'reverseProxyAdvancedHint',
      'reverseProxyBindHint',
      'reverseProxyHardeningOk',
      'reverseProxyHardeningPending',
      'reverseProxyHardeningFailed',
      'reverseProxyListenHost',
      'reverseProxyListenHostHint',
      'reverseProxyListenPort',
      'reverseProxyListenPortHint',
      'reverseProxyTargetPort',
      'reverseProxyTargetPortHint',
      'reverseProxyCertPath',
      'reverseProxyCertPathHint',
      'reverseProxyCertPlaceholder',
      'reverseProxyKeyPath',
      'reverseProxyKeyPathHint',
      'reverseProxyKeyPlaceholder',
      'reverseProxySelectCertTitle',
      'reverseProxySelectKeyTitle',
      'reverseProxyCertFile',
      'reverseProxyKeyFile',
      'reverseProxyStart',
      'reverseProxyStop',
      'reverseProxyRunning',
      'reverseProxyStopped',
      'reverseProxyStatus',
      'reverseProxyStatusRunning',
      'reverseProxyStatusListening',
      'reverseProxyStatusTarget',
      'reverseProxyStatusRequests',
      'reverseProxyBackendNotReady',
      'reverseProxySaved',
      'reverseProxyRoutePreview',
      'reverseProxyRouteClientHint',
      'reverseProxyRouteHostPlaceholder',
      'reverseProxySaveApplyHint',
    ];
    for (const key of requiredKeys) {
      expect(settingsMessages[key]).toBeDefined();
      expect(settingsMessages[key].zh).toBeTruthy();
      expect(settingsMessages[key].en).toBeTruthy();
      expect(settingsMessages[key].ja).toBeTruthy();
    }
  });

  it('describes core protection via loopback bind and trusted-proxies in every locale', () => {
    for (const key of ['reverseProxyEnableHint', 'reverseProxyHardeningOk'] as const) {
      const message = settingsMessages[key];
      for (const locale of ['zh', 'en', 'ja'] as const) {
        expect(message[locale]).toContain('127.0.0.1');
        expect(message[locale]).toContain('trusted-proxies');
      }
    }
    // Listen host is fixed and read-only in every locale
    expect(settingsMessages.reverseProxyBindHint.zh).toContain('不可修改');
    expect(settingsMessages.reverseProxyBindHint.en).toContain('read-only');
    expect(settingsMessages.reverseProxyBindHint.ja).toContain('変更不可');
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
    expect(configPanelSrc).toContain('disabled={proxyControlsDisabled}');
    expect(configPanelSrc).toContain('config-input-reverse-proxy-listen-port');
    expect(configPanelSrc).toContain('config-input-reverse-proxy-target-port');
    expect(configPanelSrc).toContain('config-input-reverse-proxy-cert-path');
    expect(configPanelSrc).toContain('config-input-reverse-proxy-key-path');

    // PEM inputs are controlled by the draft
    expect(configPanelSrc).toContain('value={proxyDraft.certPath}');
    expect(configPanelSrc).toContain('value={proxyDraft.keyPath}');

    // Listen host is not editable: fixed 0.0.0.0 shown read-only in advanced settings
    expect(configPanelSrc).not.toContain('config-input-reverse-proxy-listen-host');
    expect(configPanelSrc).toContain("<summary>{st('reverseProxyAdvancedTitle')}</summary>");
    expect(configPanelSrc).toContain('<code>0.0.0.0</code>');
    expect(configPanelSrc).toContain("st('reverseProxyBindHint')");

    // Status block with running/stopped state
    expect(configPanelSrc).toContain('st(\'reverseProxyStatus\')');
    expect(configPanelSrc).toContain('st(\'reverseProxyStatusRunning\')');
    expect(configPanelSrc).toContain('st(\'reverseProxyStatusListening\')');
    expect(configPanelSrc).toContain('st(\'reverseProxyStatusTarget\')');
    expect(configPanelSrc).toContain('st(\'reverseProxyStatusRequests\')');
    expect(configPanelSrc).toContain("proxyState?.running ? st('reverseProxyRunning') : st('reverseProxyStopped')");

    // Core protection notices driven by hardening state
    expect(configPanelSrc).toContain('proxyState?.hardening');
    expect(configPanelSrc).toContain('st(\'reverseProxyHardeningOk\')');
    expect(configPanelSrc).toContain('st(\'reverseProxyHardeningPending\')');
    expect(configPanelSrc).toContain('st(\'reverseProxyHardeningFailed\')');

    // Inline errors for missing or invalid PEM files
    expect(configPanelSrc).toContain('config.error.reverseProxyPathsRequired');
    expect(configPanelSrc).toContain('reverseProxyPathErrors(error)');
    expect(configPanelSrc).toContain('config-reverse-proxy-cert-path-error');
    expect(configPanelSrc).toContain('config-reverse-proxy-key-path-error');

    // Error alert & backend not ready
    expect(configPanelSrc).toContain('Notice tone="error"');
    expect(configPanelSrc).toContain('Notice tone="warn"');
    expect(configPanelSrc).toContain('st(\'reverseProxyBackendNotReady\')');
    expect(configPanelSrc).toContain('config-key-row skeleton');
  });

  it('persists proxy config through the backend service contract', () => {
    const serviceSrc = readFileSync(join(root, 'src/services/reverseProxy.ts'), 'utf8');
    expect(serviceSrc).toContain("'reverse_proxy_get_state'");
    expect(serviceSrc).toContain("'reverse_proxy_apply'");
    expect(serviceSrc).toContain('config?: ReverseProxyConfig | null');

    const configPanelSrc = readFileSync(join(root, 'src/pages/ConfigPanel.tsx'), 'utf8');
    expect(configPanelSrc).toContain('applyReverseProxyConfig(saveConfig)');
    expect(configPanelSrc).toContain('setProxyDraft(state.config)');
    expect(configPanelSrc).toContain('setProxyDraft({ ...DEFAULT_REVERSE_PROXY_DRAFT, ...state.config })');
  });

  it('lets a disabled save with an invalid draft reach the backend using the last saved config', () => {
    const saved: ReverseProxyConfig = {
      enabled: true,
      listenHost: '0.0.0.0',
      listenPort: 443,
      targetPort: 8317,
      certPath: '/saved/cert.pem',
      keyPath: '/saved/key.pem',
    };
    // The user cleared the listen port (draft port 0) and emptied the PEM paths,
    // then toggled the switch off: the apply payload must carry enabled=false with
    // the last saved values, discarding the invalid draft fields entirely.
    const draft: ReverseProxyConfig = {
      enabled: false,
      listenHost: '0.0.0.0',
      listenPort: 0,
      targetPort: 0,
      certPath: '',
      keyPath: '',
    };
    const payload = resolveReverseProxySaveConfig(draft, saved);
    expect(payload).toEqual({ ...saved, enabled: false });
    expect(payload.listenPort).toBe(443);
    expect(payload.certPath).toBe('/saved/cert.pem');
    // Without a saved config the draft still goes through untouched except enabled=false.
    expect(resolveReverseProxySaveConfig(draft, null)).toEqual(draft);
    // Enabled drafts keep strict validation semantics and pass through unchanged.
    expect(resolveReverseProxySaveConfig(saved, null)).toEqual(saved);

    const configPanelSrc = readFileSync(join(root, 'src/pages/ConfigPanel.tsx'), 'utf8');
    // Save resolves the disabled payload from the last saved config before applying.
    expect(configPanelSrc).toContain('resolveReverseProxySaveConfig(normalizedDraft, proxyState?.config)');
    expect(configPanelSrc).toContain('validateReverseProxyDraft(saveConfig)');
    // Port validation only runs while the draft is enabled so clearing a port
    // cannot block toggling the listener off.
    const validator = configPanelSrc.match(/const validateReverseProxyDraft = \(draft: ReverseProxyConfig\): ReverseProxyFieldError => \{([\s\S]*?)return errors;/)?.[1];
    expect(validator).toBeDefined();
    expect(validator!.indexOf('if (draft.enabled)')).toBeGreaterThanOrEqual(0);
    expect(validator!.indexOf('isValidPort(draft.listenPort)')).toBeGreaterThan(validator!.indexOf('if (draft.enabled)'));
  });

  it('labels the draft route as a listen-bind preview and only advertises real client addresses', () => {
    const configPanelSrc = readFileSync(join(root, 'src/pages/ConfigPanel.tsx'), 'utf8');
    // Draft 0.0.0.0:port is explicitly a bind preview, not a client address.
    expect(configPanelSrc).toContain("st('reverseProxyRoutePreview')");
    expect(configPanelSrc).toContain("st('reverseProxyRouteClientHint')");
    expect(configPanelSrc).toContain("st('reverseProxySaveApplyHint')");
    // Running address uses the detected LAN IP and the actual saved listen port.
    expect(configPanelSrc).toContain('https://${proxyLanIp');
    expect(configPanelSrc).toContain("st('reverseProxyRouteHostPlaceholder')");
    expect(configPanelSrc).toContain("st('reverseProxyRoutePublic')");
    expect(configPanelSrc).toContain("st('reverseProxyRouteLocal')");
    expect(configPanelSrc).toContain('proxyState.listening');
    // Wildcard or placeholder hostnames are never shown as a client address.
    expect(configPanelSrc).not.toContain('tauri.localhost');
    expect(configPanelSrc).not.toMatch(/https?:\/\/0\.0\.0\.0/);
  });
});
