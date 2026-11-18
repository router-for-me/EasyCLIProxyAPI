import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { defaultAutoUpdateSettings, validateAutoUpdateSettings, type AutoUpdateSettings, type AutoUpdateStatus } from '../src/services/autoUpdate';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';
import { supportedLocales, translate, I18nProvider } from '../src/i18n';
import { AutoUpdatePanel } from '../src/components/AutoUpdatePanel';

describe('automatic update policy', () => {
  it('is off by default and requires an explicit target when enabled', () => {
    expect(defaultAutoUpdateSettings).toEqual({ enabled: false, updateApp: false, updateCore: false });
    expect(validateAutoUpdateSettings(defaultAutoUpdateSettings)).toBeNull();
    const enabled = { ...defaultAutoUpdateSettings, enabled: true };
    expect(validateAutoUpdateSettings(enabled)).toBe('autoUpdate.selectTarget');
    expect(validateAutoUpdateSettings({ ...enabled, updateApp: true })).toBeNull();
    expect(validateAutoUpdateSettings({ ...enabled, updateCore: true })).toBeNull();
  });
  it('saves independent targets without triggering an installation', async () => {
    const runtime = createBrowserMockRuntime('stopped');
    const settings: AutoUpdateSettings = { ...defaultAutoUpdateSettings, enabled: true, updateCore: true };
    const saved = await runtime.invoke('set_auto_update_settings', { settings }) as AutoUpdateStatus;
    expect(saved.settings).toEqual(settings);
    expect(saved.phase).toBe('waiting-update');
    const initial = await runtime.invoke('get_auto_update_status') as AutoUpdateStatus;
    expect(initial.settings).toEqual(settings);
    expect((await runtime.invoke('get_app_update_task') as { running: boolean }).running).toBe(false);
    expect((await runtime.invoke('get_core_install_task') as { running: boolean }).running).toBe(false);
    await expect(runtime.invoke('set_auto_update_settings', { settings: { ...settings, updateCore: false } })).rejects.toThrow();
    expect((await runtime.invoke('get_auto_update_status') as AutoUpdateStatus).settings).toEqual(settings);
  });
  it('renders an initially disabled control without a native session', () => {
    const markup = renderToStaticMarkup(createElement(I18nProvider, null, createElement(AutoUpdatePanel)));
    expect(markup).toContain('auto-update-panel');
    expect(markup).toContain('role="switch"');
    expect(markup).not.toContain('checked=""');
  });
  it('localizes settings, eligibility, and retry states in every language', () => {
    for (const locale of supportedLocales) {
      for (const key of ['title', 'downloadHint', 'phase.waiting-startup', 'phase.installing', 'phase.failed']) {
        const message = translate(locale, `autoUpdate.${key}`);
        expect(message).toBeTruthy();
        expect(message).not.toBe(`autoUpdate.${key}`);
      }
    }
  });
});
