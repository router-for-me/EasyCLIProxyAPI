const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 1424, strictPort: true } });
  let browser;
  try {
    await server.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('easy-cli-proxy-api.locale', 'en'));
    await page.goto('http://127.0.0.1:1424/?mock=running');
    await page.getByRole('button', { name: 'Connected apps', exact: true }).click();
    await page.getByRole('button', { name: 'Import JSON', exact: true }).waitFor();
    await page.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.applies = 0;
      window.__TAURI_INTERNALS__.invoke = async (command, args, ...rest) => {
        if (command === 'update_agent_config') window.applies++;
        if (command === 'export_desktop_model_preset') window.exportedPreset = args.content;
        return original(command, args, ...rest);
      };
    });
    const preset = { format: 'tim-ai-hub.desktop-models', version: 1, client: 'claude-desktop', models: [
      { model: 'claude-sonnet-5', alias: '', context1m: false },
      { model: 'gemini-3.1-pro-low', alias: 'claude-custom-1', context1m: false },
    ] };
    const file = { name: 'models.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(preset)) };
    const input = page.locator('.model-preset-controls input[type=file]');
    const rows = page.locator('.agent-desktop-model-row');
    const count = await rows.count();
    await input.setInputFiles(file);
    await page.getByText('Review 2 models', { exact: true }).waitFor();
    assert.equal(await rows.count(), count, 'Preview must not replace the draft');
    await page.locator('.model-preset-preview').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await rows.count(), count);
    await input.setInputFiles(file);
    await page.getByRole('button', { name: 'Replace editor list', exact: true }).click();
    assert.equal(await rows.count(), 2);
    await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
    await page.getByText('Model configuration exported.', { exact: true }).waitFor();
    assert.deepEqual(JSON.parse(await page.evaluate(() => window.exportedPreset)), preset);
    const missingPreset = { ...preset, models: [...preset.models, { model: 'kimi-k3', alias: 'claude-custom-7', context1m: false }] };
    await input.setInputFiles({ ...file, buffer: Buffer.from(JSON.stringify(missingPreset)) });
    await page.locator('.model-preset-preview').getByRole('status').filter({ hasText: 'Row 3: “kimi-k3”' }).waitFor();
    assert.equal(await rows.count(), 2, 'Missing model preview preserves existing draft');
    await page.getByRole('button', { name: 'Replace editor list', exact: true }).click();
    await rows.nth(2).getByRole('status').filter({ hasText: 'Row 3: “kimi-k3”' }).waitFor();
    await rows.nth(2).getByRole('button', { name: /Remove/ }).click();
    assert.equal(await rows.count(), 2, 'Only explicitly removed model is discarded');
    await input.setInputFiles({ ...file, buffer: Buffer.from('{invalid') });
    await page.getByRole('status').filter({ hasText: 'Invalid model configuration.' }).waitFor();
    assert.equal(await rows.count(), 2, 'Invalid imports must preserve draft');
    assert.equal(await page.evaluate(() => window.applies), 0, 'Import must not apply to Desktop');
    await page.setViewportSize({ width: 640, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    console.log('PASS: import preview, cancel, replace, export round trip, invalid file preservation, no automatic apply, compact layout.');
  } finally { if (browser) await browser.close(); await server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
