export type AppTheme = 'light' | 'dark';
export type ThemePreference = AppTheme | 'system';
type Unlisten = () => void;

export interface NativeThemeSource {
  setTheme(theme: AppTheme | null): Promise<void>;
  readTheme(): Promise<AppTheme | null>;
  listen(listener: (theme: AppTheme) => void): Promise<Unlisten>;
  setBackground(theme: AppTheme): Promise<void>;
  explicitSystemAppearance: boolean;
}

export interface ThemeEnvironment {
  readPreference(): ThemePreference;
  savePreference(preference: ThemePreference): void;
  readMediaTheme(): AppTheme;
  listenMedia(listener: () => void): Unlisten;
  listenResume(listener: () => void): Unlisten;
  applyTheme(theme: AppTheme): void;
  connectNative(): Promise<NativeThemeSource | null>;
}

export function createThemeController(environment: ThemeEnvironment) {
  let preference = environment.readPreference();
  let native: NativeThemeSource | null = null;
  let disposed = false;
  let generation = 0;
  let observation = 0;
  let configuring = false;
  let nativeAppearance: AppTheme | null | undefined;
  let queue = Promise.resolve();
  const subscribers = new Set<Unlisten>();
  const cleanup: Unlisten[] = [];
  const current = (version: number) => !disposed && version === generation;
  const apply = (theme: AppTheme) => environment.applyTheme(theme);

  function enqueue(work: () => Promise<void>) {
    queue = queue.then(work).catch(() => {
    });
  }

  async function background(theme: AppTheme, version: number) {
    if (current(version) && native) await native.setBackground(theme);
  }

  async function readSystem(version: number) {
    if (!current(version) || preference !== 'system' || !native) return;
    const reading = ++observation;
    const theme = await native.readTheme().catch(() => null);
    if (!current(version) || reading !== observation) return;
    const resolved = theme ?? environment.readMediaTheme();
    apply(resolved);
    if (theme && native.explicitSystemAppearance && nativeAppearance !== theme) {
      configuring = true;
      try {
        nativeAppearance = theme;
        await native.setTheme(theme);
      } catch {
        nativeAppearance = undefined;
      } finally {
        configuring = false;
      }
      if (nativeAppearance && nativeAppearance !== theme) refreshSystem();
    }
    await background(resolved, version);
  }

  function refreshSystem() {
    if (disposed || preference !== 'system') return;
    if (!native) {
      apply(environment.readMediaTheme());
      return;
    }
    const version = generation;
    enqueue(() => readSystem(version));
  }

  function configureNative() {
    const version = generation;
    enqueue(async () => {
      if (!current(version) || !native) return;
      configuring = true;
      try {
        nativeAppearance = preference === 'system' ? null : preference;
        await native.setTheme(nativeAppearance);
      } catch {
        nativeAppearance = undefined;
      } finally {
        configuring = false;
      }
      if (!current(version)) return;
      if (preference === 'system') await readSystem(version);
      else {
        if (nativeAppearance && nativeAppearance !== preference) configureNative();
        await background(preference, version);
      }
    });
  }

  function nativeChanged(theme: AppTheme) {
    if (disposed || !native) return;
    nativeAppearance = theme;
    if (configuring) return;
    if (preference !== 'system') {
      if (theme !== preference) configureNative();
      return;
    }
    if (native.explicitSystemAppearance) {
      refreshSystem();
      return;
    }
    ++observation;
    apply(theme);
    const version = generation;
    enqueue(() => background(theme, version));
  }

  apply(preference === 'system' ? environment.readMediaTheme() : preference);
  cleanup.push(environment.listenMedia(refreshSystem), environment.listenResume(refreshSystem));
  void environment.connectNative().then(async (source) => {
    if (disposed || !source) return;
    native = source;
    try {
      const unlisten = await source.listen(nativeChanged);
      if (disposed) unlisten();
      else cleanup.push(unlisten);
    } catch {
    }
    if (!disposed) configureNative();
  }).catch(() => {
  });

  return {
    getPreference: () => preference,
    subscribe(listener: Unlisten) {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    setPreference(next: ThemePreference) {
      if (disposed || preference === next) return;
      preference = next;
      ++generation;
      ++observation;
      environment.savePreference(next);
      if (next !== 'system') apply(next);
      else if (!native) apply(environment.readMediaTheme());
      configureNative();
      subscribers.forEach((listener) => listener());
    },
    dispose() {
      disposed = true;
      ++generation;
      cleanup.forEach((unlisten) => unlisten());
      subscribers.clear();
    },
  };
}
