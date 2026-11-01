import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const releaseWorkflow = Bun.YAML.parse(readFileSync('.github/workflows/release.yml', 'utf8')) as any;

function runResolveVersionScript(env: Record<string, string>) {
  const versionJob = releaseWorkflow.jobs.version;
  const resolveStep = versionJob.steps.find((step: any) => step.id === 'resolve');
  const script = resolveStep.run;

  const tempDir = mkdtempSync(join(tmpdir(), 'resolve-ver-'));
  const outputPath = join(tempDir, 'output');
  try {
    const result = spawnSync('bash', ['-c', script], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_NUMBER: '10',
        GITHUB_RUN_ATTEMPT: '1',
        PR_NUMBER: '42',
        ...env,
      },
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(`Script failed: ${result.stderr}`);
    }

    const lines = readFileSync(outputPath, 'utf8').trim().split('\n');
    const outputs: Record<string, string> = {};
    for (const line of lines) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        outputs[match[1]] = match[2];
      }
    }
    return outputs;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('release version resolution workflow', () => {
  it('supports non-semver preview tags such as only-preview', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: 'only-preview',
      MIAOMIAO_PREVIEW: 'false',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    expect(outputs.tag).toBe('only-preview');
    expect(outputs.version).toBe('0.3.6-preview');
  });

  it('normalizes bare semver to v-prefixed tag', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: '1.2.3',
      MIAOMIAO_PREVIEW: 'false',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    expect(outputs.tag).toBe('v1.2.3');
    expect(outputs.version).toBe('1.2.3');
  });

  it('preserves v-prefixed semver tag', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: 'v2.0.0-rc.1',
      MIAOMIAO_PREVIEW: 'false',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    expect(outputs.tag).toBe('v2.0.0-rc.1');
    expect(outputs.version).toBe('2.0.0-rc.1');
  });

  it('defaults to source version when requested version is empty', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: '',
      MIAOMIAO_PREVIEW: 'false',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    expect(outputs.tag).toBe('v0.3.6');
    expect(outputs.version).toBe('0.3.6');
  });

  it('resolves rolling miaomiao preview tag and version', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: '',
      MIAOMIAO_PREVIEW: 'true',
      GITHUB_EVENT_NAME: 'workflow_call',
    });
    expect(outputs.tag).toBe('v0.3.6-miaomiao.10.1');
    expect(outputs.version).toBe('0.3.6-miaomiao.10.1');
  });

  it('resolves pull request tag and version', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: '',
      MIAOMIAO_PREVIEW: 'false',
      GITHUB_EVENT_NAME: 'pull_request',
    });
    expect(outputs.tag).toBe('v0.3.6-pr.42.10.1');
    expect(outputs.version).toBe('0.3.6-pr.42.10.1');
  });
});
