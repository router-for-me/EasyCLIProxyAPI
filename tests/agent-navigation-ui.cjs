// Run Vite on port 1421, then node tests/agent-navigation-ui.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:1421/') ? route.continue() : route.abort());
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const tab = name => page.getByRole('tab', { name, exact: true });
    const button = name => page.getByRole('button', { name, exact: true });
    const client = name => ({ click: async () => {
      const row = page.locator('.agent-list-items button').filter({ has: page.getByText(name, { exact: true }) });
      const previous = button('上一页客户端');
      while (await previous.isEnabled()) await previous.click();
      for (let index = 0; index < 13 && !(await row.count()); index++) {
        const next = button('下一页客户端');
        assert.ok(await next.isEnabled(), `${name} must be reachable in the saved client list`);
        await next.click();
      }
      await row.click();
    } });
    const active = async name => {
      await page.waitForFunction(name => Array.from(document.querySelectorAll('[role=tab]'))
        .some(el => el.textContent === name && el.getAttribute('aria-selected') === 'true'), name);
      assert.equal(await page.locator('[role=tab][aria-selected=true]').count(), 1);
    };
    const ready = () => page.waitForFunction(() => {
      const refresh = document.querySelector('.agent-client-list-heading button');
      return refresh && !refresh.disabled && window.fixtureCalls.some(call => call.cmd === 'get_agent_models');
    });
    const open = async query => {
      await page.goto('http://127.0.0.1:1421/tests/fixtures/agent-backups.html?reset-selections&' + query, { waitUntil: 'domcontentloaded' });
      await ready();
    };
    const remount = async embedded => {
      await page.evaluate(embedded => window.fixtureRemount(embedded), embedded);
      await ready();
    };
    const sessionsReady = () => page.locator('.codex-session-row').first().waitFor();
    const sessionPage = async number => {
      await sessionsReady();
      assert.equal(await page.locator('.codex-session-pagination span').textContent(), `第 ${number} 页`);
    };

    // Every agent remembers its own tab, draft and feedback, in both entry points.
    for (const width of [1280, 540]) for (const embedded of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await open(embedded ? 'embedded' : '');
      await page.locator('.agent-model-trigger').click();
      await page.getByRole('option', { name: 'gpt-two' }).click();
      if (!embedded) await button('如何选择').click();
      await tab('配置管理').click();
      await button('手动备份').click();
      const notice = page.getByText('已手动备份当前磁盘配置，未包含未保存的表单修改。', { exact: true });
      await notice.waitFor();
      await client('OpenCode').click();
      await active('基础配置');
      assert.equal(await notice.count(), 0);
      assert.equal(await tab('会话管理').count(), 0);
      await tab('配置管理').click();
      await client('Pi').click();
      await active('基础配置');
      await client('Codex').click();
      await active('配置管理');
      await notice.waitFor();
      await page.getByText('待应用', { exact: true }).waitFor();
      await client('Codex').click();
      await active('配置管理');
      await remount();
      await active('配置管理');
      await notice.waitFor();
      await tab('配置管理').press('Home');
      await active('基础配置');
      assert.equal(await tab('基础配置').evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator('.agent-model-trigger strong').textContent(), 'gpt-two');
      if (!embedded) assert.equal(await page.locator('.agent-signin-help-toggle').getAttribute('aria-expanded'), 'true');
      await client('OpenCode').click();
      await active('配置管理');
      await client('Codex').click();
      await active('基础配置');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    }

    await open('fail-apply');
    await page.locator('.agent-model-trigger').click();
    await page.getByRole('option', { name: 'gpt-two' }).click();
    await button('更新配置').click();
    await page.getByText(/模拟配置写入失败/).waitFor();
    await client('OpenCode').click();
    assert.equal(await page.getByText(/模拟配置写入失败/).count(), 0);
    await client('Codex').click();
    await page.getByText(/模拟配置写入失败/).waitFor();
    await page.getByText('待应用', { exact: true }).waitFor();

    // Full and compact navigation remain independent, including Codex-only sessions.
    await open('');
    await tab('会话管理').click();
    await sessionsReady();
    await button('下一页').click();
    await sessionPage(2);
    await button('多选').click();
    const selectedSession = page.getByRole('checkbox', { name: '选择会话 session-51', exact: true });
    await selectedSession.check();
    await client('OpenCode').click();
    await active('基础配置');
    assert.equal(await tab('会话管理').count(), 0);
    await client('Codex').click();
    await active('会话管理');
    await sessionPage(2);
    assert.ok(await selectedSession.isChecked());
    await remount(true);
    await active('基础配置');
    assert.equal(await tab('会话管理').count(), 0);
    await tab('配置管理').click();
    await remount(false);
    await active('会话管理');
    await sessionPage(2);
    assert.ok(await selectedSession.isChecked());
    await remount(true);
    await active('配置管理');
    await remount(false);
    await sessionPage(2);

    // A failed reload leaves the remembered page and selection available for a retry.
    await tab('基础配置').click();
    await page.evaluate(() => { window.fixtureFailSessionLoad = true; });
    await tab('会话管理').click();
    await page.getByText(/模拟会话读取失败/).waitFor();
    assert.equal(await page.locator('.codex-session-pagination span').textContent(), '第 2 页');
    await page.evaluate(() => { window.fixtureFailSessionLoad = false; });
    await page.locator('.codex-sessions-page').getByRole('button', { name: '刷新', exact: true }).click();
    await sessionPage(2);
    assert.ok(await selectedSession.isChecked());
    assert.equal(await page.getByText(/模拟会话读取失败/).count(), 0);

    // Reload actual data on return: drop missing selections and back up from an empty page.
    await tab('基础配置').click();
    await page.evaluate(() => { window.fixtureSessionIds = window.fixtureSessionIds.filter(id => id !== 'session-51'); });
    await tab('会话管理').click();
    await sessionPage(2);
    assert.equal(await page.locator('.codex-session-row input:checked').count(), 0);
    assert.equal(await selectedSession.count(), 0);
    await tab('配置管理').click();
    await page.evaluate(() => { window.fixtureSessionIds = window.fixtureSessionIds.slice(0, 10); });
    await tab('会话管理').click();
    await sessionPage(1);
    assert.equal(await page.locator('.codex-session-row').count(), 10);

    // A response from the previous visit must not restore stale data or overwrite its cache.
    await tab('基础配置').click();
    await page.evaluate(() => { window.fixtureDeferSessionLoad = true; });
    await tab('会话管理').click();
    await page.waitForFunction(() => !!window.fixtureFinishSessionLoad);
    await client('OpenCode').click();
    await page.evaluate(() => { window.fixtureSessionIds = ['session-new']; });
    await client('Codex').click();
    await sessionsReady();
    await page.evaluate(() => window.fixtureFinishSessionLoad());
    await page.waitForFunction(() => document.querySelector('.codex-session-row strong')?.textContent === 'session-new');
    assert.deepEqual(await page.locator('.codex-session-row strong').allTextContents(), ['session-new']);
    await remount();
    await sessionsReady();
    assert.deepEqual(await page.locator('.codex-session-row strong').allTextContents(), ['session-new']);

    assert.deepEqual(errors, []);
    console.log('PASS: per-agent tabs, drafts, feedback, help, remounts, compact/full isolation, keyboard, narrow layouts, session pagination/selection and stale response handling');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
