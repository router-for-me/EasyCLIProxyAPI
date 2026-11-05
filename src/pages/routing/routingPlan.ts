import { routingSettingPaths, type RoutingBoard, type RoutingMember, type RoutingPlan, type RoutingSettings } from '../../services/routing';

export interface RoutingTier {
  id: string;
  memberKeys: string[];
}

export interface RoutingDraft {
  tiers: RoutingTier[];

  weights: Record<string, (number | null)[]>;
  settings: RoutingSettings;
}

export type RoutingDropTarget = { kind: 'tier'; tierId: string } | { kind: 'gap'; index: number };

const TIER_STEP = 10;

export function tiersFromMembers(members: readonly RoutingMember[]): RoutingTier[] {
  const byPriority = new Map<number, RoutingMember[]>();
  for (const member of members) {
    byPriority.set(member.priority, [...(byPriority.get(member.priority) ?? []), member]);
  }
  return [...byPriority.entries()]
    .sort(([left], [right]) => right - left)
    .map(([priority, peers]) => ({
      id: `p${priority}`,
      memberKeys: peers.sort((left, right) => (left.remark || left.name).localeCompare(right.remark || right.name)).map((member) => member.key),
    }));
}

export function draftFromBoard(board: RoutingBoard): RoutingDraft {
  const weights: RoutingDraft['weights'] = {};
  for (const member of board.members) {
    weights[member.key] = [...member.weights];
  }
  return { tiers: tiersFromMembers(board.members), weights, settings: { ...board.settings } };
}

let tierSequence = 0;
function newTierId(): string {
  tierSequence += 1;
  return `new-${tierSequence}`;
}

function withoutMember(tiers: readonly RoutingTier[], key: string): RoutingTier[] {
  return tiers.map((tier) => ({ ...tier, memberKeys: tier.memberKeys.filter((memberKey) => memberKey !== key) }));
}

function withoutEmptyTiers(tiers: readonly RoutingTier[]): RoutingTier[] {
  return tiers.filter((tier) => tier.memberKeys.length > 0);
}

export function tierIndexOf(tiers: readonly RoutingTier[], key: string): number {
  return tiers.findIndex((tier) => tier.memberKeys.includes(key));
}

export function moveMember(tiers: readonly RoutingTier[], key: string, target: RoutingDropTarget): RoutingTier[] {
  const from = tierIndexOf(tiers, key);
  if (from < 0) {
    return [...tiers];
  }
  if (target.kind === 'tier') {
    if (tiers[from].id === target.tierId || !tiers.some((tier) => tier.id === target.tierId)) {
      return [...tiers];
    }
    const moved = withoutMember(tiers, key).map((tier) =>
      tier.id === target.tierId ? { ...tier, memberKeys: [...tier.memberKeys, key] } : tier,
    );
    return withoutEmptyTiers(moved);
  }
  const isAlone = tiers[from].memberKeys.length === 1;
  if (isAlone && (target.index === from || target.index === from + 1)) {
    return [...tiers];
  }
  const moved = withoutMember(tiers, key);
  const index = Math.max(0, Math.min(target.index, moved.length));
  moved.splice(index, 0, { id: newTierId(), memberKeys: [key] });
  return withoutEmptyTiers(moved);
}

export function stepMember(tiers: readonly RoutingTier[], key: string, direction: 'up' | 'down'): RoutingTier[] {
  const from = tierIndexOf(tiers, key);
  if (from < 0) {
    return [...tiers];
  }
  if (direction === 'up') {
    return from > 0 ? moveMember(tiers, key, { kind: 'tier', tierId: tiers[from - 1].id }) : moveMember(tiers, key, { kind: 'gap', index: 0 });
  }
  return from < tiers.length - 1
    ? moveMember(tiers, key, { kind: 'tier', tierId: tiers[from + 1].id })
    : moveMember(tiers, key, { kind: 'gap', index: tiers.length });
}

export function splitMember(tiers: readonly RoutingTier[], key: string, side: 'above' | 'below'): RoutingTier[] {
  const from = tierIndexOf(tiers, key);
  if (from < 0) {
    return [...tiers];
  }
  return moveMember(tiers, key, { kind: 'gap', index: side === 'above' ? from : from + 1 });
}

