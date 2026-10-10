// Opt-in integration test: runs the installed Claude Code against the configured CPA.
// Usage: node tests/claude-code-live.cjs [case-id ...]
// CLAUDE_LIVE_EXE may override the installed executable. No secrets are logged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(root, '.codex', 'claude-code-live', stamp);
fs.mkdirSync(output, { recursive: true });
const userSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const userSettingsBytes = fs.readFileSync(userSettingsPath);
const userSettings = JSON.parse(userSettingsBytes);
const upstreamBase = userSettings.env?.ANTHROPIC_BASE_URL;
const upstreamToken = userSettings.env?.ANTHROPIC_AUTH_TOKEN || userSettings.env?.ANTHROPIC_API_KEY;
assert(upstreamBase && upstreamToken, 'CPA endpoint and credential must be configured');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(upstreamBase).hostname), 'Live test requires a local CPA');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const protectedPaths = [userSettingsPath, path.join(os.homedir(), '.claude.json'), path.join(os.homedir(), '.claude', '.credentials.json')];
const protectedHashes = new Map(protectedPaths.filter(p => fs.existsSync(p)).map(p => [p, digest(fs.readFileSync(p))]));
const redact = text => String(text).split(upstreamToken).join('[REDACTED]');

const executable = process.env.CLAUDE_LIVE_EXE || path.join(path.dirname(process.execPath), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
assert(fs.existsSync(executable), 'Set CLAUDE_LIVE_EXE to the installed Claude Code executable');
const version = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
assert.equal(version.status, 0);
console.log(`Claude Code: ${version.stdout.trim()}`);
console.log(`Evidence: ${output}`);

let activeCase = null;
const observations = [];
const observer = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let message;
    if (req.url.split('?')[0] === '/v1/messages' && body.length) {
      const value = JSON.parse(body);
      message = {
        case: activeCase, path: req.url, model: value.model,
        maxTokens: value.max_tokens, stream: value.stream,
        beta: req.headers['anthropic-beta'] || '',
        toolNames: (value.tools || []).map(tool => tool.name),
      };
      observations.push(message);
      fs.writeFileSync(path.join(output, 'requests.json'), JSON.stringify(observations, null, 2));
    }
    const headers = { ...req.headers, authorization: `Bearer ${upstreamToken}`, 'x-api-key': upstreamToken };
    delete headers.host;
    delete headers['content-length'];
    delete headers.connection;
    delete headers['accept-encoding'];
    const response = await fetch(`${upstreamBase.replace(/\/$/, '')}${req.url}`, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      signal: AbortSignal.timeout(180000),
    });
    if (message) message.status = response.status;
    if (message) fs.writeFileSync(path.join(output, 'requests.json'), JSON.stringify(observations, null, 2));
    res.statusCode = response.status;
    for (const [key, value] of response.headers) {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key)) res.setHeader(key, value);
    }
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: redact(error.message) } }));
  }
});

const runProcess = (program, args, options = {}) => new Promise(resolve => {
  const child = spawn(program, args, { windowsHide: true, ...options });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeout || 180000);
  child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: redact(error.message), timedOut }); });
  child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: redact(stdout), stderr: redact(stderr), timedOut }); });
});

