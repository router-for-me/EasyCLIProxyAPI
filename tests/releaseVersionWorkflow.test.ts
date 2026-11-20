import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAppVersion } from '../scripts/version.mjs';

const releaseWorkflow = Bun.YAML.parse(readFileSync('.github/workflows/release.yml', 'utf8')) as any;
const anchors = JSON.parse(readFileSync('app-version-anchors.json', 'utf8'));
const sourceVersion = await readAppVersion();
const baseVersion = sourceVersion.split(/[-+]/)[0];

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
        MIAOMIAO_PREVIEW: 'false',
        MANUAL_PRERELEASE: 'true',
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
    expect(outputs.version.startsWith(`${baseVersion}-preview.`)).toBe(true);
    expect(outputs.version).toMatch(/-preview\.\d{8}-\d{4}$/);
    expect(outputs.release_family).toBe('preview');
    expect(outputs.preview_series_version).toBe(outputs.version.split('-preview.')[1]);
    expect(outputs.stable_series_version).toBe(anchors.stable);
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
    expect(outputs.tag).toBe(`v${sourceVersion}`);
    expect(outputs.version).toBe(sourceVersion);
  });

  it('resolves rolling miaomiao preview tag and version', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: '',
      MIAOMIAO_PREVIEW: 'true',
      GITHUB_EVENT_NAME: 'workflow_call',
    });
    expect(outputs.tag).toBe(`v${baseVersion}-miaomiao.10.1`);
    expect(outputs.version).toBe(`${baseVersion}-miaomiao.10.1`);
  });

  it('resolves pull request tag and version', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: '',
      MIAOMIAO_PREVIEW: 'false',
      GITHUB_EVENT_NAME: 'pull_request',
    });
    expect(outputs.tag).toBe(`v${baseVersion}-pr.42.10.1`);
    expect(outputs.version).toBe(`${baseVersion}-pr.42.10.1`);
  });

  it('stamps both coordinates for ordinary stable and preview workflows, never for test artifacts', () => {
    const tag = runResolveVersionScript({ REQUESTED_VERSION: 'v1.2.3', EVENT_NAME: 'push', REF_TYPE: 'tag', REF_NAME: 'v1.2.3' });
    expect(tag.stable_series_version).toBe('1.2.3');
    expect(tag.release_family).toBe('stable');
    expect(tag.preview_series_version).toBe(anchors.preview);
    const preview = runResolveVersionScript({ REQUESTED_VERSION: '', EVENT_NAME: 'push', REF_TYPE: 'branch', REF_NAME: 'preview' });
    expect(preview.release_family).toBe('preview');
    expect(preview.preview_series_version).toBe(preview.tag.slice('preview-'.length));
    expect(preview.version).toBe(`${baseVersion}-preview.${preview.preview_series_version}`);
    expect(preview.stable_series_version).toBe(anchors.stable);
    const manual = { REQUESTED_VERSION: 'v1.2.3', EVENT_NAME: 'workflow_dispatch', REF_TYPE: 'branch', REF_NAME: 'dev' };
    expect(runResolveVersionScript({ ...manual, MANUAL_PRERELEASE: 'false' }).stable_series_version).toBe('1.2.3');
    for (const env of [
      { ...manual, MANUAL_PRERELEASE: 'true' },
      { ...manual, REQUESTED_VERSION: '', MANUAL_PRERELEASE: 'false' },
      { ...manual, EVENT_NAME: 'pull_request' },
      { ...manual, MIAOMIAO_PREVIEW: 'true' },
    ]) {
      const build = runResolveVersionScript(env);
      expect(build.release_family).toBe('unknown');
      expect(build.stable_series_version).toBe('');
      expect(build.preview_series_version).toBe('');
    }
  });

  it('builds pull requests only from Roomen', () => {
    expect(String(releaseWorkflow.jobs.version.if)).toContain("github.event.pull_request.user.login == 'Roomen'");
    expect(releaseWorkflow.on.pull_request.types).not.toContain('edited');
  });
});
