import { parseDocument } from 'yaml';

const isMap = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Null-prototype records preserve literal keys such as __proto__ and constructor.
const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const record = (): Record<string, unknown> => Object.create(null);

function parseConfig(source: string): Record<string, unknown> {
  const doc = parseDocument(source, { intAsBigInt: true });
  if (doc.errors.length || doc.warnings.length) {
    throw new Error(`Invalid configuration YAML: ${[...doc.errors, ...doc.warnings][0].message}`);
  }
  const active = new Set<object>();
  function convert(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error('Configuration integer is not JSON-safe');
      return number;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null || active.has(value)) {
      throw new Error('Configuration must contain only JSON-representable values');
    }
    active.add(value);
    try {
      if (Array.isArray(value)) return value.map(convert);
      if (value instanceof Map) {
        const result = record();
        for (const [key, child] of value) {
          if (typeof key !== 'string') throw new Error('Configuration map keys must be strings');
          result[key] = convert(child);
        }
        return result;
      }
      throw new Error('Configuration must contain only JSON-representable values');
    } finally {
      active.delete(value);
    }
  }
  const result = convert(doc.toJS({ mapAsMap: true, maxAliasCount: 100 }));
  if (!isMap(result)) throw new Error('Configuration root must be a map');
  return result;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  }
  if (isMap(a) && isMap(b)) {
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => hasOwn(b, key) && equal(a[key], b[key]))
    );
  }
  return false;
}

export class ConfigDraftConflictError extends Error {
  constructor(readonly path: readonly string[]) {
    super(`Configuration list changed concurrently: ${path.join('.')}`);
    this.name = 'ConfigDraftConflictError';
  }
}

/** Lists have no stable backend IDs: refuse an ambiguous three-way replacement. */
export function assertConfigListsUnchanged(
  beforeYaml: string,
  draftYaml: string,
  latestYaml: string,
  paths?: readonly (readonly string[])[]
): void {
  const before = parseConfig(beforeYaml);
  const draft = parseConfig(draftYaml);
  const latest = parseConfig(latestYaml);
  const readPath = (root: unknown, path: readonly string[]): unknown =>
    path.reduce<unknown>(
      (value, key) => (isMap(value) && hasOwn(value, key) ? value[key] : undefined),
      root
    );
  const check = (old: unknown, desired: unknown, current: unknown, path: readonly string[]) => {
    if (Array.isArray(old) || Array.isArray(desired)) {
      if (!equal(current, old) && !equal(current, desired)) {
        throw new ConfigDraftConflictError(path);
      }
      return;
    }
    const keys = new Set([
      ...Object.keys(isMap(old) ? old : {}),
      ...Object.keys(isMap(desired) ? desired : {}),
    ]);
    for (const key of keys) {
      const nextPath = [...path, key];
      const oldValue = readPath(before, nextPath);
      const desiredValue = readPath(draft, nextPath);
      if (!equal(oldValue, desiredValue)) {
        check(oldValue, desiredValue, readPath(latest, nextPath), nextPath);
      }
    }
  };
  if (paths) {
    for (const path of paths) {
      check(readPath(before, path), readPath(draft, path), readPath(latest, path), path);
    }
  } else {
    check(before, draft, latest, []);
  }
}
