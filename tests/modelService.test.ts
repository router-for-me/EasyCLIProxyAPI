import { describe, expect, it } from 'bun:test';
import {
  mergeModelOptions,
  modelSearchText,
  modelsFromDiscoveredPayload,
  modelsFromRecord,
  reconcileModelSelection,
  usableModelAlias,
} from '../src/services/modelService';

describe('model discovery selection', () => {
  const discovered = [
    { name: 'deepseek-chat' },
    { name: 'deepseek-reasoner' },
    { name: 'deepseek-new-model' },
  ];

  it('selects every discovered model on the first fetch for a new connection', () => {
    expect(Array.from(reconcileModelSelection(discovered, [], [], 'initial'))).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-new-model',
    ]);
  });

  it('keeps saved selections and leaves newly discovered models unchecked', () => {
    expect(Array.from(reconcileModelSelection(
      discovered,
      [{ name: 'deepseek-chat' }],
      ['deepseek-chat'],
      'initial',
    ))).toEqual(['deepseek-chat']);
  });

  it('preserves refresh selections, drops unavailable discoveries, and keeps configured models', () => {
    expect(Array.from(reconcileModelSelection(
      [{ name: 'deepseek-reasoner' }, { name: 'deepseek-new-model' }],
      [{ name: 'custom-model' }],
      ['DEEPSEEK-REASONER', 'removed-model', 'custom-model'],
      'refresh',
    ))).toEqual(['deepseek-reasoner', 'custom-model']);
  });

  it('deduplicates model names case-insensitively and keeps configured metadata', () => {
    expect(mergeModelOptions(
      [{ name: 'deepseek-chat' }],
      [{ name: ' DEEPSEEK-CHAT ', alias: 'Chat' }],
    )).toEqual([{ name: 'DEEPSEEK-CHAT', alias: 'Chat' }]);
  });

  it('keeps display names for search without treating them as aliases', () => {
    expect(mergeModelOptions(
      [{ name: 'codex-auto-review', displayName: 'Codex Auto Review' }],
      [{ name: 'codex-auto-review', alias: 'review-alias' }],
    )).toEqual([{
      name: 'codex-auto-review',
      alias: 'review-alias',
      displayName: 'Codex Auto Review',
    }]);
    expect(modelSearchText({
      name: 'codex-auto-review',
      displayName: 'Codex Auto Review',
    })).toContain('codex auto review');
  });
});

describe('model catalog parsing', () => {
  it('does not treat display names as aliases', () => {
    expect(modelsFromRecord([
      {
        name: 'codex-auto-review',
        display_name: 'Codex Auto Review',
        displayName: 'Ignored Fallback',
      },
      {
        id: 'gpt-5.6-terra',
        'display-name': 'GPT-5.6 Terra',
      },
    ])).toEqual([
      { name: 'codex-auto-review', displayName: 'Codex Auto Review' },
      { name: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
    ]);
  });

  it('preserves existing aliases from saved configuration, including spaced ones', () => {
    expect(modelsFromRecord([
      { name: 'codex-auto-review', alias: 'Codex Auto Review' },
      { name: 'gpt-test', alias: 'review-alias' },
    ])).toEqual([
      { name: 'codex-auto-review', alias: 'Codex Auto Review' },
      { name: 'gpt-test', alias: 'review-alias' },
    ]);
  });

  it('rejects whitespace in newly entered aliases', () => {
    expect(usableModelAlias('Codex Auto Review')).toBe('');
    expect(usableModelAlias(' review-alias ')).toBe('review-alias');
    expect(usableModelAlias('')).toBe('');
  });

  it('does not import spaced display names as aliases when discovering models', () => {
    expect(modelsFromDiscoveredPayload({
      data: [
        { id: 'codex-auto-review', display_name: 'Codex Auto Review' },
        { id: 'gpt-test', alias: 'Codex Auto Review' },
        { id: 'gpt-alias', alias: 'review-alias' },
      ],
    })).toEqual([
      { name: 'codex-auto-review', displayName: 'Codex Auto Review' },
      { name: 'gpt-test' },
      { name: 'gpt-alias', alias: 'review-alias' },
    ]);
  });
});
