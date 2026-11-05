import { expect, test } from 'bun:test';
import { usageClientDetails, usageProviderDetails } from '../src/services/usageProvider';

test('usage API authentication distinguishes API routes from OAuth', () => {
  expect(usageProviderDetails('codex', 'apikey')).toMatchObject({ name: 'Codex', access: 'API' });
  expect(usageProviderDetails('codex', 'oauth')).toMatchObject({ name: 'Codex', access: 'OAuth' });
  expect(usageProviderDetails('  My gateway  ', 'apikey')).toMatchObject({ name: 'My gateway', access: 'API' });
  expect(usageProviderDetails('trae', 'oauth')).toMatchObject({ name: 'Trae', access: 'OAuth' });
  expect(usageProviderDetails('workbuddy', 'oauth')).toMatchObject({ name: 'WorkBuddy', access: 'OAuth' });
  expect(usageProviderDetails('qoder', 'oauth')).toMatchObject({ name: 'Qoder', access: 'OAuth' });
});

test('missing or new API values are not guessed from model or credentials', () => {
  expect(usageProviderDetails('codex')).toMatchObject({ name: 'Codex', access: '' });
  expect(usageProviderDetails('', 'unknown')).toMatchObject({ name: '—', access: '' });
  expect(usageProviderDetails('custom', 'new-method')).toMatchObject({ name: 'custom', access: 'new-method' });
});

test('usageClientDetails identifies known Agent clients from User-Agent without guessing from models', () => {
  expect(usageClientDetails('codex-tui/0.160.1 (Mac OS 26.5; arm64)')).toEqual({
    name: 'Codex',
    raw: 'codex-tui/0.160.1 (Mac OS 26.5; arm64)',
  });
  expect(usageClientDetails('claude-cli/2.1.12 (external, cli)')).toEqual({
    name: 'Claude Code',
    raw: 'claude-cli/2.1.12 (external, cli)',
  });
  expect(usageClientDetails('Mozilla/5.0')).toEqual({
    name: '',
    raw: 'Mozilla/5.0',
  });
  expect(usageClientDetails(null)).toEqual({ name: '', raw: '' });
});
