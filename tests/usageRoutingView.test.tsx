import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, supportedLocales, translate } from '../src/i18n';
import { RoutingMap } from '../src/components/routing/RoutingMap';
import { RoutingSnapshot } from '../src/components/routing/RoutingSnapshot';
import { buildLiveRouting, routingAgentId, routingCooldowns, routingDestinationId, routingFinishedAt } from '../src/services/usageRouting';
import { changeRoutingDisplay, DEFAULT_ROUTING_DISPLAY, groupRoutingTargets, LATEST_ROUTING_FOCUS, orderedRoutingRecords, parseRoutingDisplay, projectRoutingGroups, resolveRoutingFocus, routingGroupOpen, routingRecordForNode } from '../src/services/usageRoutingView';
import type { UsageRecord } from '../src/services/usage';
import { UsagePreferences } from '../src/services/usagePreferences';

const now = Date.parse('2026-11-19T09:00:00Z');
const record = (id: string, overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  id, row_id: id, request_id: `request-${id}`, timestamp: new Date(now - 2000).toISOString(), latency_ms: 400, ttft_ms: null,
  source: '', source_display: 'Main credential', auth_index: 'main', failed: false, canceled: false,
  failure_status: 0, failure_body: '', provider: 'openai', client_agent: 'claude-code', model: 'shared-model', alias: '', reasoning_effort: '',
  endpoint: '', api_key_hash: '', api_key_display: '', api_key_remark: '',
  tokens: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0 },
  ...overrides,
});
const dense = (count = 12) => Array.from({ length: count }, (_, i) => record(`dense-${i}`, {
  auth_index: `credential-${i}`, source_display: `Credential ${i}`, latency_ms: 100 + i * 10,
}));
const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
const wires = (html: string) => html.match(/<svg class="live-routing-edges"[^>]*>([\s\S]*?)<\/svg>/)?.[1] ?? '';

