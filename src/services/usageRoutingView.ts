import type { UsageRecord } from './usage';
import { routingAgentId, routingDestinationId, routingFinishedAt, routingRecordId, type RoutingNode, type RoutingTarget } from './usageRouting';

export type RoutingDepth = 'auto' | 'models' | 'credentials';
export type RoutingDisplay = { depth: RoutingDepth; expanded: Record<string, boolean> };
export const DEFAULT_ROUTING_DISPLAY: RoutingDisplay = { depth: 'auto', expanded: {} };
export const AUTO_FOLD_CREDENTIALS = 3;
export type RoutingGroup = RoutingNode & {
  agentId?: string; model?: string; provider?: string; targets: RoutingTarget[]; credentialCount: number; coolingCount: number;
};
export type RoutingRow = {
  node: RoutingTarget | RoutingGroup; group: RoutingGroup; kind: 'group' | 'single' | 'credential'; parentId?: string; targetIds: string[];
};
export const routingGroupControlId = (id: string) => {
  let first = 2166136261, second = 5381;
  for (let index = 0; index < id.length; index++) {
    first = Math.imul(first ^ id.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ id.charCodeAt(index);
  }
  return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
};
const preferenceKey = (group: RoutingGroup) => `group:${routingGroupControlId(group.id)}`;
export const routingGroupId = (target: Pick<RoutingTarget, 'agentId' | 'model' | 'provider' | 'routeProvider' | 'id'>) => target.agentId && target.model
  ? `group:${JSON.stringify([target.agentId, target.model, target.routeProvider ?? target.provider ?? ''])}` : `group:${target.id}`;

export function groupRoutingTargets(targets: RoutingTarget[]): RoutingGroup[] {
  const groups = new Map<string, RoutingGroup>();
  for (const target of targets) {
    const id = routingGroupId(target);
    const group = groups.get(id) ?? {
      id, name: target.model || target.name, agentId: target.agentId, model: target.model, provider: target.provider,
      count: 0, failures: 0, latency: 0, latestAt: -Infinity, failed: false, targets: [], credentialCount: 0, coolingCount: 0,
    };
    const count = group.count + target.count;
    group.latency = count ? (group.latency * group.count + target.latency * target.count) / count : 0;
    group.count = count;
    group.failures += target.failures;
    if (target.latestAt > group.latestAt) { group.latestAt = target.latestAt; group.failed = target.failed; }
    else if (target.latestAt === group.latestAt) group.failed ||= target.failed;
    group.targets.push(target);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    group.targets.sort((a, b) => a.credentialId.localeCompare(b.credentialId) || a.id.localeCompare(b.id));
    group.credentialCount = new Set(group.targets.map(target => target.credentialId)).size;
    group.coolingCount = new Set(group.targets.filter(target => target.cooldown).map(target => target.credentialId)).size;
  }
  return [...groups.values()].sort((a, b) => (a.agentId || '').localeCompare(b.agentId || '') || a.id.localeCompare(b.id));
}

export function parseRoutingDisplay(value: string | null): RoutingDisplay {
  try {
    const parsed: unknown = JSON.parse(value || 'null');
    if (!parsed || typeof parsed !== 'object') return DEFAULT_ROUTING_DISPLAY;
    const source = parsed as Record<string, unknown>;
    const depth: RoutingDepth = source.depth === 'models' || source.depth === 'credentials' ? source.depth : 'auto';
    const entries = source.expanded && typeof source.expanded === 'object'
      ? Object.entries(source.expanded).filter(([id, open]) => id.startsWith('group:') && id.length <= 2048 && typeof open === 'boolean').slice(-200) : [];
    return { depth, expanded: Object.fromEntries(entries) };
  } catch { return DEFAULT_ROUTING_DISPLAY; }
}

export function routingGroupOpen(group: RoutingGroup, display: RoutingDisplay): boolean {
  if (group.targets.length < 2) return false;
  const key = preferenceKey(group);
  if (Object.prototype.hasOwnProperty.call(display.expanded, key)) return display.expanded[key];
  return display.depth === 'credentials' || (display.depth === 'auto' && group.targets.length < AUTO_FOLD_CREDENTIALS);
}

export function changeRoutingDisplay(display: RoutingDisplay, action: { depth: RoutingDepth } | { toggle: RoutingGroup }): RoutingDisplay {
  if ('depth' in action) return { depth: action.depth, expanded: {} };
  return { ...display, expanded: Object.fromEntries([...Object.entries(display.expanded).filter(([id]) => id !== preferenceKey(action.toggle)),
    [preferenceKey(action.toggle), !routingGroupOpen(action.toggle, display)]].slice(-200)) };
}

export function projectRoutingGroups(groups: RoutingGroup[], display: RoutingDisplay) {
  const rows: RoutingRow[] = [];
  const endpointByTarget = new Map<string, string>();
  const sections = groups.map(group => {
    const open = routingGroupOpen(group, display);
    const multiple = group.targets.length > 1;
    const summary: RoutingRow = { node: multiple ? group : group.targets[0], group, kind: multiple ? 'group' : 'single', targetIds: group.targets.map(target => target.id) };
    const children: RoutingRow[] = multiple && open ? group.targets.map(node => ({ node, group, kind: 'credential', parentId: group.id, targetIds: [node.id] })) : [];
    rows.push(summary, ...children);
    group.targets.forEach(target => endpointByTarget.set(target.id, multiple && !open ? group.id : target.id));
    return { group, summary, children, open };
  });
  return { sections, rows, endpointByTarget };
}

export function orderedRoutingRecords(records: UsageRecord[]): UsageRecord[] {
  return [...records].sort((a, b) => routingFinishedAt(b) - routingFinishedAt(a)
    || routingRecordId(b).localeCompare(routingRecordId(a), 'en', { numeric: true }));
}
export type RoutingFocus = { mode: 'latest' } | { mode: 'pinned'; recordId: string };
export const LATEST_ROUTING_FOCUS: RoutingFocus = { mode: 'latest' };
export function resolveRoutingFocus(focus: RoutingFocus, records: UsageRecord[]) {
  const record = focus.mode === 'latest' ? orderedRoutingRecords(records)[0] : records.find(item => routingRecordId(item) === focus.recordId);
  return { record, pinned: focus.mode === 'pinned', expired: focus.mode === 'pinned' && !record };
}
export function routingRecordForNode(records: UsageRecord[], match: { agentId?: string; targetIds?: readonly string[] }) {
  const targets = match.targetIds ? new Set(match.targetIds) : undefined;
  return orderedRoutingRecords(records).find(record => (!match.agentId || routingAgentId(record) === match.agentId)
    && (!targets || targets.has(routingDestinationId(record))));
}
export const routingRowRelated = (row: RoutingRow, record: UsageRecord) => row.targetIds.includes(routingDestinationId(record));
