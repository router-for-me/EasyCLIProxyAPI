import { isRecord, readString } from './managementApi';
import { cleanProviderGroup, providerGroupIdentity } from './providerGroups';

type ProviderRecord = Record<string, unknown>;

export type ProviderEntrySource = {
  groups: ProviderRecord[];
  groupIndex: number;
  keyIndex?: number;
  group: ProviderRecord;
};

export type ProviderEntry = { record: ProviderRecord; source: ProviderEntrySource };

const own = (record: ProviderRecord, field: string) => Object.prototype.hasOwnProperty.call(record, field);
const cleanGroups = (groups: ProviderRecord[]) => structuredClone(groups.map(cleanProviderGroup));
const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const fields = Object.keys(left);
  return fields.length === Object.keys(right).length
    && fields.every((field) => own(right, field) && equal(left[field], right[field]));
};

// Ordinary providers are edited one credential at a time; the source retains
// the native group and the distinction between inherited and explicit values.
export function providerEntries(section: string, groups: ProviderRecord[]): ProviderEntry[] {
  const snapshot = structuredClone(groups);
  return snapshot.flatMap((group, groupIndex) => {
    if (section === 'openai-compatibility') {
      return [{ record: structuredClone(group), source: { groups: snapshot, groupIndex, group } }];
    }
    const { name: _name, keys: _keys, ...shared } = group;
    return (Array.isArray(group.keys) ? group.keys : []).flatMap((key, keyIndex) => {
      if (!isRecord(key)) return [];
      const overrides = Object.fromEntries(Object.entries(key).filter(([, value]) => value !== null));
      return [{
        record: structuredClone({ ...shared, ...overrides }),
        source: { groups: snapshot, groupIndex, keyIndex, group },
      }];
    });
  });
}

const staleEntry = () => new Error('Provider configuration changed or the selected entry is ambiguous. Refresh and try again.');

export function locateProviderEntry(
  groups: ProviderRecord[], source: ProviderEntrySource,
): { groupIndex: number; keyIndex?: number } {
  const identity = providerGroupIdentity(source.group);
  const snapshotGroup = source.groups[source.groupIndex];
  if (!snapshotGroup || providerGroupIdentity(snapshotGroup) !== identity) throw staleEntry();
  const snapshot = source.groups.map(providerGroupIdentity);
  const current = groups.map(providerGroupIdentity);
  let groupIndex: number;
  if (equal(snapshot, current)) {
    // An unchanged complete snapshot also identifies identical groups safely.
    groupIndex = source.groupIndex;
  } else {
    const oldMatches = snapshot.filter((item) => item === identity);
    const matches = current.flatMap((item, index) => item === identity ? [index] : []);
    if (oldMatches.length !== 1 || matches.length !== 1) throw staleEntry();
    groupIndex = matches[0];
  }
  if (source.keyIndex === undefined) return { groupIndex };
  const keys = groups[groupIndex].keys;
  if (!Number.isInteger(source.keyIndex) || !Array.isArray(keys) || !isRecord(keys[source.keyIndex])) throw staleEntry();
  return { groupIndex, keyIndex: source.keyIndex };
}

const namesIn = (groups: ProviderRecord[]) => new Set(groups.map((group) => readString(group, 'name')));
const fragmentName = (group: ProviderRecord, names: Set<string>) => {
  const base = readString(group, 'name').trim() || 'provider';
  let suffix = 2;
  let name = base;
  while (names.has(name)) name = `${base}-${suffix++}`;
  names.add(name);
  return name;
};

export function appendProviderEntry(groups: ProviderRecord[], section: string, record: ProviderRecord): ProviderRecord[] {
  const next = cleanGroups(groups);
  if (section === 'openai-compatibility') return [...next, structuredClone(cleanProviderGroup(record))];
  const family = section.replace(/-api-key$/, '');
  const names = namesIn(next);
  let suffix = 1;
  while (names.has(`${family}-${suffix}`)) suffix++;
  const key = structuredClone(cleanProviderGroup(record));
  const group: ProviderRecord = { name: `${family}-${suffix}` };
  if (own(key, 'base-url')) group['base-url'] = key['base-url'];
  delete key['base-url'];
  group.keys = [key];
  return [...next, group];
}

// Clearing an effective shared value needs an explicit empty key override.
// Optional cooling deliberately keeps its usual "restore inheritance" meaning.
const emptyOverride = (field: string): unknown => {
  if (field === 'headers') return {};
  if (['models', 'excluded-models', 'request-scoped-errors'].includes(field)) return [];
  if (['prefix', 'proxy-url'].includes(field)) return '';
  if (field === 'priority') return 0;
  if (field === 'request-retry') return -1;
  return undefined;
};

const changedFields = (before: ProviderRecord, after: ProviderRecord) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => own(before, field) !== own(after, field) || !equal(before[field], after[field]));

