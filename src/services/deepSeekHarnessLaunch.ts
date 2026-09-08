export type DeepSeekHarnessLaunchMode =
  | 'web'
  | 'headless'
  | 'acp'
  | 'sdk'
  | 'sdk-minimal'
  | 'custom';

export type DeepSeekHarnessLaunchDraft = {
  mode: DeepSeekHarnessLaunchMode;
  webHost: string;
  webPort: string;
  openBrowser: boolean;
  trustedHosts: string;
  task: string;
  profile: string;
  patches: string;
};

export type DeepSeekHarnessLaunchOptions = {
  mode: DeepSeekHarnessLaunchMode;
  webHost: string | null;
  webPort: number | null;
  openBrowser: boolean;
  trustedHosts: string[];
  task: string | null;
  profile: string | null;
  patches: string[];
};

export type DeepSeekHarnessLaunchValidationError =
  | 'invalidPort'
  | 'taskRequired'
  | 'profileRequired'
  | 'invalidProfile';

export type DeepSeekHarnessLaunchBuildResult =
  | { options: DeepSeekHarnessLaunchOptions; error: null }
  | { options: null; error: DeepSeekHarnessLaunchValidationError };

export const DEFAULT_DEEPSEEK_HARNESS_LAUNCH_DRAFT: DeepSeekHarnessLaunchDraft = {
  mode: 'web',
  webHost: '',
  webPort: '',
  openBrowser: true,
  trustedHosts: '',
  task: '',
  profile: '',
  patches: '',
};

const nonEmptyLines = (value: string): string[] => value
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean);

export const buildDeepSeekHarnessLaunchOptions = (
  draft: DeepSeekHarnessLaunchDraft,
): DeepSeekHarnessLaunchBuildResult => {
  const portText = draft.webPort.trim();
  if (draft.mode === 'web' && portText && !/^\d+$/u.test(portText)) {
    return { options: null, error: 'invalidPort' };
  }
  const webPort = portText ? Number(portText) : null;
  if (draft.mode === 'web' && webPort !== null && (!Number.isInteger(webPort) || webPort < 0 || webPort > 65535)) {
    return { options: null, error: 'invalidPort' };
  }

  const task = draft.task.trim();
  if (draft.mode === 'headless' && !task) {
    return { options: null, error: 'taskRequired' };
  }

  const profile = draft.profile.trim();
  if (draft.mode === 'custom' && !profile) {
    return { options: null, error: 'profileRequired' };
  }
  if (
    draft.mode === 'custom'
    && (profile === '.' || profile === '..' || !/^[A-Za-z0-9._-]+$/u.test(profile))
  ) {
    return { options: null, error: 'invalidProfile' };
  }

  return {
    options: {
      mode: draft.mode,
      webHost: draft.mode === 'web' ? draft.webHost.trim() || null : null,
      webPort: draft.mode === 'web' ? webPort : null,
      openBrowser: draft.openBrowser,
      trustedHosts: draft.mode === 'web' ? nonEmptyLines(draft.trustedHosts) : [],
      task: draft.mode === 'headless' ? task : null,
      profile: draft.mode === 'custom' ? profile : null,
      patches: nonEmptyLines(draft.patches),
    },
    error: null,
  };
};
