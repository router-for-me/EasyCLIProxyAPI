import { expect, test } from 'bun:test';
import { usageServiceTierDetails } from '../src/services/usageServiceTier';

test('keeps requested Ultrafast visible when the upstream reports default', () => {
  expect(usageServiceTierDetails('ultrafast', 'default')).toEqual({
    requested: 'ultrafast', response: 'default', badge: 'ultrafast',
  });
  expect(usageServiceTierDetails('ultrafast', 'ultrafast').badge).toBe('ultrafast');
});

test('normalizes badge matching without replacing reported tier values', () => {
  expect(usageServiceTierDetails(' UltraFast ', ' DEFAULT ')).toEqual({
    requested: 'UltraFast', response: 'DEFAULT', badge: 'ultrafast',
  });
  for (const tier of ['priority', 'fast', ' PRIORITY ', ' FAST ']) {
    expect(usageServiceTierDetails(tier, 'default').badge).toBe('fast');
  }
});

test('does not invent a requested tier from a response or an unknown value', () => {
  for (const tier of [undefined, null, '', ' ', 'auto', 'default', 'future-tier']) {
    expect(usageServiceTierDetails(tier, 'ultrafast').badge).toBeNull();
  }
  expect(usageServiceTierDetails('future-tier')).toEqual({
    requested: 'future-tier', response: '', badge: null,
  });
  expect(usageServiceTierDetails()).toEqual({ requested: '', response: '', badge: null });
});
