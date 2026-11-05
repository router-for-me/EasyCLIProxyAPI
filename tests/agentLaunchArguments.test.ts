import { describe, expect, it } from 'bun:test';
import cases from './fixtures/cli-arguments.json';
import { hasDeepSeekArgumentConflict, parseAgentLaunchArguments } from '../src/services/agentLaunchArguments';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';

describe('custom CLI startup arguments', () => {
  for (const [index, fixture] of cases.entries()) {
    it(`parses shared literal argument case ${index}`, () => {
      expect(parseAgentLaunchArguments(fixture.source)).toEqual(fixture.expected);
    });
  }
  it('reserves structured DeepSeek options without changing other duplicates', () => {
    for (const option of ['--profile', '--patch', '--host', '--port', '--trusted-host', '--no-open', '--open']) {
      expect(hasDeepSeekArgumentConflict([option])).toBe(true);
      expect(hasDeepSeekArgumentConflict([`${option}=value`])).toBe(true);
    }
    expect(hasDeepSeekArgumentConflict(['--verbose', '--verbose'])).toBe(false);
  });
  it('validates direct mock invokes independently of dialog validation', async () => {
    const runtime = createBrowserMockRuntime('running');
    for (const client of ['pi', 'codex', 'copilot-cli', 'antigravity-cli', 'deepseek-harness']) {
      await expect(runtime.invoke('launch_agent', { client, target: 'cli' })).resolves.toBeNull();
      await expect(runtime.invoke('launch_agent', { client, target: 'cli', customArguments: '--label "two words"' })).resolves.toBeNull();
      await expect(runtime.invoke('launch_agent', { client, target: 'cli', customArguments: '"unclosed' })).rejects.toThrow();
    }
    await expect(runtime.invoke('launch_agent', { client: 'deepseek-harness', target: 'cli', customArguments: '--port=9090' })).rejects.toThrow();
    await expect(runtime.invoke('launch_agent', { client: 'codex', target: 'app', customArguments: '--label value' })).rejects.toThrow();
  });
});
