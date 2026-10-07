export function readAccountNames(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('personal.accountNames') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, name]) =>
      /^[a-z0-9-]+\.json$/.test(key) && typeof name === 'string' && name.trim().length > 0 && name.length <= 80));
  } catch { return {}; }
}
export function saveAccountNames(names: Record<string, string>): boolean {
  try { localStorage.setItem('personal.accountNames', JSON.stringify(names)); return true; }
  catch { return false; }
}
