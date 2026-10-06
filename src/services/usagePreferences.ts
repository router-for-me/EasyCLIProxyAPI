import { invoke, isTauri } from '@tauri-apps/api/core';

type Preferences = Record<string, string>;
type Backend = {
  load: () => Promise<Preferences>;
  save: (values: Preferences) => Promise<unknown>;
};
const isUsageKey = (key: string) => key.startsWith('cpa-gui.usage-') || key === 'cpa-gui.pricing-sync-source.v1';

export class UsagePreferences {
  private values: Preferences = {};
  private backend?: Backend;
  private pending = Promise.resolve();

  constructor(private storage: () => Storage) {}

  async initialize(backend: Backend) {
    // A failed read must not be followed by writing defaults over the saved file.
    const saved = await backend.load();
    const legacy: Preferences = {};
    try {
      const storage = this.storage();
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && isUsageKey(key)) {
          const value = storage.getItem(key);
          if (value !== null) legacy[key] = value;
        }
      }
    } catch {}
    this.values = { ...legacy, ...saved };
    this.backend = backend;
    if (Object.keys(legacy).some((key) => !(key in saved))) await this.persist();
  }

  getItem(key: string): string | null {
    if (key in this.values) return this.values[key];
    try { return this.storage().getItem(key); } catch { return null; }
  }

  setItem(key: string, value: string) {
    if (!isUsageKey(key)) throw new Error('Unsupported usage preference');
    const changed = this.values[key] !== value;
    this.values[key] = value;
    try { this.storage().setItem(key, value); } catch {}
    if (changed && this.backend) void this.persist();
  }

  flush() { return this.pending; }

  private persist() {
    const values = { ...this.values };
    this.pending = this.pending.then(() => this.backend!.save(values)).then(() => {}, (error) => {
      console.error('Failed to save usage preferences', error);
    });
    return this.pending;
  }
}

export const usagePreferences = new UsagePreferences(() => localStorage);

export async function initializeUsagePreferences() {
  if (!isTauri()) return;
  try {
    await usagePreferences.initialize({
      load: () => invoke<Preferences>('get_usage_view_preferences'),
      save: (values) => invoke('save_usage_view_preferences', { values }),
    });
  } catch (error) {
    console.error('Failed to load usage preferences; using browser preferences', error);
  }
}
