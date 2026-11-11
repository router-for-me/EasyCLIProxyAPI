import { expect, test } from 'bun:test';
import {
  addCloudRules,
  validateWordEntries,
  duplicateWordGroups,
  mergeDuplicateWords,
  type SensitiveRule,
} from '../src/services/sensitiveWords';
const rule = (id: string, target: string, replacement = 'Assistant'): SensitiveRule => ({
  id,
  provider: 'antigravity',
  kind: 'replace',
  target,
  replacement,
});
test('cloud import preserves edits and skips matching targets across kinds and case', () => {
  const current = [
    rule('local', ' Codex ', 'My choice'),
    { ...rule('word', 'secret'), kind: 'obfuscate' as const, replacement: '' },
  ];
  const merged = addCloudRules(current, [
    rule('cloud', 'CODEX', 'Cloud'),
    rule('other', 'SECRET'),
    rule('new', 'New phrase', ''),
  ]);
  expect(merged).toHaveLength(3);
  expect(merged[0]).toBe(current[0]);
  expect(merged[0].replacement).toBe('My choice');
  expect(merged[2].replacement).toBe('');
  expect(addCloudRules(merged, [rule('new', 'New phrase')])).toHaveLength(3);
});
test('imported entries are ordinary editable and removable rules; explicit import can re-add them', () => {
  const cloud = [rule('cloud', 'Codex')];
  const first = addCloudRules([], cloud);
  first[0].replacement = 'Edited';
  expect(addCloudRules(first, cloud)[0].replacement).toBe('Edited');
  expect(addCloudRules([], cloud)).toHaveLength(1);
});
test('cloud entries need no IDs; editor IDs are generated locally', () => {
  const result = addCloudRules(
    [],
    [{ provider: 'devin', kind: 'replace', target: 'Phrase', replacement: '' }],
  );
  expect(result).toHaveLength(1);
  expect(result[0].id).toBeTruthy();
  expect(result[0].replacement).toBe('');
});
test('validates duplicates while preserving empty replacements', () => {
  expect(validateWordEntries([rule('a', 'A', '')])).toBeNull();
  expect(validateWordEntries([rule('a', '')])).toBeNull();
  expect(validateWordEntries([rule('a', '  ', 'Only a replacement')])).toBeNull();
  expect(validateWordEntries([{ ...rule('a', '\t '), kind: 'obfuscate' }])).toBeNull();
  expect(validateWordEntries([rule('a', 'Codex'), rule('b', ' codex ')])).toBe('duplicate');
  expect(validateWordEntries([{ ...rule('a', 'A'), kind: 'obfuscate', replacement: '' }])).toBe('target');
});
test('groups duplicate case variants per provider and action and keeps the first spelling', () => {
  const entries = ['openclaw', 'OpenClaw', 'Openclaw'].map((target, index) => ({
    ...rule(String(index), target, ''),
    kind: 'obfuscate' as const,
  }));
  entries.push({ ...entries[0], id: 'devin', provider: 'devin' });
  const groups = duplicateWordGroups(entries);
  expect(groups).toHaveLength(1);
  expect(groups[0].entries).toHaveLength(3);
  expect(groups[0].canMerge).toBe(true);
  const merged = mergeDuplicateWords(entries, groups[0]);
  expect(merged.map((entry) => entry.id)).toEqual(['0', 'devin']);
  expect(merged[0].target).toBe('openclaw');
  expect(validateWordEntries(merged)).toBeNull();
});
test('allows identical replacements to merge but never discards conflicting replacements', () => {
  const identical = [rule('a', 'Codex', ''), rule('b', ' CODEX ', '')];
  expect(mergeDuplicateWords(identical, duplicateWordGroups(identical)[0])).toHaveLength(1);
  const conflicting = [rule('a', 'Codex', 'First'), rule('b', 'codex', 'Second')];
  const group = duplicateWordGroups(conflicting)[0];
  expect(group.canMerge).toBe(false);
  expect(mergeDuplicateWords(conflicting, group)).toBe(conflicting);
});
