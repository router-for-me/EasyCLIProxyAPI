import { describe, expect, it } from 'bun:test';
import { nextEnabledOptionIndex, type AppSelectOption } from '../src/components/AppSelect';

const options: AppSelectOption[] = [
  { value: 'first', label: 'First' },
  { value: 'disabled', label: 'Disabled', disabled: true },
  { value: 'last', label: 'Last' },
];

describe('custom select keyboard navigation', () => {
  it('skips disabled options in both directions', () => {
    expect(nextEnabledOptionIndex(options, 0, 1)).toBe(2);
    expect(nextEnabledOptionIndex(options, 2, -1)).toBe(0);
  });

  it('wraps at both ends', () => {
    expect(nextEnabledOptionIndex(options, 2, 1)).toBe(0);
    expect(nextEnabledOptionIndex(options, 0, -1)).toBe(2);
  });

  it('handles empty and fully disabled menus', () => {
    expect(nextEnabledOptionIndex([], -1, 1)).toBe(-1);
    expect(nextEnabledOptionIndex([{ value: 'x', label: 'X', disabled: true }], -1, 1)).toBe(-1);
  });
});
