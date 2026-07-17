import { describe, expect, test } from 'bun:test';
import {
  agentModelAlias,
  filterAgentModels,
  findAgentModel,
  hasExactAgentModel,
  resolveAgentModelSelection,
} from '../src/services/agentModelPicker';

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
});
