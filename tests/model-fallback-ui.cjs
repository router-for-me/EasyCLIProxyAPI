const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const fixture = `
import { createElement as element, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '/src/i18n';
import { managementApi } from '/src/services/managementApi';
import { RoutingPage } from '/src/pages/routing/RoutingPage';
import { ModelFallbackPanel } from '/src/pages/routing/ModelFallbackPanel';
import { requestAppNavigation } from '/src/navigation';
const params = new URLSearchParams(location.search);
const gates = {};
const control = window.control = {
  fallback: { enabled: true, 'max-hops': 2, on: [429], chains: { primary: ['backup'] } },
  strategy: 'round-robin', writes: 0, navigations: 0, confirms: 0, allowDiscard: false,
  failRead: params.has('readFail'), failBoard: false, failWrite: false,
  hold(name) { let release; const promise = new Promise(resolve => release = resolve); gates[name] = { promise, release }; },
  release(name) { const gate = gates[name]; delete gates[name]; gate.release(); },
  navigate() { requestAppNavigation(() => this.navigations++); },
};
window.confirm = () => { control.confirms++; return control.allowDiscard; };
const wait = async name => { if (gates[name]) await gates[name].promise; };
const api = {
  async get(path) {
    if (path === '/config/routing/model-fallback') {
      const value = structuredClone(control.fallback);
      await wait('read');
      if (control.failRead) throw new Error('fallback read failed');
      return value;
    }
    if (path === '/config/routing') {
      await wait('board');
      if (control.failBoard) throw new Error('routing read failed');
      return { strategy: control.strategy, 'model-fallback': structuredClone(control.fallback) };
    }
    if (path === '/credentials') return { files: [] };
    if (path.startsWith('/config/api-keys/')) return [];
    throw new Error('Unexpected read: ' + path);
  },
  async put(path, body) {
    control.writes++;
    if (path === '/config/routing/model-fallback') {
      await wait('put');
      if (control.failWrite) throw new Error('fallback write failed');
      control.fallback = structuredClone(body);
    } else if (path === '/config/routing/strategy') control.strategy = body;
    else throw new Error('Unexpected write: ' + path);
    return {};
  },
};
managementApi.get = api.get;
managementApi.put = api.put;
function PanelFixture() {
  const [client, setClient] = useState(() => api);
  control.swapApi = () => setClient({ ...api, get: async () => ({ ...control.fallback, 'max-hops': 6 }) });
  return element(ModelFallbackPanel, { disabled: false, api: client });
}
createRoot(document.getElementById('root')).render(element(StrictMode, null,
  element(I18nProvider, null, element(params.has('panel') ? PanelFixture : RoutingPage))));
`;