export function assignTierPriorities(
  tiers: readonly RoutingTier[],
  original: ReadonlyMap<string, number>,
  fixed: ReadonlyMap<string, number> = new Map(),
): number[] | null {
  const minimum = tiers.map((_, index) => -2_147_483_648 + tiers.length - 1 - index);
  const maximum = tiers.map((_, index) => 2_147_483_647 - index);
  const fixedTiers = new Map<number, number>();
  for (const [index, tier] of tiers.entries()) {
    for (const key of tier.memberKeys) {
      const value = fixed.get(key);
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < minimum[index] || value > maximum[index]) return null;
      if (fixedTiers.has(index) && fixedTiers.get(index) !== value) return null;
      fixedTiers.set(index, value);
    }
  }

  for (const [index, value] of fixedTiers) {
    minimum[index] = maximum[index] = value;
    for (let earlier = 0; earlier < index; earlier += 1) {
      minimum[earlier] = Math.max(minimum[earlier], value + index - earlier);
    }
    for (let later = index + 1; later < tiers.length; later += 1) {
      maximum[later] = Math.min(maximum[later], value - later + index);
    }
  }
  if (minimum.some((value, index) => value > maximum[index])) return null;

  const preferred = tiers.map((tier, index) => {
    const counts = new Map<number, number>();
    for (const key of tier.memberKeys) {
      const value = original.get(key);
      if (value !== undefined && value >= minimum[index] && value <= maximum[index]) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    const fixedValue = fixedTiers.get(index);
    if (fixedValue !== undefined) return { value: fixedValue, count: counts.get(fixedValue) ?? 0 };
    let selected: { value: number; count: number } | null = null;
    for (const [value, count] of counts) {
      if (!selected || count > selected.count || (count === selected.count && value > selected.value)) {
        selected = { value, count };
      }
    }
    return selected;
  });

  const anchors = new Set(fixedTiers.keys());
  const best = preferred.map((entry) => entry?.count ?? -1);
  const previous = preferred.map(() => -1);
  let start = 0;

  for (const stop of [...fixedTiers.keys(), tiers.length]) {
    let end = -1;
    for (let index = start; index < stop; index += 1) {
      const current = preferred[index];
      if (!current) continue;
      for (let earlier = start; earlier < index; earlier += 1) {
        const candidate = preferred[earlier];
        if (candidate && candidate.value - current.value >= index - earlier && best[earlier] + current.count > best[index]) {
          best[index] = best[earlier] + current.count;
          previous[index] = earlier;
        }
      }

      if (end < 0 || best[index] >= best[end]) end = index;
    }
    for (let index = end; index >= 0; index = previous[index]) anchors.add(index);
    start = stop + 1;
  }

  const values: (number | undefined)[] = tiers.map((_, index) => anchors.has(index) ? preferred[index]!.value : undefined);
  start = 0;
  while (start < values.length) {
    if (values[start] !== undefined) {
      start += 1;
      continue;
    }
    let stop = start;
    while (stop < values.length && values[stop] === undefined) stop += 1;
    const upper = start > 0 ? values[start - 1] : undefined;
    const lower = stop < values.length ? values[stop] : undefined;
    const count = stop - start;
    for (let offset = 0; offset < count; offset += 1) {
      if (upper !== undefined && lower !== undefined) {
        values[start + offset] = upper - Math.floor((upper - lower) / (count + 1)) * (offset + 1);
      } else if (upper !== undefined) {
        values[start + offset] = upper - Math.min(TIER_STEP, Math.floor((upper + 2_147_483_648) / count)) * (offset + 1);
      } else if (lower !== undefined) {
        values[start + offset] = lower + Math.min(TIER_STEP, Math.floor((2_147_483_647 - lower) / count)) * (count - offset);
      } else {
        values[start + offset] = TIER_STEP * (count - 1 - offset);
      }
    }
    start = stop;
  }
  return values as number[];
}

export interface RoutingChange {
  key: string;
  kind: 'priority' | 'weight' | 'setting';
  field?: string;
  from: unknown;
  to: unknown;
}

