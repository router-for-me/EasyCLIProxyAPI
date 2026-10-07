const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ root:path.resolve(__dirname,'..'), configFile:false, plugins:[react()], logLevel:'error', server:{host:'127.0.0.1',port:1428,strictPort:true} });
  let browser;
  try {
    await server.listen();
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>localStorage.setItem('easy-cli-proxy-api.locale','en'));
    await page.goto('http://127.0.0.1:1428/?mock=running');
    await page.waitForFunction(()=>document.querySelector('.quota-refresh')&&!document.querySelector('.quota-refresh').disabled);
    await page.evaluate(()=>{
      const original=window.__TAURI_INTERNALS__.invoke;
      window.groupFractions=[1,1];
      window.__TAURI_INTERNALS__.invoke=async(command,args,...rest)=>{
        const req=args?.request;
        if(command==='management_request'&&req?.path==='/credentials'&&req.method==='GET') return {files:[{name:'antigravity-test.json',auth_index:'group-test',provider:'antigravity',status:'active',project_id:'test-project'}]};
        if(command==='management_request'&&req?.path==='/requests/api-call'&&req.body?.authIndex==='group-test') return {status_code:200,body:{groups:window.groupFractions.map((fraction,i)=>({displayName:i?'Claude/GPT':'Gemini',buckets:[{remainingFraction:fraction,window:'weekly',resetTime:new Date(Date.now()+(i+1)*86400000).toISOString()}]}))}};
        return original(command,args,...rest);
      };
    });
    await page.getByRole('button',{name:'Refresh accounts',exact:true}).click();
    const summary=page.locator('.quota-provider-summary-cell');
    await page.waitForFunction(()=>document.querySelector('.quota-provider-groups')?.textContent.includes('Claude/GPT'));
    assert.equal(await summary.locator('.quota-summary-value').innerText(),'2');
    assert.match(await summary.innerText(),/of 2 reported groups available/);
    for(const [fractions,expected,blocked] of [[[1,0],'1',1],[[0,0],'0',2],[[null,null],'—',0]]) {
      await page.evaluate(values=>{window.groupFractions=values},fractions);
      await page.locator('.quota-refresh').click();
      await page.waitForFunction(()=>!document.querySelector('.quota-refresh').disabled);
      assert.equal(await summary.locator('.quota-summary-value').innerText(),expected);
      assert.equal(await summary.locator('.quota-provider-groups .quota-availability-exhausted').count(),blocked);
    }
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No mobile horizontal overflow');
    assert.deepEqual(errors,[]);
    console.log('PASS Antigravity available, partial, exhausted, unknown and mobile UI');
  } finally { await browser?.close(); await server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
