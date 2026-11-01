import type { UsageRecord } from './usage';
import { normalizeAuthFileCooldowns, cooldownRemainingSeconds, type AuthFileCooldownSnapshot } from './authFileHealth';
import { isRecord, readString } from './managementApi';

export const ROUTING_WINDOW_MS = 60_000;
export type RoutingCooldown = { id: string; name: string; provider: string; snapshot: AuthFileCooldownSnapshot };
export type RoutingNode = { id: string; name: string; count: number; failures: number; latency: number; cooldown?: RoutingCooldown };
export type RoutingEdge = { id: string; modelId: string; targetId: string; count: number; failed: boolean };
export const routingRecordId = (record: UsageRecord) => record.row_id || record.id;
export const routingModelId = (record: UsageRecord) => `model:${record.alias || record.model}`;
export const routingTargetId = (record: UsageRecord) => record.auth_index?.trim()
  ? `auth:${record.auth_index.trim()}` : `provider:${record.provider}:${record.source_display || ''}`;
export const routingFinishedAt = (record: UsageRecord) => Date.parse(record.timestamp) + Math.max(0, record.latency_ms || 0);

export function routingCooldowns(payload: unknown, now: number): RoutingCooldown[] {
  if (!isRecord(payload) || !Array.isArray(payload.files)) throw new Error('Invalid credential response');
  return payload.files.filter(isRecord).flatMap(file => {
    const authIndex = readString(file, 'auth_index');
    const snapshot = normalizeAuthFileCooldowns(file.cooldowns, now, readString(payload, 'observed_at'));
    if (!authIndex || !snapshot?.records?.length) return [];
    return [{ id: `auth:${authIndex}`, name: readString(file, 'name'), provider: readString(file, 'provider', 'type'), snapshot }];
  });
}

export function routingCooldownSeconds(cooldown: RoutingCooldown, now: number) {
  return Math.max(0, ...(cooldown.snapshot.records ?? []).map(record => cooldownRemainingSeconds(record, cooldown.snapshot.receivedAtMs, now)));
}

export function buildLiveRouting(records: UsageRecord[], cooldowns: RoutingCooldown[], now: number) {
  const recent = [...new Map(records.map(record => [routingRecordId(record), record])).values()]
    .filter(record => routingFinishedAt(record) >= now - ROUTING_WINDOW_MS && routingFinishedAt(record) <= now + 5000);
  const models = new Map<string, RoutingNode>();
  const targets = new Map<string, RoutingNode>();
  const routes = new Map<string, RoutingEdge>();
  const add = (collection: Map<string, RoutingNode>, id: string, name: string, record: UsageRecord) => {
    const node = collection.get(id) ?? { id, name, count: 0, failures: 0, latency: 0 };
    node.latency = (node.latency * node.count + record.latency_ms) / (node.count + 1);
    node.count += 1;
    if (record.failed && !record.canceled) node.failures += 1;
    collection.set(id, node);
  };
  for (const record of recent) {
    const modelId = routingModelId(record);
    const targetId = routingTargetId(record);
    add(models, modelId, record.alias || record.model || '—', record);
    add(targets, targetId, record.source_display || record.provider || '—', record);
    const id = JSON.stringify([modelId, targetId]);
    const edge = routes.get(id) ?? { id, modelId, targetId, count: 0, failed: false };
    edge.count++;
    edge.failed = record.failed && !record.canceled;
    routes.set(id, edge);
  }
  for (const cooldown of cooldowns) {
    const target = targets.get(cooldown.id) ?? { id: cooldown.id, name: cooldown.name || cooldown.provider, count: 0, failures: 0, latency: 0 };
    target.cooldown = cooldown;
    targets.set(target.id, target);
  }
  const select = (nodes: Map<string, RoutingNode>) => [...nodes.values()]
    .sort((left, right) => Number(!!right.cooldown) - Number(!!left.cooldown) || right.count - left.count || left.id.localeCompare(right.id))
    .slice(0, 6).sort((left, right) => left.id.localeCompare(right.id));
  return { models: select(models), targets: select(targets), routes: [...routes.values()], records: recent,
    hidden: models.size > 6 || targets.size > 6 };
}
