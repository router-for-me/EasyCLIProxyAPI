// Run Vite on port 1421, then node tests/usage-effort-fallback-ui.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:1421';
const screenshotPath = process.env.USAGE_EFFORT_SCREENSHOT || '/tmp/ecpa_usage-effort-auto-fallback-1108_ui_usage.png';

(async () => {
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : process.env.PLAYWRIGHT_CHANNEL
        ? { channel: process.env.PLAYWRIGHT_CHANNEL }
        : {}),
    headless: true,
    args: ['--no-proxy-server'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    const open = async (locale = 'zh-CN') => {
      await page.goto(`${base}/tests/fixtures/usage-effort-auto-fallback.html?locale=${encodeURIComponent(locale)}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.usage-td-model').first().waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
    };
    const modelDetails = () => page.locator('.usage-td-model').evaluateAll(cells => cells.map(cell => ({
      effortText: cell.querySelector(':scope > .usage-model-badges > .usage-model-effort')?.textContent || '',
      effortTitle: cell.querySelector(':scope > .usage-model-badges > .usage-model-effort')?.getAttribute('title') ?? null,
      cellTitle: cell.getAttribute('title') ?? null,
      text: cell.textContent || '',
    })));

    await open('zh-CN');
    assert.equal(await page.locator('.usage-td-model').count(), 10, 'Every fixture record renders a model cell');
    const zh = await modelDetails();
    const effortLine = details => details.cellTitle.split('\n').find(line => line.startsWith('推理强度: '));

    for (const index of [0, 1]) {
      assert.equal(zh[index].effortText, 'auto', `Missing/whitespace effort case ${index}: badge falls back to auto`);
      assert.equal(zh[index].effortTitle, 'auto', `Missing/whitespace effort case ${index}: badge tooltip shows auto`);
      assert.equal(effortLine(zh[index]), '推理强度: auto', `Missing/whitespace effort case ${index}: row tooltip shows auto`);
      assert.equal(zh[index].text.includes('未记录'), false, `Missing/whitespace effort case ${index}: no unrecorded label remains`);
    }

    const expected = ['auto', 'auto', 'auto', 'high', 'max', 'none', 'off', 'high', 'high', 'high'];
    zh.forEach((details, index) => {
      assert.equal(details.effortText, expected[index], `Case ${index}: rendered effort badge is unchanged`);
      assert.equal(details.effortTitle, expected[index], `Case ${index}: effort badge tooltip is unchanged`);
      assert.equal(effortLine(details), `推理强度: ${expected[index]}`, `Case ${index}: row tooltip effort is unchanged`);
    });
    assert.equal(zh[7].text.includes('gemini-3.8-flash-high'), true, 'Alias-inferred tier keeps its recorded alias');
    assert.equal(zh[8].text.includes('gpt-5.1-high'), true, 'Model-suffix-inferred tier keeps its routed model');
    assert.equal(zh[9].text.includes('gemini-3.8-flash-high'), true, 'Whitespace effort still infers the alias tier');

    await open('en');
    const en = await modelDetails();
    assert.deepEqual(en.map(details => details.effortText), expected, 'English locale keeps the same effort badges');
    assert.equal(en[0].cellTitle.split('\n').find(line => line.startsWith('Reasoning Effort: ')), 'Reasoning Effort: auto', 'English tooltip shows auto');
    assert.equal(en[0].text.includes('Unrecorded'), false, 'English locale no longer shows the unrecorded label');

    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.locator('.usage-table-wrap').screenshot({ path: screenshotPath });

    assert.deepEqual(errors, [], 'Effort fallback rendering produces no runtime errors');
    console.log(`PASS: missing/whitespace effort renders as auto in badges and tooltips while recorded and inferred tiers stay unchanged (${screenshotPath}).`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
