import { expect, test } from 'bun:test';
import { usageProviderDetails } from '../src/services/usageProvider';

test('usage API authentication distinguishes API routes from OAuth', () => {
  expect(usageProviderDetails('codex', 'apikey')).toMatchObject({ name: 'Codex', access: 'API' });
  expect(usageProviderDetails('codex', 'oauth')).toMatchObject({ name: 'Codex', access: 'OAuth' });
  expect(usageProviderDetails('  My gateway  ', 'apikey')).toMatchObject({ name: 'My gateway', access: 'API' });
});

test('missing or new API values are not guessed from model or credentials', () => {
  expect(usageProviderDetails('codex')).toMatchObject({ name: 'Codex', access: '' });
  expect(usageProviderDetails('', 'unknown')).toMatchObject({ name: '—', access: '' });
  expect(usageProviderDetails('custom', 'new-method')).toMatchObject({ name: 'custom', access: 'new-method' });
});
