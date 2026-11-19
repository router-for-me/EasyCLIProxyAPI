import type { UsageRecord } from './usage';
import { usageClientAgent, type ClientAgent } from './clientAgent';
import { normalizeAuthFileCooldowns, cooldownRemainingSeconds, type AuthFileCooldownSnapshot } from './authFileHealth';
import { isRecord, readBoolean, readString } from './managementApi';

export const ROUTING_WINDOW_MS = 60_000;
export type RoutingCooldown = { id: string; name: string; provider: string; snapshot: AuthFileCooldownSnapshot };
export type RoutingCredential = { id: string; name: string; provider: string; disabled: boolean; unavailable: boolean };
export type RoutingNode = { id: string; name: string; count: number; failures: number; latency: number; latestAt: number; failed: boolean; provider?: string; cooldown?: RoutingCooldown };
export type RoutingAgent = RoutingNode & { client: ClientAgent };
export type RoutingTarget = RoutingNode & { agentId?: string; model?: string; routeProvider?: string; credentialId: string };
export type RoutingEdge = { id: string; agentId: string; targetId: string; count: number; failed: boolean };
export const routingRecordId = (record: UsageRecord) => record.row_id || record.id;
export const routingModelId = (record: UsageRecord) => `model:${record.alias?.trim() || record.model?.trim() || '—'}`;
export const routingTargetId = (record: UsageRecord) => record.auth_index?.trim()
  ? `auth:${record.auth_index.trim()}` : `provider:${JSON.stringify([record.provider, record.source_display || ''])}`;
export const routingAgentId = (record: UsageRecord) => `agent:${usageClientAgent(record).id}`;
export const routingDestinationId = (record: UsageRecord) => `route:${JSON.stringify([routingAgentId(record), routingModelId(record), record.provider || '', routingTargetId(record)])}`;
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

export function routingCredentials(payload: unknown): RoutingCredential[] {
  if (!isRecord(payload) || !Array.isArray(payload.files)) throw new Error('Invalid credential response');
  return [...new Map(payload.files.filter(isRecord).flatMap(file => {
    const authIndex = readString(file, 'auth_index').trim();
    if (!authIndex) return [];
    return [{ id: `auth:${authIndex}`, name: readString(file, 'name'), provider: readString(file, 'provider', 'type'),
      disabled: readBoolean(file, 'disabled') || readString(file, 'status') === 'disabled',
      unavailable: readBoolean(file, 'unavailable') || readString(file, 'status') === 'error' }];
  }).map(credential => [credential.id, credential])).values()];
}

export function buildLiveRouting(records: UsageRecord[], cooldowns: RoutingCooldown[], now: number, credentials: RoutingCredential[] = []) {
  const recent = [...new Map(records.map(record => [routingRecordId(record), record])).values()]
    .filter(record => routingFinishedAt(record) >= now - ROUTING_WINDOW_MS && routingFinishedAt(record) <= now + 5000);
  const agents = new Map<string, RoutingAgent>();
  const targets = new Map<string, RoutingTarget>();
  const routes = new Map<string, RoutingEdge>();
  const inventory = new Map(credentials.map(credential => [credential.id, credential]));
  const cooling = new Map(cooldowns.filter(cooldown => routingCooldownSeconds(cooldown, now) > 0).map(cooldown => [cooldown.id, cooldown]));
  const add = (node: RoutingNode, record: UsageRecord) => {
    node.latency = (node.latency * node.count + record.latency_ms) / (node.count + 1);
    node.count += 1;
    if (record.failed && !record.canceled) node.failures += 1;
    const finished = routingFinishedAt(record);
    if (finished > node.latestAt) {
      node.latestAt = finished;
      node.failed = record.failed && !record.canceled;
    } else if (finished === node.latestAt) {
      // Completion times have millisecond precision: a tied failure stays visible.
      node.failed ||= record.failed && !record.canceled;
    }
  };
  const blank = (id: string, name: string): RoutingNode => ({ id, name, count: 0, failures: 0, latency: 0, latestAt: -Infinity, failed: false });
  for (const record of recent) {
    const agentId = routingAgentId(record);
    const targetId = routingDestinationId(record);
    const credentialId = routingTargetId(record);
    const credential = inventory.get(credentialId);
    const cooldown = cooling.get(credentialId);
    const client = usageClientAgent(record);
    const agent = agents.get(agentId) ?? { ...blank(agentId, client.name || ''), client };
    const target = targets.get(targetId) ?? {
      ...blank(targetId, credential?.name || record.source_display || cooldown?.name || record.provider || '—'),
      agentId, model: record.alias?.trim() || record.model?.trim() || '—', routeProvider: record.provider || '', credentialId,
      provider: record.provider || credential?.provider || cooldown?.provider, cooldown,
    };
    add(agent, record);
    add(target, record);
    agents.set(agentId, agent);
    targets.set(targetId, target);
    routes.set(targetId, { id: targetId, agentId, targetId, count: target.count, failed: target.failed });
  }
  // Cooling inventory without a recorded route is not attributed to an invented client or model.
  const recordedCredentials = new Set([...targets.values()].map(target => target.credentialId));
  for (const cooldown of cooling.values()) {
    if (recordedCredentials.has(cooldown.id)) continue;
    const credential = inventory.get(cooldown.id);
    const id = `cooldown:${cooldown.id}`;
    targets.set(id, { ...blank(id, credential?.name || cooldown.name || cooldown.provider), credentialId: cooldown.id,
      provider: credential?.provider || cooldown.provider, cooldown });
  }
  const selectedAgents = [...agents.values()].sort((a, b) => a.id.localeCompare(b.id));
  const selectedTargets = [...targets.values()].sort((a, b) => (a.agentId || '').localeCompare(b.agentId || '') || a.id.localeCompare(b.id));
  const ready = credentials.filter(credential => !credential.disabled && !credential.unavailable && !cooling.has(credential.id)).length;
  return { agents: selectedAgents, targets: selectedTargets, routes: [...routes.values()], records: recent,
    metrics: { flows: routes.size, requests: recent.length, latency: recent.length ? recent.reduce((total, record) => total + record.latency_ms, 0) / recent.length : null,
      qps: recent.length / (ROUTING_WINDOW_MS / 1000), failures: recent.filter(record => record.failed && !record.canceled).length, ready, cooling: cooling.size },
    hidden: false };
}
