import { describe, expect, test } from 'bun:test';
import {
  agentModelAlias,
  filterAgentModels,
  filterAgentModelsByAlias,
  findAgentModel,
  hasExactAgentModel,
  resolveAgentModelForAliasMode,
  resolveAgentModelSelection,
} from '../src/services/agentModelPicker';
import {
  resolveAgentConfigurationAction,
  resolveAgentModelMappingsDraftSourceForClient,
  sameAgentModelMappings,
  type AgentConfigurationClientId,
} from '../src/services/agentConfigurationDraft';

const models = [
  { name: 'claude-sonnet-4-5', alias: 'Sonnet' },
  { name: 'gpt-5.2-codex', alias: 'Codex' },
  { name: 'gpt-5.2' },
  { name: 'deepseek-chat', alias: 'DeepSeek V3' },
];

describe('智能体模型选择器', () => {
  test('按名称和别名搜索且忽略大小写', () => {
    expect(filterAgentModels(models, 'SONNET').map((model) => model.name))
      .toEqual(['claude-sonnet-4-5']);
    expect(filterAgentModels(models, 'deepseek').map((model) => model.name))
      .toEqual(['deepseek-chat']);
  });

  test('精确匹配和前缀匹配排在包含匹配之前', () => {
    expect(filterAgentModels(models, 'gpt-5.2').map((model) => model.name))
      .toEqual(['gpt-5.2', 'gpt-5.2-codex']);
  });

  test('识别名称或别名的精确匹配', () => {
    expect(hasExactAgentModel(models, 'Codex')).toBeTrue();
    expect(hasExactAgentModel(models, 'gpt-5.2-codex')).toBeTrue();
    expect(hasExactAgentModel(models, 'custom-model')).toBeFalse();
  });

  test('根据当前模型显示别名', () => {
    expect(agentModelAlias(models, 'CLAUDE-SONNET-4-5')).toBe('Sonnet');
    expect(agentModelAlias(models, 'gpt-5.2')).toBe('');
  });

  test('没有历史选择时默认第一项，旧选择失效时也回退第一项', () => {
    expect(resolveAgentModelSelection(models, '')).toBe('claude-sonnet-4-5');
    expect(resolveAgentModelSelection(models, 'removed-model')).toBe('claude-sonnet-4-5');
    expect(resolveAgentModelSelection(models, 'GPT-5.2-CODEX')).toBe('gpt-5.2-codex');
    expect(resolveAgentModelSelection([], 'gpt-5.2')).toBe('');
  });

  test('配置前只能解析模型列表中真实存在的模型', () => {
    expect(findAgentModel(models, 'codex')?.name).toBeUndefined();
    expect(findAgentModel(models, 'gpt-5.2-codex')?.name).toBe('gpt-5.2-codex');
  });

  test('Claude Desktop 自定义映射只显示对应类型的模型', () => {
    const mixedModels = [
      { name: 'gpt-original', alias: 'GPT Original', isAlias: false },
      { name: 'gpt-high', alias: 'gpt-original', isAlias: true },
      { name: 'claude-original' },
    ];

    expect(filterAgentModelsByAlias(mixedModels, false).map((model) => model.name))
      .toEqual(['gpt-original', 'claude-original']);
    expect(filterAgentModelsByAlias(mixedModels, true).map((model) => model.name))
      .toEqual(['gpt-high']);
    expect(resolveAgentModelForAliasMode(mixedModels, 'gpt-original', true)).toBe('gpt-high');
    expect(resolveAgentModelForAliasMode(mixedModels, 'gpt-high', false)).toBe('gpt-original');
    expect(resolveAgentModelForAliasMode(mixedModels, 'claude-original', true)).toBe('gpt-high');
    expect(resolveAgentModelForAliasMode([], 'gpt-original', true)).toBe('');
  });
});

const appliedConfiguration = (
  client: AgentConfigurationClientId,
  selectedModel: string,
  appliedModel = 'model-a',
) => resolveAgentConfigurationAction({
  client,
  modificationState: 'applied',
  selectedModel,
  appliedModel,
  oauthConfiguration: false,
  appliedOauthConfiguration: false,
  modelMappings: {
    opus: selectedModel,
    sonnet: selectedModel,
    haiku: selectedModel,
  },
  appliedModelMappings: {
    opus: appliedModel,
    sonnet: appliedModel,
    haiku: appliedModel,
  },
});

