import { describe, expect, it } from 'bun:test';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';
import { moveAgentFallback, validAgentFallbackTargets, type AgentModelFallback } from '../src/services/agentModelFallback';

describe('agent model fallback routes', () => {
  it('validates and reorders a bounded chain without mutating its input', () => {
    expect(validAgentFallbackTargets('one', ['two', 'three'])).toBe(true);
    expect(validAgentFallbackTargets('one', [])).toBe(true);
    for (const targets of [['one'], ['ONE'], ['two', 'two'], [''], Array.from({length:9}, (_,i)=>`m${i}`)]) {
      expect(validAgentFallbackTargets('one', targets)).toBe(false);
    }
    const targets = ['two', 'three', 'four'];
    expect(moveAgentFallback(targets, 2, -1)).toEqual(['two', 'four', 'three']);
    expect(targets).toEqual(['two', 'three', 'four']);
    expect(moveAgentFallback(targets, 0, -1)).toBe(targets);
  });

  it('isolates client slots and keeps old aliases valid when a draft changes', async () => {
    const runtime = createBrowserMockRuntime('running');
    const scope = { client: 'claude-code', slot:'sonnet', model:'claude-sonnet-4-6' };
    const read = await runtime.invoke('read_agent_model_fallback',scope) as AgentModelFallback;
    expect(read.primary).toBe(scope.model);
    expect(read.fallbacks).toEqual([]);
    const first = await runtime.invoke('save_agent_model_fallback', {...scope,...read,fallbacks:['gemini-3-pro']}) as AgentModelFallback;
    expect(first.model).toStartWith('claude-cpa-fallback-');
    const opusScope = {...scope,slot:'opus'};
    const opusRead = await runtime.invoke('read_agent_model_fallback',opusScope) as AgentModelFallback;
    const opus = await runtime.invoke('save_agent_model_fallback',{...opusScope,...opusRead,fallbacks:['claude-opus-4-6']}) as AgentModelFallback;
    expect(opus.model).not.toBe(first.model);
    const refreshed = await runtime.invoke('read_agent_model_fallback',{...scope,model:first.model}) as AgentModelFallback;
    expect(refreshed.primary).toBe(scope.model);
    expect(refreshed.fallbacks).toEqual(['gemini-3-pro']);
    const revised = await runtime.invoke('save_agent_model_fallback',{...scope,...refreshed,fallbacks:['gemini-3-pro','claude-opus-4-6']}) as AgentModelFallback;
    expect(revised.model).not.toBe(first.model);
    const old = await runtime.invoke('read_agent_model_fallback',{...scope,model:first.model}) as AgentModelFallback;
    expect(old.fallbacks).toEqual(['gemini-3-pro']);
    const unowned = await runtime.invoke('read_agent_model_fallback',{...scope,client:'codex',model:first.model}) as AgentModelFallback;
    expect(unowned.primary).toBe(first.model);
    expect(unowned.fallbacks).toEqual([]);
  });

  it('rejects stale writes and leaves configuration unchanged on removing a draft chain', async () => {
    const runtime = createBrowserMockRuntime('running');
    const scope = {client:'codex',slot:'default',model:'gpt-5.2-codex'};
    const read = await runtime.invoke('read_agent_model_fallback',scope) as AgentModelFallback;
    const first = await runtime.invoke('save_agent_model_fallback',{...scope,...read,fallbacks:['gemini-3-pro']}) as AgentModelFallback;
    await expect(runtime.invoke('save_agent_model_fallback',{...scope,...read,fallbacks:['claude-opus-4-6']})).rejects.toThrow('changed');
    const refreshed = await runtime.invoke('read_agent_model_fallback',{...scope,model:first.model}) as AgentModelFallback;
    const cleared = await runtime.invoke('save_agent_model_fallback',{...scope,...refreshed,fallbacks:[]}) as AgentModelFallback;
    expect(cleared.model).toBe(scope.model);
    expect(cleared.revision).toBe(refreshed.revision);
  });
});
