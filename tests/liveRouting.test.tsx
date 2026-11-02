import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { RoutingPanel } from '../src/components/routing/RoutingPanel';
import { buildLiveRouting, routingCooldowns, routingCredentials } from '../src/services/usageRouting';
import type { UsageRecord } from '../src/services/usage';

const now = Date.parse('2026-11-02T12:00:00Z');
const request = (id: string, overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  id, row_id: id, timestamp: new Date(now - 1000).toISOString(), latency_ms: 100, ttft_ms: null,
  source: '', source_display: 'Main credential', auth_index: 'main', failed: false, canceled: false,
  failure_status: 0, failure_body: '', provider: 'openai', model: 'gpt', alias: '', reasoning_effort: '',
  endpoint: '', api_key_hash: '', api_key_display: '', api_key_remark: '',
  tokens: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0 },
  ...overrides,
});

describe('live routing telemetry', () => {
  it('deduplicates window requests and counts flows, failures, average latency and window QPS', () => {
    const first = request('one');
    const second = request('two', { latency_ms: 300, failed: true, auth_index: 'backup' });
    const canceled = request('three', { canceled: true, failed: true, latency_ms: 200 });
    const view = buildLiveRouting([first, first, second, canceled,
      request('old', { timestamp: new Date(now - 61_000).toISOString() })], [], now);
    expect(view.metrics).toEqual({ flows: 2, requests: 3, latency: 200, qps: .05, failures: 1, ready: 0, cooling: 0 });
    expect(view.targets.find(target => target.id === 'auth:main')?.provider).toBe('openai');
  });

  it('reads configured credentials without inventing ready counts for disabled or unhealthy targets', () => {
    const payload = { files: [
      { auth_index: 'main', name: 'Main', provider: 'openai' },
      { auth_index: 'main', name: 'Main', provider: 'openai' },
      { auth_index: 'off', disabled: true }, { auth_index: 'error', status: 'error' },
      { auth_index: 'unavailable', unavailable: true }, { name: 'missing index' },
    ] };
    const credentials = routingCredentials(payload);
    expect(credentials).toHaveLength(4);
    expect(buildLiveRouting([], [], now, credentials).metrics.ready).toBe(1);
    expect(() => routingCredentials({})).toThrow();
  });

  it('counts cooling credentials once and expires countdowns without retaining phantom cooling nodes', () => {
    const payload = { files: [{ auth_index: 'main', name: 'Main', provider: 'openai', cooldowns: [{
      scope: 'credential', reason: 'quota', retry_at: new Date(now + 10_000).toISOString(), remaining_seconds: 10,
    }] }] };
    const cooldowns = routingCooldowns(payload, now);
    const credentials = routingCredentials(payload);
    const cooling = buildLiveRouting([], cooldowns, now, credentials);
    expect(cooling.metrics.ready).toBe(0);
    expect(cooling.metrics.cooling).toBe(1);
    expect(cooling.targets[0].cooldown).toBeDefined();
    const expired = buildLiveRouting([], cooldowns, now + 11_000, credentials);
    expect(expired.metrics.ready).toBe(1);
    expect(expired.metrics.cooling).toBe(0);
    expect(expired.targets).toHaveLength(0);
  });

  it('keeps all flows in telemetry even when the visual topology is capped', () => {
    const records = Array.from({ length: 8 }, (_, index) => request(`request-${index}`, { model: `model-${index}`, auth_index: `target-${index}` }));
    const view = buildLiveRouting(records, [], now);
    expect(view.models).toHaveLength(6);
    expect(view.targets).toHaveLength(6);
    expect(view.metrics.flows).toBe(8);
    expect(view.hidden).toBe(true);
    expect(buildLiveRouting([], [], now).metrics.latency).toBeNull();
  });

  it('renders telemetry and a useful standby state before the first poll', () => {
    const html = renderToStaticMarkup(<I18nProvider><RoutingPanel /></I18nProvider>);
    expect(html).toContain('routing-metrics');
    expect(html).toContain('routing-standby');
    expect(html).toContain('routing-radar');
    expect(html).toContain('— / —');
    expect(html).not.toContain('live-routing-empty');
  });
});
