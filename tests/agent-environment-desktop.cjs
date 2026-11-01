const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const endpoint = process.env.WEBDRIVER_URL || 'http://127.0.0.1:4459';
let session = process.env.WEBDRIVER_SESSION;
async function request(route, payload, method = 'POST') {
  const response = await fetch(`${endpoint}${route}`, { method,
    headers: { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const result = await response.json();
  if (result.value?.error) throw new Error(JSON.stringify(result.value));
  return result.value;
}
const execute = (script, args = []) => request(`/session/${session}/execute/sync`, { script, args });
async function waitFor(script) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await execute(script)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Desktop condition timed out: ${script}`);
}
async function click(selector) {
  const element = await request(`/session/${session}/element`, { using: 'css selector', value: selector });
  await request(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
}

(async () => {
  try {
    if (!session) {
      const created = await request('/session', { capabilities: { alwaysMatch: { 'tauri:options': {
        application: path.resolve(process.env.DESKTOP_BINARY || 'src-tauri/target/debug/cpa-gui'),
      } } } });
      session = created.sessionId;
    }
    await waitFor('return !!document.querySelector(".app-shell")');
    const environments = await request(`/session/${session}/execute/async`, {
      script: `const done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke('get_agent_environment_options', {client:'claude-code'}).then(done, error => done({error:String(error)}));`, args: [],
    });
    assert.equal(environments.supported, process.platform === 'win32');
    assert.ok(environments.defaultDirectory);
    if (process.platform !== 'win32') assert.deepEqual(environments.distributions, []);
    await execute("localStorage.setItem('easy-cli-proxy-api.locale', 'en')");
    await request(`/session/${session}/refresh`, {});
    await waitFor('return !!document.querySelector(\'.nav-section button[title="Agent Configuration"]\')');
    await click('.nav-section button[title="Agent Configuration"]');
    await waitFor('return [...document.querySelectorAll("[role=tab]")].some(element => element.textContent === "Configuration management")');
    const tabs = await execute('return [...document.querySelectorAll("[role=tab]")].map(element => element.textContent)');
    await click(`[role="tab"]:nth-child(${tabs.indexOf('Configuration management') + 1})`);
    await waitFor('return !!document.querySelector(".agent-environment-current code") && !document.querySelector(".agent-environment-status .spin")');
    await click('.agent-environment-segments [data-value="wsl"]');
    if (process.platform !== 'win32') {
      await waitFor('return document.querySelector(".agent-environment-directory").textContent.includes("only available on Windows")');
      assert.equal(await execute('return document.querySelector(".agent-environment-directory select")'), null);
    }
    fs.mkdirSync('bin-work', { recursive: true });
    for (const width of [1280, 640]) {
      await request(`/session/${session}/window/rect`, { width, height: 900 });
      await execute('document.querySelector(".agent-environment-directory").scrollIntoView({block:"center"})');
      assert.equal(await execute('const panel=document.querySelector(".agent-environment-directory"); return panel.scrollWidth > panel.clientWidth + 1'), false);
      const screenshot = await request(`/session/${session}/screenshot`, undefined, 'GET');
      fs.writeFileSync(`bin-work/environment-desktop-${width}.png`, Buffer.from(screenshot, 'base64'));
    }
    await click('.agent-environment-segments [data-value="local"]');
    await click('.agent-environment-custom summary');
    assert.equal(await execute('return document.querySelector(".agent-environment-input input").disabled'), false);
    assert.equal(await execute('return document.querySelector(".agent-environment-segments [data-value=local]").getAttribute("aria-checked")'), 'true');
    console.log('PASS: built desktop application, real IPC detection, local/WSL switching, custom input, responsive WebKit GUI and screenshots');
  } finally {
    if (session) await request(`/session/${session}`, undefined, 'DELETE');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
