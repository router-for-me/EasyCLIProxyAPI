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

async function assertSelectedTarget(menu, name) {
  const selected = menu.getByRole('menuitemradio', { name, exact: true });
  assert.equal(await selected.getAttribute('aria-checked'), 'true');
  assert.equal(await selected.locator('.cpa-target-check[aria-hidden="true"]').count(), 1);
  assert.equal(await menu.locator('.cpa-target-current').count(), 0);
  assert.ok(!/Current:|当前：/.test(await menu.textContent()));
  const style = await selected.evaluate(button => {
    const css = getComputedStyle(button);
    const trigger = button.closest('.cpa-target-switcher').querySelector('.cpa-target-trigger');
    return { border: css.borderTopWidth, menuWidth: button.parentElement.getBoundingClientRect().width,
      triggerWidth: trigger.getBoundingClientRect().width };
  });
  assert.equal(style.border, '0px');
  assert.ok(style.menuWidth >= style.triggerWidth - 1 && style.menuWidth <= Math.max(180, style.triggerWidth) + 1,
    JSON.stringify(style));
}

async function assertMenuBounds(page, menu) {
  const box = await menu.boundingBox();
  const view = page.viewportSize();
  assert.ok(box.x >= 0 && box.x + box.width <= view.width && box.y >= 0 && box.y + box.height <= view.height,
    `menu is clipped: ${JSON.stringify({ box, view })}`);
  assert.ok(await menu.locator('[role="menuitem"], [role="menuitemradio"]').first().evaluate(button => {
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
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US', reducedMotion: 'reduce' });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/tests/fixtures/remote-cpa.html`);
    const opener = page.locator('.sidebar').getByRole('button', { name: 'Built-in CPA', exact: true });
    const menu = page.getByRole('menu', { name: 'CPA target' });
    const connectItem = menu.getByRole('menuitem', { name: 'Add external CPA' });
    const openConnect = async () => { await opener.click(); await connectItem.click(); };
    assert.equal(await page.locator('main').getByRole('button', { name: 'Add external CPA' }).count(), 0);
    await opener.press('ArrowDown');
    assert.equal(await opener.getAttribute('aria-expanded'), 'true');
    const localSelected = menu.getByRole('menuitemradio', { name: 'Built-in CPA', exact: true });
    await assertSelectedTarget(menu, 'Built-in CPA');
    assert.ok(await localSelected.evaluate(el => document.activeElement === el));
    await page.keyboard.press('ArrowDown');
    assert.ok(await connectItem.evaluate(el => document.activeElement === el));
    await page.keyboard.press('ArrowUp');
    await localSelected.click();
    assert.equal(await menu.count(), 0);
    assert.ok(await opener.evaluate(el => document.activeElement === el));
    assert.equal(await page.getByRole('dialog').count(), 0);
    await opener.press('ArrowDown');
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
    const dialog = page.getByRole('dialog', { name: 'Add external CPA' });
    const endpoint = dialog.getByLabel('CPA server URL');
    const key = dialog.getByLabel('Management key', { exact: true });
    const verify = dialog.getByRole('button', { name: 'Verify and connect' });
    const focused = locator => locator.evaluate(el => document.activeElement === el);
    assert.equal(await key.getAttribute('type'), 'password');
    await endpoint.fill('http://127.0.0.1:8888/');
    await key.fill('wrong-management');
    await page.evaluate(() => { window.remoteTestControls.localRunning = true; });
    await verify.click();
    await dialog.getByRole('alert').filter({ hasText: 'Management access was denied' }).waitFor();
    assert.equal(await key.inputValue(), 'wrong-management');
    assert.ok(await page.evaluate(() => window.remoteTestControls.localRunning));
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
    const nav = page.locator('.sidebar .nav-section');
    const originalNav = await nav.locator(':scope > button, .nav-plugin-parent > button:first-child').allTextContents();
    const originalHome = await page.locator('main h2:not(#home-cpa-runtime)').allTextContents();
    await page.evaluate(() => { window.originalShell = document.querySelector('.app-shell'); });
    await verify.click();
    await page.getByRole('button', { name: 'External CPA: 127.0.0.1:8888' }).waitFor();
    assert.ok(await page.evaluate(() => window.originalShell === document.querySelector('.app-shell') && !window.remoteTestControls.localRunning));
    assert.deepEqual(await nav.locator(':scope > button, .nav-plugin-parent > button:first-child').allTextContents(), originalNav);
    assert.deepEqual(await page.locator('main h2:not(#home-cpa-runtime)').allTextContents(), originalHome);
    const runtime = page.locator('.home-dashboard .control-panel');
    await runtime.getByRole('heading', { name: 'External CPA connection' }).waitFor();
    await runtime.getByText(/^http:\/\/127\.0\.0\.1:8888\/?$/).waitFor();
    await runtime.getByText('Management API reachable', { exact: true }).waitFor();
    assert.equal(await runtime.getByRole('button').count(), 1);
    await page.evaluate(() => { window.remoteTestControls.offline = true; });
    await runtime.getByRole('button', { name: 'Check connection' }).click();
    await runtime.getByText('Management API connection failed', { exact: true }).waitFor();
    assert.equal(await runtime.getByRole('button').count(), 1);
    await page.evaluate(() => { window.remoteTestControls.offline = false; });
    await runtime.getByRole('button', { name: 'Check connection' }).click();
    await runtime.getByText('Management API reachable', { exact: true }).waitFor();
    await nav.getByRole('button', { name: 'Usage', exact: true }).click();
    await page.waitForFunction(() => window.remoteTestCalls.includes('get_usage_collector_status'));
    await page.getByRole('tab', { name: 'Live routing', exact: true }).click();
    await page.getByRole('heading', { name: 'Live routing', exact: true }).waitFor();
    assert.equal(await page.getByText(/External dispatch rejected|stale usage target revision/).count(), 0);
    await nav.getByRole('button', { name: 'Agent Configuration', exact: true }).click();
    await page.locator('.agents-page').waitFor();
    await page.getByRole('button', { name: /OpenCode/ }).click();
    await page.getByRole('button', { name: 'Update Configuration', exact: true }).click();
    await page.getByRole('button', { name: 'Start App', exact: true }).click();
    await page.getByRole('button', { name: 'Restart App', exact: true }).click();
    assert.ok(await page.evaluate(() => ['update_agent_config','launch_agent','restart_agent_app'].every(cmd => window.remoteTestCalls.includes(cmd))));
    assert.equal(await page.getByText(/External dispatch rejected:/).count(), 0);
    await page.evaluate(() => { window.remoteTestControls.failRefresh = true; });
    await page.getByRole('button', { name: 'Update Configuration', exact: true }).click();
    await page.getByText(/Configuration saved, but client status could not be refreshed:.*Fixture refresh failure/).waitFor();
    await nav.getByRole('button', { name: 'Quick Configuration', exact: true }).click();
    await page.locator('#config-subpage-tab-proxy').click();
    await page.locator('#config-native-reverse-proxy').getByText('This feature is not supported for external CPA instances.').waitFor();
    assert.equal(await page.locator('#config-native-reverse-proxy button').count(), 0);
    await page.locator('#config-subpage-tab-aliases').click();
    await page.waitForFunction(() => window.remoteTestCalls.includes('get_thinking_aliases'));
    await page.locator('#config-subpage-tab-diagnostics').click();
    await page.getByRole('button', { name: 'View server logs' }).click();
    await page.getByRole('dialog').getByText(/^fixture log: http:\/\/127/).waitFor();
    await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(() => !['reverse_proxy_get_state','get_lan_ipv4','open_core_logs_directory','restart_core_process'].some(cmd => window.remoteTestCalls.includes(cmd))));
    await nav.getByRole('button', { name: 'OAuth Management', exact: true }).click();
    await page.locator('#oauth-subpage-tab-acp').click();
    await page.locator('.acp-access-page').getByText('ACP access is not supported for external CPA instances. Switch back to Built-in CPA to use it.').waitFor();
    assert.ok(!await page.evaluate(() => window.remoteTestCalls.includes('get_acp_status')));
    await nav.getByRole('button', { name: 'Quick Configuration', exact: true }).click();
    await page.locator('#config-subpage-tab-general').click();
    const add = page.getByRole('button', {name:'Add Authentication Key', exact:true});
    await add.click();
    const form = page.getByRole('dialog', {name:'Add Authentication Key'});
    await form.getByPlaceholder('sk-...').fill('sk-remote-only');
    await form.locator('button[type=submit]').click();
    await form.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.remoteTestKeys.get('http://127.0.0.1:8888/')), ['first-client','sk-remote-only']);
    assert.ok(!await page.evaluate(() => window.remoteTestCalls.includes('add_core_api_key')));
    await page.getByRole('button', { name: /^External CPA: / }).click();
    await menu.getByRole('menuitem', { name:'Return to Built-in CPA' }).click();
    await page.getByRole('alertdialog').getByRole('button', {name:'Return to Built-in CPA'}).click();
    await opener.waitFor();
    assert.ok(await page.evaluate(() => window.remoteTestControls.localRunning));
    await add.waitFor();
    assert.ok(await page.evaluate(() => window.originalShell === document.querySelector('.app-shell')));
    await nav.getByRole('button', { name: 'OAuth Management', exact: true }).click();
    await page.locator('#oauth-subpage-tab-acp').click();
    await page.locator('.acp-access-page #acp-provider-title').waitFor();
    await page.waitForFunction(() => window.remoteTestCalls.includes('get_acp_status'));
    assert.equal(await page.locator('.acp-action-notice').count(), 0);

    const savedA = 'http://127.0.0.1:8888';
    const savedB = 'https://management-gateway-with-a-long-test-subdomain.for-a-private-network.example.test/team/';
    await openConnect();
    await endpoint.fill(savedB);
    await key.fill('second-management');
    await verify.click();
    const activeExternal = page.getByRole('button', {name: /^External CPA: /});
    await activeExternal.click();
    await menu.getByRole('menuitemradio', {name:savedA, exact:true}).click();
    const switchDialog = page.getByRole('dialog', {name:'Switch CPA instance'});
    assert.equal(await switchDialog.getByLabel('Management key', {exact:true}).inputValue(), '');
    await switchDialog.getByRole('button', {name:'Verify and switch'}).click();
    await page.getByRole('button', {name:'External CPA: 127.0.0.1:8888'}).waitFor();
    await page.evaluate(() => { window.remoteTestCalls.length = 0; });
    await nav.getByRole('button', {name:'Version Management'}).click();
    await page.getByText(/Update this external kernel on its host/).waitFor();
    const calls = await page.evaluate(() => window.remoteTestCalls);
    assert.ok(calls.includes('check_app_version_display'));
    for (const cmd of ['detect_bundled_core','list_core_versions','get_core_install_task','get_auto_update_status','check_latest_core']) assert.ok(!calls.includes(cmd), cmd);
    await activeExternal.click();
    await menu.getByRole('menuitemradio', {name:savedB.slice(0,-1), exact:true}).click();
    await switchDialog.getByRole('button', {name:'Forget instance'}).click();
    await switchDialog.getByRole('button', {name:'Confirm removal'}).click();
    await switchDialog.waitFor({state:'detached'});
    await activeExternal.click();
    assert.equal(await menu.getByRole('menuitemradio', {name:savedB.slice(0,-1), exact:true}).count(),0);
    await page.keyboard.press('Escape');

    const chinese = await browser.newPage({ viewport: { width: 375, height: 500 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    await chinese.goto(`http://127.0.0.1:${port}/tests/fixtures/remote-cpa.html`);
    await chinese.getByRole('button', { name: '内置 CPA', exact: true }).click();
    const cnMenu = chinese.getByRole('menu', { name: 'CPA 目标' });
    await assertMenuBounds(chinese, cnMenu);
    await assertSelectedTarget(cnMenu, '内置 CPA');
    await cnMenu.getByRole('menuitem', { name: '添加外部 CPA' }).click();
    const cnDialog = chinese.getByRole('dialog', { name: '添加外部 CPA' });
    await cnDialog.getByLabel('CPA 服务地址').fill('http://127.0.0.1:8888/');
    await cnDialog.getByLabel('管理密钥', { exact: true }).fill('wrong-management');
    await cnDialog.getByRole('button', { name: '验证并连接' }).click();
    await cnDialog.getByRole('alert').waitFor();
    geometries.push(await assertConnectionBounds(chinese, cnDialog, { width: 375, height: 500 }, false));
    await cnDialog.getByLabel('管理密钥', { exact: true }).fill('first-management');
    await cnDialog.getByRole('button', { name: '验证并连接' }).click();
    await chinese.locator('#home-cpa-runtime').waitFor();
    await chinese.getByRole('button', { name: '外部 CPA: 127.0.0.1:8888' }).click();
    await assertMenuBounds(chinese, cnMenu);
    await assertSelectedTarget(cnMenu, '127.0.0.1:8888');
    assert.ok(await chinese.locator('.workspace').evaluate(node => node.scrollWidth <= node.clientWidth));
    await chinese.close();
    assert.deepEqual(pageErrors, []);
    console.log(`Connection modal geometry (including auth error): ${geometries.join('; ')}`);
    console.log('Remote CPA browser flow: verified switch, identical navigation and home, original agent/config pages, isolated key edit, return to Local, and compact Chinese passed');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
