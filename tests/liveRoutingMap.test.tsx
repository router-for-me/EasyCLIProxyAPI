import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import appLogo from '../src/assets/logo.jpg';
import { RoutingMap } from '../src/components/routing/RoutingMap';
import { buildLiveRouting, routingCooldowns, routingDestinationId } from '../src/services/usageRouting';
import type { UsageRecord } from '../src/services/usage';

const now = Date.parse('2026-11-19T08:00:00Z');
const request = (id: string, overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  id, row_id: id, timestamp: new Date(now - 2000).toISOString(), latency_ms: 431, ttft_ms: null,
  source: '', source_display: 'Main credential', auth_index: 'main', failed: false, canceled: false,
  failure_status: 0, failure_body: '', provider: 'openai', client_agent: 'claude-code', model: 'model-a', alias: '', reasoning_effort: '',
  endpoint: '', api_key_hash: '', api_key_display: '', api_key_remark: '',
  tokens: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0 },
  ...overrides,
});
const render = (view: ReturnType<typeof buildLiveRouting>, packets: UsageRecord[] = [], paused = false) =>
  renderToStaticMarkup(<I18nProvider><RoutingMap view={view} packets={packets} now={now} paused={paused} /></I18nProvider>);
const wires = (html: string) => html.match(/<svg class="live-routing-edges"[^>]*>([\s\S]*?)<\/svg>/)?.[1] ?? '';
const encoded = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
const pathFor = (html: string, side: 'model' | 'target', id: string) =>
  [...wires(html).matchAll(/<path\b[^>]*>/g)].map((match) => match[0]).find((path) => path.includes(`data-${side}="${encoded(id)}"`)) ?? '';
const packetsFor = (html: string, side: 'model' | 'target') =>
  [...wires(html).matchAll(/<circle\b[^>]*>/g)].map((match) => match[0]).filter((circle) => circle.includes(`data-${side}=`));

