const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const html = '<!doctype html><html data-theme="dark"><div id="root"></div><script type="module" src="/live-routing-fixture.tsx"></script></html>';
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '/src/i18n';
import { RoutingSnapshot } from '/src/components/routing/RoutingSnapshot';
import { buildLiveRouting } from '/src/services/usageRouting';
import '/src/styles/layers.css';
import '/src/styles/index.css';
const now = Date.now();
const record = (id, client_agent, age, options = {}) => ({
  id, row_id: id, request_id: id, client_agent, timestamp: new Date(now - age).toISOString(), latency_ms: 110,
  provider: 'openai', model: 'shared-model', source_display: id, auth_index: id,
  tokens: {}, failed: false, canceled: false, ...options,
});
const claude = record('claude-primary', 'claude-code', 700);
const codex = record('codex-failed', 'codex', 900, { failed: true, failure_status: 429 });
const fresh = record('codex-fresh', 'codex', 400);
const earlier = record('codex-earlier', 'codex', 1000, { auth_index: fresh.auth_index, source_display: fresh.source_display });
function Fixture() {
  const [records, setRecords] = useState([]);
  const [paused, setPaused] = useState(false);
  const [packets, setPackets] = useState([]);
  return <>
    <button onClick={() => setRecords([claude])}>Load single</button>
    <button onClick={() => setRecords([claude, codex])}>Load two</button>
    <button onClick={() => { setRecords([claude, codex, earlier, fresh]); setPackets([fresh]); }}>Receive Codex arrival</button>
    <RoutingSnapshot view={buildLiveRouting(records, [], now)} packets={packets} now={now} paused={paused} onTogglePause={() => setPaused(value => !value)} />
  </>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);
`;

(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false, root: path.resolve(__dirname, '..'), logLevel: 'error', esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, watch: null },
    plugins: [{ name: 'live-routing-test-fixture',
      resolveId(id) { if (id === '/live-routing-fixture.tsx') return id; },
      load(id) { if (id === '/live-routing-fixture.tsx') return fixture; },
      configureServer(vite) {
        vite.middlewares.use('/live-routing-fixture.html', async (_request, response, next) => {
          try {
            response.setHeader('Content-Type', 'text/html');
            response.end(await vite.transformIndexHtml('/live-routing-fixture.html', html));
          } catch (error) { next(error); }
        });
      },
    }],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true, args: ['--no-proxy-server'] });
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const page = await browser.newPage({ viewport: { width: 960, height: 740 }, locale: 'en-US' });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.goto(`${base}/live-routing-fixture.html`);
    await page.getByTestId('routing-empty').waitFor();
    const button = name => page.getByRole('button', { name, exact: true });
    const source = name => page.locator(`[data-route-model="agent:${name}"] button`);
    const group = name => page.locator(`[data-routing-agent-routes="agent:${name}"]`);
    const wires = name => page.locator(`.live-routing-edges path[data-target][data-agent="agent:${name}"]`);
    const packets = name => page.locator(`.live-routing-edges circle[data-target][data-agent="agent:${name}"]`);
    const snapshot = () => page.locator('.routing-request-context').innerText();
    const expectOpen = async (client, count) => {
      assert.equal(await source(client).getAttribute('aria-expanded'), String(count > 0));
      assert.equal(await source(client).getAttribute('aria-controls'), await group(client).getAttribute('id'));
      assert.equal(await group(client).isVisible(), count > 0);
      assert.equal(await group(client).locator('[data-route-target]').count(), count);
      assert.equal(await wires(client).count(), count);
    };
    await button('Load single').click();
    await source('claude-code').waitFor();
    await expectOpen('claude-code', 1);
    const selected = await snapshot();
    await source('claude-code').press('Space');
    await expectOpen('claude-code', 0);
    await page.getByText('Select an Agent to show its routes.', { exact: true }).waitFor();
    await page.getByText('ECPA', { exact: true }).waitFor();
    assert.equal(await snapshot(), selected, 'disclosure must not select a different request');
    await source('claude-code').press('Enter');
    await expectOpen('claude-code', 1);

    await button('Load two').click();
    await expectOpen('claude-code', 1);
    await expectOpen('codex', 0);
    await source('codex').click();
    await expectOpen('claude-code', 1);
    await expectOpen('codex', 1);
    assert.equal(await snapshot(), selected);
    assert.deepEqual(await page.locator('.routing-agent-route-heading').allTextContents(), ['Claude Code', 'Codex']);
    assert.match(await wires('codex').first().getAttribute('class'), /routing-edge-failing/);
    await group('codex').locator('.routing-node-focus').click();
    assert.match(await snapshot(), /HTTP 429/);
    const pinned = await snapshot();
    await source('codex').click();
    await button('Receive Codex arrival').click();
    await expectOpen('claude-code', 1);
    await expectOpen('codex', 0);
    assert.equal(await packets('codex').count(), 0);
    assert.equal(await snapshot(), pinned);
    await source('codex').click();
    await expectOpen('codex', 3);
    assert.equal(await packets('codex').count(), 2); // Agent summary and matching open credential
    await group('codex').locator('.routing-group-toggle').press('Enter');
    await expectOpen('codex', 1);
    assert.equal(await packets('codex').count(), 1);
    assert.equal(await page.locator('[data-testid="routing-map"]').evaluate(map => {
      const rect = map.getBoundingClientRect();
      return [...map.querySelectorAll('path[data-target]')].every(wire => {
        const port = [...map.querySelectorAll('[data-route-target]')].find(node => node.dataset.routeTarget === wire.dataset.target).querySelector('.port-in').getBoundingClientRect();
        const endpoint = wire.getPointAtLength(wire.getTotalLength());
        return Math.hypot(endpoint.x - (port.left - rect.left + port.width / 2), endpoint.y - (port.top - rect.top + port.height / 2)) < 0.2;
      });
    }), true, 'remaining wires must end at the visible destination ports after folding');
    await button('Pause monitor').click();
    await expectOpen('codex', 1);
    assert.equal(await packets('codex').count(), 0);
    await page.setViewportSize({ width: 370, height: 740 });
    await source('codex').press('Space');
    await expectOpen('codex', 0);
    await expectOpen('claude-code', 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log('PASS: single/multi Agent pointer and keyboard disclosure, route and packet projection, wire reflow, model fold, pinned snapshot, pause and narrow width.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
