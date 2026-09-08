import { describe, expect, it } from 'bun:test';
import {
  modelMatchesRule,
  normalizeOAuthExcludedRules,
  oauthExcludedRulesFromPayload,
  oauthModelCandidates,
  oauthModelsFromPayload,
  openOAuthModelNames,
  setOAuthModelsExcluded,
} from '../src/services/oauthModels';

const models = [
  { id: 'gpt-5.4', displayName: 'GPT 5.4' },
  { id: 'gpt-image-1.5', displayName: 'GPT Image 1.5' },
  { id: 'gpt-image-2', displayName: 'GPT Image 2' },
];

describe('OAuth model exclusion rules', () => {
  it('parses model definitions and normalizes provider rules without duplicates', () => {
    expect(oauthModelsFromPayload({ models: [
      { id: 'gpt-5.4', display_name: 'GPT 5.4' },
      { id: 'GPT-5.4' },
    ] })).toEqual([{ id: 'gpt-5.4', displayName: 'GPT 5.4' }]);
    expect(oauthExcludedRulesFromPayload({
      'oauth-excluded-models': { codex: [' GPT-IMAGE-* ', 'gpt-image-*'] },
    }, 'codex')).toEqual(['gpt-image-*']);
    expect(normalizeOAuthExcludedRules([' GPT-* ', '', 'gpt-*', 'future-model']))
      .toEqual(['gpt-*', 'future-model']);
  });

  it('treats checked models as exclusions and unchecking removes only their exact rule', () => {
    const rules = setOAuthModelsExcluded(['future-*'], [models[0]], true);
    expect(rules).toEqual(['future-*', 'gpt-5.4']);
    expect([...openOAuthModelNames(models, rules)]).toEqual(['gpt-image-1.5', 'gpt-image-2']);
    expect(setOAuthModelsExcluded(rules, [models[0]], false)).toEqual(['future-*']);
  });

  it('excludes all candidates without converting the list to a wildcard', () => {
    const rules = setOAuthModelsExcluded(['future-*'], models, true);
    expect(rules).toEqual(['future-*', 'gpt-5.4', 'gpt-image-1.5', 'gpt-image-2']);
    expect(rules).not.toContain('*');
    expect(openOAuthModelNames([{ id: 'new-model' }], rules).has('new-model')).toBe(true);
  });

  it('clearing selections preserves wildcard and off-list rules', () => {
    expect(setOAuthModelsExcluded(['gpt-image-*', 'gpt-5.4', 'future-model', '*'], models, false))
      .toEqual(['gpt-image-*', 'future-model', '*']);
    expect(setOAuthModelsExcluded(['gpt-image-*'], [models[1]], false)).toEqual(['gpt-image-*']);
  });

  it('restores excluded exact models to candidates without expanding wildcard rules', () => {
    expect(oauthModelCandidates([models[0]], ['gpt-image-2', 'GPT-5.4', 'future-*']))
      .toEqual([models[0], { id: 'gpt-image-2' }]);
  });

  it('matches CPA wildcard rules case-insensitively and treats regex punctuation literally', () => {
    expect(modelMatchesRule('GPT-IMAGE-2', 'gpt-image-*')).toBe(true);
    expect(modelMatchesRule('gpt-5x4', 'gpt-5.4')).toBe(false);
    expect(openOAuthModelNames([...models, { id: 'future-model' }], ['*']).size).toBe(0);
    expect(openOAuthModelNames(models, []).size).toBe(models.length);
  });
});
