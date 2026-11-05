// Quota page card layouts (Even rows, Stacked, Compact) across window sizes, aspect ratios and pixel densities, on the browser mock.
// Run with a Vite dev server at QUOTA_TEST_BASE, or let the script start one.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// [width, height, deviceScaleFactor]: phones, tablets, laptops, desktops, ultrawide, portrait monitor and a short window.
const displays = [
  [320, 640, 2], [375, 812, 3], [414, 896, 2], [768, 1024, 2], [1024, 768, 1], [800, 600, 1.25], [1280, 800, 1.5],
  [1366, 768, 1], [1440, 900, 2], [1920, 1080, 1], [2560, 1440, 1], [3440, 1440, 1], [1080, 1920, 1], [1280, 420, 1],
];
const layouts = [['even', 'Even rows'], ['stacked', 'Stacked'], ['compact', 'Compact']];

(async () => {
  let server;
  let browser;
  let base = process.env.QUOTA_TEST_BASE;
  try {
    if (!base) {
      const { createServer } = await import('vite');
      const react = (await import('@vitejs/plugin-react')).default;
      server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
      await server.listen();
      base = `http://127.0.0.1:${server.httpServer.address().port}`;
    }
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
    browser = await chromium.launch({ channel, headless: true, args: ['--no-proxy-server'] });
    for (const [width, height, deviceScaleFactor] of displays) {
      const display = `${width}x${height}@${deviceScaleFactor}x`;
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
      // A stored value that is not a layout must fall back to Even rows.
      await context.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); localStorage.setItem('cpa-gui.quota-layout.v1', 'unknown'); });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.goto(`${base}/?mock=running`);
      await page.locator('.app-shell').waitFor();
      await page.locator('#browser-mock-toolbar').evaluate(element => { element.style.display = 'none'; });
      await page.locator('.nav-section button').filter({ has: page.getByText('Quota Lookup', { exact: true }) }).click();
      await page.locator('.quota-page .real-quota-card').first().waitFor();
      await page.locator('.quota-page').getByRole('button', { name: 'Refresh Quota', exact: true }).first().click();
      await page.waitForFunction(() => !document.querySelector('.quota-page .spin'), null, { timeout: 30000 });

      // Even rows is the default, also for an unknown stored value.
      assert.equal(await page.getByRole('radio', { name: 'Even rows', exact: true }).getAttribute('aria-checked'), 'true', `${display}: Even rows is the default`);
      for (const [layout, label] of layouts) {
        const context = `${display} ${layout}`;
        await page.getByRole('radio', { name: label, exact: true }).click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const result = await page.evaluate((layout) => {
          const issues = [];
          const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
          for (const node of [document.documentElement, document.body, document.querySelector('.content'), document.querySelector('.content > .page')].filter(Boolean)) {
            if (node.scrollWidth > node.clientWidth + 1) issues.push(`page scrolls sideways (${node.className || node.tagName}: ${node.scrollWidth} > ${node.clientWidth})`);
          }
          const switcher = document.querySelector('.quota-layout-control').getBoundingClientRect();
          if (switcher.left < -1 || switcher.right > innerWidth + 1) issues.push('layout switch outside the window');
          if (new Set([...document.querySelectorAll('.quota-layout-control button')].map(button => Math.round(button.getBoundingClientRect().top))).size !== 1) issues.push('layout switch buttons not in one row');
          const grid = document.querySelector('.real-quota-grid').getBoundingClientRect();
          const cards = [...document.querySelectorAll('.quota-page .real-quota-card')];
          const rects = cards.map(card => card.getBoundingClientRect());
          rects.forEach((rect, index) => {
            if (rect.left < grid.left - 1 || rect.right > grid.right + 1) issues.push(`card ${index} outside the grid`);
            for (let other = index + 1; other < rects.length; other++) {
              const b = rects[other];
              if (Math.min(rect.right, b.right) - Math.max(rect.left, b.left) > 1 && Math.min(rect.bottom, b.bottom) - Math.max(rect.top, b.top) > 1) issues.push(`cards ${index} and ${other} overlap`);
            }
            for (const part of cards[index].querySelectorAll('.quota-identity > *, .quota-glance-plan, .quota-glance-toggle, .real-quota-row, .quota-card-actions > *, .quota-card-message, .quota-card-error')) {
              if (!visible(part)) continue;
              const box = part.getBoundingClientRect();
              if (box.left < rect.left - 1 || box.right > rect.right + 1 || box.bottom > rect.bottom + 1) issues.push(`card ${index}: ${part.className} spills out of the card`);
            }
          });
          const lefts = [...new Set(rects.map(rect => Math.round(rect.left)))];
          const widths = [...new Set(rects.map(rect => Math.round(rect.width)))];
          const rows = new Map();
          rects.forEach(rect => rows.set(Math.round(rect.top), [...(rows.get(Math.round(rect.top)) ?? []), Math.round(rect.height)]));
          const glance = cards.filter(card => card.hasAttribute('data-glance'));
          const glanceIssues = glance.flatMap((card, index) => {
            const badge = card.querySelector('.quota-identity .quota-glance-plan');
            const logo = card.querySelector('.quota-account-icon, .quota-identity > svg');
            const toggle = card.querySelector('.quota-glance-toggle');
            const found = [];
            if (!toggle || !visible(toggle)) found.push(`glance card ${index}: no visible details toggle`);
            else if (toggle.getBoundingClientRect().width > 48) found.push(`glance card ${index}: details toggle stretches to ${Math.round(toggle.getBoundingClientRect().width)}px`);
            if (badge && logo && visible(badge)) {
              const a = badge.getBoundingClientRect(); const b = logo.getBoundingClientRect();
              if (Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) > 4) found.push(`glance card ${index}: plan text not level with the logo`);
            }
            return found;
          });
          return { issues: [...issues, ...glanceIssues], cards: cards.length, columns: lefts.length, widths, gridWidth: grid.width, rowHeights: [...rows.values()], glance: glance.length, layout };
        }, layout);
        assert.deepEqual(result.issues, [], context);
        assert.equal(result.cards, 13, `${context}: every mock credential is shown`);
        const minimum = layout === 'compact' ? 240 : 300;
        const gap = layout === 'compact' ? 8 : 12;
        if (layout === 'stacked' || layout === 'compact') {
          assert.equal(result.columns, Math.max(1, Math.floor((result.gridWidth + gap) / (minimum + gap))), `${context}: column count follows the window width`);
        }
        for (const cardWidth of result.widths) assert.ok(cardWidth >= Math.min(minimum, result.gridWidth) - 1, `${context}: cards keep their minimum width (${cardWidth}px)`);
        if (layout === 'even') for (const heights of result.rowHeights) assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `${context}: every card in a row has the same height`);
        assert.equal(result.glance, layout === 'compact' ? 13 : 0, `${context}: only Compact shows glance cards`);
      }

      // Compact cards expand and collapse from the keyboard, and the toggle names its credential.
      const toggle = page.locator('.quota-glance-toggle').first();
      assert.match(await toggle.getAttribute('aria-label'), /^Show details: .+\.json$/, `${display}: the toggle names its credential`);
      await toggle.focus();
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', `${display}: Enter expands the card`);
      assert.equal(await page.locator('.real-quota-card:not([data-glance])').count(), 1, `${display}: only the chosen card expands`);
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.real-quota-card[data-glance]').count(), 13, `${display}: Enter collapses it again`);
      assert.deepEqual(errors, [], `${display}: no page errors`);
      await context.close();
    }

    // The chosen layout survives a reload.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); });
    const page = await context.newPage();
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.goto(`${base}/?mock=running`);
    await page.locator('.nav-section button').filter({ has: page.getByText('Quota Lookup', { exact: true }) }).click();
    await page.locator('.quota-page .real-quota-card').first().waitFor();
    // Choose a layout, reload, and the choice is still selected: covers the save as well as the read.
    await page.getByRole('radio', { name: 'Stacked', exact: true }).click();
    await page.goto(`${base}/?mock=running`);
    await page.locator('.nav-section button').filter({ has: page.getByText('Quota Lookup', { exact: true }) }).click();
    await page.locator('.quota-page .real-quota-card').first().waitFor();
    assert.equal(await page.getByRole('radio', { name: 'Stacked', exact: true }).getAttribute('aria-checked'), 'true', 'a chosen layout survives a reload');
    await context.close();
    console.log(`Quota layouts: ${displays.length} displays x ${layouts.length} layouts passed`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
