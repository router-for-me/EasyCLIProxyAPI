import { expect, test } from 'bun:test';
import { usageModelDetails } from '../src/services/usageModel';

test('compares reported response with routed model, not the requested alias', () => {
  expect(usageModelDetails('gpt-routed', 'my-alias', 'gpt-routed')).toMatchObject({ showResolved: true, mismatch: false, showResponseInTooltip: false });
  expect(usageModelDetails('gpt-routed', 'my-alias', 'my-alias')).toMatchObject({ mismatch: true });
  expect(usageModelDetails('gpt-routed', '', 'different')).toMatchObject({ showResolved: false, mismatch: true });
});

test('missing response and route degrade without inventing model names', () => {
  expect(usageModelDetails('gpt-routed', '', '  ')).toMatchObject({ requested: 'gpt-routed', mismatch: false });
  expect(usageModelDetails('', 'alias', 'reported')).toMatchObject({ mismatch: false, showResponseInTooltip: true });
  expect(usageModelDetails(' gpt-routed ', ' gpt-routed ', ' gpt-routed ')).toMatchObject({ showResolved: false, mismatch: false });
});

test('accepts base response models for reasoning tiers, dated pins, and build suffixes while flagging real substitutions', () => {
  expect(usageModelDetails('gemini-4-argon-high', '', 'gemini-4-argon')).toMatchObject({ mismatch: false, showResponseInTooltip: true });
  expect(usageModelDetails('gemini-4-argon-medium', '', 'gemini-4-argon')).toMatchObject({ mismatch: false, showResponseInTooltip: true });
  expect(usageModelDetails('gemini-4-argon-low', '', 'gemini-4-argon')).toMatchObject({ mismatch: false, showResponseInTooltip: true });
  expect(usageModelDetails('gemini-3.8-flash-high', '', 'gemini-3.8-flash')).toMatchObject({ mismatch: false, showResponseInTooltip: true });
  expect(usageModelDetails('claude-opus-5-5-high', '', 'claude-opus-5-5')).toMatchObject({ mismatch: false, showResponseInTooltip: true });
  expect(usageModelDetails('claude-sonnet-4-5', '', 'claude-sonnet-4-5-20250929')).toMatchObject({ mismatch: false, showResponseInTooltip: true });
  expect(usageModelDetails('grok-4.7', '', 'grok-4.7-build')).toMatchObject({ mismatch: false, showResponseInTooltip: true });
  expect(usageModelDetails('gemini-4-argon-high', '', 'gemini-4-argon-low')).toMatchObject({ mismatch: true });
  expect(usageModelDetails('gemini-4-argon', '', 'gemini-4-argon-high')).toMatchObject({ mismatch: true });
  expect(usageModelDetails('claude-opus-5-5', '', 'claude-opus-4-8')).toMatchObject({ mismatch: true });
});
