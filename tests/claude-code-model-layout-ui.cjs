// Run Vite on port 1421, or set AGENT_MODEL_LAYOUT_TEST_URL to another local server.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const base = process.env.AGENT_MODEL_LAYOUT_TEST_URL || 'http://127.0.0.1:1421';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    for (const locale of ['zh-CN', 'en', 'ja']) {
      for (const theme of ['light', 'dark']) {
        for (const width of [1392, 1100, 760, 480]) {
          await page.setViewportSize({ width, height: 962 });
          await page.goto(`${base}/tests/fixtures/agent-backups.html?client=claude-code&reset-selections&shell&claude-alias-layout&locale=${locale}&theme=${theme}`);
          await page.locator('.claude-role-row[data-role=sonnet] .agent-model-trigger small').waitFor();
          await page.evaluate(() => document.fonts.ready);
          const issues = await page.locator('.claude-role-table').evaluate(table => {
            const issues = [];
            for (const row of table.querySelectorAll('.claude-role-row')) {
              const trigger = row.querySelector('.agent-model-trigger');
              const bounds = trigger.getBoundingClientRect();
              for (const text of trigger.querySelectorAll('strong, small')) {
                const rect = text.getBoundingClientRect();
                if (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1
                  || rect.left < bounds.left - 1 || rect.right > bounds.right + 1) {
                  issues.push(`${row.dataset.role}: model text exceeds the selector`);
                }
              }
              const next = row.nextElementSibling?.getBoundingClientRect();
              if (next && bounds.bottom > next.top + 1) issues.push(`${row.dataset.role}: selector overlaps the next row`);
              if (row.scrollWidth > row.clientWidth + 1) issues.push(`${row.dataset.role}: horizontal overflow`);
              const toggle = row.querySelector('.claude-inline-context').getBoundingClientRect();
              if (bounds.right > toggle.left + 1) issues.push(`${row.dataset.role}: selector overlaps the context switch`);
            }
            return issues;
          });
          assert.deepEqual(issues, [], `${locale}/${theme}/${width}`);
          if (locale === 'zh-CN' && theme === 'light' && [1392, 480].includes(width)) {
            await page.screenshot({ path: path.join(os.tmpdir(), `claude-code-model-layout-${width}.png`), fullPage: true });
          }
        }
      }
    }
    await page.setViewportSize({ width: 1392, height: 962 });
    await page.goto(`${base}/tests/fixtures/agent-backups.html?client=claude-code&reset-selections&shell&claude-alias-layout`);
    const sonnet = page.locator('.claude-role-row[data-role=sonnet]');
    await sonnet.locator('.agent-model-trigger small').waitFor();
    await page.locator('.agent-claude-desktop-mapping-filter input').check();
    const trigger = sonnet.locator('.agent-model-trigger');
    await trigger.click();
    await page.getByRole('option', { name: /^gpt-6\.1-sol / }).click();
    assert.equal(await trigger.locator('small').count(), 0);
    await trigger.focus();
    await trigger.press('Enter');
    await sonnet.locator('.agent-model-search input').fill('high-fast');
    await page.getByRole('option', { name: /^gpt-6.1-sol-high-fast / }).click();
    assert.equal(await trigger.locator('small').innerText(), 'gpt-6.1-sol');
    await page.getByRole('switch', { name: 'sonnet 1M', exact: true }).check();
    await page.getByRole('button', { name: '更新配置', exact: true }).click();
    await page.waitForFunction(() => window.fixtureCalls.some(call => call.cmd === 'update_agent_config'
      && call.args.claudeCodeModelMappings.sonnet === 'gpt-6.1-sol-high-fast'
      && call.args.claudeCodeModelMappings.sonnet1m === true));
    assert.deepEqual(errors, []);
    console.log('PASS: 24 viewport/language/theme layouts, alias selection, keyboard search, context toggle and configuration update');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
