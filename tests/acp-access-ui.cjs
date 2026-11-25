// Browser-mock regression coverage, not a substitute for native desktop acceptance.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    cacheDir: '.codex/acp-ui/vite-cache', optimizeDeps: { entries: ['index.html'] },
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  const errors = [];
  try {
    await server.listen();
    const base = 'http://127.0.0.1:' + server.httpServer.address().port;
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, args: ['--no-proxy-server'] });
    for (const locale of ['zh-CN', 'en']) {
      const zh = locale === 'zh-CN';
      const text = (cn, en) => zh ? cn : en;
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
      await page.addInitScript(language => localStorage.setItem('easy-cli-proxy-api.locale', language), locale);
      await page.goto(base + '/?mock=running&mockDelay=25', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.locator('.app-shell').waitFor();
      await page.addStyleTag({ content: '#browser-mock-toolbar { display:none; }' });
      await page.locator('.nav-section button').nth(2).click();
      const tab = page.locator('#oauth-subpage-tab-acp');
      await tab.click();
      const idle = () => page.waitForFunction(() => document.querySelector('.acp-access-page')?.getAttribute('aria-busy') === 'false');
      await idle();
      const button = name => page.getByRole('button', { name, exact: true });
      const manage = button(text('管理账号', 'Manage accounts'));
      const test = button(text('测试回复', 'Test response'));
      assert.equal(await test.isEnabled(), false);
      assert.equal(await page.locator('.acp-empty-state').count(), 1);
      assert.match(await page.locator('.acp-current-account').textContent(), text(/0 个已保存/, /0 saved/));
      assert.equal(await page.locator('.acp-test-model-controls select').count(), 0);
      await manage.click();
      let dialog = page.locator('.acp-account-dialog:not(.acp-account-editor)');
      assert.equal(await dialog.locator('.acp-managed-account').count(), 0);
      assert.equal(await dialog.locator('.acp-account-empty').count(), 1);
      assert.match(await dialog.locator('.acp-account-empty').textContent(), text(/尚未添加账号/, /No saved accounts/));
      await button(text('新增账号', 'Add account')).click();
      let editor = page.locator('.acp-account-editor');
      let label = editor.locator('.acp-note-field > input[type=text]').first();
      await label.fill('  ');
      await editor.getByRole('button', { name: text('新增并登录', 'Add and sign in'), exact: true }).click();
      await editor.locator('#acp-note-error').waitFor();
      assert.equal(await label.getAttribute('aria-invalid'), 'true');
      await label.fill('字'.repeat(81));
      await editor.getByRole('button', { name: text('新增并登录', 'Add and sign in'), exact: true }).click();
      assert.equal(await label.getAttribute('aria-invalid'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await editor.count(), 0);
      assert.equal(await page.evaluate(() => document.querySelector('.acp-account-dialog').contains(document.activeElement)), true);
      await page.keyboard.press('Escape');
      assert.equal(await manage.evaluate(el => document.activeElement === el), true);

      await button(text('登录 Google', 'Sign in with Google')).click();
      await idle();
      assert.match(await page.locator('.acp-current-account').textContent(), /personal.acp@example.test/);
      const privacyToggle = page.locator('.sidebar-privacy-toggle');
      await privacyToggle.click();
      assert.doesNotMatch(await page.locator('.acp-current-account').textContent(), /personal.acp@example.test/);
      await privacyToggle.click();
      assert.equal(await page.locator('.acp-test-model-controls option').count(), 2);
      await page.locator('.acp-test-model-controls select').selectOption('gemini-3.8-flash-low');
      await idle();
      await test.click();
      await page.locator('.acp-probe-result').waitFor();
      assert.match(await page.locator('.acp-probe-result').textContent(), /ACP_OK/);
      const apiSwitch = page.locator('.acp-api-switch input');
      assert.equal(await apiSwitch.isChecked(), false, 'sign-in never starts API');
      await apiSwitch.click();
      await idle();
      await page.waitForFunction(() => document.querySelector('.acp-api-switch input')?.checked);
      const poolSwitch = page.locator('.acp-pool-switch input');
      assert.equal(await poolSwitch.isChecked(), false, 'multi-account pool defaults to off');
      await poolSwitch.click();
      await page.waitForFunction(() => document.querySelector('.acp-pool-switch input')?.checked);
      await page.locator('.acp-pool-strategy select').selectOption('least_busy');
      assert.equal(await page.locator('.acp-pool-strategy select').inputValue(), 'least_busy');
      await page.locator('.acp-pool-telemetry').waitFor();
      await page.locator('.acp-api-details:not(.acp-pool-advanced) > summary').click();
      assert.match(await page.locator('.acp-api-details:not(.acp-pool-advanced)').textContent(), /acp\/gemini-3.8-flash-low/);
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.locator('.acp-code-heading button').click();
      assert.equal(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).model, 'acp/gemini-3.8-flash-low');

      await manage.click();
      await button(text('新增账号', 'Add account')).click();
      await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        let rejectPending;
        window.__TAURI_INTERNALS__.invoke = (command, args, options) => {
          if (command === 'add_acp_account' && args?.label === 'Cancelled') {
            return new Promise((_, reject) => { rejectPending = reject; });
          }
          if (command === 'cancel_acp_operation' && rejectPending) {
            rejectPending(new Error('ACP request cancelled'));
            rejectPending = undefined;
            return Promise.resolve();
          }
          return invoke(command, args, options);
        };
      });
      const authResponse = editor.getByLabel(text('授权码或回跳页面完整网址', 'Authorization code or full callback URL'));
      await label.fill('Cancelled');
      await editor.getByRole('button', { name: text('新增并登录', 'Add and sign in'), exact: true }).click();
      assert.equal(await authResponse.count(), 0, 'paste field stays hidden until CLI announces the link');
      await editor.getByRole('button', { name: text('取消操作', 'Cancel operation'), exact: true }).click();
      await idle();
      assert.equal(await dialog.locator('.acp-managed-account').count(), 1, 'cancelled addition leaves no record');
      assert.equal(await page.locator('.acp-action-notice').count(), 1, 'action feedback appears only at the top dialog layer');
      assert.equal(await editor.locator('.acp-action-notice.notice-info').count(), 1, 'explicit cancellation is neutral');
      assert.match(await editor.locator('.acp-action-notice').textContent(), /ACP request cancelled/);
      assert.equal(await label.getAttribute('aria-invalid'), 'false', 'cancelled authorization does not invalidate a valid label');
      assert.equal(await editor.locator('#acp-note-error').count(), 0);
      await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
          if (command === 'add_acp_account' && args?.label === 'Already saved' && args.onLink) {
            throw new Error('This Google account is already saved. Add a different Google account, or select the existing account');
          }
          if (command === 'add_acp_account' && args?.label === 'Cannot compare') {
            throw new Error('Google identity could not be verified against saved accounts. The account was not added');
          }
          return invoke(command, args, options);
        };
      });
      await label.fill('Already saved');
      await editor.getByRole('button', { name: text('新增并登录', 'Add and sign in'), exact: true }).click();
      await idle();
      assert.match(await editor.locator('.acp-action-notice').textContent(), text(/此 Google 账号已在列表中/, /This Google account is already in the list/));
      assert.equal(await dialog.locator('.acp-managed-account').count(), 1);
      assert.match(await dialog.locator('.acp-managed-account[data-current=true]').textContent(), /personal.acp@example.test/);
      assert.equal(await apiSwitch.isChecked(), true);
      assert.equal(await authResponse.count(), 0);
      await label.fill('Cannot compare');
      await editor.getByRole('button', { name: text('新增并登录', 'Add and sign in'), exact: true }).click();
      await idle();
      assert.match(await editor.locator('.acp-action-notice').textContent(), text(/无法确认这是不同的 Google 账号/, /Could not verify that this is a different Google account/));
      assert.equal(await dialog.locator('.acp-managed-account').count(), 1);
      assert.match(await dialog.locator('.acp-managed-account[data-current=true]').textContent(), /personal.acp@example.test/);
      assert.equal(await apiSwitch.isChecked(), true);
      await page.evaluate(() => {
        const tauri = window.__TAURI_INTERNALS__;
        const invoke = tauri.invoke;
        let pending;
        tauri.invoke = (command, args, options) => {
          if (command === 'add_acp_account' && args?.label === 'Work') {
            return new Promise((resolve, reject) => {
              const channelId = args.onLink.id;
              pending = { resolve, reject, args, options };
              tauri.runCallback(channelId, { index: 0, message: { attempt: 'manual-fixture', url: 'https://accounts.google.com/o/oauth2/auth?state=synthetic' } });
            });
          }
          if (command === 'submit_acp_account_authorization') {
            if (!pending || args.attempt !== 'manual-fixture' || args.response !== '4/' + 'a'.repeat(3069) + 'z') {
              return Promise.reject(new Error('Enter the authorization code or the official Antigravity callback URL'));
            }
            const original = pending;
            pending = undefined;
            invoke('add_acp_account', original.args, original.options).then(original.resolve, original.reject);
            tauri.runCallback(original.args.onLink.id, { index: 1, end: true });
            return Promise.resolve();
          }
          return invoke(command, args, options);
        };
      });
      await label.fill('Work');
      await editor.getByRole('button', { name: text('新增并登录', 'Add and sign in'), exact: true }).click();
      const authLink = editor.getByLabel(text('Google 授权链接（选中后复制）', 'Google authorization link (select and copy)'));
      await authLink.waitFor();
      assert.match(await authLink.inputValue(), /^https:\/\/accounts\.google\.com\//);
      assert.equal(await dialog.locator('.acp-managed-account').count(), 1, 'no commit before terminal authorization');
      const submit = editor.getByRole('button', { name: text('完成授权', 'Complete authorization'), exact: true });
      await authResponse.fill('invalid');
      await submit.click();
      assert.match(await editor.locator('.acp-form-error').textContent(), text(/请粘贴本次授权码/, /Paste the code/));
      const fullResponse = '4/' + 'a'.repeat(3069) + 'z';
      await authResponse.fill(fullResponse);
      assert.equal(await authResponse.inputValue(), fullResponse);
      await submit.click();
      await editor.waitFor({ state: 'detached' });
      assert.equal(await dialog.locator('.acp-managed-account').count(), 2);
      let current = dialog.locator('.acp-managed-account[data-current=true]');
      assert.match(await current.textContent(), /Work/);
      assert.equal(await apiSwitch.isChecked(), true);
      if (process.env.ECPA_ACP_ADD_ONLY === '1') {
        await page.evaluate(() => {
          const tauri = window.__TAURI_INTERNALS__;
          const invoke = tauri.invoke;
          let attempts = 0;
          tauri.invoke = (command, args, options) => {
            if (command === 'add_acp_account' && args?.label === 'Retry') {
              window.__acpRetryCount = ++attempts;
              return Promise.reject(new Error('Could not verify Antigravity CLI terminal sign-in: ACP initialization failed'));
            }
            return invoke(command, args, options);
          };
        });
        await button(text('新增账号', 'Add account')).click();
        await label.fill('Retry');
        const add = editor.getByRole('button', { name: text('新增并登录', 'Add and sign in'), exact: true });
        for (const attempt of [1, 2]) {
          await add.click();
          await page.waitForFunction(attempt => window.__acpRetryCount === attempt, attempt);
          await idle();
          assert.match(await editor.locator('.acp-action-notice').textContent(), text(/无法验证 Antigravity CLI 的终端授权/, /Could not verify Antigravity CLI terminal sign-in/));
          assert.equal(await add.isEnabled(), true);
          assert.equal(await dialog.locator('.acp-managed-account').count(), 2);
        }
      }
      if (process.env.ECPA_ACP_ADD_ONLY === '1') {
        console.log('PASS browser-mock ACP add regression:', locale);
        await page.close();
        continue;
      }
      await current.getByRole('button', { name: text('修改“Work”的备注', 'Edit label for “Work”'), exact: true }).click();
      const longLabel = 'Work '.repeat(16).trim();
      await label.fill(longLabel);
      const settingsNumbers = editor.locator('.acp-account-settings-grid input[type=number]');
      await settingsNumbers.nth(0).fill('1');
      await settingsNumbers.nth(1).fill('4');
      await settingsNumbers.nth(2).fill('3');
      await editor.getByRole('button', { name: text('保存', 'Save'), exact: true }).click();
      await idle();
      await editor.waitFor({ state: 'detached' });
      assert.equal(await current.locator('.acp-account-name').textContent(), longLabel);
      assert.equal(await current.locator('.acp-account-name').getAttribute('title'), longLabel);
      assert.match(await current.locator('.acp-account-badges').textContent(), /P1 · W4/);
      await button(text('全部校验', 'Verify all')).click();
      await idle();
      const rowEnableSwitch = current.locator('input[type=checkbox]');
      assert.equal(await rowEnableSwitch.isChecked(), true);
      await rowEnableSwitch.click();
      await page.waitForFunction(() => document.querySelector('.acp-managed-account[data-current=true]')?.getAttribute('data-disabled') === 'true');
      await rowEnableSwitch.click();
      await page.waitForFunction(() => document.querySelector('.acp-managed-account[data-current=true]')?.getAttribute('data-disabled') === 'false');
      const closedHeight = await current.evaluate(el => el.getBoundingClientRect().height);
      await current.locator('.acp-more-trigger').focus();
      await page.keyboard.press('ArrowDown');
      await current.getByRole('menu').waitFor();
      assert.equal(await current.evaluate(el => el.getBoundingClientRect().height), closedHeight, 'more menu must not reflow the account row');
      await page.keyboard.press('Escape');
      assert.equal(await current.getByRole('menu').count(), 0);
      assert.equal(await dialog.count(), 1, 'Escape closes menu, not management dialog');
      assert.equal(await current.locator('.acp-more-trigger').evaluate(el => el === document.activeElement), true);
      assert.equal(await dialog.locator('.acp-dialog-actions').evaluate(el => getComputedStyle(el).display), 'flex');
      await current.locator('.acp-more-trigger').click();
      await current.getByRole('menuitem', { name: text('退出登录', 'Sign out'), exact: true }).click();
      let confirmation = page.getByRole('alertdialog');
      assert.match(await confirmation.textContent(), text(/保留本地记录和备注/, /Keep its local record and label/));
      await confirmation.getByRole('button', { name: text('退出登录', 'Sign out'), exact: true }).click();
      await idle();
      assert.equal(await dialog.locator('.acp-managed-account').count(), 2);
      assert.equal(await page.locator('.acp-access-page').getAttribute('data-connected'), 'false');
      assert.equal(await apiSwitch.isChecked(), true);
      assert.equal(await current.getByRole('button', { name: text('重新登录', 'Sign in again'), exact: true }).isEnabled(), true, 'reauthorize discoverable when disconnected');
      await current.getByRole('button', { name: text('重新登录', 'Sign in again'), exact: true }).click();
      assert.equal(await confirmation.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'ACP confirmation must not horizontally overflow');
      await confirmation.getByRole('button', { name: text('重新登录', 'Sign in again'), exact: true }).click();
      await idle();
      const personal = dialog.locator('.acp-managed-account').filter({ hasText: 'personal.acp@example.test' });
      await personal.getByRole('button', { name: text('切换', 'Use account'), exact: true }).click();
      await idle();
      assert.match(await dialog.locator('.acp-managed-account[data-current=true]').textContent(), /personal.acp@example.test/);
      assert.equal(await page.locator('.acp-test-model-controls select').inputValue(), 'gemini-3.8-flash-low');
      const work = dialog.locator('.acp-managed-account').filter({ hasText: longLabel });
      await work.locator('.acp-more-trigger').click();
      await work.getByRole('menuitem', { name: text('移除本地账号', 'Remove local account'), exact: true }).click();
      assert.match(await confirmation.textContent(), text(/不会退出登录或删除 Google 账号/, /does not sign out or delete your Google account/));
      await confirmation.getByRole('button', { name: text('取消', 'Cancel'), exact: true }).click();
      assert.equal(await dialog.locator('.acp-managed-account').count(), 2);

      for (const width of [520, 720, 1280]) {
        await page.setViewportSize({ width, height: 780 });
        assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'management dialog fits at ' + width);
        assert.equal(await page.locator('.acp-access-page').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
        assert.equal(await dialog.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; }), true);
      }
      await page.evaluate(async () => (await import('/src/theme.ts')).initializeTheme().setPreference('dark'));
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.evaluate(async () => (await import('/src/theme.ts')).initializeTheme().setPreference('light'));
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');

      // Missing CLI is a prerequisite, not a reason to hide saved records.
      await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
          const result = await invoke(command, args, options);
          return command === 'get_acp_status' ? { ...result, executable: null, authenticated: false, models: [], latestProbe: null } : result;
        };
      });
      await page.keyboard.press('Escape');
      await page.locator('#oauth-subpage-tab-login').click();
      await tab.click();
      await page.locator('.acp-install-state').waitFor();
      await manage.click();
      assert.equal(await dialog.locator('.acp-managed-account').count(), 2);
      assert.equal(await button(text('新增账号', 'Add account')).isEnabled(), false);
      assert.equal(await dialog.locator('.acp-managed-account button[title="' + text('修改备注', 'Edit label') + '"]').first().isEnabled(), true);
      const inactive = dialog.locator('.acp-managed-account:not([data-current=true])');
      await inactive.locator('.acp-more-trigger').click();
      await inactive.getByRole('menuitem', { name: text('移除本地账号', 'Remove local account'), exact: true }).click();
      await confirmation.getByRole('button', { name: text('移除本地账号', 'Remove local account'), exact: true }).click();
      await idle();
      assert.equal(await dialog.locator('.acp-managed-account').count(), 1);
      current = dialog.locator('.acp-managed-account[data-current=true]');
      await current.locator('.acp-more-trigger').click();
      await current.getByRole('menuitem', { name: text('移除本地账号', 'Remove local account'), exact: true }).click();
      await confirmation.getByRole('button', { name: text('移除本地账号', 'Remove local account'), exact: true }).click();
      await idle();
      assert.equal(await dialog.locator('.acp-managed-account').count(), 0);
      assert.equal(await dialog.locator('.acp-account-empty').count(), 1);
      assert.equal(await apiSwitch.isChecked(), true, 'last removal preserves explicit API setting');
      console.log('PASS browser-mock ACP management regression:', locale);
      await page.close();
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
