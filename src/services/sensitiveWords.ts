import { invoke } from './platform';
export type SensitiveRule = {
  id: string;
  provider: 'antigravity' | 'devin';
  kind: 'obfuscate' | 'replace';
  target: string;
  replacement: string;
};
export type CloudRule = Omit<SensitiveRule, 'id'>;
export type RuleCatalog = { rules: CloudRule[] };
export type WordEntry = SensitiveRule;
export const fetchLatestSensitiveWordRules = () => invoke<RuleCatalog>('fetch_latest_sensitive_word_rules');
export const ruleIdentity = (rule: Pick<SensitiveRule, 'provider' | 'target'>) => `${rule.provider}:${rule.target.trim().toLowerCase()}`;
export type DuplicateWordGroup = {
  entries: WordEntry[];
  canMerge: boolean;
};
export function duplicateWordGroups(entries: WordEntry[]): DuplicateWordGroup[] {
  const groups = new Map<string, WordEntry[]>();
  for (const entry of entries) {
    if (!entry.target.trim()) continue;
    const key = `${ruleIdentity(entry)}:${entry.kind}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      entries: group,
      // Never choose between different replacement values on the user's behalf.
      canMerge:
        group[0].kind === 'obfuscate' || group.every((entry) => entry.replacement === group[0].replacement),
    }));
}
export function mergeDuplicateWords(entries: WordEntry[], group: DuplicateWordGroup): WordEntry[] {
  if (!group.canMerge) return entries;
  const removed = new Set(group.entries.slice(1).map((entry) => entry.id));
  return entries.filter((entry) => !removed.has(entry.id));
}
// Existing entries win, including edits that have not been saved yet.
export function addCloudRules(current: WordEntry[], cloud: CloudRule[]): WordEntry[] {
  const seen = new Set(current.filter((rule) => rule.target.trim()).map(ruleIdentity));
  const added: WordEntry[] = [];
  for (const rule of cloud) {
    const identity = ruleIdentity(rule);
    if (!seen.has(identity)) {
      seen.add(identity);
      added.push({ ...rule, id: crypto.randomUUID() });
    }
  }
  return [...current, ...added];
}
export function validateWordEntries(entries: WordEntry[]): 'target' | 'duplicate' | null {
  const seen = new Set<string>();
  for (const rule of entries) {
    if (!rule.target.trim() || (rule.kind === 'obfuscate' && [...rule.target.trim()].length < 2))
      return 'target';
    // A replacement may intentionally take precedence over a separate obfuscation entry.
    const identity = `${ruleIdentity(rule)}:${rule.kind}`;
    if (seen.has(identity)) return 'duplicate';
    seen.add(identity);
  }
  return null;
}
