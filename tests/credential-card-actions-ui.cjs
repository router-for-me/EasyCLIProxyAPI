// Browser regression only; real desktop acceptance is a separate manual gate.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    cacheDir: '.codex/credential-actions/vite', logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  const errors = [];
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    for (const locale of ['en', 'zh-CN']) {
      const zh = locale === 'zh-CN';
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.on('pageerror', error => errors.push(String(error)));
      await page.addInitScript(language => localStorage.setItem('easy-cli-proxy-api.locale', language), locale);
      await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
      await page.goto(`${base}/?mock=running&mockDelay=25`);
      await page.locator('.app-shell').waitFor();
      await page.addStyleTag({ content: '#browser-mock-toolbar { display:none; }' });
      await page.locator('.nav-section button').filter({ has: page.getByText('OAuth', { exact: true }) }).click();
      await page.getByRole('tab', { name: zh ? '凭证文件' : 'Authentication Files', exact: true }).click();
      const card = page.locator('.auth-file-card').first();
      await card.waitFor();
      for (const width of [1280, 800, 640, 375, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const layout of ['even', 'stacked', 'compact']) {
          await page.locator(`.auth-files-layout-control [role="radio"]`).nth(['even', 'stacked', 'compact'].indexOf(layout)).click();
          if (layout === 'compact') await card.locator('.auth-card-glance-toggle').click();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const issues = await page.locator('.auth-card-actions:visible').evaluateAll(footers => footers.flatMap(footer => {
            const controls = [...footer.querySelectorAll('button, input')].filter(node => node.getClientRects().length);
            const box = footer.getBoundingClientRect();
            const rows = new Set(controls.map(node => Math.round(node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2)));
            const errors = rows.size > 1 ? ['actions wrap or misalign'] : [];
            for (const node of controls) {
              const rect = node.getBoundingClientRect();
              if (rect.left < box.left - 1 || rect.right > box.right + 1) errors.push(`action overflows: ${node.outerHTML.slice(0, 150)} ${rect.left}-${rect.right} footer ${box.left}-${box.right}`);
              if (node.scrollWidth > node.clientWidth + 1) errors.push('label clips');
            }
            return errors;
          }));
          assert.deepEqual(issues, [], `${locale}/${width}/${layout}`);
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      const more = card.getByRole('button', { name: zh ? '更多' : 'More', exact: true });
      assert.equal(await card.locator('.auth-list-icon-actions > .auth-card-more').count(), 1);
      assert.equal(await card.locator('.auth-list-main-actions button').count(), 0);
      assert.equal(await card.locator('.auth-list-main-actions [role="switch"]').count(), 1);
      assert.equal(await card.locator('.auth-list-icon-actions').evaluate(group => group.children[2].classList.contains('auth-list-details-button') && group.children[3].classList.contains('auth-card-more')), true);
      await more.focus(); await page.keyboard.press('ArrowDown');
      const menu = card.getByRole('menu');
      await menu.waitFor();
      assert.equal(await menu.getByRole('menuitem').count(), 4);
      assert.equal(await menu.getByRole('menuitem').first().evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('End');
      assert.equal(await menu.getByRole('menuitem').last().evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('ArrowDown');
      assert.equal(await menu.getByRole('menuitem').first().evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Escape');
      assert.equal(await menu.count(), 0); assert.equal(await more.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('ArrowUp');
      assert.equal(await menu.getByRole('menuitem').last().evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Tab'); assert.equal(await menu.count(), 0);
      await more.click(); await card.locator('.auth-card-identity').click(); assert.equal(await menu.count(), 0);
      const details = card.locator('.auth-list-details-button');
      const before = await details.getAttribute('aria-expanded'); await details.click();
      assert.notEqual(await details.getAttribute('aria-expanded'), before);
      const toggle = card.getByRole('switch');
      assert.equal(await toggle.count(), 1);
      const checked = await toggle.isChecked(); await toggle.click();
      await page.waitForFunction(({ checked }) => document.querySelector('.auth-file-card input[role="switch"]')?.checked !== checked, { checked });
      await toggle.click();
      await more.click(); await menu.getByRole('menuitem', { name: zh ? '模型' : 'Models', exact: true }).click();
      await page.getByRole('dialog').waitFor(); assert.equal(await menu.count(), 0);
      await page.keyboard.press('Escape');
      await more.click(); await menu.getByRole('menuitem', { name: zh ? '删除' : 'Delete', exact: true }).click();
      const confirm = page.getByRole('alertdialog'); await confirm.waitFor();
      await confirm.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
      assert.equal(await card.count(), 1);
      await page.close();
      console.log(`PASS ${locale}: 5 widths × 3 layouts, keyboard, outside, details, switch, models, delete confirmation`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
