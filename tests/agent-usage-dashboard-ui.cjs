const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const fixture = `
import { createElement as element } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '/src/i18n';
import { AgentUsageView } from '/src/pages/AgentUsageView';
import '/src/styles/index.css';
const now = new Date();
const key = value => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
const date = key(now);
const previous = key(new Date(now.getTime() - 86400000));
const counter = { inputTokens: 12000, outputTokens: 5000, cacheReadTokens: 1500, cacheCreationTokens: 500, reasoningOutputTokens: 0, totalTokens: 19000, costUSD: 0.1234, samples: 12, days: 1 };
const zero = { ...counter, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUSD: 0, samples: 0, days: 0 };
const days = Array.from({ length: 7 }, (_, index) => key(new Date(now.getTime() - (6 - index) * 86400000)));
const active = new Set([previous, date]);
const timeline = days.map(day => ({ bucket: day, ...(active.has(day) ? counter : zero) }));
const model = (name, priced) => ({ model: name, ...counter, priced, prompt: priced ? 3 : null, completion: priced ? 15 : null, cacheRead: priced ? 0.3 : null, cacheCreation: priced ? 3.75 : null, costUSD: priced ? 0.1234 : 0 });
const statusOf = source => source === 'codex' || source === 'claude' ? 'ok' : source === 'zcode' ? 'error' : source === 'pi' ? 'archived' : 'empty';
window.syncCount = 0;
window.queries = [];
window.backendSyncing = false;
window.callbacks = new Map();
window.listeners = new Map();
window.emitTauri = (event, payload) => window.callbacks.get(window.listeners.get(event))?.({ event, id: 0, payload });
window.__TAURI_INTERNALS__ = { transformCallback: (callback) => {
  const id = window.callbacks.size + 1;
  window.callbacks.set(id, callback);
  return id;
}, invoke: async (command, payload) => {
  if (command === 'plugin:event|listen') {
    window.listeners.set(payload.event, payload.handler);
    return payload.handler;
  }
  if (command === 'get_agent_usage') {
    const query = payload?.query || {};
    window.queries.push(query);
    await new Promise(resolve => setTimeout(resolve, query.range === '30d' ? 400 : 20));
    const selected = query.sources || [];
    const included = source => !selected.length || selected.includes(source);
    const sources = ['claude', 'codex', 'mcode', 'opencode', 'omp', 'pi', 'copilot', 'gemini', 'antigravity', 'kimi', 'zcode'].map(source => {
      const status = statusOf(source);
      const withData = status === 'ok' || status === 'archived';
      const priced = source !== 'pi';
      return {
        source, status,
        archivedAt: status === 'archived' ? new Date(now.getTime() - 86400000 * 21).toISOString() : '',
        error: status === 'error' ? 'Cannot read local records' : '',
        totals: withData ? { ...counter, costUSD: priced ? 0.2468 : 0, totalTokens: 38000, days: 2 } : zero,
        models: withData && included(source) ? [model(source === 'pi' ? 'deepseek-v4.1-flash' : source + '-model', priced)] : [],
        series: withData && included(source) ? [previous, date].map(day => ({ bucket: day, ...counter })) : [],
      };
    });
    const count = sources.filter(source => source.series.length).length;
    const scaled = { ...counter, totalTokens: 38000 * count, costUSD: 0.2468 * count, cacheReadTokens: 3000 * count, inputTokens: 24000 * count, cacheCreationTokens: 1000 * count, days: count ? 2 : 0 };
    return {
      schemaVersion: 2, generatedAt: now.toISOString(), lastSyncAt: now.toISOString(), syncing: window.backendSyncing,
      bucket: query.granularity || (query.range === 'all' ? 'week' : 'day'), rangeStart: days[0], rangeEnd: date,
      totals: count ? scaled : zero,
      previous: query.range === 'all' ? null : { totalTokens: count ? 19000 * count : 0, costUSD: 0.1 },
      sources,
      timeline: count ? timeline : timeline.map(row => ({ ...row, ...zero, bucket: row.bucket })),
      calendar: count ? [{ date: previous, totalTokens: 19000, costUSD: 0.1234 }, { date, totalTokens: 19000, costUSD: 0.1234 }] : [],
      hourly: count ? [{ weekday: 0, hour: 9, totalTokens: 500, samples: 2 }, { weekday: 0, hour: 10, totalTokens: 900, samples: 3 }] : [],
    };
  }
  if (command === 'sync_agent_usage') {
    window.syncCount++;
    await new Promise(resolve => setTimeout(resolve, 150));
    return { skipped: false, changedFiles: 2, scannedFiles: 835, durationMs: 118, lastSyncAt: now.toISOString() };
  }
  return null;
} };
createRoot(document.getElementById('root')).render(element(I18nProvider, null,
  element('main', { className: 'workspace usage-records-page', style: { display: 'block', containerType: 'inline-size', containerName: 'workspace', padding: '20px', maxWidth: '1400px', margin: 'auto' } },
    element('div', { className: 'usage-tab-panel' },
      element(AgentUsageView, { refreshKey: 0, onLoadingChange: () => {} })))));
`;

