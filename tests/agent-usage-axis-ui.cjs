const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const fixture = `
import { createElement as element } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '/src/i18n';
import { AgentUsageChart } from '/src/components/AgentUsageCharts';
import '/src/styles/index.css';
const now = new Date();
const key = value => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
const days = Array.from({ length: 7 }, (_, index) => key(new Date(now.getTime() - (6 - index) * 86400000)));
const row = (bucket, cost) => ({ bucket, inputTokens: 12000, outputTokens: 5000, cacheReadTokens: 1500, cacheCreationTokens: 500, reasoningOutputTokens: 0, totalTokens: 19000, costUSD: cost, samples: 12, days: 1 });
const series = days.map((day, index) => row(day, index === 6 ? 125 : 10 * (index + 1)));
const report = {
  schemaVersion: 2, generatedAt: now.toISOString(), bucket: 'day',
  totals: { totalTokens: 133000, costUSD: 185, days: 7 },
  sources: [
    { source: 'claude', status: 'ok', totals: { totalTokens: 133000, costUSD: 185, days: 7 }, series: series.map(day => ({ ...day, bucket: day.bucket + '|claude-sonnet' })) },
    { source: 'codex', status: 'ok', totals: { totalTokens: 133000, costUSD: 185, days: 7 }, series: series.map(day => ({ ...day, bucket: day.bucket + '|gpt-5.2' })) },
  ],
  timeline: series,
  calendar: [], hourly: [],
};
createRoot(document.getElementById('root')).render(element(I18nProvider, null,
  element('main', { style: { display: 'block', padding: '20px', maxWidth: '1400px', margin: 'auto' } },
    ['model', 'source'].map(groupBy =>
      element('div', { key: groupBy, className: 'surface-card', 'data-group': groupBy, style: { padding: '20px', marginBottom: '20px' } },
        element(AgentUsageChart, { view: 'trend', metric: 'costUSD', report, groupBy, locale: 'en-US', seriesLabel: label => label }))))));
`;

(async () => {
  let browser;
  let server;
  try {
    const { createServer } = await import('vite');
    server = await createServer({
      configFile: false, root: path.resolve(__dirname, '..'), logLevel: 'error',
      plugins: [{
        name: 'usage-axis-fixture',
        resolveId(id) { if (id === '/__axis.js') return id; },
        load(id) { if (id === '/__axis.js') return fixture; },
        configureServer(vite) {
          vite.middlewares.use('/__axis.html', async (_request, response, next) => {
            try {
              const html = await vite.transformIndexHtml('/__axis.html', '<html lang="en"><head></head><body><div id="root"></div><script type="module" src="/__axis.js"></script></body></html>');
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__axis.html`);
    await page.locator('.agent-usage-axis text').first().waitFor();

    for (const groupBy of ['model', 'source']) {
      const chart = page.locator(`[data-group="${groupBy}"]`);
      const labels = await chart.locator('.agent-usage-axis text').allTextContents();
      assert.ok(labels.some(text => text.startsWith('$')), `${groupBy} renders cost ticks: ${labels}`);
      const ticks = labels.map(text => Number(text.replace(/[$,]/g, '')));
      assert.ok(Math.max(...ticks) >= 100, `${groupBy} reaches a >= $100 tick: ${labels}`);
      const fitted = await chart.locator('.agent-usage-svg').evaluate(svg => {
        const box = svg.getBoundingClientRect();
        return [...svg.querySelectorAll('.agent-usage-axis text')].map(node => {
          const label = node.getBoundingClientRect();
          return { text: node.textContent, left: label.left - box.left, right: label.right - box.left, width: box.width };
        });
      });
      assert.ok(fitted.every(label => label.left >= 0 && label.right <= label.width),
        `${groupBy} axis labels stay inside the svg: ${JSON.stringify(fitted)}`);
    }
    assert.deepEqual(errors, []);
    console.log('agent-usage-axis-ui: all assertions passed');
  } finally {
    await browser?.close();
    await server?.close();
  }
})();
