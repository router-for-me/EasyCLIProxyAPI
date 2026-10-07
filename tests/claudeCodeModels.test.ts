import { expect, test } from 'bun:test';
import { claudeCodeModelPreview, isKnownClaudeCodeModel } from '../src/services/claudeCodeModels';

const routes = { fable: 'model-f', fable1m: false, opus: 'model-a', sonnet: 'model-b', haiku: 'model-c', opus1m: true, sonnet1m: false, haiku1m: false };
test('role selections follow changed mappings and role context flags', () => {
  expect(claudeCodeModelPreview('opus', routes).model).toBe('model-a[1m]');
  expect(claudeCodeModelPreview('sonnet', { ...routes, sonnet: 'model-d', sonnet1m: true }).model).toBe('model-d[1m]');
});
test('direct model stays pinned and has its own context flag', () => {
  expect(claudeCodeModelPreview('model-a', routes)).toEqual({ role: null, model: 'model-a', context1m: false });
  expect(claudeCodeModelPreview('model-a[1m]', { ...routes, opus: 'other' }).model).toBe('model-a[1m]');
});
test('role aliases do not need to appear in CPA model list', () => {
  expect(isKnownClaudeCodeModel('sonnet[1m]', [])).toBeTrue();
  expect(isKnownClaudeCodeModel('', [])).toBeTrue();
  expect(isKnownClaudeCodeModel('model-a[1m]', [{ name: 'model-a' }])).toBeTrue();
  expect(isKnownClaudeCodeModel('unknown', [{ name: 'model-a' }])).toBeFalse();
});
