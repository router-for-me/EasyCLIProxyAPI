const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const viewports = [
  { width: 640, height: 600 },
  { width: 800, height: 600 },
  { width: 964, height: 600 },
  { width: 1280, height: 800 },
];

(async () => {
  let server;
  let browser;
  let base = 'http://127.0.0.1:1420/';
  try {
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      const { createServer } = await import('vite');
      const react = (await import('@vitejs/plugin-react')).default;
      server = await createServer({
        configFile: false,
        root: path.resolve(__dirname, '..'),
        plugins: [react()],
        logLevel: 'error',
        server: { host: '127.0.0.1', port: 1421, strictPort: false },
      });
      await server.listen();
      base = `http://127.0.0.1:${server.httpServer.address().port}/`;
    }

    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch({ channel, headless: true, args: ['--no-proxy-server'] });
    let page;
    const errors = [];

    const settle = () => page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const open = async (label, ready) => {
      await page.locator('.nav-section button').filter({ has: page.getByText(label, { exact: true }) }).click();
      await page.locator(ready).first().waitFor();
      await settle();
    };
    const tab = async (id, ready) => {
      await page.locator(`#${id}`).click();
      await page.locator(ready).first().waitFor();
      await settle();
    };
    const assertNoPageOverflow = async label => {
      const overflow = await page.evaluate(() => {
        const nodes = [document.documentElement, document.body,
          document.querySelector('.content'), document.querySelector('.content > .page')].filter(Boolean);
        return nodes.filter(node => node.scrollWidth > node.clientWidth + 1)
          .map(node => ({ element: node.className || node.tagName, client: node.clientWidth, scroll: node.scrollWidth }));
      });
      assert.deepEqual(overflow, [], `${label}: horizontal scrolling must stay inside intentional tables or navigation`);
    };
    const assertReachable = async (locator, label) => {
      await locator.scrollIntoViewIfNeeded();
      assert.equal(await locator.evaluate(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.left < -1 || rect.right > innerWidth + 1
          || rect.top < -1 || rect.bottom > innerHeight + 1) return false;
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !!hit && element.contains(hit);
      }), true, `${label}: the control must be visible and unobstructed after scrolling`);
    };
    const assertRequestToolbar = async label => {
      const metrics = await page.locator('.usage-events-panel').evaluate(panel => {
        const table = panel.querySelector('.usage-table-wrap');
        const scrollbar = panel.querySelector('.usage-table-top-scrollbar');
        const footer = panel.querySelector('.usage-events-footer');
        const panelRect = panel.getBoundingClientRect();
        const tableRect = table.getBoundingClientRect();
        const scrollbarRect = scrollbar.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        const controls = [...footer.querySelectorAll('button, select, .usage-pagination-info')];
        return {
          panelTop: panelRect.top,
          tableTop: tableRect.top,
          tableBottom: tableRect.bottom,
          scrollbarTop: scrollbarRect.top,
          scrollbarBottom: scrollbarRect.bottom,
          footerTop: footerRect.top,
          controlsContained: controls.every(control => {
            const rect = control.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0
              && rect.left >= footerRect.left - 1 && rect.right <= footerRect.right + 1
              && rect.top >= footerRect.top - 1
              && rect.bottom <= footerRect.bottom + 1;
          }),
        };
      });
      assert.ok(Math.abs(metrics.tableTop - metrics.panelTop) <= 1, `${label}: the request table starts directly at the top of the panel`);
      assert.ok(metrics.tableBottom <= metrics.scrollbarTop + 1, `${label}: the horizontal scrollbar must remain below the table`);
      assert.ok(metrics.scrollbarBottom <= metrics.footerTop + 1, `${label}: the scrollbar must not overlap the pagination footer`);
      assert.equal(metrics.controlsContained, true, `${label}: table actions and pagination controls must fit completely inside their footer`);
      for (const control of await page.locator('.usage-events-footer button, .usage-page-size-select').all()) {
        await assertReachable(control, `${label} footer controls`);
      }
      const scrolled = await page.locator('.usage-events-panel .usage-table-wrap').evaluate(table => {
        table.scrollLeft = table.scrollWidth;
        return { overflowing: table.scrollWidth > table.clientWidth, scrolled: table.scrollLeft > 0 };
      });
      assert.equal(scrolled.overflowing, true, `${label}: the full request table remains available beyond the viewport`);
      assert.equal(scrolled.scrolled, true, `${label}: request columns remain reachable by horizontal scrolling`);
    };
    const assertExpandedPricing = async () => {
      await page.getByRole('combobox', { name: '时间范围', exact: true }).selectOption('custom');
      await page.locator('.usage-custom-range').waitFor();
      await page.getByRole('button', { name: '手动添加', exact: true }).click();
      const editor = page.locator('.usage-price-editor');
      await editor.waitFor();
      await settle();
      // A clipped ancestor can be scrolled programmatically by scrollIntoView,
      // while still preventing the user from reaching the overflowing content.
      const clipped = await page.locator('.usage-pricing-table-wrap').evaluate(table => {
        const ancestors = [];
        for (let parent = table.parentElement; parent; parent = parent.parentElement) {
          if (['hidden', 'clip'].includes(getComputedStyle(parent).overflowY)
            && parent.scrollHeight > parent.clientHeight + 1) ancestors.push(parent.className);
        }
        return ancestors;
      });
      assert.deepEqual(clipped, [], 'Expanded pricing content must remain reachable through user scrolling');
      await assertReachable(editor.getByRole('button', { name: '保存', exact: true }), '800x600 price editor save');
      await assertReachable(editor.getByRole('button', { name: '取消', exact: true }), '800x600 price editor cancel');
      const table = page.locator('.usage-pricing-table-wrap');
      await assertReachable(table, '800x600 price table');
      const scrollbarReachable = await table.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const y = rect.bottom - 2;
        if (y < 0 || y >= innerHeight) return false;
        const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
        if (!hit || !element.contains(hit)) return false;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowY !== 'visible') {
            const bounds = parent.getBoundingClientRect();
            if (y < bounds.top || y > bounds.bottom) return false;
          }
        }
        element.scrollLeft = element.scrollWidth;
        return element.scrollLeft > 0;
      });
      assert.equal(scrollbarReachable, true, 'Expanded pricing table scrollbar must remain visible and usable');
      await editor.getByRole('button', { name: '取消', exact: true }).click();
      await editor.waitFor({ state: 'detached' });
    };

    for (const viewport of viewports) {
      const label = `${viewport.width}x${viewport.height}`;
      // browser.newPage creates an isolated context, so persisted tabs, selected
      // clients and table preferences cannot leak between viewport cases.
      page = await browser.newPage({ viewport });
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(`${label}: ${error}`));
      await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'zh-CN'));
      await page.goto(`${base}?mock=running`, { waitUntil: 'domcontentloaded' });
      await page.locator('.home-page .client-api-card').first().waitFor();
      // The native app does not include the development scenario picker overlay.
      await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
      await settle();
      await assertNoPageOverflow(`${label} home`);

      if (viewport.width === 964) {
        assert.equal(await page.locator('.sidebar-bottom').evaluate(footer => {
          const rect = footer.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight + 1;
        }), true, `${label}: desktop sidebar footer must stay visible without scrolling the page`);
        await assertReachable(page.locator('.sidebar-contact'), `${label} sidebar contact`);
      }

      await open('API 接入', '.real-provider-row');
      await assertNoPageOverflow(`${label} API access`);
      if (viewport.width === 964) {
        const rows = await page.locator('.provider-category-panel button').evaluateAll(buttons =>
          new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top))).size);
        assert.equal(rows, 2, `${label}: nine provider categories stay within two rows in a short window`);
        await assertReachable(page.locator('.provider-category-panel button').last(), `${label} final provider category`);
      }
      await assertReachable(page.locator('.provider-row-actions button').first(), `${label} provider action`);

      await open('OAuth', '.oauth-subpage-tabs');
      assert.equal(await page.locator('#oauth-subpage-tab-quota').count(), 0, `${label}: quota has a separate sidebar entry`);
      await tab('oauth-subpage-tab-login', '.oauth-card');
      await assertNoPageOverflow(`${label} OAuth login`);
      await tab('oauth-subpage-tab-authFiles', '.auth-file-card');
      await assertNoPageOverflow(`${label} OAuth credentials`);
      await open('额度查询', '.quota-page .real-quota-card');
      assert.equal(await page.locator('.nav-section button.active').innerText(), '额度查询', `${label}: quota activates its sidebar entry`);
      assert.equal(await page.locator('.quota-page h1').innerText(), '额度查询', `${label}: standalone quota page has its own heading`);
      assert.equal(await page.locator('.oauth-subpage-tabs').count(), 0, `${label}: standalone quota page does not contain OAuth navigation`);
      await assertNoPageOverflow(`${label} quota`);

      await open('智能体配置', '.agent-config-panel');
      await page.waitForFunction(() => !document.querySelector('.agent-client-list-heading button')?.disabled);
      await tab('agent-subpage-tab-core', '#agent-subpage-panel-core');
      await assertNoPageOverflow(`${label} agents`);
      const configuration = page.locator('#agent-subpage-panel-core');
      assert.equal(await configuration.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }), true, `${label}: the configuration area must not collapse below its tab bar`);
      const agentControl = configuration.locator('button, input:not([type="hidden"]), select').filter({ visible: true }).first();
      await assertReachable(agentControl, `${label} agent configuration`);

      await open('使用记录', '.usage-tabs');
      await tab('usage-tab-overview', '.usage-overview-layout');
      await assertNoPageOverflow(`${label} usage overview`);
      for (const [id, ready] of [
        ['analysis', '.usage-analysis-grid'],
        ['events', '.usage-events-table tbody tr'],
        ['pricing', '.usage-pricing-table-wrap tbody tr'],
        ['data-management', '.usage-data-management-panel'],
      ]) {
        await tab(`usage-tab-${id}`, ready);
        await assertNoPageOverflow(`${label} usage ${id}`);
        if (id === 'events') await assertRequestToolbar(label);
        if (id === 'pricing' && viewport.width === 800) await assertExpandedPricing();
      }

      await open('高级功能', '#config-subpage-panel');
      for (const id of ['general', 'routing', 'requests', 'oauth', 'diagnostics', 'extensions', 'software']) {
        await tab(`config-subpage-tab-${id}`, `#config-subpage-panel[aria-labelledby="config-subpage-tab-${id}"]`);
        await assertNoPageOverflow(`${label} settings ${id}`);
      }
      assert.equal(await page.locator('.config-settings-views').count(), 0, 'settings are integrated without secondary pagination');
      await page.getByLabel('搜索设置', { exact: true }).fill('重试');
      await page.locator('.config-search-results button').first().waitFor();
      await settle();
      await assertNoPageOverflow(`${label} settings search results`);
      await page.getByLabel('搜索设置', { exact: true }).fill('');

      await open('版本管理', '.version-list-item');
      await assertNoPageOverflow(`${label} versions`);
      await page.close();
    }

    page = await browser.newPage({ viewport: { width: 640, height: 600 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(`640x600 English: ${error}`));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}?mock=running`, { waitUntil: 'domcontentloaded' });
    await page.locator('.home-page').waitFor();
    await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
    await open('Advanced Features', '.config-subpage-tabs');
    for (const id of ['general', 'routing', 'requests', 'oauth', 'diagnostics', 'extensions', 'software']) {
      await tab(`config-subpage-tab-${id}`, `#config-subpage-panel[aria-labelledby="config-subpage-tab-${id}"]`);
      await assertNoPageOverflow(`640x600 English settings ${id}`);
      const button = page.locator(`#config-subpage-tab-${id}`);
      await assertReachable(button, `English settings ${id} tab`);
      assert.equal(await button.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return text.left >= bounds.left - 1 && text.right <= bounds.right + 1;
      }), true, `English ${id} label must fit inside its own clickable tab`);
    }
    await page.getByLabel('Search settings', { exact: true }).fill('retry');
    await page.locator('.config-search-results button').first().waitFor();
    await settle();
    await assertNoPageOverflow('640x600 English settings search results');
    await page.close();
    assert.deepEqual(errors, [], 'Responsive navigation must not produce runtime errors');
    console.log('PASS: responsive pages, short-window navigation, reachable controls, and independent request-table scrolling.');
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
