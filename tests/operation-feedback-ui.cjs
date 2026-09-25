// Run Vite on port 1421, then node tests/operation-feedback-ui.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.FEEDBACK_TEST_BASE_URL || 'http://127.0.0.1:1421';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const open = query => page.goto(`${base}/tests/fixtures/operation-feedback.html?${query || ''}`, { waitUntil: 'domcontentloaded' });
    const stack = page.locator('.app-notice-stack');
    const notice = stack.locator('.inline-notice');
    const positions = () => page.locator('[data-testid="toolbar"], [data-testid="panel"], [data-testid="after"]').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
    }));
    const button = name => page.getByRole('button', { name, exact: true });
    const waitNotices = count => page.waitForFunction(count => document.querySelectorAll('.app-notice-stack .inline-notice').length === count, count);
    await open();
    await page.clock.install();
    const initial = await positions();
    await button('Success').click(); await waitNotices(1);
    assert.deepEqual(await positions(), initial, 'Showing feedback does not move form or toolbar');
    assert.equal(await page.locator('[data-testid="panel"] .inline-notice').count(), 0, 'Escapes clipped/transformed ancestor');
    await button('Second').click(); await waitNotices(2);
    assert.equal(await stack.count(), 1, 'All owners share one stack');
    const rects = await notice.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    assert.ok(rects[0].bottom <= rects[1].top, 'Simultaneous notices do not overlap');
    await notice.first().getByRole('button').click(); await waitNotices(1);
    assert.deepEqual(await positions(), initial, 'Closing feedback does not move page');
    await button('Clear').click(); await waitNotices(0);
    assert.equal(await stack.count(), 0, 'Unused host is cleaned up');

    await button('Success').click(); await waitNotices(1);
    await page.clock.fastForward(3500);
    await button('Success').click();
    await page.clock.fastForward(3500); await waitNotices(1);
    await page.clock.fastForward(3000); await waitNotices(0);
    await button('Success').click(); await waitNotices(1);
    await notice.locator('.action-feedback-text').focus();
    await page.clock.fastForward(7000); await waitNotices(1);
    await page.getByTestId('after').focus();
    await page.clock.fastForward(6100); await waitNotices(0);
    assert.equal(await page.getByTestId('after').evaluate(node => node === document.activeElement), true, 'Feedback does not steal focus');
    await button('Success').click(); await waitNotices(1);
    await notice.hover(); await page.clock.fastForward(7000); await waitNotices(1);
    await page.mouse.move(0, 0); await page.clock.fastForward(6100); await waitNotices(0);

    await button('Error').click(); await waitNotices(1);
    await page.clock.fastForward(30000); await waitNotices(1);
    assert.equal(await notice.getAttribute('role'), 'alert');
    assert.ok(await notice.locator('.action-feedback-text').evaluate(node => node.scrollHeight > node.clientHeight), 'Long errors retain scrollable full text');
    assert.deepEqual(await positions(), initial);
    await button('Toggle source').click(); await waitNotices(0);
    assert.equal(await stack.count(), 0, 'Unmounting owner removes its notices');
    await button('Toggle source').click(); await waitNotices(1);
    await button('Clear').click(); await waitNotices(0);
    await button('Agent result').click(); await waitNotices(1);
    assert.deepEqual(await positions(), initial, 'Agent pending and success feedback leave controls stable');
    await button('Quota result').click(); await waitNotices(2);
    const quotaText = await notice.last().innerText();
    for (const text of ['test.json', '重置请求已提交', '额度刷新失败', '避免重复消耗', 'query failed']) assert.ok(quotaText.includes(text));
    assert.deepEqual(await positions(), initial, 'Quota reset error does not resize its row');
    await button('Clear').click(); await waitNotices(0);

    await button('Second').click(); await waitNotices(1);
    await button('Native dialog').click();
    const footer = page.getByTestId('native-footer');
    const nativeBefore = await footer.boundingBox();
    await button('Native error').click(); await waitNotices(2);
    assert.equal(await stack.evaluate(node => node.parentElement.matches('dialog:modal')), true, 'Notifications remain above native dialog and clickable');
    assert.deepEqual(await footer.boundingBox(), nativeBefore, 'Native error does not move dialog actions');
    const floated = await stack.boundingBox();
    assert.ok(floated.y + floated.height <= nativeBefore.y, 'Stack avoids dialog action buttons, allowing immediate retry');
    await notice.last().getByRole('button').click(); await waitNotices(1);
    await button('Close dialog').click();
    await page.waitForFunction(() => document.querySelector('.app-notice-stack')?.parentElement === document.body);
    await notice.getByRole('button').click(); await waitNotices(0);

    await button('Error').click(); await waitNotices(1);
    await button('Confirmation dialog').click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.locator('.app-notice-stack').waitFor();
    const confirmBefore = await confirmation.boundingBox();
    await button('Confirm').focus();
    await page.keyboard.press('Tab');
    const longText = notice.locator('.action-feedback-text');
    assert.equal(await longText.evaluate(node => node === document.activeElement), true, 'Capture-phase focus trap includes the notification text');
    await page.keyboard.press('End');
    await page.clock.fastForward(500);
    await page.waitForFunction(() => document.querySelector('.app-notice-stack .action-feedback-text')?.scrollTop > 0);
    await page.keyboard.press('Tab');
    assert.equal(await notice.getByRole('button').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await confirmation.locator('button').first().evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter'); await waitNotices(0);
    assert.equal(await confirmation.count(), 1, 'Dismissing a notice does not activate confirmation');
    assert.deepEqual(await confirmation.boundingBox(), confirmBefore, 'Notifications do not resize ordinary modals');
    assert.equal(await confirmation.locator('button').first().evaluate(node => node === document.activeElement), true, 'Focus stays in the modal after notification dismissal');
    await button('Confirm').click();
    await confirmation.waitFor({ state: 'detached' });

    for (const theme of ['light', 'dark']) for (const width of [360, 640, 1280]) {
      await page.setViewportSize({ width, height: 700 }); await open(`theme=${theme}`);
      await button('Error').click(); await waitNotices(1);
      const r = await stack.boundingBox();
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= 700, `${theme} ${width}: stack fits viewport`);
      assert.ok(Math.abs(width - (r.x + r.width) - 24) < 1 && Math.abs(700 - (r.y + r.height) - 24) < 1, 'Anchored at bottom right');
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await open('scenario=pricing');
    const table = page.locator('.usage-pricing-table'); await table.waitFor();
    const priceBefore = await table.boundingBox();
    const sync = page.locator('.usage-pricing-actions .primary-button');
    await sync.click();
    const priceDialog = page.locator('.usage-price-sync-dialog');
    await priceDialog.waitFor({ state: 'visible' });
    assert.equal(await notice.count(), 0, 'Preview does not save prices');
    await priceDialog.getByRole('button', { name: '保存所选 1 项' }).click(); await waitNotices(1);
    assert.ok((await notice.innerText()).includes('已保存 1 个模型价格'));
    assert.deepEqual(await table.boundingBox(), priceBefore, 'Real pricing success never shifts table');
    if (process.env.FEEDBACK_SCREENSHOT) await page.screenshot({ path: process.env.FEEDBACK_SCREENSHOT });
    await notice.getByRole('button').click(); await waitNotices(0);
    assert.deepEqual(await table.boundingBox(), priceBefore);
    await page.evaluate(() => { window.feedbackFixture.failSync = true; });
    await sync.click(); await waitNotices(1);
    assert.ok((await notice.innerText()).includes('price sync failed'));
    assert.deepEqual(await table.boundingBox(), priceBefore, 'Real pricing error never shifts table');
    assert.deepEqual(errors, []);
    console.log('PASS: no layout shifts, shared stack, owner cleanup, success expiry/repeat/hover/focus, persistent errors, quota details, native modal, light/dark at 3 widths, real pricing success/error.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
