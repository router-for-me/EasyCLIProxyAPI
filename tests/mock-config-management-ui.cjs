const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer: createPortProbe } = require('node:net');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const probe = createPortProbe();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const portNumber = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], cacheDir: 'node_modules/.vite-mock-config-test',
    optimizeDeps: { entries: ['index.html'] }, logLevel: 'error', server: { host: '127.0.0.1', port: portNumber, strictPort: true, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.route('**/*', (route) => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}/?mock=running`);
    await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
    const nav = page.locator('.nav-section');
    const quick = nav.getByRole('button', { name: 'Quick Configuration', exact: true });
    const management = nav.getByRole('button', { name: 'Configuration Management', exact: true });
    await quick.click();
    await page.locator('#config-subpage-panel').waitFor();
    await management.click();
    const config = page.locator('[data-mock-config-management]');
    const tab = (id) => config.locator(`#mock-config-tab-${id}`);
    const port = config.locator('#cfg-field-port input');
    const yaml = config.getByRole('textbox', { name: 'YAML', exact: true });
    const yamlText = () => yaml.locator('.cm-line').allTextContents().then((lines) => lines.join('\n'));
    const mode = (name) => config.getByRole('button', { name, exact: true });
    const button = (name) => config.getByRole('button', { name, exact: true });
    const save = button('Save changes');
    const confirmation = page.getByRole('alertdialog');
    const diff = page.getByRole('dialog', { name: 'Review Changes' });

    await port.waitFor();
    assert.equal(await port.inputValue(), '8317');
    assert.equal(await config.getByRole('tab').count(), 7);
    for (const id of ['connectivity', 'network', 'logging', 'streaming', 'advanced', 'payload', 'common']) {
      await tab(id).click();
      await config.locator(`[aria-labelledby="mock-config-tab-${id}"]`).waitFor();
      assert.doesNotMatch(await config.getByRole('tabpanel').innerText(), /\bconfig_management\./);
    }
    assert.equal(await port.evaluate((input) => getComputedStyle(input).borderTopStyle), 'solid');
    await tab('network').click();
    const strategy = config.locator('#cfg-field-routingStrategy').getByRole('combobox', { name: 'Routing Strategy' });
    await strategy.press('ArrowDown');
    const strategyMenu = page.getByRole('listbox', { name: 'Routing Strategy' });
    await strategyMenu.getByRole('option', { name: 'Weighted Round Robin' }).waitFor();
    await strategy.press('ArrowDown');
    await strategy.press('Enter');
    assert.match(await strategy.textContent(), /Weighted Round Robin/);
    await strategy.click();
    await strategyMenu.getByRole('option', { name: 'Round Robin', exact: true }).click();
    await tab('common').click();
    await button('Add API Key').click();
    const keyDialog = page.getByRole('dialog', { name: 'Add API Key' });
    const keyInput = keyDialog.getByRole('textbox', { name: 'API Key', exact: true });
    assert.equal(await keyInput.evaluate(input => getComputedStyle(input).borderTopStyle), 'solid');
    await keyDialog.getByRole('button', { name: 'Generate', exact: true }).click();
    assert.ok((await keyInput.inputValue()).length > 0);
    const cancelKey = keyDialog.getByRole('button', { name: 'Cancel', exact: true });
    const keyBox = await keyInput.boundingBox();
    assert.ok((await cancelKey.boundingBox()).y > keyBox.y + keyBox.height);
    await cancelKey.click();

    await port.fill('70000');
    await save.click();
    assert.match(await config.getByRole('alert').textContent(), /Fix the highlighted settings/);
    assert.equal(await diff.count(), 0);
    await port.fill('9123');
    const search = config.getByRole('combobox', { name: 'Search settings (label or YAML key)' });
    await search.fill('port');
    await search.press('Enter');
    await config.locator('[aria-labelledby="mock-config-tab-connectivity"]').waitFor();
    assert.equal(await port.inputValue(), '9123');
    await search.fill('trusted-proxies');
    await search.press('Enter');
    await config.locator('#cfg-field-trustedProxies.mock-config-field-highlight').waitFor();

    await mode('Source').click();
    await yaml.waitFor();
    await config.locator('.cm-lineNumbers').waitFor();
    assert.ok(await config.locator('.cm-foldGutter').count());
    const materialized = await yamlText();
    assert.match(materialized, /port: 9123 # Local listener/);
    assert.match(materialized, /preview-extension:\s+keep-this: true # Not represented/);
    await yaml.fill(`${materialized}\ninvalid: [\n`);
    assert.equal(await mode('Visual').isDisabled(), true);
    assert.equal(await save.isDisabled(), true);
    assert.match(await config.getByRole('alert').textContent(), /YAML/);
    await yaml.fill(materialized.replace('9123', '9245'));
    const sourceSearch = config.getByRole('searchbox');
    await sourceSearch.fill('9245');
    await sourceSearch.press('Enter');
    assert.equal(await page.evaluate(() => window.getSelection().toString()), '9245');
    await mode('Visual').click();
    assert.equal(await port.inputValue(), '9245');

    await tab('payload').click();
    const payload = config.locator('#cfg-field-payloadDefaultRules');
    await payload.locator('summary').click();
    await payload.getByRole('button', { name: 'Add Rule', exact: true }).click();
    await payload.getByRole('button', { name: 'Add Model', exact: true }).click();
    await payload.locator('.input').first().fill('preview-model');
    await payload.getByRole('button', { name: 'Add Parameter', exact: true }).click();
    await payload.getByRole('textbox', { name: /^JSON Path/ }).fill('temperature');
    await payload.getByRole('textbox', { name: 'Parameter Value', exact: true }).fill('low');
    await payload.getByRole('button', { name: 'Add Rule', exact: true }).click();
    await payload.getByRole('button', { name: 'Delete', exact: true }).last().click();
    assert.equal(await payload.locator('.input').first().inputValue(), 'preview-model');

    await save.click();
    await diff.waitFor();
    assert.match(await diff.getByRole('alert').innerText(), /server\.port/);
    assert.match(await diff.locator('[data-change="removed"]').allTextContents().then(lines => lines.join('')), /8317/);
    assert.match(await diff.locator('[data-change="added"]').allTextContents().then(lines => lines.join('')), /9245/);
    assert.match(await diff.locator('[data-change="added"]').allTextContents().then(lines => lines.join('')), /preview-model/);
    await diff.getByRole('button', { name: 'Cancel', exact: true }).click();
    await save.click();
    await diff.getByRole('button', { name: 'Confirm Save', exact: true }).click();
    await save.waitFor({ state: 'hidden' });
    await quick.click();
    await management.click();
    assert.equal(await port.inputValue(), '9245');

    await port.fill('9456');
    await quick.click();
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await port.inputValue(), '9456');
    await button('Reload').click();
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    assert.equal(await port.inputValue(), '9245');
    await port.fill('9456');
    await button('Discard changes').click();
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    assert.equal(await port.inputValue(), '9245');
    await port.fill('9456');
    await quick.click();
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.locator('#config-subpage-panel').waitFor();
    await management.click();
    assert.equal(await port.inputValue(), '9245');
    await page.reload();
    await management.click();
    assert.equal(await port.inputValue(), '8317');
    await page.setViewportSize({ width: 390, height: 700 });
    await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
    await tab('payload').click();
    assert.equal(await config.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await mode('Source').click();
    const syntax = yaml.locator('.cm-line span').first();
    const lightColor = await syntax.evaluate(element => getComputedStyle(element).color);
    await page.evaluate(async () => (await import('/src/theme.ts')).initializeTheme().setPreference('dark'));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.waitForFunction(color => getComputedStyle(document.querySelector('.cm-line span')).color !== color, lightColor);
    assert.equal(await config.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.deepEqual(errors, []);

    await page.setViewportSize({ width: 1400, height: 900 });
    await mode('Visual').click();
    await tab('common').click();
    await port.fill('9420');
    await save.click();
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const current = await invoke('read_cpa_config_document', { revision: 0 });
      await invoke('save_cpa_config_document', { revision: 0, etag: current.etag, yaml: `${current.yaml}\n# concurrent edit\n`, remarks: [] });
    });
    await diff.getByRole('button', { name: 'Confirm Save', exact: true }).click();
    await config.getByText(/configuration changed on CPA/).waitFor();
    assert.equal(await port.inputValue(), '9420');
    assert.equal(await save.isDisabled(), true);
    await button('Read current version').click();
    await yaml.waitFor();
    assert.match(await yamlText(), /9420/);
    await save.click();
    assert.match(await diff.locator('[data-change="removed"]').allTextContents().then(lines => lines.join('')), /concurrent edit/);
    await page.evaluate(() => {
      const internals = window.__TAURI_INTERNALS__;
      const invoke = internals.invoke;
      internals.invoke = async (command, payload, options) => {
        const result = await invoke(command, payload, options);
        return command === 'save_cpa_config_document' ? { ...result, document: null } : result;
      };
    });
    await diff.getByRole('button', { name: 'Confirm Save', exact: true }).click();
    await config.getByText(/Configuration saved, but CPA could not be reached/).waitFor();
    assert.equal(await save.count(), 0);
    await button('Reload').click();
    await config.getByText('Configuration loaded', { exact: true }).waitFor();
    assert.match(await yamlText(), /9420/);

    await page.goto(`${base}/?mock=stopped`);
    await management.click();
    await config.getByText(/Start the built-in CPA core/).waitFor();
    await button('Start core').click();
    await port.waitFor();
    assert.equal(await port.inputValue(), '8317');

    const fileBeforeRemark = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('read_cpa_config_document', { revision: 0 }));
    await config.locator('#cfg-field-apiKeys').getByRole('button', { name: 'Edit', exact: true }).click();
    const editKey = page.getByRole('dialog', { name: 'Edit API Key' });
    await editKey.getByRole('textbox', { name: 'Name / description' }).fill('Desktop-only remark');
    await editKey.getByRole('button', { name: 'Update', exact: true }).click();
    await save.click();
    assert.equal(await diff.getByLabel('YAML diff').count(), 0);
    await diff.getByRole('button', { name: 'Confirm Save', exact: true }).click();
    await save.waitFor({ state: 'hidden' });
    const fileAfterRemark = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('read_cpa_config_document', { revision: 0 }));
    assert.equal(fileAfterRemark.etag, fileBeforeRemark.etag);
    assert.equal(fileAfterRemark.yaml, fileBeforeRemark.yaml);
    assert.deepEqual(fileAfterRemark.remarks, [{ key: 'preview-client', remark: 'Desktop-only remark' }]);

    await page.evaluate(() => {
      const internals = window.__TAURI_INTERNALS__;
      const invoke = internals.invoke;
      internals.invoke = async (command, payload, options) => {
        const result = await invoke(command, payload, options);
        return command === 'read_cpa_config_document' ? { ...result, etag: null } : result;
      };
    });
    await button('Reload').click();
    await config.getByText(/Editing is read-only/).waitFor();
    assert.equal(await port.isDisabled(), true);
    await mode('Source').click();
    await yaml.waitFor();
    assert.equal(await yaml.getAttribute('contenteditable'), 'false');

    await page.goto(`${base}/?mock=off`);
    await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0);
    assert.equal(await management.count(), 0);
    assert.equal(await config.count(), 0);
    assert.deepEqual(external, []);
    console.log('PASS: configuration form/YAML, connection warning, conflict review, saved-but-offline recovery, and stopped core.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