export function updateProviderEntry(
  groups: ProviderRecord[], source: ProviderEntrySource, before: ProviderRecord, after: ProviderRecord,
): ProviderRecord[] {
  const { groupIndex, keyIndex } = locateProviderEntry(groups, source);
  const next = cleanGroups(groups);
  const group = next[groupIndex];
  const previous = cleanProviderGroup(before);
  const updated = cleanProviderGroup(after);
  const fields = changedFields(previous, updated);
  if (keyIndex === undefined) {
    for (const field of fields) {
      if (own(updated, field)) group[field] = structuredClone(updated[field]);
      else delete group[field];
    }
    return next;
  }
  const keys = group.keys as ProviderRecord[];
  const key = keys[keyIndex];
  for (const field of fields.filter((field) => field !== 'base-url')) {
    if (own(updated, field)) key[field] = structuredClone(updated[field]);
    else {
      const empty = group[field] == null ? undefined : emptyOverride(field);
      if (empty !== undefined) key[field] = empty;
      else delete key[field];
    }
  }
  if (fields.includes('base-url')) {
    let destination = group;
    if (keys.length > 1) {
      destination = { ...structuredClone(group), name: fragmentName(group, namesIn(next)), keys: [key] };
      keys.splice(keyIndex, 1);
      next.splice(groupIndex + 1, 0, destination);
    }
    if (own(updated, 'base-url')) destination['base-url'] = structuredClone(updated['base-url']);
    else delete destination['base-url'];
  }
  return next;
}

export function removeProviderEntry(groups: ProviderRecord[], source: ProviderEntrySource): ProviderRecord[] {
  const { groupIndex, keyIndex } = locateProviderEntry(groups, source);
  const next = cleanGroups(groups);
  if (keyIndex === undefined) next.splice(groupIndex, 1);
  else {
    const keys = next[groupIndex].keys as ProviderRecord[];
    keys.splice(keyIndex, 1);
    if (!keys.length) next.splice(groupIndex, 1);
  }
  return next;
}

// Reorder values only within the visible slots; filtered entries keep their
// original positions in the complete configuration.
function moveInSlots<T>(items: T[], from: number, to: number, visibleIndexes?: number[]): void {
  const slots = visibleIndexes ? [...visibleIndexes].sort((left, right) => left - right) : items.map((_, index) => index);
  if (slots.some((index) => index < 0 || index >= items.length) || new Set(slots).size !== slots.length) throw staleEntry();
  const fromSlot = slots.indexOf(from);
  const toSlot = slots.indexOf(to);
  if (fromSlot < 0 || toSlot < 0) throw staleEntry();
  const values = slots.map((index) => items[index]);
  const [moved] = values.splice(fromSlot, 1);
  values.splice(toSlot, 0, moved);
  slots.forEach((index, position) => { items[index] = values[position]; });
}

export function reorderProviderEntries(
  groups: ProviderRecord[], section: string, source: ProviderEntrySource, target: ProviderEntrySource,
  visibleSources?: ProviderEntrySource[],
): ProviderRecord[] {
  const from = locateProviderEntry(groups, source);
  const to = locateProviderEntry(groups, target);
  const visible = visibleSources?.map((entry) => locateProviderEntry(groups, entry));
  const next = cleanGroups(groups);
  if (section === 'openai-compatibility') {
    if (from.keyIndex !== undefined || to.keyIndex !== undefined || visible?.some((entry) => entry.keyIndex !== undefined)) throw staleEntry();
    moveInSlots(next, from.groupIndex, to.groupIndex, visible?.map((entry) => entry.groupIndex));
    return next;
  }
  if (from.keyIndex === undefined || to.keyIndex === undefined || visible?.some((entry) => entry.keyIndex === undefined)) throw staleEntry();
  // Empty groups are represented by a sentinel so a reorder cannot discard them.
  const items = next.flatMap((group, groupIndex) => {
    const keys = Array.isArray(group.keys) ? group.keys : [];
    return keys.length ? keys.map((_, keyIndex) => ({ groupIndex, keyIndex }))
      : [{ groupIndex, keyIndex: undefined as number | undefined }];
  });
  const fromIndex = items.findIndex((item) => item.groupIndex === from.groupIndex && item.keyIndex === from.keyIndex);
  const toIndex = items.findIndex((item) => item.groupIndex === to.groupIndex && item.keyIndex === to.keyIndex);
  if (fromIndex < 0 || toIndex < 0) throw staleEntry();
  const visibleIndexes = visible?.map((entry) => items.findIndex((item) => item.groupIndex === entry.groupIndex && item.keyIndex === entry.keyIndex));
  moveInSlots(items, fromIndex, toIndex, visibleIndexes);
  if (fromIndex === toIndex) return next;
  const names = namesIn(next);
  const emitted = new Set<number>();
  const result: ProviderRecord[] = [];
  let previousGroupIndex = -1;
  for (const item of items) {
    const original = next[item.groupIndex];
    if (item.keyIndex === undefined) {
      result.push(original);
      previousGroupIndex = -1;
      continue;
    }
    if (previousGroupIndex !== item.groupIndex) {
      const fragment: ProviderRecord = { ...structuredClone(original), keys: [] as ProviderRecord[] };
      if (emitted.has(item.groupIndex)) fragment.name = fragmentName(original, names);
      result.push(fragment);
      emitted.add(item.groupIndex);
    }
    (result[result.length - 1].keys as ProviderRecord[]).push((original.keys as ProviderRecord[])[item.keyIndex]);
    previousGroupIndex = item.groupIndex;
  }
  return result;
}
