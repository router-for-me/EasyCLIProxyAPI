import { describe, expect, it } from 'bun:test';
import { usageClientAgent } from '../src/services/clientAgent';
import { buildLiveRouting, routingAgentId, routingDestinationId, routingCredentials } from '../src/services/usageRouting';
import type { UsageRecord } from '../src/services/usage';
import clients from './fixtures/usageClientAgents.json';

const now = Date.parse('2026-11-19T08:00:00Z');
const record = (id: string, overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  id, row_id: id, timestamp: new Date(now - 2000).toISOString(), latency_ms: 431, ttft_ms: null,
  source: '', source_display: 'personal', auth_index: 'main', failed: false, canceled: false,
  failure_status: 0, failure_body: '', provider: 'openai', model: 'gpt-test', alias: '', reasoning_effort: '',
  endpoint: '', api_key_hash: '', api_key_display: '', api_key_remark: '',
  tokens: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0 },
  ...overrides,
});

describe('safe usage client identity', () => {
  it.each([
    ['claude-code', 'Claude Code'], ['claude-desktop', 'Claude Desktop'], ['codex', 'Codex'],
    ['gemini-cli', 'Gemini CLI'], ['opencode', 'OpenCode'], ['openclaw', 'OpenClaw'],
  ])('renders stable canonical %s as %s', (id, name) => {
    expect(usageClientAgent({ client_agent: id }).name).toBe(name);
  });

  it.each(clients)('keeps $id label parity with the native classifier fixture', ({ id, name }) => {
    const client = usageClientAgent({ client_agent: id });
    expect(client.id).toBe(id);
    expect(client.name).toBe(name);
    expect(client.icon).toBeTruthy();
    const view = buildLiveRouting([record(`source-${id}`, { client_agent: id })], [], now);
    expect(view.agents[0].client.id).toBe(id);
    expect(view.targets[0].agentId).toBe(`agent:${id}`);
  });

  it('does not infer an agent from model, provider, credentials, SDKs or arbitrary identifiers', () => {
    for (const id of [undefined, null, '']) expect(usageClientAgent({ client_agent: id }).id).toBe('unknown');
    for (const id of ['constructor', '__proto__', 'curl', 'python-httpx', 'Mozilla', 'Claude/4.5', 'person@example.test']) {
      const client = usageClientAgent({ client_agent: id });
      expect(client).toEqual({ id: 'other' });
    }
    const misleading = record('misleading', { model: 'claude-code', provider: 'codex', source_display: 'OpenClaw' });
    expect(routingAgentId(misleading)).toBe('agent:unknown');
  });
});

describe('agent to model and credential associations', () => {
  it('keeps the same model served to different Agents and multiple models per Agent distinct', () => {
    const records = [
      record('a1', { client_agent: 'claude-code' }),
      record('a2', { client_agent: 'claude-code', model: 'gemini-test', auth_index: 'backup', provider: 'antigravity' }),
      record('b1', { client_agent: 'codex' }),
      record('b2', { client_agent: 'codex' }),
    ];
    const view = buildLiveRouting(records, [], now);
    expect(view.agents).toHaveLength(2);
    expect(view.targets).toHaveLength(3);
    expect(view.routes).toHaveLength(3);
    for (const request of records) {
      const destination = view.targets.find(target => target.id === routingDestinationId(request))!;
      expect(destination.agentId).toBe(routingAgentId(request));
      expect(destination.model).toBe(request.model);
      expect(view.routes.find(route => route.targetId === destination.id)?.agentId).toBe(destination.agentId);
    }
    const codex = view.targets.find(target => target.agentId === 'agent:codex')!;
    expect(codex.count).toBe(2);
    expect(view.targets.filter(target => target.model === 'gpt-test')).toHaveLength(2);
  });

  it('resolves credential inventory by auth index instead of replacing it with a generic provider label', () => {
    const credentials = routingCredentials({ files: [{ auth_index: 'main', name: 'personal-main', provider: 'openai' }] });
    const view = buildLiveRouting([record('known', { client_agent: 'openclaw', source_display: 'openai' })], [], now, credentials);
    expect(view.targets[0].name).toBe('personal-main');
    expect(view.targets[0].credentialId).toBe('auth:main');
  });

  it('keeps legacy missing UA separate from recognized and unsupported clients without making up history', () => {
    const view = buildLiveRouting([
      record('old'), record('sdk', { client_agent: 'other' }), record('new', { client_agent: 'openclaw' }),
    ], [], now);
    expect(view.agents.map(agent => agent.id)).toEqual(['agent:openclaw', 'agent:other', 'agent:unknown']);
    expect(view.targets).toHaveLength(3);
  });
});
