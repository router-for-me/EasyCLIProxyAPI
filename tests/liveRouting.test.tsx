import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { RoutingPanel } from '../src/components/routing/RoutingPanel';
import { RoutingSnapshot } from '../src/components/routing/RoutingSnapshot';
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
    expect(view.targets.find(target => target.credentialId === 'auth:main')?.provider).toBe('openai');
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

  it('keeps every observed route available instead of silently capping credential rows', () => {
    const records = Array.from({ length: 10 }, (_, index) => request(`request-${index}`, { model: `model-${index}`, auth_index: `target-${index}` }));
    const view = buildLiveRouting(records, [], now);
    expect(view.agents).toHaveLength(1);
    expect(view.targets).toHaveLength(10);
    expect(view.metrics.flows).toBe(10);
    expect(view.hidden).toBe(false);
    expect(buildLiveRouting([], [], now).metrics.latency).toBeNull();
  });

  it('renders telemetry and a useful standby state before the first poll', () => {
    const html = renderToStaticMarkup(<I18nProvider><RoutingPanel /></I18nProvider>);
    expect(html).toContain('data-testid="routing-empty"');
    expect(html.match(/Waiting for recorded requests…/g)).toHaveLength(1);
    expect(html).not.toContain('data-route-gateway');
    expect(html).not.toContain('routing-record-control');
    expect(html).not.toContain('routing-request-context');
    expect(html).not.toContain('<footer');
  });
});

const renderEmpty = (state: Partial<Pick<Parameters<typeof RoutingSnapshot>[0], 'paused' | 'updated' | 'error' | 'initialFocus'>>) =>
  renderToStaticMarkup(<I18nProvider><RoutingSnapshot view={buildLiveRouting([], [], now)} packets={[]} now={now} {...state} /></I18nProvider>);

it('does not present a paused or failed empty snapshot as a functioning live feed', () => {
  const paused = renderEmpty({ paused: true, updated: now });
  expect(paused).toContain('No requests in the paused snapshot.');
  expect(paused).toContain('Updated ');
  expect(paused).not.toContain('Waiting for recorded requests…');
  expect(paused).not.toContain('Listening for gateway traffic');

  const failed = renderEmpty({ error: 'Unable to read usage' });
  expect(failed.match(/Unable to read usage/g)).toHaveLength(1);
  expect(failed).toContain('Unavailable');
  expect(failed).not.toContain('Waiting for recorded requests…');
  expect(failed).not.toContain('Listening for gateway traffic');
});

it('keeps expired pin context and the back-to-latest control in an empty window', () => {
  const html = renderEmpty({ initialFocus: { mode: 'pinned', recordId: 'past-record' } });
  expect(html).toContain('Outside window');
  expect(html).toContain('Back to latest');
  expect(html).toContain('This record left the 60-second window.');
  expect(html.match(/Waiting for recorded requests…/g)).toHaveLength(1);
});
