import { describe, expect, it } from 'bun:test';
import {
  apiAccessRemarkLocatorFromRecord,
  applyProviderRemarkIdentity,
  applyProviderPreset,
  buildProviderRecord,
  createProviderDraft,
  hasDuplicateProviderRecord,
  DEEPSEEK_BASE_URL,
  exclusionsForModelSelection,
  modelSelectionForDiscovery,
  parseProviderHeaders,
  parseProviderApiKeys,
  providerCategoryMatchesRecord,
  providerDragId,
  providerRecordWithDisabledState,
  providerRemarkIdentity,
  providerSectionOrder,
  reorderProviderRecords,
  resolveProviderRecordIndex,
  sectionRecordsFromConfig,
  stripResponseFields,
} from '../src/pages/ApiAccessPage';
import { modelsFromRecord } from '../src/services/modelService';

describe('shared-credential provider entries (#276)', () => {
  const first = {
    'api-key': 'shared-key',
    'base-url': 'https://claude.example.test',
    priority: 10,
    models: [{ name: 'upstream-a', alias: 'claude-a' }],
  };
  const second = {
    ...first, priority: 1, models: [{ name: 'upstream-b', alias: 'claude-b' }],
  };
  const row = (record: Record<string, unknown>, index: number) => ({
    section: 'claude-api-key' as const, index, name: 'Claude',
    apiKey: 'shared-key', baseUrl: first['base-url'], record,
  });

  it('allows different model mappings, aliases, priorities and routing settings', () => {
    for (const candidate of [
      second,
      { ...first, priority: 1 },
      { ...first, models: [{ name: 'upstream-a', alias: 'claude-other' }] },
      { ...first, prefix: 'team-b' },
      { ...first, headers: { 'X-Team': 'b' } },
      { ...first, 'disable-cooling': false },
      { ...first, 'request-retry': 0 },
      { ...first, weight: 0 },
    ]) {
      expect(hasDuplicateProviderRecord('claude-api-key', [first], [candidate])).toBe(false);
    }
  });

  it('still rejects identical configurations, ignoring runtime IDs and empty defaults', () => {
    const persisted = { ...first, 'auth-index': 'runtime-only', headers: {}, prefix: '', cloak: null };
    const candidate = buildProviderRecord('claude-api-key', {
      ...createProviderDraft('claude-api-key'), apiKey: 'shared-key',
      baseUrl: first['base-url'], priority: '10', models: first.models,
    });
    expect(hasDuplicateProviderRecord('claude-api-key', [persisted], [candidate])).toBe(true);
    expect(hasDuplicateProviderRecord('claude-api-key', [persisted], [candidate], 0)).toBe(false);
    expect(hasDuplicateProviderRecord('claude-api-key', [first], [second, candidate])).toBe(true);
    expect(hasDuplicateProviderRecord('openai-compatibility', [{ name: 'same' }], [{ name: 'same', models: first.models }])).toBe(true);
    expect(hasDuplicateProviderRecord('gemini-api-key', [first], [second])).toBe(true);
    expect(hasDuplicateProviderRecord('codex-api-key', [first], [second])).toBe(false);
  });

  it('locates the second entry for edit/toggle/delete, even after an external reorder', () => {
    const selected = row({ ...second, 'auth-index': 'runtime-second' }, 1);
    expect(resolveProviderRecordIndex([first, second], selected)).toBe(1);
    expect(resolveProviderRecordIndex([second, first], selected)).toBe(0);
    expect(resolveProviderRecordIndex([first], selected)).toBe(-1);
    expect(resolveProviderRecordIndex([first, { ...second, priority: 5 }], selected)).toBe(-1);
  });

  it('retains default URL compatibility without guessing among sibling records', () => {
    const { 'base-url': _base, ...withoutBase } = second;
    expect(resolveProviderRecordIndex([first, withoutBase], row(second, 1))).toBe(1);
    expect(resolveProviderRecordIndex([first, withoutBase, { ...withoutBase }], row(second, 1))).toBe(-1);
  });

  it('uses distinct drag IDs and reorders only the intended entries', () => {
    const firstRow = row(first, 0);
    const secondRow = row(second, 1);
    expect(providerDragId(firstRow)).not.toBe(providerDragId(secondRow));
    expect(reorderProviderRecords([first, second], [firstRow, secondRow], secondRow, firstRow)).toEqual([second, first]);
  });

  it('keeps remarks separate and stable through enable/disable and property ordering', () => {
    const firstLocator = apiAccessRemarkLocatorFromRecord('claude-api-key', first);
    const secondLocator = apiAccessRemarkLocatorFromRecord('claude-api-key', second);
    expect(providerRemarkIdentity('claude-api-key', firstLocator))
      .not.toBe(providerRemarkIdentity('claude-api-key', secondLocator));
    const disabled = providerRecordWithDisabledState('claude-api-key', first, true);
    expect(apiAccessRemarkLocatorFromRecord('claude-api-key', disabled)).toEqual(firstLocator);
    expect(apiAccessRemarkLocatorFromRecord('claude-api-key', {
      models: first.models, priority: 10, 'base-url': first['base-url'], 'api-key': first['api-key'],
      'auth-index': 'runtime', websockets: false,
    })).toEqual(firstLocator);
  });
});