describe('routing model and credential disclosure', () => {
  it('isolates Agent, requested model, and recorded upstream provider with stable polling identities', () => {
    const first = record('a');
    const otherAgent = record('b', { client_agent: 'codex' });
    const otherProvider = record('c', { provider: 'antigravity' });
    const otherModel = record('d', { alias: 'client-alias' });
    const records = [first, otherAgent, otherProvider, otherModel];
    const groups = groupRoutingTargets(buildLiveRouting(records, [], now).targets);
    expect(groups).toHaveLength(4);
    const refreshed = groupRoutingTargets(buildLiveRouting([...records].reverse(), [], now + 1).targets);
    expect(refreshed.map(group => group.id)).toEqual(groups.map(group => group.id));
    const inventory = [{ id: 'auth:main', name: 'Renamed', provider: 'generic-catalog', disabled: false, unavailable: false }];
    expect(groupRoutingTargets(buildLiveRouting(records, [], now, inventory).targets).map(group => group.id)).toEqual(groups.map(group => group.id));
    const missingProvider = [record('missing-provider', { provider: '' })];
    expect(groupRoutingTargets(buildLiveRouting(missingProvider, [], now, inventory).targets)[0].id)
      .toBe(groupRoutingTargets(buildLiveRouting(missingProvider, [], now).targets)[0].id);
  });

  it('weights summary latency by requests, sums failures, and retains cooling status while collapsed', () => {
    const rows = [record('1', { latency_ms: 100 }), record('2', { latency_ms: 100 }), record('3', { latency_ms: 100 }),
      record('4', { latency_ms: 900, auth_index: 'backup', failed: true }), record('5', { latency_ms: 200, auth_index: 'third', failed: true })];
    const cooldowns = routingCooldowns({ files: [{ auth_index: 'backup', name: 'Backup', provider: 'openai', cooldowns: [{
      scope: 'credential', reason: 'quota', remaining_seconds: 20, retry_at: new Date(now + 20_000).toISOString(),
    }] }] }, now);
    const view = buildLiveRouting(rows, cooldowns, now);
    const [group] = groupRoutingTargets(view.targets);
    expect(group.count).toBe(5);
    expect(group.latency).toBe(280);
    expect(group.failures).toBe(2);
    expect(group.credentialCount).toBe(3);
    expect(group.coolingCount).toBe(1);
    expect(routingGroupOpen(group, DEFAULT_ROUTING_DISPLAY)).toBe(false);
    const html = render(<RoutingMap view={view} packets={[]} now={now} />);
    expect(html).toContain('5 · 280 ms');
    expect(html).toContain('2 failed');
    expect(html).toContain('1 cooling');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('healthy');
  });

  it('changes global depth immediately and lets later local toggles override with persisted safe preferences', () => {
    const [group] = groupRoutingTargets(buildLiveRouting(dense(), [], now).targets);
    let display = changeRoutingDisplay(DEFAULT_ROUTING_DISPLAY, { depth: 'credentials' });
    expect(routingGroupOpen(group, display)).toBe(true);
    display = changeRoutingDisplay(display, { toggle: group });
    expect(routingGroupOpen(group, display)).toBe(false);
    expect(JSON.stringify(display)).not.toContain('shared-model');
    expect(JSON.stringify(display)).not.toContain('credential-');
    display = parseRoutingDisplay(JSON.stringify(display));
    expect(routingGroupOpen(group, display)).toBe(false);
    display = changeRoutingDisplay(display, { depth: 'models' });
    expect(display.expanded).toEqual({});
    expect(routingGroupOpen(group, display)).toBe(false);
    display = changeRoutingDisplay(display, { toggle: group });
    expect(routingGroupOpen(group, display)).toBe(true);
    expect(parseRoutingDisplay('bad-json')).toEqual(DEFAULT_ROUTING_DISPLAY);
    expect(parseRoutingDisplay('{"depth":"invalid","expanded":{"__proto__":true,"group:x":"false"}}')).toEqual(DEFAULT_ROUTING_DISPLAY);
  });

  it('persists the display under an accepted usage preference key without storing credentials', async () => {
    const cached = new Map<string, string>();
    const storage = { get length() { return cached.size; }, key: (index: number) => [...cached.keys()][index] || null,
      getItem: (key: string) => cached.get(key) ?? null, setItem: (key: string, value: string) => cached.set(key, value),
      removeItem: (key: string) => cached.delete(key), clear: () => cached.clear() } as Storage;
    const preferences = new UsagePreferences(() => storage);
    let saved: Record<string, string> = {};
    await preferences.initialize({ load: async () => ({}), save: async values => { saved = values; } });
    const [group] = groupRoutingTargets(buildLiveRouting(dense(), [], now).targets);
    const display = changeRoutingDisplay(DEFAULT_ROUTING_DISPLAY, { toggle: group });
    preferences.setItem('cpa-gui.usage-routing-display.v1', JSON.stringify(display));
    await preferences.flush();
    expect(parseRoutingDisplay(saved['cpa-gui.usage-routing-display.v1'])).toEqual(display);
    expect(saved['cpa-gui.usage-routing-display.v1']).not.toContain('shared-model');
    const reload = new UsagePreferences(() => storage);
    expect(parseRoutingDisplay(reload.getItem('cpa-gui.usage-routing-display.v1'))).toEqual(display);
  });

  it('uses no useless disclosure for a single credential and opens two-credential groups automatically', () => {
    const single = groupRoutingTargets(buildLiveRouting([record('one')], [], now).targets);
    const pair = groupRoutingTargets(buildLiveRouting(dense(2), [], now).targets);
    expect(projectRoutingGroups(single, { depth: 'credentials', expanded: {} }).rows).toHaveLength(1);
    expect(routingGroupOpen(pair[0], DEFAULT_ROUTING_DISPLAY)).toBe(true);
    const html = render(<RoutingMap view={buildLiveRouting([record('one')], [], now)} packets={[]} now={now} />);
    expect(html).toMatch(/class="routing-node-focus routing-agent-toggle" aria-expanded="true"/);
    expect(html).not.toContain('routing-group-toggle');
  });

  it('makes every credential beyond eight reachable, with hidden activity projected onto its visible summary', () => {
    const records = dense();
    const view = buildLiveRouting(records, [], now);
    expect(view.targets).toHaveLength(12);
    const groups = groupRoutingTargets(view.targets);
    const folded = projectRoutingGroups(groups, DEFAULT_ROUTING_DISPLAY);
    expect(folded.rows).toHaveLength(1);
    for (const request of records) expect(folded.endpointByTarget.get(routingDestinationId(request))).toBe(groups[0].id);
    const open = projectRoutingGroups(groups, { depth: 'credentials', expanded: {} });
    expect(open.rows).toHaveLength(13);
    for (const request of records) expect(open.endpointByTarget.get(routingDestinationId(request))).toBe(routingDestinationId(request));
    const latest = record('latest', { auth_index: 'credential-11', timestamp: new Date(now - 500).toISOString() });
    const refreshed = buildLiveRouting([...records, latest], [], now);
    const html = render(<RoutingMap view={refreshed} packets={[latest]} now={now} display={DEFAULT_ROUTING_DISPLAY} />);
    expect(wires(html)).toContain('routing-edge-flowing');
    expect(wires(html).match(/data-target=/g)).toHaveLength(2); // one path and one packet at summary, no phantom child path
    const expanded = render(<RoutingMap view={refreshed} packets={[]} now={now} display={{ depth: 'credentials', expanded: {} }} />);
    expect(expanded.match(/data-routing-kind="credential"/g)).toHaveLength(12);
    expect(expanded.match(/data-route-parent=/g)).toHaveLength(12);
    expect(expanded).toMatch(/<button[^>]*class="routing-group-toggle"[^>]*aria-expanded="true"[^>]*aria-controls=/);
    expect(wires(expanded)).not.toMatch(/<(text|tspan|title|foreignObject)\b/);
  });
  it('does not emit a healthy packet for hidden failed, canceled, cooling or paused arrivals', () => {
    const base = dense(4);
    for (const overrides of [{ failed: true }, { canceled: true, failed: true }]) {
      const arrival = record('recent', { auth_index: 'credential-3', timestamp: new Date(now - 500).toISOString(), ...overrides });
      const html = render(<RoutingMap view={buildLiveRouting([...base, arrival], [], now)} packets={[arrival]} now={now} />);
      expect(wires(html)).not.toContain('routing-packet');
    }
    const arrival = record('recent', { auth_index: 'credential-3', timestamp: new Date(now - 500).toISOString() });
    const view = buildLiveRouting([...base, arrival], [], now);
    expect(wires(render(<RoutingMap view={view} packets={[arrival]} now={now} paused />))).not.toContain('routing-packet');
    const cooldowns = routingCooldowns({ files: [{ auth_index: 'credential-3', name: 'Cooling', provider: 'openai', cooldowns: [{ scope: 'credential', reason: 'quota', remaining_seconds: 20, retry_at: new Date(now + 20_000).toISOString() }] }] }, now);
    const coolingHtml = render(<RoutingMap view={buildLiveRouting([...base, arrival], cooldowns, now)} packets={[arrival]} now={now} />);
    const targetWires = wires(coolingHtml).split('<g').filter(group => group.includes('data-target='));
    expect(targetWires.join('')).not.toContain('routing-packet');
  });

});