(async () => {
  let server;
  let browser;
  try {
    const { createServer } = await import('vite');
    server = await createServer({
      configFile: false, root: path.resolve(__dirname, '..'), logLevel: 'error',
      cacheDir: 'node_modules/.vite-model-fallback-test',
      plugins: [{
        name: 'model-fallback-fixture',
        resolveId(id) { if (id === '/__model-fallback.js') return id; },
        load(id) { if (id === '/__model-fallback.js') return fixture; },
        configureServer(vite) {
          vite.middlewares.use('/__model-fallback.html', async (_request, response, next) => {
            try {
              response.setHeader('Content-Type', 'text/html');
              response.end(await vite.transformIndexHtml('/__model-fallback.html', '<html lang="en"><body><div id="root"></div><script type="module" src="/__model-fallback.js"></script></body></html>'));
            } catch (error) { next(error); }
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, watch: null },
    });
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}/__model-fallback.html`;
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const panel = page.locator('.routing-fallback');
    const hops = panel.locator('input[type="number"]');
    const panelRefresh = panel.getByRole('button', { name: 'Refresh', exact: true });
    const panelDiscard = panel.getByRole('button', { name: 'Discard changes', exact: true });
    const panelSave = panel.locator('button.primary-button');
    const toolbar = page.locator('.routing-actions');
    const apply = toolbar.getByRole('button', { name: 'Apply plan', exact: true });
    const refresh = toolbar.getByRole('button', { name: 'Refresh', exact: true });
    const idle = () => page.waitForFunction(() => document.querySelector('.routing-fallback')?.getAttribute('aria-busy') === 'false'
      && document.querySelector('.routing-page')?.getAttribute('aria-busy') !== 'true');

    // Failed reads must be retryable, not replaced by editable defaults.
    await page.goto(base + '?panel&readFail');
    await panel.getByText('Error: fallback read failed', { exact: true }).waitFor();
    assert.equal(await hops.count(), 0);
    await page.evaluate(() => { window.control.failRead = false; });
    await panelRefresh.click();
    await idle();
    assert.equal(await hops.inputValue(), '2');
    await hops.fill('3');
    await panelDiscard.click();
    assert.equal(await hops.inputValue(), '2');
    assert.equal(await panelSave.isDisabled(), true);
    await page.evaluate(() => { window.control.failRead = true; });
    await panelRefresh.click();
    await idle();
    await hops.fill('4');
    assert.equal(await panelSave.isDisabled(), true);
    await panel.getByText('Error: fallback read failed', { exact: true }).waitFor();
    await page.evaluate(() => { window.control.failRead = false; window.control.allowDiscard = true; });
    await panelRefresh.click();
    await idle();
    assert.equal(await hops.inputValue(), '2');

    // A superseded read cannot replace the newer API's form state.
    await page.evaluate(() => window.control.hold('read'));
    await panelRefresh.click();
    await page.evaluate(() => window.control.swapApi());
    await page.waitForFunction(() => document.querySelector('.routing-fallback input[type="number"]')?.value === '6');
    await page.evaluate(() => window.control.release('read'));
    await idle();
    assert.equal(await hops.inputValue(), '6');

    // Keep navigation and both forms locked through PUT and routing revision refresh.
    await page.goto(base);
    await idle();
    await hops.fill('3');
    await page.evaluate(() => { window.control.hold('put'); window.control.hold('board'); });
    await panelSave.click();
    await page.waitForFunction(() => window.control.writes === 1);
    await page.evaluate(() => window.control.navigate());
    assert.equal(await page.evaluate(() => window.control.navigations), 0);
    assert.equal(await page.evaluate(() => window.control.confirms), 0);
    assert.equal(await refresh.isDisabled(), true);
    assert.equal(await page.getByRole('radio', { name: 'Fill first', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event); return event.defaultPrevented;
    }), true);
    await page.evaluate(() => window.control.release('put'));
    await panel.locator('.notice-success').waitFor();
    await page.evaluate(() => window.control.navigate());
    assert.equal(await page.evaluate(() => window.control.navigations), 0);
    await page.evaluate(() => window.control.release('board'));
    await idle();
    assert.equal(await panelSave.isDisabled(), true);
    await page.evaluate(() => window.control.navigate());
    assert.equal(await page.evaluate(() => window.control.navigations), 1);

    // A clean plan gets a fresh revision and can apply after a fallback save.
    await page.getByRole('radio', { name: 'Fill first', exact: true }).click();
    await apply.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply plan', exact: true }).click();
    await page.getByText('Routing plan applied.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.control.strategy), 'fill-first');

    // A dirty plan is preserved but explicitly invalidated, never silently rebased.
    await page.getByRole('radio', { name: 'Round robin', exact: true }).click();
    await hops.fill('4');
    await panelSave.click();
    await idle();
    await page.locator('.routing-page > .routing-error').getByText('Configuration changed.', { exact: false }).waitFor();
    assert.equal(await apply.isDisabled(), true);
    assert.equal(await page.getByRole('radio', { name: 'Round robin', exact: true }).getAttribute('aria-checked'), 'true');
    await hops.fill('5');
    await refresh.click();
    assert.equal(await hops.inputValue(), '5');
    await page.evaluate(() => { window.control.allowDiscard = true; window.control.fallback['max-hops'] = 6; });
    await refresh.click();
    await idle();
    assert.equal(await hops.inputValue(), '6');
    assert.equal(await panelDiscard.isDisabled(), true);
    assert.equal(await page.getByRole('radio', { name: 'Fill first', exact: true }).getAttribute('aria-checked'), 'true');

    // External edits reject a stale save without writing or discarding the local draft.
    await hops.fill('5');
    const writes = await page.evaluate(() => { window.control.fallback['max-hops'] = 7; return window.control.writes; });
    await panelSave.click();
    await idle();
    await panel.getByText('Configuration changed.', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.control.writes), writes);
    assert.equal(await hops.inputValue(), '5');
    await panelRefresh.click();
    await idle();
    assert.equal(await hops.inputValue(), '7');

    // A failed write preserves the draft; failed revision refresh blocks plan application.
    await hops.fill('8');
    await page.evaluate(() => { window.control.failWrite = true; window.control.failBoard = true; });
    await panelSave.click();
    await idle();
    await panel.getByText('Error: fallback write failed', { exact: true }).waitFor();
    await page.getByText('Error: routing read failed', { exact: true }).waitFor();
    assert.equal(await hops.inputValue(), '8');
    assert.equal(await panelDiscard.isDisabled(), false);
    assert.equal(await page.getByRole('radio', { name: 'Round robin', exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.control.failWrite = false; window.control.failBoard = false; });
    await refresh.click();
    await idle();
    assert.equal(await hops.inputValue(), '7');

    // An explicit empty condition list matches none; only an omitted list uses defaults.
    await panel.locator('.routing-fallback-conditions input:checked').uncheck();
    assert.equal(await panelSave.isDisabled(), false);
    await panelSave.click();
    await idle();
    assert.deepEqual(await page.evaluate(() => window.control.fallback.on), []);
    await panelRefresh.click();
    await idle();
    assert.equal(await panel.locator('.routing-fallback-conditions input:checked').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Model fallback UI passed: read/retry, stale-read cancellation, save/discard, navigation locks, conflict handling, and routing revisions.');
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
