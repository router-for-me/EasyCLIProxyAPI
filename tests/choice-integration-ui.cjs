const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const root = require('node:path').resolve(__dirname, '..');
const base = process.env.CHOICE_TEST_URL || 'http://127.0.0.1:1437';
(async () => {
 const browser = await chromium.launch({headless:true});
 try {
 const page = await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});
 page.setDefaultTimeout(12000);
 const errors=[];page.on('pageerror', e=>errors.push(String(e)));
 await page.addInitScript(()=>{localStorage.setItem('cpa-gui.agent-selected-client.v1','codex');localStorage.setItem('easy-cli-proxy-api.locale','zh-CN');});
 await page.route('**/*', route=>route.request().url().startsWith(base) ? route.continue() : route.abort());
 await page.goto(`${base}/?mock=running`);await page.locator('.app-shell').waitFor();
 const navigate=async id=>{await page.evaluate(id=>window.dispatchEvent(new CustomEvent('app:navigate',{detail:id})),id);await page.waitForTimeout(200);};
 let scenarios=0;
 const shotdir=process.env.CHOICE_SHOTS_DIR || `${root}/agent_docs/plans/shots/1.3`;fs.mkdirSync(shotdir,{recursive:true});
 for(const theme of ['light','dark','sakura-light','translucent']){
  await page.evaluate(async theme=>{
   const {initializeTheme}=await import('/src/theme.ts');initializeTheme().setPreference(theme==='translucent'?'dark':theme);
   if(theme==='translucent'){
    const {createThemeApplicator}=await import('/src/themes/applyTheme.ts');
    const {builtinThemes}=await import('/src/themes/registry.ts');
    createThemeApplicator(document,()=> 'vibrancy')({...builtinThemes.find(theme=>theme.id==='dark'),id:'mock-glass',windowMaterial:'translucent',tokens:{workspaceBackground:'#0E1A1F',windowMaterialWorkspaceOpacity:'72%',windowMaterialSidebarOpacity:'40%'}});
   }
  },theme);
  for(const [id,selector] of [['home','.home-protocol-tabs'],['config','.config-subpage-tabs'],['oauth','.oauth-subpage-tabs'],['usage-records','.usage-tabs'],['plugins','.plugin-tabs'],['agents','.agent-subpage-tabs']]){
   await navigate(id);await page.locator(selector).waitFor();
   if(id==='config')await page.locator('#config-subpage-tab-routing').click();
   if(id==='agents')await page.locator('.agent-auth-segmented').waitFor();
   await page.evaluate(async()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
   if(theme==='translucent'){
    assert.equal(await page.locator('.workspace').evaluate(el=>getComputedStyle(el).backgroundColor.match(/([\d.]+)\)$/)?.[1]),'0.72');
    assert.equal(await page.locator('.workspace .content').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
   }
   if (!process.env.CHOICE_SHOTS_ONLY || process.env.CHOICE_SHOTS_ONLY.split(',').includes(id)) await page.screenshot({path:`${shotdir}/${theme}-${id}.png`});scenarios++;
  }
 }
 await navigate('config');
 await page.locator('.config-settings-search input').fill('retry');
 await page.locator('#config-subpage-tab-requests').click();
 assert.equal(await page.locator('.config-settings-search input').inputValue(),'');
 await page.locator('#config-group-request-behavior').waitFor();scenarios++;
 await page.locator('.config-settings-search input').fill('retry');
 await page.locator('#config-subpage-tab-requests').focus();await page.keyboard.press('Home');
 await page.waitForFunction(()=>document.activeElement?.id==='config-subpage-tab-general');
 assert.equal(await page.locator('.config-settings-search input').inputValue(),'');scenarios++;
 await navigate('oauth');
 await page.locator('.oauth-account-count.has-accounts').first().click();
 const provider=page.locator('.auth-files-filters select').first(); assert.notEqual(await provider.inputValue(),'all');
 await page.locator('#oauth-subpage-tab-authFiles').focus();await page.keyboard.press('ArrowLeft');
 await page.waitForFunction(()=>document.activeElement?.id==='oauth-subpage-tab-login');await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>document.querySelector('.auth-files-filters select')?.value==='all');scenarios++;
 await navigate('plugins');
 await page.locator('#plugin-tab-store').click();
 await page.locator('.plugin-search input').fill('missing');
 await page.locator('.plugin-toolbar select').selectOption('updates');
 await page.locator('#plugin-tab-store').focus();await page.keyboard.press('Home');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.activeElement?.id==='plugin-tab-installed');
 assert.equal(await page.locator('.plugin-search input').inputValue(),'');
 scenarios++;
 await page.goto(`${base}/tests/fixtures/plugins.html?empty-installed`);
 await page.locator('#plugin-tab-store').click();
 await page.locator('.plugin-toolbar select').selectOption('updates');
 await page.locator('#plugin-tab-store').focus();await page.keyboard.press('Home');await page.keyboard.press('Enter');
 await page.locator('.plugin-empty .empty-state-title').waitFor();
 assert.equal(await page.locator('.plugin-empty .empty-state-title').innerText(),'No plugins yet','Home activation must clear the filter before any later tab activation');scenarios++;
 await page.goto(`${base}/?mock=running`);await page.locator('.app-shell').waitFor();
 await navigate('usage-records');await page.locator('#usage-tab-overview').focus();await page.keyboard.press('End');
 await page.waitForFunction(()=>document.querySelector('.usage-records-page')?.getAttribute('data-active-tab')==='data-management');
 assert.equal(await page.locator('.usage-filter-panel').count(),0);
 assert.equal(await page.evaluate(()=>localStorage.getItem('cpa-gui.usage-records-tab.v1')),'data-management');scenarios++;
 await navigate('quota');
 const quota=page.locator('.quota-category-filter');await quota.getByRole('radio').first().focus();await page.keyboard.press('ArrowDown');
 assert.equal(await quota.getByRole('radio').nth(1).getAttribute('aria-checked'),'true');scenarios++;
 await page.locator('.theme-selector-trigger:visible').click();
 assert.equal(await page.locator('.theme-selector-menu').evaluate(element => { const color=getComputedStyle(element).backgroundColor; return color.startsWith('rgba') ? Number(color.match(/([\d.]+)\)$/)[1]) : 1; }),1);
 const modes=page.locator('.theme-selector-modes');await modes.getByRole('radio').first().focus();await page.keyboard.press('End');
 assert.equal(await modes.getByRole('radio').last().getAttribute('aria-checked'),'true');scenarios++;
 for (const embedded of [false, true]) {
  await page.goto(`${base}/tests/fixtures/agent-backups.html?client=codex&reset-selections${embedded ? '&embedded' : ''}`);
  const tabs = page.locator('.agent-subpage-tabs');
  const last = tabs.getByRole('tab').last();
  await last.click();
  await last.focus();await page.keyboard.press('Home');
  await page.waitForFunction(()=>document.activeElement===document.getElementById('agent-subpage-tab-core'));
  assert.equal(await tabs.getByRole('tab').first().getAttribute('aria-selected'),'true');scenarios++;
  await page.keyboard.press('End');
  await page.waitForFunction(()=>document.activeElement===document.querySelector('.agent-subpage-tabs [role=tab]:last-child'));
  assert.equal(await last.getAttribute('aria-selected'),'true');scenarios++;
 }
 await page.goto(`${base}/tests/fixtures/agent-backups.html?client=codex&no-oauth-login`);
 const auth=page.locator('.agent-auth-segmented');
 await auth.getByRole('radio').first().focus();await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>window.fixtureCalls.some(call=>call.cmd==='check_codex_oauth_login') && !document.querySelector('.agent-auth-segmented button')?.disabled);
 assert.equal(await auth.getByRole('radio').first().getAttribute('aria-checked'),'true');
 const loginDialog=page.getByRole('alertdialog');await loginDialog.waitFor();
 await page.waitForFunction(()=>document.activeElement?.closest('[role=alertdialog]'));
 await loginDialog.getByRole('button',{name:'我知道了',exact:true}).click();await loginDialog.waitFor({state:'detached'});scenarios++;
 await page.evaluate(()=>{window.fixtureOauthLoggedIn=true;});
 await auth.getByRole('radio').first().focus();await page.keyboard.press('End');
 await page.waitForFunction(()=>document.querySelector('.agent-auth-segmented [aria-checked="true"]')?.getAttribute('data-value')==='oauth');
 assert.equal(await auth.getByRole('radio').last().evaluate(el=>document.activeElement===el),true);scenarios++;
 assert.deepEqual(errors, []);
 console.log(`Choice integration: ${scenarios} scenarios passed`);
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
