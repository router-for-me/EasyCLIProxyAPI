const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async()=>{
 const {createServer}=await import('vite'); const react=(await import('@vitejs/plugin-react')).default;
 const server=await createServer({configFile:false,root:path.resolve(__dirname,'..'),plugins:[react()],logLevel:'error',server:{host:'127.0.0.1',port:1437,strictPort:true}});let browser;
 try{
  await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('easy-cli-proxy-api.locale','en'));
  await page.goto('http://127.0.0.1:1437/?mock=running');await page.waitForFunction(()=>document.querySelector('.quota-refresh')&&!document.querySelector('.quota-refresh').disabled);
  await page.evaluate(()=>{
   const original=window.__TAURI_INTERNALS__.invoke;window.uxWrites=[];window.uxItems=[];window.uxFail=false;
   window.__TAURI_INTERNALS__.invoke=async(command,args,...rest)=>{
    if(command==='get_usage_events'){if(window.uxFail)throw new Error('test unavailable');return {items:window.uxItems};}
    if(command==='management_request'&&args.request.path==='/config/requests/payload')return {override:[{models:[{name:'claude-opus-4-6',protocol:'antigravity'}],params:{'generationConfig.thinkingConfig':{thinkingLevel:'high'}}}]};
    if(command==='management_request'&&args.request.path==='/credentials/models')return {models:[{id:'fixture-model',input_modalities:['text','image'],context_length:200000}]};
    if(['create_agent_config_backup','update_agent_config','restore_agent_config_backup'].includes(command))window.uxWrites.push(command);
    const result=await original(command,args,...rest);
    if(command==='management_request'&&args.request.path==='/credentials')return {...result,files:result.files.map(file=>({...file,status:'active'}))};
    return result;
   };
  });
  await page.locator('.quota-refresh').click();await page.waitForFunction(()=>!document.querySelector('.quota-refresh').disabled);
  await page.evaluate(async()=>{const {updateQuotaCache}=await import('/src/services/quotaCache.ts');updateQuotaCache(cache=>Object.fromEntries(Object.entries(cache).map(([key,value])=>[key,{...value,status:'success',fetchedAt:Date.now(),rows:[{scope:'account',label:'Weekly',remainingPercent:60,resetAtMs:Date.now()+86400000}]}])));});
  const nav=page.getByRole('navigation',{name:'Main navigation'});
  await page.getByRole('button',{name:'Compare alternatives',exact:true}).click();
  const alternatives=page.getByRole('region',{name:'Compare alternatives'});await alternatives.waitFor();
  await alternatives.getByRole('button',{name:'Load available models'}).first().click();await alternatives.getByText('fixture-model',{exact:true}).waitFor();await alternatives.getByText('Reported inputs: text, image',{exact:true}).waitFor();
  await alternatives.getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('.ux-insight summary').filter({hasText:'Upcoming allowance resets'}).click();
  await page.getByText('Provider estimates. A new quota check must confirm availability after each reset.',{exact:true}).waitFor();
  await page.getByLabel('Notify me in Overview',{exact:true}).check();
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1700);
  await page.evaluate(()=>{window.uxItems=[{timestamp:new Date().toISOString(),auth_index:'mock-codex-1',model:'fixture-model',user_agent:'claude-desktop/1',failed:true,canceled:false,failure_status:429}];window.dispatchEvent(new Event('focus'));});
  await page.locator('.ux-alerts [role=status]').waitFor();assert.equal(await page.locator('.ux-alerts li').count(),1);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(1700);assert.equal(await page.locator('.ux-alerts li').count(),1,'No repeated alert for same failure');
  await page.getByRole('button',{name:'Dismiss notifications'}).click();
  await nav.getByRole('button',{name:'Connected apps',exact:true}).click();
  await page.locator('.ux-models summary').click();await page.getByText('Explicit reasoning override: high',{exact:true}).waitFor();
  await page.locator('.connection-evidence').getByText('The provider limited this request. Check quota and available alternatives.',{exact:true}).waitFor();
  await page.evaluate(()=>{window.uxItems=[{timestamp:new Date().toISOString(),model:'fixture-model',user_agent:'claude-desktop/1',failed:false,canceled:false,reasoning_effort:'high'}];window.dispatchEvent(new Event('focus'));});
  await page.locator('.connection-overview h2').getByText('Recent request verified',{exact:true}).waitFor();
  await page.getByText('Recorded reasoning: high',{exact:true}).waitFor();
  await page.evaluate(()=>{window.uxFail=true;window.dispatchEvent(new Event('focus'));});
  await page.getByText('Evidence refresh failed; showing the previous snapshot.',{exact:true}).waitFor();
  assert.equal(await page.locator('.connection-overview h2').innerText(),'Configured','Failed refresh cannot keep verified badge');
  await page.evaluate(()=>{window.uxFail=false;window.dispatchEvent(new Event('focus'));});
  await page.locator('.connection-overview h2').getByText('Recent request verified',{exact:true}).waitFor();
  const preset={format:'tim-ai-hub.desktop-models',version:1,client:'claude-desktop',models:[{model:'claude-sonnet-4-6',alias:'',context1m:false}]};
  await page.locator('.model-preset-controls input[type=file]').setInputFiles({name:'test.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(preset))});
  await page.getByRole('button',{name:'Replace editor list',exact:true}).click();await page.locator('.ux-change-preview').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.uxWrites),[],'Preview must not save');
  await page.getByRole('button',{name:'Update Configuration',exact:true}).click();
  await page.getByRole('button',{name:'Undo last save…',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.uxWrites),['create_agent_config_backup','update_agent_config']);
  await page.getByRole('button',{name:'Undo last save…',exact:true}).click();
  await page.locator('.agent-backup-changes').getByText('Before',{exact:true}).waitFor().catch(()=>{});
  await page.waitForFunction(()=>document.querySelector('.agent-backup-modal footer .primary-button')&&!document.querySelector('.agent-backup-modal footer .primary-button').disabled);
  assert.equal((await page.evaluate(()=>window.uxWrites)).length,2,'Undo previews before any restore');
  await page.locator('.agent-backup-modal footer').getByRole('button',{name:'Cancel',exact:true}).click();
  for(const theme of ['Light','Dark']){await page.getByRole('button',{name:theme,exact:true}).click();for(const width of [1440,960,640]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${theme} overflow ${width}`);}}
  if(process.env.UI_OUTPUT){await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'Light',exact:true}).click();await page.locator('.connection-overview').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.UI_OUTPUT,'ux-connections.png')});}
  assert.deepEqual(errors,[]);console.log('PASS: alternatives/capabilities, recovery explanation, opt-in deduped alerts, live request evidence, explicit vs recorded reasoning, refresh failure downgrade, preview, backup-before-save, Undo preview, responsive light/dark.');
 }finally{await browser?.close();await server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