describe('agent configuration update action', () => {
  test('仅修改 Codex 全局审批模型也走现有更新入口，其他客户端不受影响', () => {
    for (const client of ['codex', 'opencode'] as const) {
      expect(resolveAgentConfigurationAction({
        client, modificationState: 'applied', selectedModel: 'main-a', appliedModel: 'main-a',
        oauthConfiguration: false, appliedOauthConfiguration: false, codexReviewModelChanged: true,
        modelMappings: { opus: 'main-a', sonnet: 'main-a', haiku: 'main-a' },
        appliedModelMappings: { opus: 'main-a', sonnet: 'main-a', haiku: 'main-a' },
      })).toBe(client === 'codex' ? 'update' : 'close');
    }
  });
  test('Claude mapping clients keep their own unsaved draft after switching away and back', () => {
    const codeDraft = { opus: 'code-opus', sonnet: 'code-sonnet', haiku: 'code-haiku' };
    const desktopDraft = {
      opus: 'desktop-opus',
      sonnet: 'desktop-sonnet',
      haiku: 'desktop-haiku',
    };
    const desktopFallback = {
      opus: 'desktop-model',
      sonnet: 'desktop-model',
      haiku: 'desktop-model',
    };
    const drafts = {
      'claude-code': codeDraft,
      'claude-desktop': desktopDraft,
    };
    const dirtyByClient = {
      'claude-code': true,
      'claude-desktop': false,
    };

    // Switch from Claude Code to Desktop: Desktop still loads its own default.
    expect(resolveAgentModelMappingsDraftSourceForClient(
      drafts,
      'claude-desktop',
      null,
      desktopFallback,
      dirtyByClient['claude-desktop'],
    )).toEqual(desktopFallback);

    // Switch back to Claude Code: its unapplied selection must not be overwritten.
    expect(resolveAgentModelMappingsDraftSourceForClient(
      drafts,
      'claude-code',
      { opus: 'applied', sonnet: 'applied', haiku: 'applied' },
      desktopFallback,
      dirtyByClient['claude-code'],
    )).toEqual(codeDraft);
  });

  test('Claude Code missing auto-compact preference defaults to 90%', () => {
    const mappings = { opus: 'model-a', sonnet: 'model-a', haiku: 'model-a' };
    expect(sameAgentModelMappings(mappings, { ...mappings, autoCompactPct: 90 })).toBeTrue();
    expect(sameAgentModelMappings(mappings, { ...mappings, autoCompactPct: 100 })).toBeFalse();
  });

  test.each<AgentConfigurationClientId>([
    'claude-code',
    'claude-desktop',
    'codex',
    'opencode',
    'openclaw',
    'hermes',
    'zcode',
    'kimi-code',
    'grok-build',
  ])('%s updates only while its model draft differs', (client) => {
    expect(appliedConfiguration(client, 'model-b')).toBe('update');
    expect(appliedConfiguration(client, ' MODEL-A ')).toBe('close');
  });

  test('ZCode updates an applied legacy configuration even when the model is unchanged', () => {
    expect(resolveAgentConfigurationAction({
      client: 'zcode',
      modificationState: 'applied',
      configurationSynchronized: false,
      selectedModel: 'model-a',
      appliedModel: 'model-a',
      oauthConfiguration: false,
      appliedOauthConfiguration: false,
      modelMappings: { opus: '', sonnet: '', haiku: '' },
      appliedModelMappings: { opus: '', sonnet: '', haiku: '' },
    })).toBe('update');
  });

  test.each<AgentConfigurationClientId>(['kimi-code', 'grok-build'])(
    '%s updates an applied configuration whose CPA context catalog is stale',
    (client) => {
      expect(resolveAgentConfigurationAction({
        client,
        modificationState: 'applied',
        configurationSynchronized: false,
        selectedModel: 'model-a',
        appliedModel: 'model-a',
        oauthConfiguration: false,
        appliedOauthConfiguration: false,
        modelMappings: { opus: '', sonnet: '', haiku: '' },
        appliedModelMappings: { opus: '', sonnet: '', haiku: '' },
      })).toBe('update');
    },
  );

  test('Codex also updates when only OAuth configuration changes', () => {
    expect(resolveAgentConfigurationAction({
      client: 'codex',
      modificationState: 'applied',
      selectedModel: 'model-a',
      appliedModel: 'model-a',
      oauthConfiguration: true,
      appliedOauthConfiguration: false,
      modelMappings: { opus: '', sonnet: '', haiku: '' },
      appliedModelMappings: { opus: '', sonnet: '', haiku: '' },
    })).toBe('update');
  });

  test('Claude Desktop updates when only a 1M preference changes', () => {
      expect(resolveAgentConfigurationAction({
        client: 'claude-desktop',
        modificationState: 'applied',
        selectedModel: 'model-a',
        appliedModel: 'model-a',
        oauthConfiguration: false,
        appliedOauthConfiguration: false,
        modelMappings: {
          opus: 'model-a',
          sonnet: 'model-a',
          haiku: 'model-a',
          opus1m: true,
        },
        appliedModelMappings: {
          opus: 'model-a',
          sonnet: 'model-a',
          haiku: 'model-a',
          opus1m: false,
        },
      })).toBe('update');
  });

  test('Claude Code updates when its shared context policy changes', () => {
    expect(resolveAgentConfigurationAction({
      client: 'claude-code',
      modificationState: 'applied',
      selectedModel: 'model-a',
      appliedModel: 'model-a',
      oauthConfiguration: false,
      appliedOauthConfiguration: false,
      modelMappings: {
        opus: 'model-a',
        sonnet: 'model-a',
        haiku: 'model-a',
        maxContextTokens: 372000,
        autoCompactPct: 80,
        disableAutoCompact: true,
      },
      appliedModelMappings: {
        opus: 'model-a',
        sonnet: 'model-a',
        haiku: 'model-a',
        maxContextTokens: 200000,
        autoCompactPct: 100,
        disableAutoCompact: false,
      },
    })).toBe('update');
  });

  test('Pi never exposes the model update action', () => {
    expect(appliedConfiguration('pi', 'model-b')).toBe('close');
  });
});
