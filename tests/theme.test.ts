import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createThemeController, type AppTheme, type NativeThemeSource, type ThemePreference } from '../src/themeController';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function setup(options: {
  preference?: ThemePreference;
  system?: AppTheme;
  media?: AppTheme;
  platform?: 'windows' | 'macos' | 'linux' | 'browser';
} = {}) {
  let saved = options.preference ?? 'system';
  let system: AppTheme | null = options.system ?? 'dark';
  let media = options.media ?? 'light';
  let displayed: AppTheme | undefined;
  let shell: AppTheme | undefined;
  let backdrop: AppTheme | undefined;
  let mediaListener: (() => void) | undefined;
  let resumeListener: (() => void) | undefined;
  let nativeListener: ((theme: AppTheme) => void) | undefined;
  let removals = 0;
  const writes: ThemePreference[] = [];
  const nativeWrites: (AppTheme | null)[] = [];
  const native: NativeThemeSource = {
    explicitSystemAppearance: options.platform === 'linux',
    async setTheme(theme) {
      nativeWrites.push(theme);
      shell = theme ?? system ?? 'light';
    },
    async readTheme() { return system; },
    async listen(listener) {
      nativeListener = listener;
      return () => { nativeListener = undefined; removals++; };
    },
    async setBackground(theme) { backdrop = theme; },
  };
  const connection = deferred<NativeThemeSource | null>();
  const controller = createThemeController({
    readPreference: () => saved,
    savePreference(value) { saved = value; writes.push(value); },
    readMediaTheme: () => media,
    listenMedia(listener) {
      mediaListener = listener;
      return () => { mediaListener = undefined; removals++; };
    },
    listenResume(listener) {
      resumeListener = listener;
      return () => { resumeListener = undefined; removals++; };
    },
    applyTheme(theme) { displayed = theme; },
    connectNative: () => connection.promise,
  });
  return {
    controller, native, writes, nativeWrites,
    get displayed() { return displayed; },
    get shell() { return shell; },
    get backdrop() { return backdrop; },
    get saved() { return saved; },
    get removals() { return removals; },
    setSystem(theme: AppTheme | null) { system = theme; },
    emitNative(theme: AppTheme) { shell = theme; nativeListener?.(theme); },
    emitMedia(theme: AppTheme) { media = theme; mediaListener?.(); },
    resume() { resumeListener?.(); },
    async connect() {
      connection.resolve(options.platform === 'browser' ? null : native);
      await settle();
    },
  };
}

