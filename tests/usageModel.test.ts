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
