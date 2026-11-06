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
  expect(usageModelDetails('gpt-5.1-codex-max', '', 'gpt-5.1-codex')).toMatchObject({ mismatch: true });
});

test('normalizes provider prefixes, thinking suffixes, -latest, and every accepted pin or effort suffix before comparing', () => {
  for (const [routed, served] of [
    ['gemini-4-argon-xhigh', 'gemini-4-argon'],
    ['gemini-4-argon-minimal', 'gemini-4-argon'],
    ['claude-sonnet-4-5(8192)', 'claude-sonnet-4-5'],
    ['anthropic/claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'],
    ['gemini-4-argon-latest', 'gemini-4-argon'],
    ['gpt-5.1', 'gpt-5.1-2025-11-13'],
    ['gemini-2.5-flash', 'gemini-2.5-flash-001'],
  ]) {
    expect(usageModelDetails(routed, '', served)).toMatchObject({ mismatch: false });
  }
  for (const [routed, served] of [
    ['gpt-5.1-codex', 'gpt-5.1-codex-max'],
    ['grok-4.7', 'grok-4.7-fast'],
    ['gemini-4-argon-high', 'gemini-4-argon-max'],
  ]) {
    expect(usageModelDetails(routed, '', served)).toMatchObject({ mismatch: true });
  }
});

test('treats Antigravity thinking-tier and -n response variants as matching the routed model and infers effort', () => {
  expect(usageModelDetails('gemini-3.8-flash-high', '', 'gemini-3.8-flash')).toMatchObject({
    mismatch: false,
    showResponseInTooltip: true,
    effort: 'high',
  });
  expect(usageModelDetails('gemini-3.8-flash-high', 'gemini-3.8-flash-high-low', 'gemini-3.8-flash-n', '')).toMatchObject({
    mismatch: false,
    showResponseInTooltip: true,
    effort: 'low',
  });
  expect(usageModelDetails('gemini-3.8-flash-high', 'gemini-3.8-flash-high-medium', 'gemini-3.8-flash-n', '')).toMatchObject({
    mismatch: false,
    effort: 'medium',
  });
});

test('preserves explicit reasoning_effort and leaves missing effort empty when no alias/model tier suffix exists', () => {
  expect(usageModelDetails('gpt-4o', '', 'gpt-4o', 'auto')).toMatchObject({ effort: 'auto' });
  expect(usageModelDetails('gpt-4o', '', 'gpt-4o', '')).toMatchObject({ effort: '' });
});