describe('theme preferences and native synchronization', () => {
  for (const platform of ['windows', 'macos'] as const) {
    test(`${platform}: native startup and events win without locking system mode`, async () => {
      const app = setup({ platform, media: 'light', system: 'dark' });
      expect(app.displayed).toBe('light');
      await app.connect();
      expect(app.displayed).toBe('dark');
      expect(app.backdrop).toBe('dark');
      expect(app.nativeWrites).toEqual([null]);
      app.setSystem('light');
      app.emitNative('light');
      await settle();
      expect(app.displayed).toBe('light');
      expect(app.backdrop).toBe('light');
      expect(app.controller.getPreference()).toBe('system');
      expect(app.writes).toEqual([]);
      expect(app.nativeWrites).toEqual([null]);
      app.controller.dispose();
    });
  }

  test('native reading wins over a conflicting WebView change', async () => {
    const app = setup({ system: 'light' });
    await app.connect();
    app.emitMedia('dark');
    await settle();
    expect(app.displayed).toBe('light');
    app.controller.dispose();
  });

  test('preserves an existing manual preference and ignores system/media changes', async () => {
    const app = setup({ preference: 'light', system: 'dark' });
    await app.connect();
    app.emitMedia('dark');
    app.emitNative('dark');
    await settle();
    expect(app.displayed).toBe('light');
    expect(app.shell).toBe('light');
    expect(app.writes).toEqual([]);
    app.controller.dispose();
  });

  test('switches manual → system → manual and persists the preference, not its result', async () => {
    const app = setup({ preference: 'light', system: 'dark' });
    await app.connect();
    app.controller.setPreference('system');
    await settle();
    expect(app.displayed).toBe('dark');
    expect(app.saved).toBe('system');
    expect(app.nativeWrites).toEqual(['light', null]);
    app.controller.setPreference('light');
    app.setSystem('dark');
    app.emitNative('dark');
    await settle();
    expect(app.displayed).toBe('light');
    expect(app.shell).toBe('light');
    expect(app.saved).toBe('light');
    app.controller.dispose();
  });

  test('browser preview follows media changes, including after a manual override', async () => {
    const app = setup({ platform: 'browser' });
    await app.connect();
    app.emitMedia('dark');
    expect(app.displayed).toBe('dark');
    app.controller.setPreference('light');
    app.emitMedia('dark');
    expect(app.displayed).toBe('light');
    app.controller.setPreference('system');
    expect(app.displayed).toBe('dark');
    app.emitMedia('light');
    expect(app.displayed).toBe('light');
    app.controller.dispose();
  });

  test('failed native reads and listeners retain the media fallback', async () => {
    const app = setup();
    app.native.readTheme = async () => { throw new Error('unavailable'); };
    app.native.listen = async () => { throw new Error('unsupported'); };
    app.native.setTheme = async () => { throw new Error('unsupported'); };
    await app.connect();
    app.emitMedia('dark');
    await settle();
    expect(app.displayed).toBe('dark');
    expect(app.controller.getPreference()).toBe('system');
    app.controller.dispose();
  });

  test('refreshes after resuming from tray/sleep when a notification was missed', async () => {
    const app = setup();
    await app.connect();
    app.setSystem('light');
    app.resume();
    await settle();
    expect(app.displayed).toBe('light');
    expect(app.backdrop).toBe('light');
    app.controller.dispose();
  });

  test('a delayed initial read cannot overwrite a newer native notification', async () => {
    const app = setup();
    const reading = deferred<AppTheme>();
    app.native.readTheme = () => reading.promise;
    await app.connect();
    app.emitNative('dark');
    reading.resolve('light');
    await settle();
    expect(app.displayed).toBe('dark');
    expect(app.backdrop).toBe('dark');
    app.controller.dispose();
  });

  test('a delayed system read cannot overwrite a newer manual selection', async () => {
    const app = setup();
    const reading = deferred<AppTheme>();
    app.native.readTheme = () => reading.promise;
    await app.connect();
    app.controller.setPreference('light');
    reading.resolve('dark');
    await settle();
    expect(app.displayed).toBe('light');
    expect(app.shell).toBe('light');
    expect(app.backdrop).toBe('light');
    app.controller.dispose();
  });

  test('serializes slow native writes during rapid preference changes', async () => {
    const app = setup();
    const write = deferred<void>();
    const original = app.native.setTheme;
    app.native.setTheme = async (theme) => {
      if (theme === null) await write.promise;
      await original(theme);
    };
    await app.connect();
    app.controller.setPreference('light');
    app.controller.setPreference('dark');
    app.controller.setPreference('system');
    app.controller.setPreference('light');
    write.resolve();
    await settle();
    expect(app.nativeWrites).toEqual([null, 'light']);
    expect(app.displayed).toBe('light');
    expect(app.shell).toBe('light');
    app.controller.dispose();
  });

  test('Linux reads the portal after clearing a manual override and applies GTK appearance', async () => {
    const app = setup({ platform: 'linux', preference: 'light', system: 'dark' });
    await app.connect();
    app.controller.setPreference('system');
    await settle();
    expect(app.displayed).toBe('dark');
    expect(app.shell).toBe('dark');
    expect(app.saved).toBe('system');
    expect(app.nativeWrites).toEqual(['light', null, 'dark']);
    app.emitNative('light');
    await settle();
    expect(app.displayed).toBe('dark');
    expect(app.shell).toBe('dark');
    const writeCount = app.nativeWrites.length;
    app.emitNative('dark');
    app.emitMedia('dark');
    await settle();
    expect(app.nativeWrites.length).toBe(writeCount);
    app.setSystem('light');
    app.emitNative('light');
    await settle();
    expect(app.displayed).toBe('light');
    app.controller.dispose();
  });

  test('Linux without a portal preference falls back to WebKit', async () => {
    const app = setup({ platform: 'linux' });
    app.setSystem(null);
    await app.connect();
    app.emitMedia('dark');
    await settle();
    expect(app.displayed).toBe('dark');
    expect(app.nativeWrites).toEqual([null]);
    app.controller.dispose();
  });

  test('Linux retains a manual appearance when the portal sends a different theme', async () => {
    const app = setup({ platform: 'linux', preference: 'dark' });
    await app.connect();
    app.setSystem('light');
    app.emitNative('light');
    await settle();
    expect(app.displayed).toBe('dark');
    expect(app.shell).toBe('dark');
    app.controller.dispose();
  });

  test('Linux reconciles a system change delivered during an in-flight GTK appearance write', async () => {
    const app = setup({ platform: 'linux', system: 'dark' });
    const write = deferred<void>();
    const original = app.native.setTheme;
    app.native.setTheme = async (theme) => {
      await original(theme);
      if (theme === 'dark') await write.promise;
    };
    await app.connect();
    app.setSystem('light');
    app.emitNative('light');
    write.resolve();
    await settle();
    expect(app.displayed).toBe('light');
    expect(app.shell).toBe('light');
    expect(app.backdrop).toBe('light');
    app.controller.dispose();
  });

  test('Linux reasserts a manual mode when the portal changes GTK during the manual write', async () => {
    const app = setup({ platform: 'linux', preference: 'dark' });
    const write = deferred<void>();
    const original = app.native.setTheme;
    app.native.setTheme = async (theme) => {
      await original(theme);
      await write.promise;
    };
    await app.connect();
    app.setSystem('light');
    app.emitNative('light');
    write.resolve();
    await settle();
    expect(app.displayed).toBe('dark');
    expect(app.shell).toBe('dark');
    expect(app.backdrop).toBe('dark');
    app.controller.dispose();
  });

  test('disposes all observers and ignores late async reads', async () => {
    const app = setup();
    const reading = deferred<AppTheme>();
    app.native.readTheme = () => reading.promise;
    await app.connect();
    app.controller.dispose();
    reading.resolve('dark');
    app.emitMedia('dark');
    await settle();
    expect(app.removals).toBe(3);
    expect(app.displayed).toBe('light');
  });

  test('cleans up a native listener that attaches after disposal', async () => {
    const app = setup();
    const registration = deferred<() => void>();
    let removed = false;
    app.native.listen = () => registration.promise;
    await app.connect();
    app.controller.dispose();
    registration.resolve(() => { removed = true; });
    await settle();
    expect(removed).toBe(true);
    expect(app.nativeWrites).toEqual([]);
  });
});

describe('first paint', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  for (const [saved, dark, expected] of [
    [null, true, 'dark'], ['system', true, 'dark'], ['system', false, 'light'],
    ['light', true, 'light'], ['dark', false, 'dark'], ['invalid', true, 'dark'],
  ] as const) {
    test(`saved ${saved}, dark system ${dark} → ${expected}`, () => {
      const root = { dataset: {} as Record<string, string>, style: {} };
      runInNewContext(script, {
        localStorage: { getItem: () => saved },
        window: { matchMedia: () => ({ matches: dark }) },
        document: { documentElement: root },
      });
      expect(root.dataset.theme).toBe(expected);
    });
  }
  test('blocked storage still uses the system theme before React loads', () => {
    const root = { dataset: {} as Record<string, string>, style: {} };
    runInNewContext(script, {
      localStorage: { getItem() { throw new Error('blocked'); } },
      window: { matchMedia: () => ({ matches: true }) },
      document: { documentElement: root },
    });
    expect(root.dataset.theme).toBe('dark');
  });
});