describe('live route map', () => {
  it('keeps the existing CPA logo in the compact gateway rather than a generic network glyph', () => {
    const html = render(buildLiveRouting([request('logo')], [], now));
    const gateway = html.match(/<span class="gateway-mark"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '';
    expect(gateway).toContain(`<img src="${encoded(appLogo)}" width="30" height="30" alt=""`);
    expect(gateway).not.toContain('<svg');
    expect(html).toContain('data-route-gateway="true"');
    expect(html).toContain('<span class="gateway-name">ECPA</span>');
    expect(wires(html)).not.toMatch(/<(text|tspan|title|foreignObject)\b/);
  });

  it('keeps every connector free of copy, chips, and tooltips while metrics remain on nodes', () => {
    const records = [request('failed', { failed: true }), request('ok')];
    const html = render(buildLiveRouting(records, [], now));
    expect(wires(html)).not.toMatch(/<(text|tspan|title|foreignObject)\b/);
    expect(wires(html)).not.toContain('ms');
    expect(wires(html)).not.toContain('failed');
    expect(html).toContain('2 · 431 ms');
    expect(html).toContain('1 failed');
    expect(html).toContain('data-testid="routing-map"');
    expect(html).toContain('data-route-model="agent:claude-code"');
    expect(html).toContain(`data-route-target="${encoded(routingDestinationId(request('main')))}"`);
    expect(html).toContain('data-route-gateway="true"');
  });

  it('does not animate history or a first snapshot', () => {
    const html = render(buildLiveRouting([request('history')], [], now));
    expect(pathFor(html, 'model', 'agent:claude-code')).toContain('routing-edge-recorded');
    expect(wires(html)).not.toContain('routing-edge-flow');
    expect(wires(html)).not.toContain('routing-packet');
  });

  it('pulses only the Agent and associated model/credential of a matching successful arrival', () => {
    const fresh = request('fresh', { timestamp: new Date(now - 1000).toISOString(), model: 'aliased-source', alias: 'shown-model', auth_index: '  main  ' });
    const other = request('other', { model: 'model-b', client_agent: 'codex', auth_index: 'backup', source_display: 'Backup' });
    const html = render(buildLiveRouting([fresh, other], [], now), [fresh]);
    expect(pathFor(html, 'model', 'agent:claude-code')).toContain('routing-edge-flowing');
    expect(pathFor(html, 'target', routingDestinationId(fresh))).toContain('routing-edge-flowing');
    expect(pathFor(html, 'model', 'agent:codex')).toContain('routing-edge-recorded');
    expect(pathFor(html, 'target', routingDestinationId(other))).toBe('');
    expect(packetsFor(html, 'model')).toHaveLength(1);
    expect(packetsFor(html, 'model')[0]).toContain('data-model="agent:claude-code"');
    expect(packetsFor(html, 'target')).toHaveLength(1);
    expect(packetsFor(html, 'target')[0]).toContain(`data-target="${encoded(routingDestinationId(fresh))}"`);
    expect(wires(html)).toContain('repeatCount="1"');
    expect(wires(html)).toContain('fill="freeze"');
    expect(wires(html)).not.toContain('indefinite');
  });

  it('maps arrivals without auth indexes to the same provider target as the service', () => {
    const fresh = request('provider', { auth_index: undefined });
    const html = render(buildLiveRouting([fresh], [], now), [fresh]);
    expect(pathFor(html, 'target', routingDestinationId(fresh))).toContain('routing-edge-flowing');
  });

  it('selects latest completed failures by time independently of queue ordering', () => {
    const newest = request('newest', { failed: true, timestamp: new Date(now - 1000).toISOString() });
    const records = [newest, request('older'), request('oldest', { timestamp: new Date(now - 3000).toISOString() })];
    const view = buildLiveRouting(records, [], now);
    expect(view.routes[0].failed).toBe(true);
    for (const sorted of [records, [...records].reverse()]) {
      const html = render(buildLiveRouting(sorted, [], now), [newest]);
      expect(pathFor(html, 'model', 'agent:claude-code')).toContain('routing-edge-failing');
      expect(pathFor(html, 'target', routingDestinationId(request('main')))).toContain('routing-edge-failing');
      expect(wires(html)).not.toContain('routing-packet');
    }
  });

  it('does not turn a healthy aggregate red because an older minor route failed', () => {
    const oldFailure = request('old-failure', { failed: true, auth_index: 'old' });
    const fresh = request('success', { timestamp: new Date(now - 1000).toISOString() });
    const html = render(buildLiveRouting([fresh, request('success-2'), request('success-3'), oldFailure], [], now), [fresh]);
    expect(pathFor(html, 'model', 'agent:claude-code')).toContain('routing-edge-flowing');
    expect(pathFor(html, 'target', routingDestinationId(oldFailure))).toContain('routing-edge-failing');
    expect(pathFor(html, 'target', routingDestinationId(request('main')))).toContain('routing-edge-flowing');
  });

  it('keeps majority-failed paths static even after a successful arrival', () => {
    const fresh = request('recovered', { timestamp: new Date(now - 1000).toISOString() });
    const html = render(buildLiveRouting([fresh, request('bad-1', { failed: true }), request('bad-2', { failed: true })], [], now), [fresh]);
    expect(pathFor(html, 'target', routingDestinationId(request('main')))).toContain('routing-edge-failing');
    expect(wires(html)).not.toContain('routing-packet');
  });

  it('does not animate canceled requests or paused monitors', () => {
    const canceled = request('canceled', { canceled: true, failed: true });
    const fresh = request('fresh');
    const canceledHtml = render(buildLiveRouting([canceled], [], now), [canceled]);
    expect(pathFor(canceledHtml, 'model', 'agent:claude-code')).toContain('routing-edge-recorded');
    expect(wires(canceledHtml)).not.toContain('routing-packet');
    const paused = render(buildLiveRouting([fresh], [], now), [fresh], true);
    expect(wires(paused)).not.toContain('routing-packet');
    expect(wires(paused)).not.toContain('routing-edge-flow');
  });

  it('gives cooldown precedence without hiding counts or latency', () => {
    const cooldowns = routingCooldowns({ files: [{ auth_index: 'main', name: 'Main', provider: 'openai', cooldowns: [{
      scope: 'credential', reason: 'quota', retry_at: new Date(now + 10_000).toISOString(), remaining_seconds: 10,
    }] }] }, now);
    const view = buildLiveRouting([request('failed', { failed: true })], cooldowns, now);
    const html = render(view);
    const target = html.slice(html.indexOf(`data-route-target="${encoded(routingDestinationId(request('main')))}"`));
    expect(target).toContain('Cooldown · 10s');
    expect(target).toContain('1 · 431 ms');
    expect(target).not.toContain('1 failed');
    expect(wires(html)).not.toContain('routing-packet');
    const idle = render(buildLiveRouting([], cooldowns, now));
    expect(idle).toContain('class="routing-unobserved-cooling"');
    expect(idle).toContain('Main');
    expect(idle).toContain('Cooldown · 10s');
    expect(idle).not.toContain('data-route-target');
    expect(wires(idle)).toBe('');
    expect(idle).not.toContain('0 · 0 ms');

    const unrelated = render(buildLiveRouting([request('ok', { auth_index: 'other' })], cooldowns, now));
    expect(unrelated).toContain('class="routing-unobserved-cooling"');
    expect(pathFor(unrelated, 'target', 'cooldown:auth:main')).toBe('');
  });

  it('shows a single empty region without disconnected nodes or synthetic paths', () => {
    const html = render(buildLiveRouting([], [], now));
    expect(html).toContain('data-testid="routing-empty"');
    expect(html.match(/Waiting for recorded requests…/g)).toHaveLength(1);
    expect(html).not.toContain('data-route-');
    expect(html).not.toContain('live-routing-edges');
  });

  it('bounds link stroke weights while distinguishing route volume', () => {
    const records = [request('small', { model: 'small', auth_index: 'small' }), ...Array.from({ length: 20 }, (_, i) => request(`big-${i}`))];
    const html = render(buildLiveRouting(records, [], now));
    const smallWidth = Number(pathFor(html, 'target', routingDestinationId(request('small', { model: 'small', auth_index: 'small' }))).match(/stroke-width:([^;"<]+)/)?.[1]);
    const bigWidth = Number(pathFor(html, 'target', routingDestinationId(request('main'))).match(/stroke-width:([^;"<]+)/)?.[1]);
    expect(smallWidth).toBeGreaterThanOrEqual(1.6);
    expect(bigWidth).toBeLessThanOrEqual(3.4);
    expect(bigWidth).toBeGreaterThan(smallWidth);
  });

  it('retains reduced-motion and compact layout rules without constraining every node to full width', () => {
    const css = readFileSync(new URL('../src/components/routing/RoutingPanel.css', import.meta.url), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.routing-packet\s*\{\s*display: none;/);
    expect(css).toContain('@container (max-width: 740px)');
    expect(css).toContain('@container (max-width: 540px)');
    expect(css).toMatch(/\.live-routing-map \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);[^}]*align-items: start;/);
    expect(css).toMatch(/@container \(max-width: 400px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).not.toMatch(/\.live-routing-map \{[^}]*min-height:/);
    expect(css.match(/^\.routing-row-text \{/gm)).toHaveLength(1);
    expect(css).toMatch(/^\.routing-row-heading \{/m);
    expect(css).not.toMatch(/\.node-ghost \.routing-row-heading/);
    expect(css).not.toContain('routing-edge-label');
  });

  it('does not repeat the model, Agent name or failure count across both ends of a single route', () => {
    const html = render(buildLiveRouting([request('single', { failed: true })], [], now));
    const source = html.split('class="routing-map-column routing-map-models"')[1]?.split('class="routing-map-center"')[0];
    const destination = html.split('class="routing-map-column routing-map-targets"')[1];
    expect(source).toContain('Claude Code');
    expect(source).not.toContain('model-a');
    expect(source).not.toContain('1 failed');
    expect(destination).toContain('model-a');
    expect(destination).toContain('Main credential');
    expect(destination).toContain('1 failed');
    expect(destination).not.toContain('>Claude Code<');
  });

  it('initially opens only the latest Agent and omits folded destination paths and packets', () => {
    const claude = request('claude', { client_agent: 'claude-code', model: 'same-model' });
    const codex = request('codex', { client_agent: 'codex', model: 'same-model', timestamp: new Date(now - 1000).toISOString() });
    const html = render(buildLiveRouting([claude, codex], [], now), [claude]);
    expect(html).toContain('data-route-agent="agent:claude-code"');
    expect(html).toContain('data-route-agent="agent:codex"');
    expect(html).toContain('aria-label="Expand routes for Claude Code"');
    expect(html).toContain('aria-label="Collapse routes for Codex"');
    expect(html).not.toContain('routing-row-origin');
    expect(pathFor(html, 'target', routingDestinationId(claude))).toBe('');
    expect(pathFor(html, 'target', routingDestinationId(codex))).toContain('routing-edge-recorded');
    expect(packetsFor(html, 'target')).toHaveLength(0);
  });

  it('does not display raw or unrecognized client header content in text or titles', () => {
    const bad = request('private', { client_agent: 'person@example.test /home/private token=secret' });
    const html = render(buildLiveRouting([bad], [], now));
    expect(html).toContain('Other client');
    for (const value of ['person@example.test', '/home/private', 'token=secret']) expect(html).not.toContain(value);
    const old = request('legacy', { client_agent: undefined, model: 'codex', provider: 'claude' });
    expect(render(buildLiveRouting([old], [], now))).toContain('Unknown client');
  });

  it('keeps tied completion failures deterministic across history and packet order', () => {
    const timestamp = new Date(now - 1000).toISOString();
    const failed = request('tie-failed', { timestamp, failed: true });
    const success = request('tie-ok', { timestamp });
    const older = Array.from({ length: 4 }, (_, i) => request(`older-${i}`));
    for (const records of [[failed, success, ...older], [...older, success, failed]]) {
      for (const arrivals of [[failed, success], [success, failed]]) {
        const view = buildLiveRouting(records, [], now);
        expect(view.agents[0].failed).toBe(true);
        expect(view.targets[0].failed).toBe(true);
        expect(view.routes[0].failed).toBe(true);
        expect(view.targets[0].failures / view.targets[0].count).toBeLessThan(0.5);
        const html = render(view, arrivals);
        expect(pathFor(html, 'model', 'agent:claude-code')).toContain('routing-edge-failing');
        expect(pathFor(html, 'target', routingDestinationId(success))).toContain('routing-edge-failing');
        expect(wires(html)).not.toContain('routing-packet');
      }
    }
  });

});
