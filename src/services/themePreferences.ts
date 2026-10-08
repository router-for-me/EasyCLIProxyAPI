import type { ThemePreference } from '../themeController';

const STORAGE_KEY = 'easy-cli-proxy-api.theme';
type Backend = {
  load(): Promise<ThemePreference | null>;
  save(preference: ThemePreference): Promise<unknown>;
};

export class ThemePreferences {
  private value?: ThemePreference;
  private backend?: Backend;
  private pending = Promise.resolve();

  constructor(private storage: () => Storage) {}

  private readLegacy(): ThemePreference | null {
    try {
      const saved = this.storage().getItem(STORAGE_KEY);
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    } catch {}
    return null;
  }

  get(): ThemePreference {
    return this.value ?? this.readLegacy() ?? 'system';
  }

  async initialize(backend: Backend) {
    // Do not overwrite a file with fallback defaults if reading it fails.
    const saved = await backend.load();
    const legacy = this.readLegacy();
    this.backend = backend;
    this.value = saved ?? legacy ?? 'system';
    if (saved !== null) this.cache(saved);
    else if (legacy !== null) {
      this.set(legacy);
      await this.flush();
    }
  }

  private cache(preference: ThemePreference) {
    try { this.storage().setItem(STORAGE_KEY, preference); } catch {}
  }

  set(preference: ThemePreference) {
    this.value = preference;
    this.cache(preference);
    if (this.backend) {
      this.pending = this.pending.then(() => this.backend!.save(preference)).then(() => {}, () => {
        console.error('Failed to save theme preference');
      });
    }
  }

  flush() { return this.pending; }
}
