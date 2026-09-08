import { describe, expect, it } from 'bun:test';
import {
  buildDeepSeekHarnessLaunchOptions,
  DEFAULT_DEEPSEEK_HARNESS_LAUNCH_DRAFT,
  type DeepSeekHarnessLaunchDraft,
} from '../src/services/deepSeekHarnessLaunch';

const draft = (overrides: Partial<DeepSeekHarnessLaunchDraft> = {}): DeepSeekHarnessLaunchDraft => ({
  ...DEFAULT_DEEPSEEK_HARNESS_LAUNCH_DRAFT,
  ...overrides,
});

describe('DeepSeek Harness launch options', () => {
  it('builds web options and normalizes repeatable values', () => {
    const result = buildDeepSeekHarnessLaunchOptions(draft({
      webHost: ' 127.0.0.1 ',
      webPort: '8080',
      openBrowser: false,
      trustedHosts: 'localhost:3000\n\n example.test ',
      patches: './base.yml\n ./local.yml ',
    }));

    expect(result).toEqual({
      options: {
        mode: 'web',
        webHost: '127.0.0.1',
        webPort: 8080,
        openBrowser: false,
        trustedHosts: ['localhost:3000', 'example.test'],
        task: null,
        profile: null,
        patches: ['./base.yml', './local.yml'],
      },
      error: null,
    });
  });

  it('requires valid web ports', () => {
    expect(buildDeepSeekHarnessLaunchOptions(draft({ webPort: '65536' })).error).toBe('invalidPort');
    expect(buildDeepSeekHarnessLaunchOptions(draft({ webPort: '12.5' })).error).toBe('invalidPort');
  });

  it('requires a headless task and keeps it as one value', () => {
    expect(buildDeepSeekHarnessLaunchOptions(draft({ mode: 'headless' })).error).toBe('taskRequired');
    expect(buildDeepSeekHarnessLaunchOptions(draft({ mode: 'headless', task: ' review repo ' }))).toMatchObject({
      options: { mode: 'headless', task: 'review repo' },
      error: null,
    });
  });

  it('validates custom profile names', () => {
    expect(buildDeepSeekHarnessLaunchOptions(draft({ mode: 'custom' })).error).toBe('profileRequired');
    expect(buildDeepSeekHarnessLaunchOptions(draft({ mode: 'custom', profile: '../web' })).error).toBe('invalidProfile');
    expect(buildDeepSeekHarnessLaunchOptions(draft({ mode: 'custom', profile: 'tui-dev' }))).toMatchObject({
      options: { mode: 'custom', profile: 'tui-dev' },
      error: null,
    });
  });
});