it('saves non-empty custom model names and removes duplicate or blank entries', () => {
  const result = buildProviderRecord('openai-compatibility', {
    name: 'custom-provider',
    apiKey: 'provider-key',
    baseUrl: 'https://api.example.com',
    priority: '',
    models: [
      { name: ' custom-model ', alias: ' custom-alias ' },
      { name: ' ' },
      { name: 'CUSTOM-MODEL', alias: 'duplicate' },
    ],
  });

  expect(result.models).toEqual([{ name: 'custom-model', alias: 'custom-alias' }]);
});

it('does not persist display names as model aliases', () => {
  const result = buildProviderRecord('codex-api-key', {
    name: '',
    apiKey: 'codex-key',
    baseUrl: 'https://www.loomex.cc',
    priority: '',
    models: [
      { name: 'codex-auto-review', displayName: 'Codex Auto Review' },
      { name: 'gpt-test', alias: 'review-alias', displayName: 'GPT Test' },
    ],
  });

  expect(result.models).toEqual([
    { name: 'codex-auto-review' },
    { name: 'gpt-test', alias: 'review-alias' },
  ]);
});

it('rejects newly entered aliases that contain whitespace', () => {
  expect(() => buildProviderRecord('codex-api-key', {
    name: '',
    apiKey: 'codex-key',
    baseUrl: 'https://www.loomex.cc',
    priority: '',
    models: [{ name: 'codex-auto-review', alias: 'Codex Auto Review' }],
  })).toThrow(/空白|whitespace|空白文字/);
});

it('preserves an existing spaced alias until the user changes it', () => {
  const result = buildProviderRecord(
    'codex-api-key',
    {
      name: '',
      apiKey: 'codex-key',
      baseUrl: 'https://www.loomex.cc',
      priority: '',
      models: [{ name: 'codex-auto-review', alias: 'Codex Auto Review' }],
    },
    {
      'api-key': 'codex-key',
      models: [{ name: 'codex-auto-review', alias: 'Codex Auto Review' }],
    },
  );

  expect(result.models).toEqual([
    { name: 'codex-auto-review', alias: 'Codex Auto Review' },
  ]);
});

it('keeps an existing spaced alias when only the letter case changes', () => {
  const result = buildProviderRecord(
    'codex-api-key',
    {
      name: '',
      apiKey: 'codex-key',
      baseUrl: 'https://www.loomex.cc',
      priority: '',
      models: [{ name: 'codex-auto-review', alias: 'codex auto review' }],
    },
    {
      'api-key': 'codex-key',
      models: [{ name: 'codex-auto-review', alias: 'Codex Auto Review' }],
    },
  );

  expect(result.models).toEqual([
    { name: 'codex-auto-review', alias: 'Codex Auto Review' },
  ]);
});

