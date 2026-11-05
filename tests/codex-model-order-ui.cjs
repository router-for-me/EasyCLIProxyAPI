const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }).catch(() => chromium.launch({ headless: true }));
  const page = await browser.newPage();
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:1421/') ? route.continue() : route.abort());
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const dialog = () => page.getByRole('dialog', { name: 'Codex 模型列表' });
  const rows = () => dialog().locator('.codex-catalog-row');
  const readOrder = () => dialog().locator('.codex-catalog-row strong').allTextContents();
  const openDialog = async () => {
    await page.getByRole('button', { name: '模型列表设置', exact: true }).click();
    await dialog().waitFor();
    await rows().first().waitFor();
  };
  const save = async () => {
    await dialog().getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.app-notice-stack').getByRole('status').filter({ hasText: /已保存/ }).waitFor();
  };
  const closeDialog = async () => {
    await dialog().getByRole('button', { name: '取消', exact: true }).click();
    await dialog().waitFor({ state: 'detached' });
  };
  try {
    await page.goto('http://127.0.0.1:1421/tests/fixtures/agent-backups.html?client=codex&reset-selections');
    await page.evaluate(async () => {
      const { createBrowserMockRuntime } = await import('/src/mocks/browserMockRuntime.ts');
      const runtime = createBrowserMockRuntime('running');
      const prevInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (cmd, args, options) => {
        if (cmd === 'get_codex_model_catalog_editor' || cmd === 'save_codex_model_catalog_editor') {
          return runtime.invoke(cmd, args);
        }
        return prevInvoke(cmd, args, options);
      };
    });

    await openDialog();
    assert.equal(await rows().count(), 3);

    const firstRow = rows().first();
    assert.equal(await firstRow.getByRole('button', { name: '下移', exact: true }).isEnabled(), true);
    assert.equal(await firstRow.getByRole('button', { name: '上移', exact: true }).isDisabled(), true);

    const before = await readOrder();
    assert.equal(before.length, 3);

    await firstRow.getByRole('button', { name: '下移', exact: true }).click();
    const reordered = [before[1], before[0], before[2]];
    assert.deepEqual(await readOrder(), reordered);

    await save();
    await closeDialog();
    await openDialog();
    assert.deepEqual(await readOrder(), reordered);

    await dialog().getByRole('button', { name: '恢复默认排序', exact: true }).click();
    assert.deepEqual(await readOrder(), before);

    await save();
    await closeDialog();
    await openDialog();
    assert.deepEqual(await readOrder(), before);

    await dialog().screenshot({ path: '/tmp/ecpa_codex-order-ui_dialog.png' });
    await closeDialog();

    assert.deepEqual(errors, []);
    console.log('codex model order UI: ok');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
