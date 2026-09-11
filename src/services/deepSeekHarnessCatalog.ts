import schemaSource from './deepSeekHarnessSchema.json';

export type HarnessProfile = Record<string, unknown>;
export type HarnessDraft = Record<string, string>;
export type HarnessField = {
  name: string;
  kind: string;
  group?: string;
  values?: string[];
  apis?: string[];
  default?: unknown;
  example?: unknown;
  min?: number;
  max?: number;
  exclusiveMin?: number;
};
export const harnessSchema = schemaSource as unknown as Record<string, HarnessField[]>;
export type HarnessContextDefault = { value: number; source: 'model' | 'provider' | 'default' };

export function harnessContextDefault(defaults: HarnessProfile, provider: HarnessDraft): HarnessContextDefault {
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (valid(defaults.contextWindow)) return { value: defaults.contextWindow, source: 'model' };
  const configured = Number(provider.defaultContextWindow);
  if (valid(configured)) return { value: configured, source: 'provider' };
  return { value: harnessSchema.provider.find(field => field.name === 'defaultContextWindow')!.default as number, source: 'default' };
}

export const harnessReasoningLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export type HarnessEditorModel = { id: string; defaults: HarnessProfile; configuration: HarnessProfile };
export type HarnessEditorSnapshot = {
  revision: string;
  models: HarnessEditorModel[];
  provider: HarnessProfile;
  baseUrl: string;
  defaultModel: string | null;
  configured: boolean;
};
export const isHarnessRecord = (value: unknown): value is HarnessProfile =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function harnessDraft(profile: HarnessProfile, group: string, prefix = ''): HarnessDraft {
  return Object.fromEntries(harnessSchema[group].flatMap(field => {
    const value = profile[field.name];
    const key = `${prefix}${field.name}`;
    if (value === undefined) return [];
    if (field.group && isHarnessRecord(value)) return Object.entries(harnessDraft(value, field.group, `${key}.`));
    return [[key, ['string', 'enum'].includes(field.kind) ? String(value) : JSON.stringify(value)]];
  }));
}

export function updateHarnessDraft(draft: HarnessDraft, key: string, value: string): HarnessDraft {
  const next = { ...draft };
  if (!value.length) delete next[key];
  else return { ...next, [key]: value };
  return next;
}

export function parseHarnessDraft(draft: HarnessDraft, group: string, api: string, prefix = ''): HarnessProfile {
  const profile: HarnessProfile = {};
  for (const field of harnessSchema[group]) {
    const key = `${prefix}${field.name}`;
    if (field.group) {
      const nested = parseHarnessDraft(draft, field.group, api, `${key}.`);
      if (Object.keys(nested).length) profile[field.name] = nested;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(draft, key) || !draft[key].trim()) continue;
    let value: unknown;
    try {
      value = ['string', 'enum'].includes(field.kind) ? draft[key].trim() : JSON.parse(draft[key]);
    } catch { throw new Error(`${key}: JSON`); }
    if (field.apis && !field.apis.includes(api)) throw new Error(`${key}: ${api}`);
    let valid = true;
    if (['integer', 'number'].includes(field.kind)) valid = typeof value === 'number' && Number.isFinite(value)
      && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      && (field.kind !== 'integer' || Number.isInteger(value))
      && (field.min === undefined || value >= field.min)
      && (field.max === undefined || value <= field.max)
      && (field.exclusiveMin === undefined || value > field.exclusiveMin);
    if (field.kind === 'enum') valid = field.values!.includes(value as string);
    if (field.kind === 'boolean') valid = typeof value === 'boolean';
    if (['modalities', 'strings'].includes(field.kind)) valid = Array.isArray(value) && (value.length > 0 || field.name === 'input')
      && value.every(v => typeof v === 'string' && v.trim() && (field.kind !== 'modalities' || ['text', 'image'].includes(v)))
      && new Set(value).size === value.length;
    if (field.kind === 'reasoning') valid = value === false || (isHarnessRecord(value) && Object.keys(value).length > 0
      && Object.entries(value).every(([level, wire]) => harnessReasoningLevels.includes(level)
        && ((level === 'off' && wire === null) || (typeof wire === 'string' && wire.trim()))));
    if (field.kind === 'headers') valid = isHarnessRecord(value)
      && Object.entries(value).every(([name, v]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
        && typeof v === 'string' && [...v].every(c => c.charCodeAt(0) <= 255) && !/[\r\n\0]/.test(v));
    if (field.kind === 'kwargs') valid = isHarnessRecord(value) && Object.values(value).every(v => !Array.isArray(v)
      && (!isHarnessRecord(v) || (Object.keys(v).every(key => ['$var', 'omitWhenOff'].includes(key))
        && ['thinking.enabled', 'thinking.effort', 'thinking.budget'].includes(v.$var as string)
        && (v.omitWhenOff === undefined || typeof v.omitWhenOff === 'boolean'))));
    if (!valid) throw new Error(key);
    profile[field.name] = value;
  }
  if (group === 'retryPolicy' && Object.keys(profile).length && profile.mode === undefined) profile.mode = 'normal';
  if (group === 'backoff' && Number(profile.initialDelayMs ?? 500) > Number(profile.maxDelayMs ?? 10000)) throw new Error(`${prefix}initialDelayMs > maxDelayMs`);
  return profile;
}

export function sameHarnessDraft(left: HarnessDraft, right: HarnessDraft): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => left[key] === right[key]);
}