export interface RoutingPlanDiff {
  priorities: Map<string, number>;
  tierPriorities: number[];
  changes: RoutingChange[];
  plan: RoutingPlan;
}

export function diffPlan(board: RoutingBoard, draft: RoutingDraft): RoutingPlanDiff | null {
  const tierPriorities = assignTierPriorities(draft.tiers,
    new Map(board.members.map(member => [member.key, member.priority])),
    new Map(board.members.filter(member => member.runtimeOnly).map(member => [member.key, member.priority])));
  if (!tierPriorities) return null;
  const keys = draft.tiers.flatMap(tier => tier.memberKeys);
  if (keys.length !== board.members.length || new Set(keys).size !== keys.length
    || keys.some(key => !board.members.some(member => member.key === key))) return null;
  const priorities = new Map<string, number>();
  draft.tiers.forEach((tier, index) => tier.memberKeys.forEach(key => priorities.set(key, tierPriorities[index])));
  const changes: RoutingChange[] = [];
  const members = board.members.map(member => {
    const priority = priorities.get(member.key)!;
    const weights = draft.weights[member.key] ?? member.weights;
    if (weights.length !== member.weights.length) return null;
    if (member.runtimeOnly && (priority !== member.priority || weights.some((value, index) => value !== member.weights[index]))) return null;
    if (priority !== member.priority) changes.push({ key: member.key, kind: 'priority', from: member.priority, to: priority });
    weights.forEach((value, index) => {
      if (value !== member.weights[index]) changes.push({ key: member.key, kind: 'weight', field: String(index), from: member.weights[index], to: value });
    });
    return { ...member, priority, weights: [...weights] };
  });
  if (members.some(member => !member)) return null;
  for (const field of Object.keys(routingSettingPaths) as (keyof RoutingSettings)[]) {
    if (draft.settings[field] !== board.settings[field]) changes.push({ key: 'settings', kind: 'setting', field, from: board.settings[field], to: draft.settings[field] });
  }
  return { priorities, tierPriorities, changes, plan: { revision: board.revision, settings: { ...draft.settings }, members: members as RoutingMember[] } };
}

export type RouteMemberState = 'serving' | 'standby' | 'excluded' | 'blocked' | 'ineligible';
export interface RouteMember { key: string; state: RouteMemberState; share: number | null }
export interface RouteStep { tierId: string; step: number; members: RouteMember[]; isPrimary: boolean }
export interface RoutePreview { steps: RouteStep[]; states: Map<string, RouteMemberState> }

export function resolveRoute(board: RoutingBoard, draft: RoutingDraft): RoutePreview {
  const members = new Map(board.members.map(member => [member.key, member]));
  const states = new Map<string, RouteMemberState>();
  const steps: RouteStep[] = [];
  let hasPrimary = false;
  for (const tier of draft.tiers) {
    const routeMembers: RouteMember[] = [];
    const unitsByKey = new Map<string, number>();
    let units = 0;
    for (const key of tier.memberKeys) {
      const member = members.get(key);
      if (!member) continue;
      let state: RouteMemberState = member.disabled ? 'ineligible' : member.unavailable ? 'blocked' : 'serving';
      if (state === 'serving') {
        const weights = draft.weights[key] ?? member.weights;
        const count = member.keyCount ?? member.weights.length;
        const amount = draft.settings.strategy === 'weighted-round-robin'
          ? weights.reduce<number>((sum, value) => sum + (value ?? 1), 0) + Math.max(0, count - weights.length) : count;
        if (amount <= 0) state = 'excluded';
        else { unitsByKey.set(key, amount); units += amount; }
      }
      states.set(key, state);
      routeMembers.push({ key, state, share: null });
    }
    if (units === 0) continue;
    const isPrimary = !hasPrimary;
    hasPrimary = true;
    for (const member of routeMembers) {
      const amount = unitsByKey.get(member.key);
      if (amount === undefined) continue;
      member.share = draft.settings.strategy === 'fill-first' ? null : amount / units;
      member.state = isPrimary ? 'serving' : 'standby';
      states.set(member.key, member.state);
    }
    steps.push({ tierId: tier.id, step: steps.length + 1, members: routeMembers, isPrimary });
  }
  return { steps, states };
}
