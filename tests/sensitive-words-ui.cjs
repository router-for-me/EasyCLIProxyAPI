const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer: createPortProbe } = require('node:net');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const probe = createPortProbe();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    cacheDir: 'node_modules/.vite-sensitive-words-test', logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true, watch: null } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 640, height: 900 } });
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto(`${base}/?mock=running`);
    await page.addStyleTag({ content: '#browser-mock-toolbar { display: none; }' });
    await page.locator('.nav-section').getByRole('button', { name: 'Configuration Management', exact: true }).click();
    const config = page.locator('[data-config-management]');
    await config.locator('#mock-config-tab-advanced').click();
    const addRules = config.getByRole('button', { name: 'Add latest cloud rules' });
    await addRules.click();
    await config.getByText(/Cloud rules added to the draft/).waitFor();
    await addRules.click();
    await config.getByText('No new cloud rules to add.').waitFor();
    const readSaved = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('read_cpa_config_document', { revision: 0 }));
    assert.doesNotMatch((await readSaved()).yaml, /cloud-word/);
    await config.getByRole('button', { name: 'Save changes', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Review Changes' });
    assert.match(await review.getByLabel('YAML diff').innerText(), /cloud-word/);
    assert.match(await review.getByLabel('YAML diff').innerText(), /Devin Assistant/);
    await review.getByRole('button', { name: 'Confirm Save', exact: true }).click();
    await config.getByRole('button', { name: 'Save changes', exact: true }).waitFor({ state: 'hidden' });
    assert.match((await readSaved()).yaml, /cloud-word/);
    await page.close();
    console.log('PASS: cloud rules are deduplicated, staged in the configuration draft, reviewed, and saved.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