(async () => {
  await new Promise(resolve => observer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${observer.address().port}`;
  const modelResponse = await fetch(`${upstreamBase.replace(/\/$/, '')}/v1/models`, { headers: { Authorization: `Bearer ${upstreamToken}` } });
  assert.equal(modelResponse.status, 200);
  const available = (await modelResponse.json()).data.map(model => model.id);
  const modelA = process.env.CLAUDE_LIVE_MODEL_A || 'gpt-6.1-sol';
  const modelB = process.env.CLAUDE_LIVE_MODEL_B || 'gpt-6-luna';
  const modelAlias = process.env.CLAUDE_LIVE_MODEL_ALIAS || 'gpt-6.1-sol-high-fast';
  assert(available.includes(modelA) && available.includes(modelB), 'Both live models must be available in CPA');
  const mapping = changes => ({ opus: modelA, sonnet: modelB, haiku: modelB, fable: modelA,
    startupModel: 'opus', subagentModel: '', maxContextTokens: 200000, autoCompactPct: 90,
    disableAutoCompact: false, ...changes });
  const smokePrompt = 'Reply with exactly EZCPA_LIVE_OK. Do not use tools.';
  const workerPrompt = 'Use the Agent tool to delegate this task to the live-worker subagent: reply with exactly EZCPA_WORKER_OK. Wait for the worker to finish, then reply EZCPA_PARENT_OK. You must call Agent; do not answer without delegation.';
  const cases = [
    { id: 'default-opus', mappings: mapping({}), expected: modelA, prompt: smokePrompt },
    { id: 'default-sonnet', mappings: mapping({ startupModel: 'sonnet' }), expected: modelB, prompt: smokePrompt },
    { id: 'default-haiku', mappings: mapping({ startupModel: 'haiku' }), expected: modelB, prompt: smokePrompt },
    { id: 'default-fable', mappings: mapping({ startupModel: 'fable' }), expected: modelA, prompt: smokePrompt },
    { id: 'direct-model', mappings: mapping({ startupModel: modelB }), expected: modelB, prompt: smokePrompt },
    { id: 'configured-alias', mappings: mapping({ opus: modelAlias }), expected: modelAlias, prompt: smokePrompt },
    { id: 'updated-role-mapping', mappings: mapping({ startupModel: 'sonnet', sonnet: modelA }),
      existingFrom: 'default-sonnet', expected: modelA, prompt: smokePrompt },
    { id: 'cli-model-override', mappings: mapping({}), expected: modelB, args: ['--model', 'sonnet'], prompt: smokePrompt },
    { id: 'role-1m', mappings: mapping({ opus1m: true, maxContextTokens: 1000000 }), expected: modelA, context: 1000000, prompt: smokePrompt },
    { id: 'direct-1m', mappings: mapping({ startupModel: `${modelA}[1m]`, maxContextTokens: 1000000 }), expected: modelA, context: 1000000, prompt: smokePrompt },
    { id: 'after-disable-1m', mappings: mapping({}), existingFrom: 'role-1m', expected: modelA, context: 200000, prompt: smokePrompt },
    { id: 'compact-policy', mappings: mapping({ maxContextTokens: 300000, autoCompactPct: 75, disableAutoCompact: true }),
      expected: modelA, context: 300000, prompt: smokePrompt, debug: true },
    { id: 'compact-enabled-policy', mappings: mapping({ maxContextTokens: 300000, autoCompactPct: 75 }),
      expected: modelA, context: 300000, prompt: smokePrompt, debug: true },
    { id: 'agent-file-tools', mappings: mapping({ startupModel: 'sonnet' }), expected: modelB,
      tools: 'Read,Write', prompt: 'Read input.txt using Read. Write output.txt using Write with exactly the contents EZCPA_TOOL_OK:42. Then read output.txt using Read to verify it. Reply EZCPA_TOOL_OK. Do not run shell commands.', fileTools: true },
    { id: 'subagent-inherit', mappings: mapping({}), expected: modelA, workerExpected: modelA, tools: 'Agent', prompt: workerPrompt },
    { id: 'subagent-pinned-role', mappings: mapping({ subagentModel: 'haiku' }), expected: modelA, workerExpected: modelB, tools: 'Agent', prompt: workerPrompt },
    { id: 'subagent-pinned-direct', mappings: mapping({ subagentModel: modelB }), expected: modelA, workerExpected: modelB, tools: 'Agent', prompt: workerPrompt },
    { id: 'subagent-1m', mappings: mapping({ subagentModel: `${modelB}[1m]`, maxContextTokens: 1000000 }), expected: modelA, workerExpected: modelB, context: 1000000, tools: 'Agent', prompt: workerPrompt },
    // Enabling 1M keeps custom auto-compact windows: 400000 must survive into settings and runtime.
    { id: 'compact-window-1m-400k', mappings: mapping({ opus1m: true, maxContextTokens: 400000, autoCompactPct: 75 }),
      expected: modelA, context: 1000000, prompt: smokePrompt, debug: true, effectiveWindow: 380000 },
    { id: 'unavailable-custom-model', mappings: mapping({ startupModel: 'ezcpa-live-unavailable-model' }),
      expected: 'ezcpa-live-unavailable-model', expectedError: true, prompt: smokePrompt },
  ];
  const filters = process.argv.slice(2);
  const selected = cases.filter(c => !filters.length || filters.includes(c.id));
  assert(selected.length, 'No matching live cases');
  const requestPath = path.join(output, 'fixture-request.json');
  const configPath = path.join(output, 'generated-settings.json');
  fs.writeFileSync(requestPath, JSON.stringify({ baseUrl, models: [
    ...[modelA, modelB].map(name => ({ name, alias: null, contextWindow: 200000 })),
    { name: modelAlias, alias: modelA, isAlias: true, contextWindow: 200000 },
  ], cases }, null, 2));
  const cargo = await runProcess('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml',
    'export_claude_code_live_configurations', '--', '--ignored', '--nocapture'], {
    cwd: root, env: { ...process.env, EZCPA_CLAUDE_LIVE_REQUEST: requestPath, EZCPA_CLAUDE_LIVE_OUTPUT: configPath }, timeout: 300000,
  });
  fs.writeFileSync(path.join(output, 'cargo.txt'), cargo.stdout + cargo.stderr);
  assert.equal(cargo.code, 0, 'Rust fixture export failed; see cargo.txt');
  const configurations = JSON.parse(fs.readFileSync(configPath));
  const results = [];
  for (const test of selected) {
    activeCase = test.id;
    const caseDir = path.join(output, test.id);
    fs.mkdirSync(caseDir, { recursive: true });
    const configDir = path.join(caseDir, 'claude-home');
    fs.mkdirSync(configDir);
    const settings = configurations.find(c => c.id === test.id).settings;
    const settingsPath = path.join(configDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    fs.writeFileSync(path.join(caseDir, 'input.txt'), 'The test number is 42.');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|EASYCLIPROXY_MANAGE_CLAUDE|DISABLE_AUTO_COMPACT)/.test(key)) delete env[key];
    Object.assign(env, { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' });
    const args = ['-p', test.prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--setting-sources', '', '--settings', settingsPath, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands', '--tools', test.tools || '', '--permission-mode', 'acceptEdits', ...(test.args || [])];
    if (test.tools) args.push('--allowedTools', test.tools);
    if (test.debug) args.push('--debug-file', path.join(caseDir, 'debug.log'));
    if (test.workerExpected) args.push('--agents', JSON.stringify({ 'live-worker': {
      description: 'A worker for the live configuration test.', prompt: 'Reply with exactly EZCPA_WORKER_OK. Do not use tools.', tools: [],
    } }));
    console.log(`RUN ${test.id}`);
    const started = Date.now();
    const run = await runProcess(executable, args, { cwd: caseDir, env });
    fs.writeFileSync(path.join(caseDir, 'stdout.jsonl'), run.stdout);
    fs.writeFileSync(path.join(caseDir, 'stderr.txt'), run.stderr);
    const events = run.stdout.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const final = events.findLast(event => event.type === 'result');
    const requests = observations.filter(request => request.case === test.id);
    const toolUses = events.flatMap(event => (event.message?.content || []).filter(block => block.type === 'tool_use').map(block => ({ name: block.name, parent: event.parent_tool_use_id || null })));
    const failures = [];
    const check = (condition, reason) => { if (!condition) failures.push(reason); };
    const autoCompactionChecks = test.debug && fs.existsSync(path.join(caseDir, 'debug.log'))
      ? fs.readFileSync(path.join(caseDir, 'debug.log'), 'utf8').split(/\r?\n/).filter(line => line.includes('autocompact:')) : [];
    if (test.expectedError) {
      check(!run.timedOut && (run.code !== 0 || final?.is_error), 'Unavailable model did not report an error');
      check(requests.every(request => request.model === test.expected), 'Unavailable model silently fell back to another model');
    } else {
      check(run.code === 0 && !run.timedOut, `Claude exit ${run.code}, timedOut=${run.timedOut}`);
      check(final && !final.is_error, 'Claude did not complete successfully');
      if (test.prompt === smokePrompt) check(final?.result?.trim() === 'EZCPA_LIVE_OK', 'Smoke response marker is incorrect');
      check((final?.permission_denials || []).length === 0, 'Tool permission was denied');
    }
    const mainRequests = requests.filter(request => request.model?.replace(/\[1m\]$/i, '') === test.expected);
    check(mainRequests.length > 0, `No actual request for expected model ${test.expected}`);
    if (!test.expectedError) check(requests.every(request => request.status === 200), 'At least one actual request failed');
    if (test.context) check(Object.values(final?.modelUsage || {}).some(usage => usage.contextWindow === test.context), `Expected runtime context window ${test.context}`);
    check(settings.autoCompactWindow === test.mappings.maxContextTokens,
      `Expected written auto-compact window ${test.mappings.maxContextTokens}, got ${settings.autoCompactWindow}`);
    if (test.debug) {
      check(settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === String(test.mappings.autoCompactPct), 'Compaction percentage was not persisted');
      check(test.mappings.disableAutoCompact ? autoCompactionChecks.length === 0 : autoCompactionChecks.length > 0,
        'Runtime auto-compaction check did not match the configured enabled state');
      if (test.effectiveWindow) check(autoCompactionChecks.some(line => line.includes(`effectiveWindow=${test.effectiveWindow}`)),
        `Expected runtime auto-compact window ${test.effectiveWindow}`);
    }
    if (test.fileTools) {
      check(toolUses.some(tool => tool.name === 'Read') && toolUses.some(tool => tool.name === 'Write'), 'Read/Write tools were not both executed');
      const written = path.join(caseDir, 'output.txt');
      check(fs.existsSync(written) && fs.readFileSync(written, 'utf8').trim() === 'EZCPA_TOOL_OK:42', 'Agent output file is incorrect');
    }
    if (test.workerExpected) {
      check(toolUses.some(tool => tool.name === 'Agent'), 'Agent delegation did not execute');
      check(events.some(event => event.message?.content?.some(block => block.type === 'tool_result'
        && JSON.stringify(block.content).includes('EZCPA_WORKER_OK') && JSON.stringify(block.content).includes('agentId:'))), 'No completed real subagent report');
      check(requests.some(request => request.toolNames.length === 0 && request.model?.replace(/\[1m\]$/i, '') === test.workerExpected), `No worker request for ${test.workerExpected}`);
      if (test.workerExpected === test.expected) check(requests.length >= 3, 'Expected parent, worker and parent continuation requests');
    }
    const result = { id: test.id, passed: failures.length === 0, failures, durationMs: Date.now() - started,
      initialModel: events.find(event => event.type === 'system' && event.subtype === 'init')?.model,
      modelUsage: final?.modelUsage, result: final?.result, toolUses, requests, autoCompactionChecks };
    fs.writeFileSync(path.join(caseDir, 'summary.json'), JSON.stringify(result, null, 2));
    results.push(result);
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ version: version.stdout.trim(), results }, null, 2));
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${test.id}: ${failures.join('; ') || requests.map(r => r.model).join(', ')}`);
  }
  for (const [protectedPath, hash] of protectedHashes) assert.equal(digest(fs.readFileSync(protectedPath)), hash, `User configuration changed: ${protectedPath}`);
  console.log(`User settings and credentials unchanged. ${results.filter(r => r.passed).length}/${results.length} live cases passed.`);
  if (results.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(redact(error.stack)); process.exitCode = 1; }).finally(() => observer.close());
