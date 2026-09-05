import { readBoolean, readString } from './managementApi';
import { getCurrentLocale, translate } from '../i18n';

export type AuthFileRecord = Record<string, unknown>;
export type AuthFileSnapshot = Map<string, string>;
export type AuthFileBatchAction = 'enable' | 'disable' | 'delete';

export const authFileName = (file: AuthFileRecord) =>
  readString(file, 'name') || translate(getCurrentLocale(), 'authFiles.unnamed');

export const isRuntimeOnlyAuthFile = (file: AuthFileRecord) =>
  readBoolean(file, 'runtime_only', 'runtimeOnly');

export const authFilesForBatchAction = (
  files: AuthFileRecord[],
  selectedNames: ReadonlySet<string>,
  action: AuthFileBatchAction,
) => files.filter((file) => {
  if (!selectedNames.has(authFileName(file))) return false;
  if (action === 'delete') return !isRuntimeOnlyAuthFile(file);
  const disabled = readBoolean(file, 'disabled');
  return action === 'enable' ? disabled : !disabled;
});

export const parseAuthFilePriority = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return undefined;
  const priority = Number(normalized);
  return Number.isSafeInteger(priority) ? priority : undefined;
};

export const normalizeAuthFilePriorityInput = (value: string): number | null => {
  const normalized = value.trim();
  if (!normalized) return 0;
  return parseAuthFilePriority(normalized) ?? null;
};

const normalizeOAuthProvider = (value: string) => {
  const provider = value.trim().toLowerCase();
  if (provider === 'anthropic') return 'claude';
  if (provider === 'openai') return 'codex';
  return provider;
};

const authFileProvider = (file: AuthFileRecord) =>
  normalizeOAuthProvider(readString(file, 'provider', 'type'));

export const snapshotAuthFiles = (files: AuthFileRecord[]): AuthFileSnapshot => {
  const grouped = new Map<string, string[]>();
  files.forEach((file) => {
    const name = readString(file, 'name');
    if (!name) return;
    const fingerprints = grouped.get(name) ?? [];
    fingerprints.push(JSON.stringify(file));
    grouped.set(name, fingerprints);
  });
  return new Map(Array.from(grouped, ([name, fingerprints]) => [
    name,
    fingerprints.sort().join('\n'),
  ]));
};

export const changedOAuthAuthFileNames = (
  before: AuthFileSnapshot,
  files: AuthFileRecord[],
  provider: string,
) => {
  const expectedProvider = normalizeOAuthProvider(provider);
  const after = snapshotAuthFiles(files);
  const names = new Set<string>();
  files.forEach((file) => {
    const name = readString(file, 'name');
    if (!name || authFileProvider(file) !== expectedProvider) return;
    const priority = parseAuthFilePriority(file.priority);
    if (priority !== undefined && priority !== 0) return;
    if (before.get(name) !== after.get(name)) names.add(name);
  });
  return Array.from(names);
};

const hasMeaningfulValue = (value: unknown) => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

const authFileTimestamp = (file: AuthFileRecord) => {
  for (const value of [file.modtime, file.updated_at, file.last_refresh]) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = new Date(String(value)).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
};

const authFilePriority = (file: AuthFileRecord) => {
  let score = 0;
  if (readString(file, 'source').toLowerCase() === 'file') score += 32;
  if (readString(file, 'path')) score += 16;
  if (!isRuntimeOnlyAuthFile(file)) score += 8;
  if (!readBoolean(file, 'disabled')) score += 4;
  if (authFileTimestamp(file) > 0) score += 2;
  return score;
};

const mergeDuplicateAuthFiles = (entries: AuthFileRecord[]) => {
  const sorted = [...entries].sort((left, right) => {
    const priority = authFilePriority(right) - authFilePriority(left);
    if (priority !== 0) return priority;
    const timestamp = authFileTimestamp(right) - authFileTimestamp(left);
    if (timestamp !== 0) return timestamp;
    return Object.values(right).filter(hasMeaningfulValue).length
      - Object.values(left).filter(hasMeaningfulValue).length;
  });
  const merged = { ...sorted[0] };
  sorted.slice(1).forEach((entry) => {
    Object.entries(entry).forEach(([key, value]) => {
      if (!hasMeaningfulValue(merged[key]) && hasMeaningfulValue(value)) merged[key] = value;
    });
  });
  return merged;
};

export const dedupeAuthFiles = (files: AuthFileRecord[]) => {
  const grouped = new Map<string, AuthFileRecord[]>();
  files.forEach((file, index) => {
    const key = authFileName(file) || `unnamed-${index}`;
    const entries = grouped.get(key) ?? [];
    entries.push(file);
    grouped.set(key, entries);
  });
  return Array.from(grouped.values())
    .map(mergeDuplicateAuthFiles)
    .sort((left, right) =>
      authFileName(left).localeCompare(authFileName(right), undefined, { sensitivity: 'base' }),
    );
};