it('preserves aliases added in advanced settings when saving an API connection', () => {
  const current = {
    'api-key': 'codex-key',
    'base-url': 'https://foobar.com/v1',
    headers: { 'User-Agent': '$User-Agent' },
    models: [
      { name: 'gpt-5.6-luna' },
      {
        name: 'gpt-5.6-luna',
        alias: 'claude-sonnet-5-luna',
        custom: { keep: true },
      },
    ],
  };
  const result = buildProviderRecord(
    'codex-api-key',
    {
      name: '',
      apiKey: 'codex-key',
      baseUrl: 'https://foobar.com/v1',
      priority: '',
      models: modelsFromRecord(current.models),
      headersText: 'User-Agent: $User-Agent',
    },
    current,
  );

  expect(result.models).toEqual(current.models);
});

it('parses multiline API keys into unique trimmed entries', () => {
  expect(parseProviderApiKeys(' key-a\n\nkey-b\r\nkey-a ')).toEqual(['key-a', 'key-b']);
});

it('keeps remark identities separate for records that share an API key', () => {
  const first = apiAccessRemarkLocatorFromRecord('codex-api-key', {
    'api-key': 'shared-key',
    'base-url': 'https://first.example/v1',
  });
  const second = apiAccessRemarkLocatorFromRecord('codex-api-key', {
    'api-key': 'shared-key',
    'base-url': 'https://second.example/v1',
  });

  expect(first.apiKeys).toEqual(second.apiKeys);
  expect(first.baseUrl).not.toBe(second.baseUrl);
  expect(providerRemarkIdentity('codex-api-key', first))
    .not.toBe(providerRemarkIdentity('codex-api-key', second));
  expect(providerRemarkIdentity('codex-api-key', first)).toBe(
    providerRemarkIdentity('codex-api-key', { ...first, apiKeys: [...first.apiKeys] }),
  );
});

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

  it('DeepSeek 使用 Codex API 记录且不写入内置思考等级', () => {
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
    const identified = applyProviderRemarkIdentity('deepseek', prepared);
    const result = buildProviderRecord('codex-api-key', identified);

    expect(draft.name).toBe('DeepSeek');
    expect(draft.remark).toBe('');
    expect(identified.name).toBe('DeepSeek');
    expect(draft.baseUrl).toBe(DEEPSEEK_BASE_URL);
    expect(draft.models).toEqual([]);
    expect(result).toMatchObject({
      name: 'DeepSeek',
      'base-url': 'https://api.deepseek.com',
      'api-key': 'deepseek-key',
      models: [
        {
          name: 'deepseek-chat',
        },
        {
          name: 'deepseek-reasoner',
        },
        {
          name: 'deepseek-new-model',
        },
      ],
    });
  });

  it('OpenAI 兼容接入使用备注自动生成内核要求的名称', () => {
    const draft = applyProviderRemarkIdentity('openai-compatibility', {
      ...createProviderDraft('openai-compatibility'),
      name: '不再使用的名称',
      remark: '生产环境',
    });

    expect(draft.remark).toBe('生产环境');
    expect(draft.name).toBe('生产环境');
  });

  it('DeepSeek 只从 Codex API 分类识别，旧 OpenAI 兼容记录保持原样', () => {
    const codexRecord = {
      name: 'custom-deepseek',
      'base-url': 'https://api.deepseek.com/v1',
    };
    const legacyRecord = {
      name: 'custom-deepseek',
      'base-url': 'https://api.deepseek.com/v1',
    };

    expect(providerCategoryMatchesRecord('deepseek', codexRecord, 'codex-api-key')).toBe(true);
    expect(providerCategoryMatchesRecord('codex-api-key', codexRecord, 'codex-api-key')).toBe(false);
    expect(providerCategoryMatchesRecord('deepseek', legacyRecord, 'openai-compatibility')).toBe(false);
    expect(providerCategoryMatchesRecord('openai-compatibility', legacyRecord, 'openai-compatibility')).toBe(true);
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

  it('重新启用仅含全停用规则的普通提供商时删除停用规则', () => {
    const result = providerRecordWithDisabledState(
      'claude-api-key',
      {
        'api-key': 'claude-key',
        'excluded-models': ['*'],
        custom: { keep: true },
        'auth-index': 'runtime-only',
      },
      false,
    );

    expect(result['excluded-models']).toBeUndefined();
    expect(result.custom).toEqual({ keep: true });
    expect(result['auth-index']).toBeUndefined();
  });

  it('切换普通提供商时保留其他模型排除规则且不会重复追加停用规则', () => {
    const disabled = providerRecordWithDisabledState(
      'codex-api-key',
      {
        'api-key': 'codex-key',
        'excluded-models': ['preview-*', '*'],
      },
      true,
    );
    const enabled = providerRecordWithDisabledState('codex-api-key', disabled, false);

    expect(disabled['excluded-models']).toEqual(['preview-*', '*']);
    expect(enabled['excluded-models']).toEqual(['preview-*']);
  });

  it('运行时补全默认 Base URL 后仍能按原始索引找到配置记录', () => {
    const records = [
      { 'api-key': 'first-key', 'base-url': 'https://first.example' },
      { 'api-key': 'target-key' },
    ];
    const index = resolveProviderRecordIndex(records, {
      section: 'claude-api-key',
      index: 1,
      name: 'Claude',
      apiKey: 'target-key',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(index).toBe(1);
  });

  it('拖动筛选后的供应商时保留隐藏供应商所在槽位', () => {
    const records = [
      { name: 'OpenAI A', 'auth-index': 'runtime-a' },
      { name: 'DeepSeek', 'base-url': 'https://api.deepseek.com' },
      { name: 'OpenAI B', 'auth-index': 'runtime-b' },
    ];
    const openAiA = {
      section: 'openai-compatibility' as const,
      index: 0,
      name: 'OpenAI A',
      apiKey: '',
      baseUrl: '',
    };
    const openAiB = {
      section: 'openai-compatibility' as const,
      index: 2,
      name: 'OpenAI B',
      apiKey: '',
      baseUrl: '',
    };

    const reordered = reorderProviderRecords(records, [openAiA, openAiB], openAiB, openAiA);

    expect(reordered?.map((record) => record.name)).toEqual([
      'OpenAI B',
      'DeepSeek',
      'OpenAI A',
    ]);
    expect(reordered?.[0]['auth-index']).toBeUndefined();
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
      [{ name: 'gpt-5-codex' }],
    );

    expect(result.split('\n')).toEqual(['legacy-*', 'gpt-image', 'gpt-5-mini']);
  });

  it('重新勾选模型时移除对应的精确排除规则', () => {
    const result = exclusionsForModelSelection(
      'legacy-*\ngpt-image\nmanual-model',
      [{ name: 'gpt-5-codex' }, { name: 'gpt-image' }],
      [{ name: 'gpt-image' }],
    );

    expect(result.split('\n')).toEqual(['legacy-*', 'manual-model', 'gpt-5-codex']);
  });

  it('未勾选的原模型名与已选模型别名相同时不生成冲突排除规则', () => {
    const discovered = [{ name: 'dsv4' }, { name: 'dsv4.1' }, { name: 'other' }];
    const models = [{ name: 'dsv4.1', alias: 'dsv4' }];
    const excludedModelsText = exclusionsForModelSelection('', discovered, models);

    for (const section of ['codex-api-key', 'claude-api-key', 'gemini-api-key'] as const) {
      const record = buildProviderRecord(section, {
        ...createProviderDraft(section), apiKey: 'key', models, excludedModelsText,
      });
      expect(record.models).toEqual(models);
      expect(record['excluded-models']).toEqual(['other']);
    }
  });

  it('重新应用勾选时清理旧的别名冲突，保留手动规则和通配符', () => {
    expect(exclusionsForModelSelection(
      'legacy-*\nmanual-model\nDSV4\ndsv4.1\ndsv*',
      [{ name: ' dsv4 ' }, { name: 'dsv4.1' }, { name: 'other' }],
      [{ name: ' DSV4.1 ', alias: ' DSV4 ' }],
    ).split('\n')).toEqual(['legacy-*', 'manual-model', 'dsv*', 'other']);
  });

  it('已选自定义模型不在发现列表中时也保护其别名', () => {
    expect(exclusionsForModelSelection(
      'dsv4\nmanual-model',
      [{ name: 'dsv4' }, { name: 'other', alias: 'dsv4' }],
      [{ name: 'custom-upstream', alias: 'dsv4' }],
    ).split('\n')).toEqual(['manual-model', 'other']);
  });

  it('勾选后编辑或移除别名时同步恢复和移除自动排除规则', () => {
    const discovered = [{ name: 'dsv4' }, { name: 'dsv4.1' }, { name: 'other' }];
    const before = exclusionsForModelSelection('manual-model', discovered, [{ name: 'dsv4.1' }]);
    expect(before.split('\n')).toEqual(['manual-model', 'dsv4', 'other']);
    const mapped = exclusionsForModelSelection(before, discovered, [{ name: 'dsv4.1', alias: 'dsv4' }]);
    expect(mapped.split('\n')).toEqual(['manual-model', 'other']);
    const renamed = exclusionsForModelSelection(mapped, discovered, [{ name: 'dsv4.1', alias: 'other' }]);
    expect(renamed.split('\n')).toEqual(['manual-model', 'dsv4']);
    expect(exclusionsForModelSelection(renamed, discovered, [{ name: 'dsv4.1' }])).toBe(before);
  });

  it('保存时按最终映射清理自动冲突，未应用勾选的手动排除保持不变', () => {
    const draft = {
      ...createProviderDraft('codex-api-key'), apiKey: 'key',
      models: [{ name: 'dsv4.1', alias: 'dsv4' }],
      excludedModelsText: 'dsv4\nother\ndsv*',
    };
    const automatic = buildProviderRecord('codex-api-key', {
      ...draft, modelSelectionCatalog: [{ name: 'dsv4' }, { name: 'dsv4.1' }, { name: 'other' }],
    });
    expect(automatic['excluded-models']).toEqual(['dsv*', 'other']);
    expect(automatic.modelSelectionCatalog).toBeUndefined();
    expect(buildProviderRecord('codex-api-key', draft)['excluded-models']).toEqual(['dsv4', 'other', 'dsv*']);
  });

  it('保存时也保护配置合并保留的同源额外别名，并保留停用状态', () => {
    const current = {
      'api-key': 'key',
      models: [{ name: 'dsv4.1' }, { name: 'dsv4.1', alias: 'dsv4', custom: true }],
    };
    const record = buildProviderRecord('codex-api-key', {
      ...createProviderDraft('codex-api-key'), apiKey: 'key', disabled: true,
      models: modelsFromRecord(current.models), excludedModelsText: 'dsv4',
      modelSelectionCatalog: [{ name: 'dsv4' }, { name: 'dsv4.1' }, { name: 'other' }],
    }, current);
    expect(record.models).toEqual(current.models);
    expect(record['excluded-models']).toEqual(['other', '*']);
  });

  it('反向映射同样保护已选模型对外名称', () => {
    expect(exclusionsForModelSelection(
      '',
      [{ name: 'dsv4' }, { name: 'dsv4.1' }, { name: 'other' }],
      [{ name: 'dsv4', alias: 'dsv4.1' }],
    )).toBe('other');
  });

  it('普通提供商没有模型映射时按真实开放状态初始化勾选', () => {
    const selected = modelSelectionForDiscovery(
      [],
      [{ name: 'gpt-5.4' }, { name: 'gpt-image-1.5' }, { name: 'gpt-image-2' }],
      'gpt-image-*',
    );

    expect(Array.from(selected)).toEqual(['gpt-5.4']);
  });

  it('普通提供商未限制模型时默认显示全部已开放', () => {
    const selected = modelSelectionForDiscovery(
      [],
      [{ name: 'gpt-5.4' }, { name: 'gpt-image-2' }],
      '',
    );

    expect(Array.from(selected)).toEqual(['gpt-5.4', 'gpt-image-2']);
  });

  it('OpenAI 兼容接入没有已保存模型时默认全选发现的模型', () => {
    const selected = modelSelectionForDiscovery(
      [],
      [{ name: 'model-a' }, { name: 'model-b' }],
      '',
    );

    expect(Array.from(selected)).toEqual(['model-a', 'model-b']);
  });
});