describe('completed request focus', () => {
  it('follows latest deterministically until pinned, without background arrivals overriding selection', () => {
    const old = record('10');
    const newest = record('11', { timestamp: new Date(now - 500).toISOString() });
    const tied = record('12', { timestamp: newest.timestamp });
    expect(orderedRoutingRecords([old, newest, tied])[0]).toBe(tied);
    expect(orderedRoutingRecords([tied, newest, old])[0]).toBe(tied);
    expect(resolveRoutingFocus(LATEST_ROUTING_FOCUS, [old, newest]).record).toBe(newest);
    const focus = { mode: 'pinned' as const, recordId: old.row_id };
    expect(resolveRoutingFocus(focus, [old, newest, tied]).record).toBe(old);
    expect(resolveRoutingFocus(focus, [newest, tied])).toEqual({ record: undefined, pinned: true, expired: true });
    expect(resolveRoutingFocus(LATEST_ROUTING_FOCUS, [newest, tied]).record).toBe(tied);
  });

  it('node focus chooses a matching observed record, not an unrelated Agent or model credential', () => {
    const rows = [record('a'), record('b', { client_agent: 'codex', auth_index: 'backup' })];
    expect(routingRecordForNode(rows, { agentId: 'agent:codex' })).toBe(rows[1]);
    expect(routingRecordForNode(rows, { targetIds: [routingDestinationId(rows[0])] })).toBe(rows[0]);
    expect(routingRecordForNode(rows, { agentId: 'agent:codex', targetIds: [routingDestinationId(rows[0])] })).toBeUndefined();
  });

  it('renders pinned request context separately from window metrics without raw failure detail or invented retries', () => {
    const old = record('old', { request_id: 'private@email.test/token=secret', alias: 'requested-model', response_model: 'served-model', failed: true, failure_status: 429, failure_body: 'authorization: Bearer raw-secret' });
    const newest = record('new', { client_agent: 'codex', timestamp: new Date(now - 500).toISOString() });
    const view = buildLiveRouting([old, newest], [], now);
    const html = render(<RoutingSnapshot view={view} packets={[]} now={now} display={DEFAULT_ROUTING_DISPLAY} initialFocus={{ mode: 'pinned', recordId: old.row_id }} />);
    expect(html).toContain('Pinned record');
    expect(html).toContain('Back to latest');
    expect(html).toContain('requested-model → served-model');
    expect(html).toContain('HTTP 429');
    expect(html).toContain('Recorded requests');
    expect(html).toContain('Failed records');
    for (const secret of ['raw-secret', 'private@email.test', 'token=secret', 'rerouted', 'retry']) expect(html).not.toContain(secret);
    expect(html).toContain('node-unrelated');
    expect(wires(html)).not.toMatch(/<(text|tspan|title|foreignObject)\b/);
    const expired = render(<RoutingSnapshot view={buildLiveRouting([newest], [], now)} packets={[]} now={now} initialFocus={{ mode: 'pinned', recordId: old.row_id }} />);
    expect(expired).toContain('This record left the 60-second window.');
    expect(expired).not.toContain('served-model');
    expect(routingFinishedAt(newest)).toBeGreaterThan(routingFinishedAt(old));
  });

  it('uses only route-window metrics on the live page and localizes new controls in every locale', () => {
    const source = readFileSync(new URL('../src/pages/UsageRecordsPage.tsx', import.meta.url), 'utf8');
    const live = source.match(/\{activeTab === 'live-routing' \? [\s\S]*? : null\}/)?.[0] ?? '';
    expect(live).not.toContain('UsageStatGrid');
    expect(live).toContain('<RoutingPanel');
    for (const locale of supportedLocales) for (const key of ['routing.depth', 'routing.depth.auto', 'routing.depth.models', 'routing.depth.credentials', 'routing.windowRecords', 'routing.failedRecords', 'routing.observedPaths', 'routing.backToLatest', 'routing.recordExpired', 'routing.expiredSelection', 'routing.pausedEmpty', 'routing.expandAgent', 'routing.collapseAgent', 'routing.allAgentsFolded'] as const) {
      expect(translate(locale, key)).not.toBe(key);
      expect(translate(locale, key).length).toBeGreaterThan(0);
    }
  });
});
