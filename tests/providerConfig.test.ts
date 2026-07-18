import { describe, expect, it } from 'bun:test';
import {
  allModelSelectionForDiscovery,
  applyProviderPreset,
  buildProviderRecord,
  createProviderDraft,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_THINKING_LEVELS,
  exclusionsForModelSelection,
  modelSelectionForDiscovery,
  parseProviderHeaders,
  providerCategoryMatchesRecord,
  providerSectionOrder,
  sectionRecordsFromConfig,
  stripResponseFields,
} from '../src/pages/ApiAccessPage';

describe('API 接入配置合并', () => {
  it('固定使用 Codex、OpenAI、DeepSeek、Claude、Gemini 顺序且不包含 Vertex', () => {
    expect(providerSectionOrder).toEqual([
      'codex-api-key',
      'openai-compatibility',
      'deepseek',
      'claude-api-key',
      'gemini-api-key',
    ]);
  });

  it('DeepSeek 新增预设默认发现全部模型并应用内置思考等级', () => {
    const draft = createProviderDraft('deepseek');
    const discovered = [
      { name: 'deepseek-chat' },
      { name: 'deepseek-reasoner' },
      { name: 'deepseek-new-model' },
    ];
    const prepared = applyProviderPreset('deepseek', {
      ...draft,
      apiKey: 'deepseek-key',
      models: discovered,
    });
    const result = buildProviderRecord('openai-compatibility', prepared);

    expect(draft.name).toBe('DeepSeek');
    expect(draft.baseUrl).toBe(DEEPSEEK_BASE_URL);
    expect(draft.models).toEqual([]);
    expect(result).toMatchObject({
      name: 'DeepSeek',
      'base-url': 'https://api.deepseek.com',
      'api-key-entries': [{ 'api-key': 'deepseek-key' }],
      models: [
        {
          name: 'deepseek-chat',
          thinking: { levels: [...DEEPSEEK_THINKING_LEVELS] },
        },
        {
          name: 'deepseek-reasoner',
          thinking: { levels: [...DEEPSEEK_THINKING_LEVELS] },
        },
        {
          name: 'deepseek-new-model',
          thinking: { levels: [...DEEPSEEK_THINKING_LEVELS] },
        },
      ],
    });
  });

  it('DeepSeek 接入单独归类，不在 OpenAI 兼容列表重复显示', () => {
    const record = {
      name: 'custom-deepseek',
      'base-url': 'https://api.deepseek.com/v1',
    };

    expect(providerCategoryMatchesRecord('deepseek', record)).toBe(true);
    expect(providerCategoryMatchesRecord('openai-compatibility', record)).toBe(false);
  });

  it('OpenAI 兼容接入把选定思考等级写入全部开放模型', () => {
    const draft = applyProviderPreset('openai-compatibility', {
      ...createProviderDraft('openai-compatibility'),
      apiKey: 'openai-key',
      name: 'custom-openai',
      baseUrl: 'https://api.example.com',
      thinkingLevels: ['fast', 'ultra'],
      models: [
        { name: 'reasoning-a' },
        { name: 'reasoning-b', thinking: { effort: 'high' } },
      ],
    });
    const result = buildProviderRecord('openai-compatibility', draft);

    expect(result.models).toEqual([
      { name: 'reasoning-a', thinking: { levels: ['fast', 'ultra'] } },
      {
        name: 'reasoning-b',
        thinking: { effort: 'high', levels: ['fast', 'ultra'] },
      },
    ]);
  });

  it('只删除响应字段，不破坏隐藏的代理和扩展配置', () => {
    const result = stripResponseFields({
      'api-key': 'key',
      'auth-index': 'runtime-id',
      'proxy-url': 'http://proxy.example',
      custom: { enabled: true },
      'api-key-entries': [
        { 'api-key': 'first', 'auth-index': 'entry-id', 'proxy-url': 'direct' },
      ],
    });

    expect(result['auth-index']).toBeUndefined();
    expect(result['proxy-url']).toBe('http://proxy.example');
    expect(result.custom).toEqual({ enabled: true });
    expect(result['api-key-entries']).toEqual([
      { 'api-key': 'first', 'proxy-url': 'direct' },
    ]);
  });

  it('编辑 OpenAI 接入时保留后续密钥和模型扩展字段', () => {
    const result = buildProviderRecord(
      'openai-compatibility',
      {
        name: 'openrouter',
        apiKey: 'new-first\nsecond-key',
        baseUrl: 'https://openrouter.ai/api',
        priority: '20',
        models: [{ name: 'gpt-test', alias: 'gpt-alias' }],
      },
      {
        name: 'openrouter',
        'base-url': 'https://old.example',
        'api-key-entries': [
          { 'api-key': 'old-first', 'proxy-url': 'direct', 'auth-index': 'runtime-1' },
          { 'api-key': 'second-key', custom: true },
        ],
        models: [{ name: 'gpt-test', alias: 'old-alias', image: true }],
        headers: { 'X-Test': '1' },
      },
    );

    expect(result['api-key-entries']).toEqual([
      { 'api-key': 'new-first', 'proxy-url': 'direct' },
      { 'api-key': 'second-key', custom: true },
    ]);
    expect(result.models).toEqual([{ name: 'gpt-test', alias: 'gpt-alias', image: true }]);
    expect(result.headers).toEqual({ 'X-Test': '1' });
  });

  it('从最新完整配置读取对应提供商列表', () => {
    expect(sectionRecordsFromConfig({
      'codex-api-key': [{ 'api-key': 'one' }, null, 'invalid'],
    }, 'codex-api-key')).toEqual([{ 'api-key': 'one' }]);
  });

  it('空优先级不会被错误写成 0', () => {
    const result = buildProviderRecord(
      'codex-api-key',
      {
        name: '',
        apiKey: 'codex-key',
        baseUrl: 'https://api.example.com',
        priority: '',
        models: [],
      },
      {
        'api-key': 'old-key',
        priority: 30,
      },
    );

    expect(result.priority).toBeUndefined();
  });

  it('高级设置可编辑且不会引入代理字段', () => {
    const result = buildProviderRecord('codex-api-key', {
      name: '',
      apiKey: 'codex-key',
      baseUrl: 'https://api.example.com',
      priority: '',
      models: [],
      prefix: 'team-a',
      headersText: 'X-Team: production\nX-Trace: enabled',
      excludedModelsText: 'old-*\npreview-model',
      disableCooling: true,
      websockets: true,
    });

    expect(result).toMatchObject({
      prefix: 'team-a',
      headers: { 'X-Team': 'production', 'X-Trace': 'enabled' },
      'excluded-models': ['old-*', 'preview-model'],
      'disable-cooling': true,
      websockets: true,
    });
    expect(result['proxy-url']).toBeUndefined();
  });

  it('编辑已停用的普通提供商时保留停用规则', () => {
    const result = buildProviderRecord('claude-api-key', {
      name: '',
      apiKey: 'claude-key',
      baseUrl: '',
      priority: '',
      models: [],
      excludedModelsText: 'claude-old-*',
      disabled: true,
    });

    expect(result['excluded-models']).toEqual(['claude-old-*', '*']);
  });

  it('校验自定义请求头格式', () => {
    expect(parseProviderHeaders('Authorization: Bearer abc:def')).toEqual({
      Authorization: 'Bearer abc:def',
    });
    expect(() => parseProviderHeaders('Invalid header')).toThrow('缺少冒号');
  });

  it('把未勾选的上游模型写入排除列表', () => {
    const result = exclusionsForModelSelection(
      'legacy-*\ngpt-image',
      [{ name: 'gpt-5-codex' }, { name: 'gpt-image' }, { name: 'gpt-5-mini' }],
      new Set(['gpt-5-codex']),
    );

    expect(result.split('\n')).toEqual(['legacy-*', 'gpt-image', 'gpt-5-mini']);
  });

  it('重新勾选模型时移除对应的精确排除规则', () => {
    const result = exclusionsForModelSelection(
      'legacy-*\ngpt-image\nmanual-model',
      [{ name: 'gpt-5-codex' }, { name: 'gpt-image' }],
      new Set(['gpt-image']),
    );

    expect(result.split('\n')).toEqual(['legacy-*', 'manual-model', 'gpt-5-codex']);
  });

  it('普通提供商没有模型映射时按真实开放状态初始化勾选', () => {
    const selected = modelSelectionForDiscovery(
      'codex-api-key',
      [],
      [{ name: 'gpt-5.4' }, { name: 'gpt-image-1.5' }, { name: 'gpt-image-2' }],
      'gpt-image-*',
    );

    expect(Array.from(selected)).toEqual(['gpt-5.4']);
  });

  it('普通提供商未限制模型时默认显示全部已开放', () => {
    const selected = modelSelectionForDiscovery(
      'codex-api-key',
      [],
      [{ name: 'gpt-5.4' }, { name: 'gpt-image-2' }],
      '',
    );

    expect(Array.from(selected)).toEqual(['gpt-5.4', 'gpt-image-2']);
  });

  it('OpenAI 兼容接入没有已保存模型时默认全选发现的模型', () => {
    const selected = modelSelectionForDiscovery(
      'openai-compatibility',
      [],
      [{ name: 'model-a' }, { name: 'model-b' }],
      '',
    );

    expect(Array.from(selected)).toEqual(['model-a', 'model-b']);
  });

  it('模型选择窗口每次打开都以接口返回的全部模型作为默认选择', () => {
    const selected = allModelSelectionForDiscovery([
      { name: 'deepseek-chat' },
      { name: 'deepseek-reasoner' },
      { name: 'deepseek-new-model' },
    ]);

    expect(Array.from(selected)).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-new-model',
    ]);
  });
});
