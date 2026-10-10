import { describe, expect, test } from 'bun:test';
import {
  CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS,
  CLAUDE_CODE_EXTENDED_MAX_CONTEXT_TOKENS,
  claudeCodeUsesExtendedContext,
  followClaudeCodeContextWindow,
  resolveClaudeCodeMaxContextTokens,
} from '../src/services/claudeCodeModels';

const mappings = (overrides: Record<string, unknown> = {}) => ({
  opus: 'gpt-6.1-sol',
  sonnet: 'gpt-6.1-sol',
  haiku: 'gpt-6.1-sol',
  fable: 'gpt-6.1-sol',
  opus1m: false,
  sonnet1m: false,
  haiku1m: false,
  fable1m: false,
  maxContextTokens: CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS,
  startupModel: 'opus',
  subagentModel: '',
  ...overrides,
});

describe('Claude Code 自动压缩窗口', () => {
  test('启用 1M 时，自动窗口从 200K 跟随到 1M', () => {
    const next = followClaudeCodeContextWindow(
      mappings({ sonnet1m: true }), CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS, true,
    );
    expect(next.maxContextTokens).toBe(CLAUDE_CODE_EXTENDED_MAX_CONTEXT_TOKENS);
  });

  test('关闭 1M 时，自动窗口回到 200K', () => {
    const next = followClaudeCodeContextWindow(
      mappings({ sonnet1m: false }), CLAUDE_CODE_EXTENDED_MAX_CONTEXT_TOKENS, true,
    );
    expect(next.maxContextTokens).toBe(CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS);
  });

  test('自定义窗口 400000 在开关 1M 前后都保持不变', () => {
    expect(followClaudeCodeContextWindow(
      mappings({ sonnet1m: true, maxContextTokens: 400_000 }), 400_000, true,
    ).maxContextTokens).toBe(400_000);
    expect(followClaudeCodeContextWindow(
      mappings({ sonnet1m: false, maxContextTokens: 400_000 }), 400_000, true,
    ).maxContextTokens).toBe(400_000);
    expect(resolveClaudeCodeMaxContextTokens(272_000, true)).toBe(272_000);
  });

  test('启动或 Subagent 模型带 [1m] 后缀同样视为扩展上下文', () => {
    expect(claudeCodeUsesExtendedContext(
      mappings({ startupModel: ' gpt-6.1-sol[1m] ' }),
    )).toBe(true);
    expect(claudeCodeUsesExtendedContext(mappings({ subagentModel: 'gpt-6.1-sol[1M]' }))).toBe(true);
    expect(claudeCodeUsesExtendedContext(mappings())).toBe(false);
    expect(followClaudeCodeContextWindow(
      mappings({ startupModel: 'gpt-6.1-sol[1m]' }), CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS, true,
    ).maxContextTokens).toBe(CLAUDE_CODE_EXTENDED_MAX_CONTEXT_TOKENS);
  });

  test('Claude Desktop 草稿不跟随 1M 调整窗口', () => {
    const next = followClaudeCodeContextWindow(
      mappings({ sonnet1m: true }), CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS, false,
    );
    expect(next.maxContextTokens).toBe(CLAUDE_CODE_DEFAULT_MAX_CONTEXT_TOKENS);
  });
});
