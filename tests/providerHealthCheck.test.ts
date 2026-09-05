import { describe, expect, it } from 'bun:test';
import {
  buildProviderHealthProbe,
  mergeProviderHealthModels,
  primaryProviderHealthCredential,
  runProviderModelHealthChecks,
} from '../src/services/providerHealthCheck';
import { modelEndpointCandidates } from '../src/services/modelService';

describe('API 接入健康检测', () => {
  it('取消后不派发剩余模型，也不更新已关闭的界面', async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const delivered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checking = runProviderModelHealthChecks(
      Array.from({ length: 100 }, (_, index) => ({ name: String(index) })),
      async (model) => {
        requested.push(model.name);
        await gate;
        return { model: model.name, status: 'healthy', success: true };
      },
      (result) => delivered.push(result.model),
      4,
      controller.signal,
    );
    expect(requested).toHaveLength(4);
    controller.abort();
    release();
    expect(await checking).toEqual([]);
    expect(requested).toHaveLength(4);
    expect(delivered).toEqual([]);
  });

  it('已取消的批次不会发起请求', async () => {
    const controller = new AbortController();
    controller.abort();
    let requested = false;
    const results = await runProviderModelHealthChecks([{ name: 'unused' }], async (model) => {
      requested = true;
      return { model: model.name, status: 'healthy', success: true };
    }, undefined, 4, controller.signal);
    expect(results).toEqual([]);
    expect(requested).toBe(false);
  });

  it('健康检测只保留已勾选模型，并使用发现结果补充模型信息', () => {
    const models = mergeProviderHealthModels(
      [
        { name: 'model-b' },
        { name: 'model-a', contextWindow: 200_000 },
        { name: 'model-c' },
      ],
      [{ name: 'MODEL-A', alias: 'model-a-alias' }, { name: 'model-c' }],
    );

    expect(models).toEqual([
      { name: 'MODEL-A', alias: 'model-a-alias', contextWindow: 200_000 },
      { name: 'model-c' },
    ]);
  });

  it('没有勾选模型时不允许发现列表自动加入健康检测', () => {
    expect(mergeProviderHealthModels(
      [{ name: 'model-a' }, { name: 'model-b' }],
      [],
    )).toEqual([]);
  });

  it('逐模型检测只使用当前接入的首个有效密钥', () => {
    expect(primaryProviderHealthCredential(['', ' first-key ', 'second-key'])).toBe('first-key');
    expect(primaryProviderHealthCredential([])).toBe('');
  });

  it('为 OpenAI 兼容接入构造最小 chat completions 请求并保留自定义头', () => {
    const probe = buildProviderHealthProbe(
      'openai',
      'https://openrouter.example/api/v1',
      'gpt-test',
      'secret-key',
      '',
      { 'X-Team': 'production' },
    );

    expect(probe.url).toBe('https://openrouter.example/api/v1/chat/completions');
    expect(probe.header).toMatchObject({
      Authorization: 'Bearer secret-key',
      'Content-Type': 'application/json',
      'X-Team': 'production',
    });
    expect(JSON.parse(probe.data)).toEqual({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(probe.protocol).toBe('openai-chat');
  });

  it('为非 v1 的 OpenAI 兼容版本前缀保留原始版本号', () => {
    const probe = buildProviderHealthProbe(
      'openai',
      'https://open.bigmodel.cn/api/coding/paas/v4',
      'glm-test',
      'secret-key',
    );

    expect(probe.url).toBe(
      'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
    );
    expect(modelEndpointCandidates(
      'openai',
      'https://open.bigmodel.cn/api/coding/paas/v4',
    )).toEqual([
      'https://open.bigmodel.cn/api/coding/paas/v4/models',
    ]);
  });

  it('把不含版本号的中转地址视为完整 API 路径前缀', () => {
    const baseUrl = 'https://relay.example/custom/openai';
    const probe = buildProviderHealthProbe(
      'openai',
      baseUrl,
      'mapped-model',
      'secret-key',
    );

    expect(probe.url).toBe(
      'https://relay.example/custom/openai/chat/completions',
    );
    expect(modelEndpointCandidates('openai', baseUrl)).toEqual([
      'https://relay.example/custom/openai/models',
    ]);
    expect(modelEndpointCandidates(
      'openai',
      'https://relay.example/custom/openai/v1/models',
    )).toEqual([
      'https://relay.example/custom/openai/v1/models',
    ]);
    expect(modelEndpointCandidates('codex', 'https://codex.example')).toEqual([
      'https://codex.example/v1/models',
    ]);
  });

  it('不会覆盖供应商已有的自定义认证头', () => {
    const probe = buildProviderHealthProbe(
      'claude',
      '',
      'claude-test',
      'new-key',
      '',
      { 'X-Api-Key': 'custom-key', 'Anthropic-Version': 'custom-version' },
    );

    expect(probe.url).toBe('https://api.anthropic.com/v1/messages');
    expect(probe.header['X-Api-Key']).toBe('custom-key');
    expect(probe.header['Anthropic-Version']).toBe('custom-version');
    expect(probe.header['x-api-key']).toBeUndefined();
    expect(probe.header['anthropic-version']).toBeUndefined();
  });

  it('使用运行时凭据占位符构造 Codex responses 请求', () => {
    const probe = buildProviderHealthProbe(
      'codex',
      'https://codex.example/v1/responses',
      'gpt-5-codex',
      '',
      'runtime-auth-index',
    );

    expect(probe.url).toBe('https://codex.example/v1/responses');
    expect(probe.header.Authorization).toBe('Bearer $TOKEN$');
    expect(JSON.parse(probe.data)).toEqual({
      model: 'gpt-5-codex',
      input: 'hi',
      stream: true,
    });
    expect(probe.protocol).toBe('openai-responses');
  });

  it('为 Gemini 使用默认地址并移除 models/ 前缀', () => {
    const probe = buildProviderHealthProbe(
      'gemini',
      '',
      'models/gemini-2.5-flash',
      'gemini-key',
    );

    expect(probe.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?alt=sse',
    );
    expect(probe.header['x-goog-api-key']).toBe('gemini-key');
    expect(probe.protocol).toBe('gemini');
    expect(probe.model).toBe('gemini-2.5-flash');
    expect(probe.source).toBe('gemini-key');
  });

  it('检测全部时每个模型只请求一次并保持结果顺序', async () => {
    const requested: string[] = [];
    const results = await runProviderModelHealthChecks([
      { name: 'model-a' },
      { name: 'model-b' },
      { name: 'model-c' },
    ], async (model) => {
      requested.push(model.name);
      return {
        model: model.name,
        status: 'healthy',
        success: true,
        firstTokenLatencyMs: 120,
      };
    }, undefined, 2);

    expect(requested.sort()).toEqual(['model-a', 'model-b', 'model-c']);
    expect(results.map((result) => result.model)).toEqual(['model-a', 'model-b', 'model-c']);
  });

});