(async () => {
  let browser;
  let server;
  try {
    const { createServer } = await import('vite');
    server = await createServer({
      configFile: false, root: path.resolve(__dirname, '..'), logLevel: 'error',
      plugins: [{
        name: 'usage-dashboard-fixture',
        resolveId(id) { if (id === '/__usage.js') return id; },
        load(id) { if (id === '/__usage.js') return fixture; },
        configureServer(vite) {
          vite.middlewares.use('/__usage.html', async (_request, response, next) => {
            try {
              const html = await vite.transformIndexHtml('/__usage.html', '<html lang="en"><head></head><body><div id="root"></div><script type="module" src="/__usage.js"></script></body></html>');
              response.setHeader('Content-Type', 'text/html');
              response.end(html);
            } catch (error) { next(error); }
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__usage.html`);
    const active = page.locator('.agent-usage-chip[data-source="codex"]');
    await active.waitFor();
    await page.waitForFunction(() => window.syncCount === 1);
    assert.equal(await page.locator('.agent-usage-kpi').count(), 3);
    assert.match(await page.locator('.agent-usage-kpi[data-kpi="tokens"]').textContent(), /114K.*\+100% vs previous period/);
    assert.equal(await page.locator('.agent-usage-kpi[data-kpi="tokens"] strong').getAttribute('title'), '114,000');
    assert.equal(await page.locator('.agent-usage-kpi .agent-usage-sparkline polyline').count(), 2);
    assert.match(await page.locator('.agent-usage-kpi[data-kpi="cost"]').textContent(), /2 active days · \$0\.\d+\/day/);
    assert.match(await page.locator('.agent-usage-kpi[data-kpi="cache"]').textContent(), /\d+(\.\d+)?%.*read · .* written/);
    assert.deepEqual(await page.locator('.agent-usage-chip').evaluateAll(nodes => nodes.map(node => node.dataset.source || 'all')), ['all', 'claude', 'codex', 'pi']);
    assert.match(await page.locator('.agent-usage-chip[data-source="pi"]').getAttribute('title'), /Uninstalled/);
    assert.match(await page.locator('.notice').textContent(), /ZCode: Cannot read local records/);
    assert.equal(await page.locator('.agent-usage-chart svg g[data-bucket]').count(), 7);
    assert.deepEqual(await page.locator('.agent-usage-axis text').allTextContents(), ['0', '20K', '40K', '60K']);
    assert.deepEqual(await page.locator('.agent-usage-bar-value').allTextContents(), ['57K', '57K']);

    const plot = await page.locator('.agent-usage-chart svg').boundingBox();
    await page.mouse.move(plot.x + plot.width - 20, plot.y + plot.height / 2);
    await page.locator('.agent-usage-tooltip').waitFor();
    assert.match(await page.locator('.agent-usage-tooltip').textContent(), /^\d{4}-\d{2}-\d{2}57K.*Claude Code19K/);
    assert.equal(await page.locator('.agent-usage-highlight').count(), 1);
    await page.mouse.move(plot.x + 5, plot.y - 40);
    await page.waitForFunction(() => !document.querySelector('.agent-usage-tooltip'));

    assert.deepEqual(await page.locator('.agent-usage-view-tabs [data-value]').evaluateAll(nodes => nodes.map(node => node.dataset.value)), ['trend', 'structure']);
    for (const view of ['structure', 'trend']) {
      await page.locator('.agent-usage-view-tabs [data-value="' + view + '"]').click();
      assert.equal(await page.locator('.agent-usage-chart svg').count(), 1, view);
      assert.equal(await page.locator('.agent-usage-group-tabs').count(), view === 'trend' ? 1 : 0, view);
    }
    const chartHeights = [];
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.waitForTimeout(50);
      chartHeights.push((await page.locator('.agent-usage-chart svg').boundingBox()).height);
    }
    assert.ok(chartHeights[0] > chartHeights[1], `trend height follows width: ${chartHeights}`);

    const activity = page.locator('.agent-usage-activity');
    for (const view of ['calendar', 'hours']) {
      const block = activity.locator(`[data-view="${view}"]`);
      const cells = await block.locator('rect.agent-usage-heat').evaluateAll(nodes => nodes.map(node => [node.getAttribute('width'), node.getAttribute('height')]));
      assert.ok(cells.length >= (view === 'hours' ? 168 : 365), view);
      assert.ok(cells.every(([width, height]) => width === '13' && height === '13'), `${view} cells are uniform squares`);
      await block.locator('rect.agent-usage-heat.level-4').first().hover();
      await block.locator('.agent-usage-tooltip').waitFor();
      assert.match(await block.locator('.agent-usage-tooltip').textContent(), view === 'hours' ? /10:00900/ : /19K\$0\.1234$/);
    }
    assert.equal(await activity.locator('.agent-usage-heat-legend i').count(), 5);
    const calendarScroll = await activity.locator('[data-view="calendar"] .agent-usage-scroll').evaluate(node => node.scrollWidth - node.clientWidth - node.scrollLeft);
    assert.ok(calendarScroll <= 1, 'calendar opens at the latest week');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator('.agent-usage-view-tabs [data-value="trend"]').click();
    await page.locator('.agent-usage-group-tabs [data-value="model"]').click();
    await page.locator('.agent-usage-metric-tabs [data-value="costUSD"]').click();
    assert.equal(await page.locator('.agent-usage-metric-tabs [data-value="costUSD"]').getAttribute('aria-checked'), 'true');
    assert.ok((await page.locator('.agent-usage-axis text').allTextContents()).every(text => text.startsWith('$')));
    await page.locator('.agent-usage-metric-tabs [data-value="totalTokens"]').click();
    await page.locator('.agent-usage-group-tabs [data-value="source"]').click();

    assert.equal(await page.locator('.agent-usage-table[data-table="models"] tbody tr').count(), 3);
    assert.equal(await page.locator('.agent-usage-table[data-table="models"] tr[data-model="deepseek-v4.1-flash"] td.unpriced').textContent(), '$0.00');

    await active.click();
    await page.locator('.agent-usage-chip[data-source="pi"]').click();
    assert.equal(await active.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.agent-usage-chip:not([data-source])').getAttribute('aria-pressed'), 'false');
    await page.waitForFunction(() => JSON.stringify(window.queries.at(-1).sources) === JSON.stringify(['codex', 'pi']));
    await page.waitForFunction(() => document.querySelectorAll('.agent-usage-table[data-table="models"] tbody tr').length === 2);
    await page.locator('.agent-usage-ranking-tabs [data-value="sources"]').click();
    assert.equal(await page.locator('.agent-usage-table[data-table="sources"] tbody tr').count(), 3);
    assert.equal(await page.locator('.agent-usage-table[data-table="sources"] tr[data-source="claude"]').evaluate(node => node.classList.contains('dimmed')), true);
    await page.locator('.agent-usage-chip:not([data-source])').click();
    await page.waitForFunction(() => window.queries.at(-1).sources.length === 0);

    await page.locator('.agent-usage-range [data-value="all"]').click();
    assert.equal(await page.locator('.agent-usage-granularity [data-value="hour"]').isDisabled(), true);
    await page.locator('.agent-usage-granularity [data-value="day"]').click();
    await page.waitForFunction(() => window.queries.at(-1).range === 'all' && window.queries.at(-1).granularity === 'day');
    await page.locator('.agent-usage-range [data-value="7d"]').click();
    await page.waitForFunction(() => window.queries.at(-1).range === '7d' && window.queries.at(-1).granularity === '');
    assert.equal(await page.locator('.agent-usage-granularity [data-value="hour"]').isDisabled(), false);

    await page.locator('.agent-usage-range [data-value="30d"]').click();
    await page.locator('.agent-usage-range [data-value="all"]').click();
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.agent-usage-granularity [data-value="week"]').getAttribute('aria-checked'), 'true', 'a late 30-day response must not replace the all-time report');
    assert.equal(await page.locator('.agent-usage-range [data-value="all"]').getAttribute('aria-checked'), 'true');

    await page.evaluate(() => {
      window.backendSyncing = true;
      window.emitTauri('agent-usage-sync-progress', { source: 'claude', scanned: 1, total: 10, finished: false });
    });
    await page.waitForFunction(() => document.querySelector('.agent-usage-sync').disabled);
    await page.evaluate(() => { window.backendSyncing = false; });
    await page.locator('.agent-usage-range [data-value="7d"]').click();
    await page.waitForFunction(() => !document.querySelector('.agent-usage-sync').disabled, null, { timeout: 2000 });
    await page.evaluate(() => {
      window.backendSyncing = true;
      window.emitTauri('agent-usage-sync-progress', { source: 'claude', scanned: 2, total: 10, finished: false });
    });
    await page.waitForFunction(() => document.querySelector('.agent-usage-sync').disabled);
    await page.evaluate(() => {
      window.backendSyncing = false;
      window.emitTauri('agent-usage-synced', null);
    });
    await page.waitForFunction(() => !document.querySelector('.agent-usage-sync').disabled, null, { timeout: 2000 });

    await page.locator('.agent-usage-ranking-tabs [data-value="details"]').click();
    assert.equal(await page.locator('.agent-usage-table[data-table="details"] tbody tr').count(), 2);
    assert.equal(await page.locator('.agent-usage-table[data-table="details"] thead th').count(), 7);
    await page.locator('.agent-usage-ranking-tabs [data-value="models"]').click();

    const before = await page.evaluate(() => window.syncCount);
    await page.locator('.agent-usage-sync').click();
    assert.equal(await page.locator('.agent-usage-sync').isDisabled(), true);
    assert.equal(await page.locator('.agent-usage-spin').count(), 1);
    await page.waitForFunction(() => !document.querySelector('.agent-usage-sync').disabled);
    assert.equal(await page.evaluate(() => window.syncCount), before + 1);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await page.setViewportSize({ width: 1280, height: 800 });
      if (process.env.USAGE_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.USAGE_SCREENSHOTS, `usage-${theme}-1280.png`), fullPage: true, animations: 'disabled' });
      const singleKpiRow = await page.evaluate(() => {
        const kpis = [...document.querySelectorAll('.agent-usage-kpi')].map(node => node.getBoundingClientRect());
        return kpis.every(kpi => kpi.top === kpis[0].top && kpi.height === kpis[0].height);
      });
      assert.equal(singleKpiRow, true, `${theme} KPI row`);
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1100 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} at ${width}px overflows`);
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('.agent-usage-sparkline')].every(line => {
          const card = line.closest('.agent-usage-kpi').getBoundingClientRect();
          const box = line.getBoundingClientRect();
          return box.left >= card.left && box.right <= card.right;
        })), true, `${theme} sparklines stay inside their cards at ${width}px`);
        await page.waitForFunction(() => {
          const node = document.querySelector('.agent-usage-calendar .agent-usage-scroll');
          return node.scrollWidth - node.clientWidth - node.scrollLeft <= 1;
        }, null, { timeout: 2000 });
        if (process.env.USAGE_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.USAGE_SCREENSHOTS, `usage-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await active.hover();
    assert.equal(await active.evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    assert.deepEqual(errors, []);
    console.log('Usage dashboard passed: compact KPIs, source chips, chart tooltips and sizing, range and granularity, ranking tabs, sync, light/dark, responsive layout, reduced motion.');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
