import { describe, expect, test } from 'bun:test';
import { resolveAgentConfigurationAction } from '../src/services/agentConfigurationDraft';
import {
  claudeDesktopEgressContainsWildcard,
  DEFAULT_CLAUDE_DESKTOP_EGRESS_ALLOWED_HOSTS,
  parseClaudeDesktopEgressAllowedHosts,
  sameClaudeDesktopEgressAllowedHosts,
} from '../src/services/claudeDesktopEgress';

const appliedDesktopConfiguration = (
  egressAllowedHosts: readonly string[],
  appliedEgressAllowedHosts: readonly string[],
) => resolveAgentConfigurationAction({
  client: 'claude-desktop',
  modificationState: 'applied',
  selectedModel: 'model-a',
  appliedModel: 'model-a',
  oauthConfiguration: false,
  appliedOauthConfiguration: false,
  modelMappings: { opus: 'model-a', sonnet: 'model-a', haiku: 'model-a' },
  appliedModelMappings: { opus: 'model-a', sonnet: 'model-a', haiku: 'model-a' },
  egressAllowedHosts,
  appliedEgressAllowedHosts,
});

describe('Claude Desktop egress hosts', () => {
  test('uses an explicit recommended list instead of a wildcard', () => {
    expect(DEFAULT_CLAUDE_DESKTOP_EGRESS_ALLOWED_HOSTS).toEqual([
      'localhost',
      '127.0.0.1',
      'api.anthropic.com',
      'github.com',
      '*.github.com',
      '*.githubusercontent.com',
      'gitlab.com',
      '*.gitlab.com',
    ]);
    expect(claudeDesktopEgressContainsWildcard(
      DEFAULT_CLAUDE_DESKTOP_EGRESS_ALLOWED_HOSTS,
    )).toBeFalse();
  });

  test('normalizes, deduplicates, and preserves stable order', () => {
    expect(parseClaudeDesktopEgressAllowedHosts([
      ' GitHub.com ',
      '*.GitHub.com:443',
      'github.com',
      '127.0.0.1:8317',
    ].join('\n'))).toEqual({
      valid: true,
      hosts: ['github.com', '*.github.com:443', '127.0.0.1:8317'],
    });
  });

  test.each([
    '*',
    'localhost',
    'localhost:8317',
    'api.github.com',
    '*.corp.example.com',
    '*.corp.example.com:8443',
    '127.0.0.1',
  ])('accepts %s', (entry) => {
    expect(parseClaudeDesktopEgressAllowedHosts(entry)).toEqual({
      valid: true,
      hosts: [entry],
    });
  });

  test.each([
    '',
    'https://github.com',
    'github.com/path',
    'github.com:0',
    'github.com:65536',
    'github.com:abc',
    '*:443',
    '*.127.0.0.1',
    '*.localhost',
    '2001:db8::1',
    'bad_host.example.com',
  ])('rejects %s', (entry) => {
    expect(parseClaudeDesktopEgressAllowedHosts(entry).valid).toBeFalse();
  });

  test('compares host lists semantically', () => {
    expect(sameClaudeDesktopEgressAllowedHosts(
      ['GitHub.com', '*.github.com'],
      ['*.github.com', 'github.com'],
    )).toBeTrue();
    expect(sameClaudeDesktopEgressAllowedHosts(
      ['github.com'],
      ['github.com', 'gitlab.com'],
    )).toBeFalse();
  });

  test('requests an update when only the egress list changes or is missing', () => {
    expect(appliedDesktopConfiguration(['github.com'], ['github.com'])).toBe('close');
    expect(appliedDesktopConfiguration(['github.com'], [])).toBe('update');
    expect(appliedDesktopConfiguration(['github.com'], ['gitlab.com'])).toBe('update');
  });
});
