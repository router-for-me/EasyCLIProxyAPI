import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import App from '../../src/App';
import { I18nProvider } from '../../src/i18n';
import { initializeTheme, initializeThemePreferences } from '../../src/theme';
import type { AppTheme } from '../../src/themeController';
import { extensionRegistry, ThemeExtensionFixture } from './themeExtensions';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
const platform = params.get('platform') || 'windows';
let saveError = params.has('save-error');
localStorage.setItem('easy-cli-proxy-api.theme', 'dark');
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') || 'zh-CN');
let system: AppTheme = params.get('system') === 'light' ? 'light' : 'dark';
let override: AppTheme | null = null;
let appearance: AppTheme = system;
const calls: { cmd: string; args: unknown }[] = [];
const customTheme = (id: string, name: unknown, extra = {}) => JSON.stringify({
  schemaVersion: 1, id, name, appearance: 'dark', windowBackground: '#0E1A1F', tokens: { workspaceBackground: '#0E1A1F', accent: '#6FD3C1' }, ...extra,
});
let customError = params.has('custom-error');
let customOmitted = params.has('custom') ? 3 : 0;
let customThemes = params.has('custom') ? [
  { folder: 'a-harbor', content: customTheme('harbor-dark', { en: 'Harbor', 'zh-CN': '港湾' }) },
  { folder: 'b-broken', content: '{' },
  { folder: 'c-duplicate', content: customTheme('dark', 'Shadow') },
  { folder: 'd-extra', content: customTheme('extra-dark', 'Extra', { order: 1 }) },
  { folder: 'e-large', content: null },
] : params.has('glass') ? [
  { folder: 'glass', content: customTheme('glass-dark', 'Glass', { windowMaterial: 'translucent' }) },
] : [];
const notify = (theme: AppTheme) => emit('tauri://theme-changed', theme);
mockWindows('main');
mockIPC(async (cmd, args: any) => {
  calls.push({ cmd, args });
  if (cmd === 'get_theme_selection') {
    if (params.has('read-error')) throw new Error('Unreadable configuration');
    const response = await fetch('/__theme_fixture_selection');
    return response.ok ? response.json() : null;
  }
  if (cmd === 'save_theme_selection') {
    if (saveError) throw new Error('Disk full');
    await fetch('/__theme_fixture_selection', { method: 'POST', body: JSON.stringify(args.selection) });
    return;
  }
  if (cmd === 'list_custom_themes') {
    if (customError) throw new Error('Permission denied');
    return { files: customThemes, omitted: customOmitted };
  }
  if (cmd === 'open_custom_themes_directory') {
    if (params.has('open-error')) throw new Error('No file manager');
    return;
  }
  if (cmd === 'detect_window_material') return params.get('material');
  if (cmd === 'set_window_material') {
    await new Promise(resolve => setTimeout(resolve, Number(params.get('material-delay') ?? 0)));
    if (params.has('material-error') && args.material) throw new Error('Material unavailable');
    return;
  }
  if (cmd === 'detect_core_platform') return { os: platform, arch: 'x86_64' };
  if (cmd === 'get_linux_system_theme') return params.has('no-portal') ? null : system;
  if (cmd === 'plugin:window|theme') return override ?? system;
  if (cmd === 'plugin:window|set_theme') {
    override = args.value ?? null;
    appearance = override ?? (platform === 'linux' ? 'light' : system);
    const changed = appearance;
    setTimeout(() => void notify(changed), 0);
    return;
  }
  if (cmd.includes('background_color') || cmd === 'set_app_locale') return;
  if (cmd === 'plugin:app|version') return '0.0.0';
  if (cmd === 'get_core_status') return { installed: false, running: false, starting: false, managed: false };
  if (cmd === 'get_gui_settings') return { host: '127.0.0.1', port: 8317, closeBehavior: 'ask' };
  if (cmd === 'get_core_config_settings') return { apiKeys: [] };
  if (cmd === 'get_core_tls_settings') return { enabled: false };
  if (cmd === 'check_app_update') return { updateAvailable: false, currentVersion: '0.0.0' };
  if (cmd === 'get_app_update_task') return { running: false, phase: 'idle' };
  if (cmd === 'check_latest_core') return { version: '0.0.0' };
  throw new Error(`Theme fixture does not implement ${cmd}`);
}, { shouldMockEvents: true });
Object.assign(window, {
  isTauri: platform !== 'browser',
  themeFixture: {
    calls,
    get appearance() { return appearance; },
    setSaveError(value: boolean) { saveError = value; },
    setCustomThemes(files: typeof customThemes, error = false) { customThemes = files; customError = error; customOmitted = 0; },
    async setSystem(theme: AppTheme) {
      system = theme;
      if (platform === 'linux' || override === null) {
        appearance = theme;
        await notify(theme);
      }
    },
  },
});
await initializeThemePreferences();
initializeTheme(params.has('extensions') ? extensionRegistry : undefined);
createRoot(document.getElementById('root')!).render(
  <StrictMode><I18nProvider>{params.has('extensions') ? <ThemeExtensionFixture /> : <App />}</I18nProvider></StrictMode>,
);
