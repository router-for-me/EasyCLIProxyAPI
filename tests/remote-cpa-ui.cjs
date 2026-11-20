const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

async function assertConnectionBounds(page, dialog, { width, height }, mustScroll) {
  await page.setViewportSize({ width, height });
  await dialog.evaluate(async element => {
    await document.fonts.ready;
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  const geometry = await dialog.evaluate(element => {
    const rect = node => {
      const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const form = element.querySelector('.cpa-connection-form');
    return {
      panel: rect(element), body: rect(form), scrollHeight: form.scrollHeight, clientHeight: form.clientHeight,
      scrollY: getComputedStyle(form).overflowY,
      scrollWidth: form.scrollWidth, clientWidth: form.clientWidth,
      controls: Array.from(element.querySelectorAll('button')).slice(-2).map(rect),
      surface: getComputedStyle(element).backgroundColor,
    };
  });
  const { panel, body, controls } = geometry;
  const message = `${width}×${height}: ${JSON.stringify(geometry)}`;
  assert.ok(panel.top >= 0 && panel.bottom <= height + 1 && panel.left >= 0 && panel.right <= width + 1, message);
  assert.ok(body.bottom <= panel.bottom && body.left >= panel.left && body.right <= panel.right, message);
  assert.ok(controls.length === 2 && controls.every(button => button.top >= body.bottom - 1 && button.bottom <= panel.bottom && button.left >= panel.left && button.right <= panel.right), message);
  assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, message);
  assert.notEqual(geometry.surface, 'rgba(0, 0, 0, 0)', message);
  if (mustScroll) assert.ok(geometry.scrollHeight > geometry.clientHeight && geometry.scrollY === 'auto', message);
  return `${width}×${height}: panel ${Math.round(panel.width)}×${Math.round(panel.height)}, body ${geometry.clientHeight}/${geometry.scrollHeight}, actions bottom ${Math.round(Math.max(...controls.map(button => button.bottom)))}`;
}

async function assertMenuBounds(page, menu) {
  const box = await menu.boundingBox();
  const view = page.viewportSize();
  assert.ok(box.x >= 0 && box.x + box.width <= view.width && box.y >= 0 && box.y + box.height <= view.height,
    `menu is clipped: ${JSON.stringify({ box, view })}`);
  assert.ok(await menu.getByRole('menuitem').first().evaluate(button => {
    const rect = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }), 'menu action must be unobscured');
}

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US', reducedMotion: 'reduce' });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/tests/fixtures/remote-cpa.html`);
    const opener = page.locator('.sidebar').getByRole('button', { name: 'Built-in CPA', exact: true });
    const menu = page.getByRole('menu', { name: 'CPA target' });
    const connectItem = menu.getByRole('menuitem', { name: 'Connect Remote CPA' });
    const openConnect = async () => { await opener.click(); await connectItem.click(); };
    assert.equal(await page.locator('main').getByRole('button', { name: 'Connect Remote CPA' }).count(), 0);
    await opener.press('ArrowDown');
    assert.equal(await opener.getAttribute('aria-expanded'), 'true');
    assert.ok(await connectItem.evaluate(el => document.activeElement === el));
    await assertMenuBounds(page, menu);
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0);
    assert.ok(await opener.evaluate(el => document.activeElement === el));
    await opener.click();
    await page.locator('.sidebar-brand-text strong').click();
    assert.equal(await menu.count(), 0);
    await opener.press('Enter');
    await page.keyboard.press('Tab');
    assert.equal(await menu.count(), 0);
    await page.locator('.nav-section').getByRole('button', { name: 'Version Management' }).click();
    await opener.click();
    await connectItem.waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.nav-section').getByRole('button', { name: 'Home', exact: true }).click();
    await openConnect();
    const dialog = page.getByRole('dialog', { name: 'Connect Remote CPA' });
    const endpoint = dialog.getByLabel('CPA server URL');
    const key = dialog.getByLabel('Management key', { exact: true });
    const verify = dialog.getByRole('button', { name: 'Verify and connect' });
    const focused = locator => locator.evaluate(el => document.activeElement === el);
    assert.equal(await key.getAttribute('type'), 'password');
    await endpoint.fill('http://127.0.0.1:8888/');
    await key.fill('wrong-management');
    await verify.click();
    await dialog.getByRole('alert').filter({ hasText: 'Management access was denied' }).waitFor();
    assert.equal(await key.inputValue(), 'wrong-management');
    const geometries = [];
    for (const viewport of [{ width: 1280, height: 800 }, { width: 640, height: 600 }, { width: 360, height: 420 }]) {
      geometries.push(await assertConnectionBounds(page, dialog, viewport, viewport.height === 420));
    }
    const first = dialog.getByRole('button', { name: 'Close', exact: true });
    await verify.focus();
    await page.keyboard.press('Tab');
    assert.ok(await focused(first));
    await page.keyboard.press('Shift+Tab');
    assert.ok(await focused(verify));
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await focused(opener));
    await page.setViewportSize({ width: 1280, height: 800 });
    await openConnect();
    await endpoint.fill('http://127.0.0.1:8888/');
    await key.fill('first-management');
    await page.evaluate(() => { window.remoteTestControls.localRunning = true; });
    await verify.click();
    await dialog.getByRole('button', { name: 'Back to runtime controls' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'home-cpa-runtime');
    await page.evaluate(() => { window.remoteTestControls.localRunning = false; });

    const connect = async () => {
      await openConnect();
      await endpoint.fill('http://127.0.0.1:8888/');
      await key.fill('first-management');
      assert.ok(!page.url().includes('first-management'));
      await verify.click();
      await page.getByRole('heading', { name: 'Reopen ECPA to switch modes' }).waitFor();
      await page.getByText('Remote saved · Built-in CPA still active').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Edit keys' }).count(), 0);
    };
    await connect();
    await page.getByRole('button', { name: 'Cancel switch and keep Built-in CPA' }).click();
    await opener.waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('remote-selected')), null);
    await connect();
    await page.reload();
    await page.getByRole('heading', { name: 'Remote CPA', exact: true }).waitFor();
    await page.getByText('Client keys: 1').waitFor();
    assert.deepEqual(await page.evaluate(() => window.remoteTestCalls), ['get_cpa_connection', 'get_remote_cpa_keys']);
    assert.equal(await page.locator('.app-shell').count(), 0);
    assert.ok(!(await page.locator('main').textContent()).includes('first-client'));
    await page.getByRole('button', { name: 'Reveal keys' }).click();
    await page.getByText('first-client', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Hide keys' }).click();
    assert.equal(await page.getByText('first-client', { exact: true }).count(), 0);
    const editor = page.getByLabel('Client API keys (one per line)');
    const latestKeys = page.getByLabel('Latest keys on the server (read-only)');
    const editKeys = page.getByRole('button', { name: 'Edit keys' });
    const saveKeys = page.getByRole('button', { name: 'Save client API keys' });
    const reloadKeys = page.getByRole('button', { name: 'Reload latest keys' });
    const discard = page.getByRole('button', { name: 'Discard key draft' });
    const remoteTrigger = page.getByRole('button', { name: /^Remote CPA: / });
    const changeItem = menu.getByRole('menuitem', { name: 'Change server' });
    const returnItem = menu.getByRole('menuitem', { name: 'Return to Built-in CPA' });
    const changeConnection = async () => { await remoteTrigger.click(); await changeItem.click(); };
    await remoteTrigger.press('ArrowUp');
    assert.ok(await focused(returnItem));
    await page.keyboard.press('Home');
    assert.ok(await focused(changeItem));
    await assertMenuBounds(page, menu);
    assert.equal(await menu.getByText('http://127.0.0.1:8888/', { exact: true }).count(), 1);
    await page.keyboard.press('Escape');
    assert.ok(await focused(remoteTrigger));
    const reviewed = page.getByRole('button', { name: 'I reviewed the latest keys' });
    const originA = 'http://127.0.0.1:8888/';
    const listA = () => page.evaluate(origin => window.remoteTestKeys.get(origin), originA);
    const externalEdit = keys => page.evaluate(({ origin, keys }) => window.remoteTestKeys.set(origin, keys), { origin: originA, keys });
    await editKeys.press('Enter');
    assert.ok(await focused(editor));
    assert.equal(await editor.inputValue(), 'first-client');
    await editor.fill('first-client\nnew-client');
    await changeConnection();
    const unsaved = page.getByRole('alertdialog', { name: 'Discard unsaved key changes?' });
    await unsaved.getByRole('button', { name: 'Continue editing' }).click();
    assert.equal(await editor.inputValue(), 'first-client\nnew-client');
    assert.ok(await focused(editor));
    assert.equal(await page.getByRole('dialog', { name: 'Change server' }).count(), 0);

    await externalEdit(['first-client', 'external-client']);
    await saveKeys.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'configuration or loaded keys changed' }).waitFor();
    assert.ok(await focused(reloadKeys));
    assert.equal(await editor.inputValue(), 'first-client\nnew-client');
    assert.deepEqual(await listA(), ['first-client', 'external-client']);
    assert.equal(await saveKeys.count(), 0);
    await page.evaluate(() => { window.remoteTestControls.offline = true; });
    await reloadKeys.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'Could not reach the server' }).waitFor();
    assert.ok(await focused(reloadKeys));
    assert.equal(await editor.inputValue(), 'first-client\nnew-client');
    assert.equal(await saveKeys.count(), 0);
    await page.evaluate(() => { window.remoteTestControls.offline = false; });
    await reloadKeys.press('Enter');
    assert.equal(await latestKeys.inputValue(), 'first-client\nexternal-client');
    assert.ok(await focused(latestKeys));
    assert.equal(await saveKeys.count(), 0, 'reload alone cannot authorize a replacement');
    await editor.fill('first-client\nexternal-client\nnew-client');
    await reviewed.press('Enter');
    assert.ok(await focused(editor));

    // A further concurrent edit still rejects the newly reviewed snapshot.
    await externalEdit(['first-client', 'external-client', 'late-client']);
    await saveKeys.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'configuration or loaded keys changed' }).waitFor();
    assert.deepEqual(await listA(), ['first-client', 'external-client', 'late-client']);
    assert.equal(await editor.inputValue(), 'first-client\nexternal-client\nnew-client');
    await reloadKeys.press('Enter');
    assert.equal(await latestKeys.inputValue(), 'first-client\nexternal-client\nlate-client');
    await editor.fill('first-client\nexternal-client\nlate-client\nnew-client');
    await reviewed.press('Enter');

    // The server may have applied a write even when its response was lost.
    await page.evaluate(() => { window.remoteTestControls.unconfirmed = true; });
    await saveKeys.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'save could not be confirmed' }).waitFor();
    assert.equal(await editor.inputValue(), 'first-client\nexternal-client\nlate-client\nnew-client');
    await reloadKeys.press('Enter');
    assert.equal(await latestKeys.inputValue(), 'first-client\nexternal-client\nlate-client\nnew-client');
    await reviewed.press('Enter');
    assert.ok(await saveKeys.isDisabled(), 'identical confirmed list needs no retry');
    await editor.fill('first-client\nexternal-client\nlate-client\nnew-client\nfinal-client');
    await saveKeys.press('Enter');
    await page.getByRole('status').filter({ hasText: 'Client keys saved and reloaded' }).waitFor();
    assert.ok(await focused(editKeys));
    assert.equal(await page.getByText('final-client', { exact: true }).count(), 0);
    assert.deepEqual(await listA(), ['first-client', 'external-client', 'late-client', 'new-client', 'final-client']);

    await editKeys.press('Enter');
    await editor.fill('first-client\nexternal-client\nlate-client\nnew-client');
    await saveKeys.press('Enter');
    const removal = page.getByRole('alertdialog', { name: 'Confirm key removal' });
    await removal.getByText(originA).waitFor();
    await removal.getByText('Added: 0 · Removed: 1', { exact: false }).waitFor();
    await removal.getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await listA()).length, 5);
    await saveKeys.press('Enter');
    await removal.getByRole('button', { name: 'Save client API keys' }).click();
    await page.getByText('Client keys: 4', { exact: true }).waitFor();

    await editKeys.press('Enter');
    await editor.fill('discard-me-manually');
    await discard.press('Enter');
    assert.ok(await focused(editKeys));
    await editKeys.press('Enter');
    await editor.fill('draft-not-for-target-b');
    await changeConnection();
    await unsaved.getByRole('button', { name: 'Discard and continue' }).click();
    const switchDialog = page.getByRole('dialog', { name: 'Change server' });
    const switchKey = switchDialog.getByLabel('Management key', { exact: true });
    const switchAddress = switchDialog.getByLabel('CPA server URL');
    const switchSubmit = switchDialog.getByRole('button', { name: 'Verify and switch' });
    assert.equal(await switchKey.inputValue(), '');
    await switchKey.fill('draft-key-for-old-address');
    await switchAddress.fill('https://management-gateway-with-a-long-test-subdomain.for-a-private-network.example.test/team/');
    assert.equal(await switchKey.inputValue(), '');
    await switchSubmit.click();
    await switchDialog.getByRole('alert').filter({ hasText: 'Enter the management key for this server' }).waitFor();
    await page.getByRole('button', { name: 'Remote CPA: 127.0.0.1:8888' }).waitFor();
    await switchKey.fill('second-management');
    await switchSubmit.click();
    await page.getByRole('button', { name: 'Remote CPA: management-gateway-with-a-long-test-subdomain.for-a-private-network.example.test' }).waitFor();
    await page.getByText('Client keys: 1', { exact: true }).waitFor();
    await page.setViewportSize({ width: 360, height: 420 });
    await remoteTrigger.click();
    await assertMenuBounds(page, menu);
    assert.ok(await remoteTrigger.locator('strong').evaluate(el => el.scrollWidth > el.clientWidth), 'long host truncates visually');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 800 });
    await editKeys.click();
    assert.equal(await editor.inputValue(), 'second-client');
    await editor.fill('another-unsaved-value');
    await remoteTrigger.click();
    await returnItem.click();
    await unsaved.getByRole('button', { name: 'Discard and continue' }).click();
    const returnDialog = page.getByRole('alertdialog', { name: 'Return to Built-in CPA' });
    await returnDialog.getByText('The saved remote management key is cleared', { exact: false }).waitFor();
    await returnDialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => {
      if (document.activeElement === el) return;
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.ok(await focused(returnDialog.getByRole('button', { name: 'Cancel', exact: true })));
    await returnDialog.getByRole('button', { name: 'Return to Built-in CPA' }).click();
    await page.getByText('Built-in mode saved · Remote management ended').waitFor();
    assert.equal(await remoteTrigger.count(), 0);
    await page.reload();
    await page.locator('.app-shell').waitFor();

    const chinese = await browser.newPage({ viewport: { width: 375, height: 500 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    await chinese.goto(`http://127.0.0.1:${port}/tests/fixtures/remote-cpa.html`);
    await chinese.getByRole('button', { name: '内置 CPA', exact: true }).click();
    const cnMenu = chinese.getByRole('menu', { name: 'CPA 目标' });
    await assertMenuBounds(chinese, cnMenu);
    await cnMenu.getByRole('menuitem', { name: '连接远程 CPA' }).click();
    const cnDialog = chinese.getByRole('dialog', { name: '连接远程 CPA' });
    await cnDialog.getByLabel('CPA 服务地址').fill(originA);
    await cnDialog.getByLabel('管理密钥', { exact: true }).fill('wrong-management');
    await cnDialog.getByRole('button', { name: '验证并连接' }).click();
    await cnDialog.getByRole('alert').waitFor();
    geometries.push(await assertConnectionBounds(chinese, cnDialog, { width: 375, height: 500 }, false));
    await cnDialog.getByLabel('管理密钥', { exact: true }).fill('first-management');
    await cnDialog.getByRole('button', { name: '验证并连接' }).click();
    await chinese.getByRole('heading', { name: '重新打开 ECPA 以切换模式' }).waitFor();
    await chinese.reload();
    await chinese.getByText('客户端密钥：1 个').waitFor();
    await chinese.getByRole('button', { name: '远程 CPA: 127.0.0.1:8888' }).click();
    await assertMenuBounds(chinese, cnMenu);
    assert.ok(await chinese.locator('.cpa-remote-workspace').evaluate(node => node.scrollWidth <= node.clientWidth));
    await chinese.close();
    assert.deepEqual(pageErrors, []);
    console.log(`Connection modal geometry (including auth error): ${geometries.join('; ')}`);
    console.log('Remote CPA browser flow: sidebar and remote keyboard menus, pending undo, verified connection, masked keys, conflict/review, removal, dirty discard, scoped switch, return to Local, and compact Chinese passed');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
