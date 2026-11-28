import { describe, expect, it } from 'bun:test';
import { readNumber } from '../src/services/managementApi';

describe('management numeric fields', () => {
  it('treats absent, null, blank and nonnumeric values as unknown', () => {
    for (const value of [undefined, null, '', '  ', true, false, [], {}, 'not a number']) {
      expect(readNumber({ size: value }, 'size')).toBeNull();
    }
  });

  it('continues to a valid alias after an unknown value', () => {
    for (const value of [undefined, null, '', ' ', true, []]) {
      expect(readNumber({ reasoningOutputTokens: value, reasoningTokens: '12' }, 'reasoningOutputTokens', 'reasoningTokens')).toBe(12);
    }
  });

  it('retains zero, numeric strings and finite fractional values', () => {
    expect(readNumber({ value: 0 }, 'value')).toBe(0);
    expect(readNumber({ value: ' 0 ' }, 'value')).toBe(0);
    expect(readNumber({ value: '-1.5' }, 'value')).toBe(-1.5);
    expect(readNumber({ value: Infinity }, 'value')).toBeNull();
  });
});
