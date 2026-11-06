const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const fixture = `
import { createElement as element } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '/src/i18n';
import { UsageActivityChart } from '/src/pages/UsageActivityChart';
import '/src/styles/index.css';
const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') || 'zh-CN');
const day = new Date();
const key = value => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
const point = (date, hour, requests) => ({
  hour: key(date) + '-' + String(hour).padStart(2, '0'),
  requests,
  success: Math.round(requests * 0.9),
  failure: Math.round(requests * 0.05),
  canceled: Math.round(requests * 0.05),
  tokens: requests * 500,
});
const yesterday = new Date(day.getTime() - 86400000);
const timeline = [
  ...Array.from({ length: 24 }, (_, hour) => point(yesterday, hour, 800 + hour * 31)),
  ...Array.from({ length: 24 }, (_, hour) => point(day, hour, hour === 10 ? 9_500_000 : 1000 + hour * 37)),
];
createRoot(document.getElementById('root')).render(element(I18nProvider, null,
  element('main', { style: { display: 'block', padding: '20px', margin: 'auto' } },
    element(UsageActivityChart, { timeline }))));
`;

(async () => {
  let browser;
  let server;
  try {
    const { createServer } = await import('vite');
    server = await createServer({
      configFile: false, root: path.resolve(__dirname, '..'), logLevel: 'error',
      plugins: [{
        name: 'usage-activity-axis-fixture',
        resolveId(id) { if (id === '/__activity-axis.js') return id; },
        load(id) { if (id === '/__activity-axis.js') return fixture; },
        configureServer(vite) {
          vite.middlewares.use('/__activity-axis.html', async (_request, response, next) => {
            try {
              const html = await vite.transformIndexHtml('/__activity-axis.html', '<html lang="en"><head></head><body><div id="root"></div><script type="module" src="/__activity-axis.js"></script></body></html>');
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
    for (const locale of ['zh-CN', 'ja', 'en']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__activity-axis.html?locale=${locale}`);
      await page.locator('.usage-activity-axis text').first().waitFor();
      for (const viewport of [1440, 420]) {
        await page.setViewportSize({ width: viewport, height: 900 });
        await page.waitForTimeout(60);
        const fitted = await page.locator('.usage-activity-svg').evaluate(svg => {
          const box = svg.getBoundingClientRect();
          return [...svg.querySelectorAll('.usage-activity-axis text')].map(node => {
            const label = node.getBoundingClientRect();
            return { text: node.textContent, left: label.left - box.left, right: label.right - box.left, width: box.width };
          });
        });
        assert.ok(fitted.length >= 2, `${locale}@${viewport} renders axis ticks: ${JSON.stringify(fitted)}`);
        assert.ok(fitted.every(label => label.left >= 0 && label.right <= label.width),
          `${locale}@${viewport} axis labels stay inside the svg: ${JSON.stringify(fitted)}`);
      }
      const labels = await page.locator('.usage-activity-axis text').allTextContents();
      if (locale === 'zh-CN') assert.ok(labels.some(text => text.includes('万')), `zh-CN renders a 万-scale tick: ${labels}`);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('usage-activity-axis-ui: all assertions passed');
  } finally {
    await browser?.close();
    await server?.close();
  }
})();
