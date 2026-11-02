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
const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
const tokens = { inputTokens: 12000, outputTokens: 5000, cacheReadTokens: 1500, cacheCreationTokens: 500, totalTokens: 19000, costUSD: 0.1234 };
const report = { schemaVersion: 1, generatedAt: now.toISOString(), sources:
  ['claude', 'codex', 'mcode', 'opencode', 'omp', 'pi', 'copilot', 'gemini', 'antigravity', 'kimi', 'zcode'].map(source => ({
    source, status: source === 'codex' ? 'ok' : source === 'zcode' ? 'error' : 'empty',
    error: source === 'zcode' ? 'Cannot read local records' : '',
    daily: source === 'codex' ? [{ date, ...tokens, models: [{ model: 'sample-model', ...tokens }] }] : [],
  })) };
window.syncCount = 0;
window.__TAURI_INTERNALS__ = { invoke: async command => {
  if (command === 'get_agent_usage') {
    window.syncCount++;
    await new Promise(resolve => setTimeout(resolve, 150));
    return report;
  }
  if (command === 'get_usage_pricing') return { rows: [], totalCost: 0 };
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
    const active = page.locator('[data-source="codex"]');
    await active.waitFor();
    assert.equal(await page.locator('.agent-usage-stat').count(), 6);
    assert.equal(await page.locator('.agent-usage-stat.primary').count(), 2);
    assert.equal(await active.locator('.agent-usage-source-share').textContent(), '100%');
    assert.equal(await page.locator('.is-empty .agent-usage-source-metrics').count(), 0);
    assert.match(await page.locator('[data-source="zcode"]').textContent(), /Cannot read local records/);
    assert.equal(await page.locator('.agent-usage-daily tbody tr').count(), 1);
    assert.equal(await page.locator('.agent-usage-pricing tbody tr').count(), 1);
    await active.click();
    assert.equal(await active.getAttribute('aria-pressed'), 'true');
    await active.click();
    assert.equal(await active.getAttribute('aria-pressed'), 'false');
    const empty = page.locator('[data-source="claude"]');
    await empty.click();
    assert.equal(await page.locator('.agent-usage-stat.tokens strong').textContent(), '0');
    assert.equal(await page.locator('.agent-usage-daily tbody tr').count(), 0);
    await empty.press('Enter');
    assert.equal(await page.locator('.agent-usage-stat.tokens strong').textContent(), '19,000');
    const range = page.getByRole('radio', { name: 'All', exact: true });
    await range.click();
    assert.equal(await range.getAttribute('aria-checked'), 'true');
    await range.press('ArrowLeft');
    assert.equal(await page.locator('.agent-usage-range [data-value="30d"]').getAttribute('aria-checked'), 'true');
    await page.locator('.agent-usage-refresh-setting select').selectOption('60000');
    assert.equal(await page.evaluate(() => localStorage.getItem('cpa-gui.usage-agent-refresh-interval.v1')), '60000');
    await page.locator('.agent-usage-sync').click();
    assert.equal(await page.locator('.agent-usage-sync').isDisabled(), true);
    assert.equal(await page.locator('.agent-usage-spin').count(), 1);
    await page.waitForFunction(() => !document.querySelector('.agent-usage-sync').disabled);
    assert.equal(await page.evaluate(() => window.syncCount), 2);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await page.setViewportSize({ width: 1280, height: 800 });
      if (process.env.USAGE_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.USAGE_SCREENSHOTS, `usage-${theme}-1280.png`), fullPage: true, animations: 'disabled' });
      const desktopLayout = await page.evaluate(() => {
        const sources = [...document.querySelectorAll('.agent-usage-source-row')].map(node => node.getBoundingClientRect());
        const stats = [...document.querySelectorAll('.agent-usage-stat')].map(node => node.getBoundingClientRect());
        const daily = document.querySelector('.agent-usage-daily').getBoundingClientRect();
        const pricing = document.querySelector('.agent-usage-pricing').getBoundingClientRect();
        return {
          uniformSources: sources.every(source => Math.abs(source.width - sources[0].width) < 1 && Math.abs(source.height - sources[0].height) < 1),
          singleStatRow: stats.every(stat => stat.top === stats[0].top),
          sideBySide: daily.top === pricing.top && daily.right <= pricing.left,
          fitsViewport: document.querySelector('.agent-usage-view').getBoundingClientRect().bottom <= innerHeight,
        };
      });
      assert.deepEqual(desktopLayout, { uniformSources: true, singleStatRow: true, sideBySide: true, fitsViewport: true }, `${theme} desktop layout`);
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1100 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} at ${width}px overflows`);
        assert.equal(await page.locator('.agent-usage-stat-grid').evaluate(node => getComputedStyle(node).gap === '1px'), false);
        if (width <= 768) {
          const daily = await page.locator('.agent-usage-daily').boundingBox();
          const pricing = await page.locator('.agent-usage-pricing').boundingBox();
          assert.ok(pricing.y >= daily.y + daily.height, `${theme} tables stack at ${width}px`);
        }
        if (process.env.USAGE_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.USAGE_SCREENSHOTS, `usage-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await active.hover();
    assert.equal(await active.evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    assert.equal(await active.evaluate(node => getComputedStyle(node).transform), 'none');
    assert.deepEqual(errors, []);
    console.log('Usage dashboard passed: filters, ranges, refresh, light/dark, responsive layout, reduced motion.');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
