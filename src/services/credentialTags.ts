export const CREDENTIAL_TAGS_STORAGE_KEY = 'easy-cli-proxy-api.credential-tags';

export const normalizeAuthFileTags = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean))]
    : [];

const readTags = (): Map<string, string[]> => {
  try {
    const payload: unknown = JSON.parse(localStorage.getItem(CREDENTIAL_TAGS_STORAGE_KEY) ?? '{}');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return new Map();
    return new Map(Object.entries(payload).flatMap(([name, tags]) =>
      Array.isArray(tags) ? [[name, normalizeAuthFileTags(tags)] as const] : []));
  } catch {
    return new Map();
  }
};

export const getCredentialTags = (name: string): string[] => readTags().get(name) ?? [];

export const setCredentialTags = (name: string, tags: unknown): string[] => {
  const normalized = normalizeAuthFileTags(tags);
  if (typeof localStorage === 'undefined') return normalized;
  const stored = readTags();
  stored.set(name, normalized);
  localStorage.setItem(CREDENTIAL_TAGS_STORAGE_KEY, JSON.stringify(Object.fromEntries(stored)));
  return normalized;
};

export const resolveCredentialTags = (name: string, incoming: unknown): string[] => {
  const existing = readTags().get(name);
  if (existing) return existing;
  const normalized = normalizeAuthFileTags(incoming);
  if (!normalized.length) return [];
  return setCredentialTags(name, normalized);
};

export const mergeCredentialTags = <File extends Record<string, unknown>>(files: File[]): File[] =>
  files.map(file => typeof file.name === 'string'
    ? { ...file, tags: resolveCredentialTags(file.name, file.tags) }
    : file);
