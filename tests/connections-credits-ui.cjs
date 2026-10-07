const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile:false, root:path.resolve(__dirname,'..'), plugins:[react()], logLevel:'error', server:{host:'127.0.0.1',port:1436,strictPort:true} });
  let browser;
  try {
    await server.listen(); browser = await chromium.launch({channel:'msedge',headless:true});
    const page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    page.setDefaultTimeout(10000);
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>localStorage.setItem('easy-cli-proxy-api.locale','en'));
    await page.goto('http://127.0.0.1:1436/?mock=running');
    await page.waitForFunction(()=>document.querySelector('.quota-refresh')&&!document.querySelector('.quota-refresh').disabled);
    await page.evaluate(()=>{
      const original=window.__TAURI_INTERNALS__.invoke;
      window.connectionMode='configured'; window.writes=[];
      window.__TAURI_INTERNALS__.invoke=async(command,args,...rest)=>{
        const request=args?.request;
        if (/apply_agent|redeem|write_agent/.test(command)) window.writes.push(command);
        if(command==='management_request'&&request?.path==='/requests/api-call'&&request.body?.url?.includes('wham/usage')) return {status_code:200,body:{rate_limit:{allowed:false,limit_reached:true,primary_window:{used_percent:100,limit_window_seconds:604800,reset_after_seconds:420000}},credits:{has_credits:true,balance:'849.89',overage_limit_reached:false}}};
        if(command==='get_usage_events')return {items:window.connectionMode==='verified'?[{timestamp:new Date().toISOString(),auth_index:'mock-codex-1',model:'test-model',user_agent:'claude-desktop/1',failed:false,canceled:false}]:[]};
        const result=await original(command,args,...rest);
        if(/^(get|refresh)_agent_config_statuses$/.test(command)) return result.map(s=>({...s,installed:window.connectionMode!=='notDetected',configValid:window.connectionMode!=='attention',connectionState:window.connectionMode==='detected'?'not-configured':'configured',codexNativeOauth:false,error:window.connectionMode==='attention'?'Fixture: malformed configuration':null}));
        return result;
      };
    });
    await page.locator('.quota-refresh').click();
    const codex=page.locator('.ad-card').filter({hasText:'codex-personal.json'});
    await codex.locator('.quota-availability strong').filter({hasText:'Included quota used · credits available'}).waitFor();
    assert.ok((await codex.innerText()).includes('849.89 credits reported'));
    assert.ok(!(await codex.innerText()).includes('Blocked for'));
    assert.ok((await codex.innerText()).includes('0% left'));
    await codex.locator('summary').click();
    await codex.getByLabel('Friendly name').fill('My work account');
    await codex.getByRole('button',{name:'Save name',exact:true}).click();
    const nav=page.getByRole('navigation',{name:'Main navigation'});
    await nav.getByRole('button',{name:'Accounts',exact:true}).click();
    await page.locator('.auth-card-identity strong').filter({hasText:'My work account'}).waitFor();
    await nav.getByRole('button',{name:'Connected apps',exact:true}).click();
    await page.locator('.connection-overview h2').getByText('Configured',{exact:true}).waitFor();
    const refresh=page.locator('.agent-header-actions button').last();
    for(const [mode,text] of [['verified','Recent request verified'],['attention','Needs attention'],['notDetected','App not detected'],['detected','Detected'],['configured','Configured']]) {
      await page.evaluate(mode=>{window.connectionMode=mode},mode);await refresh.click();
      await page.locator('.connection-overview h2').getByText(text,{exact:true}).waitFor();
      if(mode==='verified') await page.locator('.connection-evidence').getByText('test-model · My work account',{exact:true}).waitFor();
      if(mode==='attention') {
        assert.equal(await page.locator('.connection-error pre').isVisible(),false);
        await page.locator('.connection-error summary').click();
        assert.equal(await page.locator('.connection-error pre').innerText(),'Fixture: malformed configuration');
      }
    }
    await page.getByRole('button',{name:'Review configuration',exact:true}).click();
    assert.equal(await page.evaluate(()=>Boolean(document.activeElement?.closest('.agent-core-config'))),true);
    await page.locator('.connection-overview').scrollIntoViewIfNeeded();
    for(const theme of ['Light','Dark']) {
      await page.getByRole('button',{name:theme,exact:true}).click();
      if(process.env.UI_OUTPUT)await page.screenshot({path:path.join(process.env.UI_OUTPUT,`connected-apps-${theme.toLowerCase()}.png`)});
      for(const width of [1440,960,640]) {
        await page.setViewportSize({width,height:1000});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${theme} overflow at ${width}`);
      }
      await page.setViewportSize({width:1440,height:1000});
    }
    assert.deepEqual(await page.evaluate(()=>window.writes),[],'Inspection must not change integrations or redeem credits');
    assert.deepEqual(errors,[]);
    console.log('PASS: credit-backed Codex; real 0% allowance retained; shared names; connection stages and request evidence; action focus; light/dark and responsive; no writes/errors.');
  } finally {await browser?.close();await server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
