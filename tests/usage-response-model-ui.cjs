// Run Vite on port 1421, then node tests/usage-response-model-ui.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:1421';
const locales = {
  'zh-CN': { request: '请求模型', upstream: '路由模型', response: '响应模型' },
  en: { request: 'Requested model', upstream: 'Routed model', response: 'Response model' },
  ja: { request: 'リクエストモデル', upstream: 'ルーティングモデル', response: '応答モデル' },
  'zh-TW': { request: '請求模型', upstream: '路由模型', response: '響應模型' },
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell === '') {
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    const open = async (locale = 'zh-CN', theme = 'light') => {
      await page.goto(`${base}/tests/fixtures/usage-response-model.html?locale=${encodeURIComponent(locale)}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.usage-td-model').first().waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
    };
    const modelCells = () => page.locator('.usage-td-model');
    const modelDetails = () => modelCells().evaluateAll(cells => cells.map(cell => ({
      main: cell.querySelector(':scope > strong')?.textContent || '',
      sublines: Array.from(cell.querySelectorAll(':scope > small')).map(item => item.textContent || ''),
      response: cell.querySelector(':scope > .usage-response-model')?.textContent || '',
      title: cell.getAttribute('title')?.split('\n').slice(0, 3).join('\n') ?? null,
    })));
    const assertNoHorizontalPageOverflow = async (label) => {
      const dimensions = await page.evaluate(() => ({
        htmlWidth: document.documentElement.clientWidth,
        htmlScrollWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        tableViewport: document.querySelector('.usage-table-wrap')?.clientWidth || 0,
        tableContent: document.querySelector('.usage-table-wrap')?.scrollWidth || 0,
      }));
      assert.ok(dimensions.htmlScrollWidth <= dimensions.htmlWidth + 1, `${label}: document does not overflow horizontally`);
      assert.ok(dimensions.bodyScrollWidth <= dimensions.bodyWidth + 1, `${label}: body does not overflow horizontally`);
      return dimensions;
    };

    await open('zh-CN');
    assert.equal(await modelCells().count(), 9, 'Every fixture record renders a model cell');
    assert.deepEqual(await page.locator('.usage-model-fast').allTextContents(), ['fast', 'fast'], 'Only priority and fast request tiers show a badge');
    assert.equal(await modelCells().nth(2).locator('.usage-model-fast').count(), 0, 'Default request tier has no badge');
    const badgePositions = await modelCells().first().locator('.usage-model-badges > small').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
    assert.ok(Math.abs(badgePositions[0] - badgePositions[1]) < 2, 'Fast badge stays beside reasoning effort');
    const badgeAlignment = await modelCells().first().evaluate(cell => {
      const cellBounds = cell.getBoundingClientRect();
      const badgesBounds = cell.querySelector('.usage-model-badges').getBoundingClientRect();
      const badges = Array.from(cell.querySelectorAll('.usage-model-badges > small'));
      const left = badges[0].getBoundingClientRect().left;
      const right = badges.at(-1).getBoundingClientRect().right;
      return { cellCenter: cellBounds.left + cellBounds.width / 2, badgesCenter: (left + right) / 2, containerCenter: badgesBounds.left + badgesBounds.width / 2 };
    });
    assert.ok(Math.abs(badgeAlignment.badgesCenter - badgeAlignment.cellCenter) < 2, 'The badge group is centered in the model cell');
    const zhDetails = await modelDetails();
    assert.equal(await page.locator('.usage-th-effort').count(), 1, 'Migration enables reasoning effort for existing layouts');
    assert.equal(await page.locator('.usage-td-request').first().textContent(), '/v1/responses');
    assert.equal(await page.locator('.usage-td-request').first().getAttribute('title'), '/v1/responses');
    assert.match(await modelCells().first().getAttribute('title'), /response_model.*上游声明/);
    assert.deepEqual(await page.locator('.usage-events-table th').evaluateAll(cells => cells.slice(0, 2).map(cell => cell.className.split(' ')[0])), ['usage-th-time', 'usage-th-provider']);
    assert.equal(await page.locator('.usage-td-provider strong').first().textContent(), 'Codex');
    assert.equal(await page.locator('.usage-access-type').first().textContent(), 'API');
    assert.equal(await page.locator('.usage-access-type').nth(1).textContent(), 'OAuth');
    assert.equal(await page.locator('.usage-access-type').nth(2).textContent(), '未记录接入方式');
    assert.deepEqual(zhDetails[0], {
      main: 'astra',
      sublines: ['gpt-6-astra', '响应模型: gpt-5.6-luna'],
      response: '响应模型: gpt-5.6-luna',
      title: '请求模型: astra\n路由模型: gpt-6-astra\n响应模型: gpt-5.6-luna',
    }, 'Differing alias, upstream model, and upstream response remain distinguishable');
    assert.deepEqual(zhDetails[1], {
      main: 'same-alias',
      sublines: ['gpt-6-sol'],
      response: '',
      title: '请求模型: same-alias\n路由模型: gpt-6-sol',
    }, 'A response equal to the routed model is not repeated');
    assert.deepEqual(zhDetails[2].sublines, ['openai/gpt-4o-latest', '响应模型: gpt-4o-2024-08-06'], 'Snapshot and prefix model names preserve the existing upstream subline');
    assert.equal(zhDetails[2].title, '请求模型: gpt4o\n路由模型: openai/gpt-4o-latest\n响应模型: gpt-4o-2024-08-06');
    assert.deepEqual(zhDetails.slice(3, 6).map(item => item.sublines), [[], [], []], 'Missing, empty, and whitespace response_model values stay omitted');
    assert.ok(zhDetails.slice(3, 6).every(item => !item.title.includes('响应模型')), 'Legacy rows never invent a response model');
    assert.equal(await page.locator('.usage-model-mismatch').count(), 5, 'Only responses different from the routed model are flagged');
    assert.equal(await page.locator('.usage-td-cost strong').first().textContent(), '$0.0042');
    assert.equal(await page.locator('.usage-td-cost strong').nth(1).textContent(), '$0.00');
    assert.equal(await page.locator('.usage-td-cost').nth(2).locator('small').textContent(), '未定价');
    await assertNoHorizontalPageOverflow('desktop');
    for (const child of await modelCells().first().locator(':scope > strong, :scope > small').all()) {
      assert.equal((await child.getAttribute('title')).split('\n').slice(0, 3).join('\n'), zhDetails[0].title, 'Hovering each line exposes the full three-model title');
    }
    const longLine = await modelCells().nth(6).locator('.usage-response-model').evaluate(element => ({
      truncated: element.scrollWidth > element.clientWidth,
      overflow: getComputedStyle(element).textOverflow,
      title: element.title,
    }));
    assert.equal(longLine.truncated, true, 'Long response names stay within the model column');
    assert.equal(longLine.overflow, 'ellipsis', 'Long response names are visibly ellipsized');
    assert.ok(longLine.title.includes(`response-${'r'.repeat(120)}`), 'The complete long response remains available in the title');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出本页 CSV', exact: true }).click();
    const download = await downloadPromise;
    const csvPath = await download.path();
    assert.ok(csvPath, 'CSV export creates a download');
    const csv = await fs.promises.readFile(csvPath, 'utf8');
    const csvRows = parseCsv(csv.replace(/^\uFEFF/, ''));
    const header = csvRows[0];
    const aliasIndex = header.indexOf('alias');
    const responseIndex = header.indexOf('response_model');
    assert.equal(responseIndex, aliasIndex + 1, 'response_model is immediately after alias in CSV');
    const csvById = new Map(csvRows.slice(1).map(row => [row[0], row]));
    assert.equal(csvById.get('differing')[header.indexOf('estimated_cost_usd')], '0.0042');
    assert.equal(csvById.get('matching')[header.indexOf('estimated_cost_usd')], '0');
    assert.equal(csvById.get('missing')[header.indexOf('estimated_cost_usd')], '');
    assert.equal(csvById.get('differing')[responseIndex], 'gpt-5.6-luna', 'CSV preserves a regular response model');
    assert.equal(csvById.get('matching')[responseIndex], 'gpt-6-sol', 'CSV preserves a response equal to model');
    assert.equal(csvById.get('missing')[responseIndex], '', 'CSV preserves an empty legacy response field');
    assert.equal(csvById.get('empty')[responseIndex], '', 'CSV preserves an explicitly empty response field');
    assert.equal(csvById.get('whitespace')[responseIndex], '   ', 'CSV preserves nonempty whitespace exactly');
    assert.equal(csvById.get('quoted')[responseIndex], 'model,"quoted"', 'CSV escapes quotes and commas in response_model');
    assert.equal(csvById.get('formula')[responseIndex], "'=SUM(A1)", 'CSV formula mitigation protects response_model values');

    for (const [locale, labels] of Object.entries(locales)) {
      await open(locale);
      const details = await modelDetails();
      assert.equal(details[0].response, `${labels.response}: gpt-5.6-luna`, `${locale}: response line is localized`);
      assert.equal(details[0].title, `${labels.request}: astra\n${labels.upstream}: gpt-6-astra\n${labels.response}: gpt-5.6-luna`, `${locale}: model title localizes all three labels`);
    }

    for (const [theme, color] of [['light', 'rgb(154, 88, 8)'], ['dark', 'rgb(240, 188, 115)']]) {
      await open('zh-CN', theme);
      assert.equal(await modelCells().first().locator('.usage-response-model').evaluate(element => getComputedStyle(element).color), color, `${theme}: response line uses the theme's mismatch text color`);
      if (process.env.USAGE_RESPONSE_MODEL_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.USAGE_RESPONSE_MODEL_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.USAGE_RESPONSE_MODEL_SCREENSHOT_DIR, `response-model-${theme}.png`) });
      }
    }

    await page.setViewportSize({ width: 390, height: 850 });
    await open('zh-CN');
    const narrow = await assertNoHorizontalPageOverflow('narrow');
    assert.ok(narrow.tableContent > narrow.tableViewport, 'Narrow viewport keeps wide usage columns inside a scrollable table');
    assert.equal(await page.locator('.usage-table-top-scrollbar').count(), 1, 'Narrow viewport renders the synchronized top scrollbar');
    assert.ok(await page.locator('.usage-td-model').nth(6).boundingBox(), 'Long model names remain visible in the narrow model cell');
    assert.deepEqual(errors, [], 'Response model interactions produce no runtime errors');
    console.log('PASS: response-model rendering, titles/locales, CSV ordering/escaping/formula mitigation, legacy omission, and desktop/narrow geometry.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
