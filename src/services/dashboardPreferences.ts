/** Display preferences must never prevent the dashboard from opening. */
export function readDashboardPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const saved = localStorage.getItem(`personal.${key}`);
    return allowed.includes(saved as T) ? saved as T : fallback;
  } catch { return fallback; }
}

export function saveDashboardPreference(key: string, value: string): void {
  try { localStorage.setItem(`personal.${key}`, value); } catch { /* Keep the current view usable without persistence. */ }
}
