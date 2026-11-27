// Sidebar navigation helper for UI tests.
//
// The sidebar groups related pages under one entry ("hub"). Only the hub that
// contains the current page shows its pages; clicking a hub opens its first
// available page. `openNav` clicks a page by its visible label, opening the
// owning hub first when the page row is not on screen yet.

const HUBS = [
  { labels: ['接入与路由', 'Access & Routing'], pages: ['API 接入', 'API Access', '路由编排', 'Routing'] },
  { labels: ['凭证与额度', 'Credentials & Quota'], pages: ['OAuth', '额度查询', 'Quota Lookup'] },
  { labels: ['智能体', 'Agents'], pages: ['智能体配置', 'Agent Configuration', 'MCP与Skills', 'MCP & Skills'] },
  { labels: ['用量统计', 'Usage Stats'], pages: ['使用记录', 'Usage', 'Agent 使用记录', 'Agent Usage'] },
  {
    labels: ['设置', 'Settings'],
    pages: ['快捷配置', 'Quick Configuration', '配置面板', 'Configuration Management', '版本管理', 'Version Management'],
  },
];

function hubFor(name) {
  return HUBS.find((hub) => hub.pages.includes(name));
}

function navButton(page, name) {
  return page.locator('.nav-section').getByRole('button', { name, exact: true });
}

async function openNav(page, name) {
  // Wait for the sidebar to render before deciding whether the row is on screen.
  await page.locator('.nav-section button').first().waitFor();
  const direct = navButton(page, name);
  if ((await direct.count()) === 0 || !(await direct.first().isVisible())) {
    const hub = hubFor(name);
    if (hub) {
      const hubButton = page
        .locator('.nav-section button.nav-hub-toggle')
        .filter({ has: page.locator('span', { hasText: new RegExp(`^(${hub.labels.map(escapeRegExp).join('|')})$`) }) });
      await hubButton.first().click();
    }
  }
  await direct.first().click();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { HUBS, hubFor, navButton, openNav };
